// DMIT restock radar, OCR, and operational incident monitoring.
// Methods are copied onto GuardState.prototype in ../state.js.
import { telegram } from '../telegram.js';
import { dmitNotification, dmitOfficialNotification, parseDmitOfficialRestocks, parseDmitPricing, withDmitAffiliate } from '../dmit.js';
import { DAY, ADMIN_STATUS } from './shared.js';

export class MonitorsMethods {
  dmitStatus() {
    return this.read('dmit:status', { enabled: this.env.DMIT_MONITOR_ENABLED === 'true', state: '尚未执行' });
  }
  ocrQuota(chatId){
    const limit=Math.max(1,Math.min(100,Number(this.env.OCR_MAX_PER_CHAT_HOUR||30))), key='ocr:quota:'+chatId;
    let quota=this.read(key,{used:0,resetAt:0});
    if(typeof quota==='number'){const row=this.sql.exec('SELECT expires FROM records WHERE key=?',key).toArray()[0];quota={used:quota,resetAt:row?.expires||Date.now()};}
    if(quota.resetAt<=Date.now())quota={used:0,resetAt:0};
    return {enabled:this.env.OCR_ENABLED==='true',limit,used:quota.used,remaining:Math.max(0,limit-quota.used),resetAt:quota.resetAt||null,exhausted:quota.used>=limit};
  }
  async ocr(msg, tg) {
    if (this.env.OCR_ENABLED !== 'true' || !this.env.AI || !Array.isArray(msg.photo) || !msg.photo.length) return '';
    const photo = [...msg.photo].reverse().find(item => Number(item.file_size || 0) > 8000 && Number(item.file_size || 0) <= 3 * 1024 * 1024);
    if (!photo?.file_id || !photo.file_unique_id) return '';
    const cached = this.read(`ocr:photo:${photo.file_unique_id}`);
    if (cached) return cached;
    const quotaKey='ocr:quota:'+msg.chat.id, quota=this.ocrQuota(msg.chat.id);
    if(quota.exhausted){
      this.log({action:'ocr-quota-exhausted',chatId:msg.chat.id,messageId:msg.message_id,outcome:'skipped'});
      const alertKey='ocr:quota-alert:'+msg.chat.id;
      if(!this.read(alertKey)){
        const sent=await this.env.GUARD_STATE.getByName('admin').alertOwner('ocr-quota-'+msg.chat.id,'OCR 图片识别额度已用完\n群：'+(msg.chat.title||msg.chat.id)+'\n本轮上限：'+quota.limit+' 次；恢复时间：'+new Date(quota.resetAt).toISOString()+'\n文字、链接等其他过滤仍继续运行。').catch(()=>{});
        if(sent)this.write(alertKey,true,Math.max(1,quota.resetAt-Date.now()));
      }
      return '';
    }
    try {
      const resetAt=quota.resetAt || Date.now()+3600000;
      this.write(quotaKey,{used:quota.used+1,resetAt},Math.max(1,resetAt-Date.now()));
      const file = await tg('getFile', { file_id: photo.file_id });
      if (!file?.file_path) return '';
      const response = await fetch(`https://api.telegram.org/file/bot${this.env.BOT_TOKEN}/${file.file_path}`, { signal: AbortSignal.timeout(10000) });
      const bytes = new Uint8Array(await response.arrayBuffer());
      const contentType = response.headers.get('content-type') || 'image/jpeg';
      if (!response.ok || bytes.byteLength > 3 * 1024 * 1024 || !contentType.startsWith('image/')) return '';
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      const result = await this.env.AI.run('@cf/moondream/moondream3.1-9B-A2B', {
        task: 'query', image: `data:${contentType};base64,${btoa(binary)}`,
        question: '逐字抄录图片中可见的中文、英文、数字、金额、网址和 Telegram 用户名。只输出图片文字，不要说明或评价。', reasoning: false,
      });
      const output = String(result?.answer || result?.response || result?.result || '').trim().slice(0, 4000);
      if (output) {
        this.write(`ocr:photo:${photo.file_unique_id}`, output, 30 * DAY);
        this.log({ action: 'ocr', chatId: msg.chat.id, messageId: msg.message_id, outcome: 'success', text: output.slice(0, 300) });
      }
      return output;
    } catch (error) {
      this.log({ action: 'ocr', chatId: msg.chat.id, messageId: msg.message_id, outcome: 'failed', error: String(error.message || 'unknown error').slice(0, 200) });
      await this.env.GUARD_STATE.getByName('admin').alertOwner('ocr-failure', `OCR 图片识别失败\n群：${msg.chat.title || msg.chat.id}\n原因：${String(error.message || '未知错误').slice(0, 300)}`).catch(() => {});
      return '';
    }
  }
  async monitorDmit() {
    const source = this.env.DMIT_PRICING_URL || 'https://www.dmit.io/pages/pricing';
    const channel = this.env.DMIT_NOTIFY_CHAT || '@jason_vps_deal';
    const affiliateId = this.env.DMIT_AFFILIATE_ID || '';
    const now = new Date().toISOString();
    let response;
    try {
      response = await fetch(source, { headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'Mozilla/5.0 (compatible; DMIT-Restock-Radar/1.0; +https://bot.jasonselect.com)' }, signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`官网返回 HTTP ${response.status}`);
      const products = parseDmitPricing(await response.text(), source);
      if (!products.length) throw new Error('未找到可识别的 DMIT 产品，页面结构可能已变化');
      const initialized = this.read('dmit:initialized', false);
      let notifications = 0;
      for (const product of products) {
        const key = `dmit:product:${product.id}`;
        const previous = this.read(key);
        if (initialized && previous?.inStock === false && product.inStock) {
          try {
            await telegram(this.env.BOT_TOKEN)('sendMessage', {
              chat_id: channel,
              text: dmitNotification(product, channel),
              reply_markup: product.orderUrl ? { inline_keyboard: [[{ text: '🛒 ➔ 点击这里｜立即抢购', url: withDmitAffiliate(product.orderUrl, affiliateId) }]] } : undefined,
              disable_web_page_preview: true,
            });
            notifications++;
            this.log({ action: 'dmit-restock-notification', product: product.product, channel, outcome: 'success' });
          } catch (error) {
            this.log({ action: 'dmit-restock-notification', product: product.product, channel, outcome: 'failed', error: String(error.message || 'unknown error').slice(0, 300) });
            continue;
          }
        }
        this.write(key, product);
      }
      this.write('dmit:initialized', true);
      this.write('dmit:status', { enabled: true, state: '正常', sourceType:'inventory-page', source, channel, affiliateId: affiliateId || null, lastChecked: now, lastSuccess: now, products: products.length, inStock: products.filter(item => item.inStock).length, notifications });
    } catch (error) {
      // The store can reject automated traffic (HTTP 403).  Keep monitoring
      // DMIT's own public announcement channel instead of leaving a blind spot.
      const fallback = 'https://t.me/s/DMIT_INC';
      try {
        const response = await fetch(fallback, { headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
        if (!response.ok) throw new Error(`官方公告返回 HTTP ${response.status}`);
        const html=await response.text();
        const postIds=[...html.matchAll(/data-post=["']DMIT_INC\/(\d+)["']/gi)].map(x=>Number(x[1])).filter(Number.isSafeInteger);
        if(!postIds.length)throw new Error('未读取到有效的官方频道公告');
        const items = parseDmitOfficialRestocks(html);
        const lastId=this.read('dmit:official-last-id',0);
        let notifications = 0;
        const baseline=!this.read('dmit:official-initialized',false);
        for (const item of items.slice().reverse()) {
          const key = `dmit:official:${item.id}`;
          if (this.read(key, false)) continue;
          if(baseline || Number(item.id)<=lastId){this.write(key,true,180*DAY);continue;}
          await telegram(this.env.BOT_TOKEN)('sendMessage', {
            chat_id: channel,
            text: dmitOfficialNotification(item, channel),
            reply_markup: { inline_keyboard: [[{ text: '🛒 ➔ 点击这里｜立即抢购', url: withDmitAffiliate('https://www.dmit.io/aff.php',affiliateId) }],[{text:'🔍 查看官方补货公告',url:item.url}]] },
            disable_web_page_preview: true,
          });
          this.write(key, true, 180 * DAY);
          notifications++;
          this.log({ action: 'dmit-official-restock-notification', channel, outcome: 'success' });
        }
        this.write('dmit:official-last-id',Math.max(lastId,...postIds));
        this.write('dmit:official-initialized',true);
        this.write('dmit:status', { sourceType:'official-announcement',baseline, enabled: true, state: '官网受限，官方公告备用运行中', source, fallback, channel, lastChecked: now, lastSuccess: now, error: String(error.message || 'unknown error').slice(0, 300), officialItems: items.length, notifications });
        return;
      } catch (fallbackError) {
        error = new Error(`${String(error.message || '官网读取失败')}；备用公告读取失败：${String(fallbackError.message || '未知错误')}`);
      }
      const previous = this.dmitStatus();
      const status = { ...previous, enabled: true, state: '读取失败', source, channel, lastChecked: now, error: String(error.message || 'unknown error').slice(0, 300) };
      this.write('dmit:status', status);
      // Keep a compact durable audit trail without flooding it on every minute.
      if (previous.error !== status.error || !previous.lastError || Date.now() - Date.parse(previous.lastError) > 3600000) this.log({ action: 'dmit-monitor', outcome: 'failed', error: status.error });
      status.lastError = now; this.write('dmit:status', status);
      await this.alertOwner('dmit-monitor-failure', `DMIT 补货监控读取失败\n原因：${status.error}`).catch(() => {});
    }
  }
  incidentList(){return this.sql.exec("SELECT value FROM records WHERE key LIKE 'incident:%' AND expires>? ORDER BY json_extract(value,'$.active') DESC,rowid DESC LIMIT 200",Date.now()).toArray().map(x=>JSON.parse(x.value));}
  async checkIncident(id,bad,details){
    const key='incident:'+id;let incident=this.read(key,{id,active:false,notified:false});
    if(bad){if(!incident.active)incident={id,active:true,notified:false,since:new Date().toISOString()};incident.details=details;incident.checked=new Date().toISOString();this.write(key,incident,30*DAY);
      if(!incident.notified){const sent=await this.alertOwner('incident-'+id,'运行异常\n'+details);if(sent){incident.notified=true;this.write(key,incident,30*DAY);}}
    }else if(incident.active || incident.recoveryPending){
      if(incident.active){incident.active=false;incident.recoveryPending=incident.notified;incident.recovered=new Date().toISOString();}
      incident.checked=new Date().toISOString();this.write(key,incident,30*DAY);
      if(incident.recoveryPending && await this.alertOwner('recovered-'+id,'已恢复正常\n'+details)){incident.recoveryPending=false;this.write(key,incident,30*DAY);}
    }
    return incident;
  }
  async probeTelegram(tg,method) {
    for(let attempt=1;attempt<=2;attempt++)try{return await tg(method);}
    catch(error){
      this.log({action:'telegram-health-probe',method,attempt,code:Number(error.code)||null,retryable:!!error.retryable,outcome:'failed',error:String(error.message||'状态请求失败').slice(0,350)});
      // Only repeat read-only probes, and never ignore Telegram's rate-limit delay.
      if(attempt===2||!error.retryable||Number(error.code)===429)throw error;
    }
  }
  async monitorOperations(force=false){
    if(this.monitoring || (!force && this.read('monitor:next',0)>Date.now()))return;
    this.monitoring=true;this.write('monitor:next',Date.now()+5*60000);
    try{
      const tg=telegram(this.env.BOT_TOKEN);let me;
      let webhook,probeError;
      try{me=await this.probeTelegram(tg,'getMe');webhook=await this.probeTelegram(tg,'getWebhookInfo');}
      catch(error){probeError=error;me=null;}
      if(probeError){const detail='Telegram API 状态检查失败\n错误码：'+(probeError.code||'未知')+'\n原因：'+String(probeError.message||'未知错误').slice(0,350);await this.checkIncident('telegram-api',true,detail);}
      else {const stale=webhook.pending_update_count>0 && webhook.last_error_date*1000>Date.now()-15*60000;
        await this.checkIncident('webhook',!webhook.url || !webhook.url.endsWith('/webhook/'+this.env.WEBHOOK_SECRET) || stale,'Webhook：待接收更新 '+(webhook.pending_update_count||0)+(stale?'，最近出现投递异常':''));
        await this.checkIncident('telegram-api',false,'Telegram API 可用');
      }
      const chats=await this.listChats();
      for(const chat of chats){
        try{const health=await this.env.GUARD_STATE.getByName('chat:'+chat.id).healthSummary();await this.checkIncident('queue-'+chat.id,health.failed>0 || health.overdueSeconds>300,'群：'+chat.title+'\n队列失败 '+health.failed+'，最久等待 '+health.oldestPendingSeconds+' 秒');}
        catch{await this.checkIncident('queue-'+chat.id,true,'群：'+chat.title+'\n无法检查执行队列');}
        if(me)try{const member=await tg('getChatMember',{chat_id:Number(chat.id),user_id:me.id});await this.checkIncident('permission-'+chat.id,!ADMIN_STATUS.includes(member.status)||!member.can_delete_messages||!member.can_restrict_members,'群：'+chat.title+'\n身份：'+member.status+'；删消息权限：'+(member.can_delete_messages?'有':'无')+'；封禁权限：'+(member.can_restrict_members?'有':'无'));}catch{await this.checkIncident('permission-'+chat.id,true,'群：'+chat.title+'\n无法读取机器人权限');}
      }
      this.write('monitor:last',new Date().toISOString());
    }finally{this.monitoring=false;}
  }
}
