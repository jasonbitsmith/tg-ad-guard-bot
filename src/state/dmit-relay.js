import { telegram } from '../telegram.js';
import { DAY } from './shared.js';

export function isDmitRestock(text) {
  const value=String(text||'').normalize('NFKC');
  return /DMIT/i.test(value) && /补货|restock(?:ed)?|back\s+in\s+stock/i.test(value)
    && /\b(?:LAX|HKG|TYO|SJC|SEA|FRA|SIN)\.(?:AS|AN)\d+(?:\.[A-Z0-9_-]+){1,}/i.test(value)
    && !/无货|缺货|售罄|售完|暂不补货|补货失败|out\s*of\s*stock|sold\s*out/i.test(value);
}
export function dmitTargets(env){
 const values=String(env.DMIT_NOTIFY_CHATS||env.DMIT_NOTIFY_CHAT||'@jason_vps_deal').split(/[,\s]+/).filter(Boolean);const result=[];
 for(const raw of values){if(!/^@[a-zA-Z0-9_]{5,32}$|^-\d{5,16}$/.test(raw))throw Error('补货接收目标必须是 @用户名或负数群 ID');const value=raw.startsWith('@')?raw.toLowerCase():raw;if(!result.includes(value))result.push(value);}
 if(!result.length||result.length>20)throw Error('补货接收目标须为 1–20 个');return result;
}
export function relayPosts(html,username) {
  const escaped=username.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return [...String(html).matchAll(new RegExp('data-post=["\']'+escaped+'/(\\d+)["\'][\\s\\S]*?(?=data-post=["\']'+escaped+'/|$)','gi'))].map(match=>{
    const body=match[0].match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/i)?.[1]||'';
    return {id:Number(match[1]),text:body.replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&')};
  }).filter(x=>Number.isSafeInteger(x.id)&&x.id>0);
}
export class DmitRelayMethods {
  relayConfig(){return {enabled:this.env.DMIT_RELAY_ENABLED==='true',source:String(this.env.DMIT_RELAY_SOURCE_CHAT||'@APPKITLIFE'),target:String(this.env.DMIT_NOTIFY_CHAT||'@jason_vps_deal'),targets:dmitTargets(this.env)};}
  relayStatus(){return {...this.relayConfig(),...this.read('dmit-relay:status',{}),lastDelivery:this.read('dmit-relay:last-delivery'),permissions:this.read('dmit-relay:permissions'),queue:this.sql.exec("SELECT status,COUNT(*) AS count FROM jobs WHERE id LIKE 'dmit-relay:%' OR id LIKE 'dmit-notify:%' GROUP BY status").toArray()};}
  async queueDmitRelay(message) {
    const config=this.relayConfig();
    if(!config.enabled||message?.chat?.type!=='channel'||String(message.chat.username||'').toLowerCase()!==config.source.slice(1).toLowerCase()||config.source.toLowerCase()===config.target.toLowerCase()||(!Number.isSafeInteger(message.message_id)||message.message_id<=0)||!isDmitRestock(message.text||message.caption))return {accepted:false};
    const base=`dmit-relay:${config.source.toLowerCase()}:${message.message_id}`;let queued=0;
    await this.schedule(Date.now()+200);
    for(const target of config.targets.filter(x=>x.toLowerCase()!==config.source.toLowerCase())){
      // Preserve the old primary job ID to avoid replaying an already sent primary notification.
      const id=target.toLowerCase()===config.target.toLowerCase()?base:base+':'+target.toLowerCase();
      if(this.read('delivered:'+id))continue;
      const plan={ops:[{method:'copyMessage',params:{chat_id:target,from_chat_id:config.source,message_id:message.message_id}},{local:'dmit-relay-delivered',id,sourceMessageId:message.message_id,target}],entry:{action:'dmit-channel-relay',source:config.source,channel:target,messageId:message.message_id,reasons:['已批准频道的 DMIT 补货通知同步'],text:String(message.text||message.caption).slice(0,300)}};
      queued+=this.sql.exec('INSERT OR IGNORE INTO jobs(id,payload,plan,due,created) VALUES (?,?,?,?,?) RETURNING id',id,'{}',JSON.stringify(plan),Date.now(),Date.now()).toArray().length;
    }
    return {accepted:true,queued,duplicate:queued===0};
  }
  async queueDmitNotification(event,params){
    await this.schedule(Date.now()+200);let queued=0;
    for(const target of dmitTargets(this.env)){
      const id='dmit-notify:'+event+':'+target;
      if(this.read('delivered:'+id))continue;
      const plan={ops:[{method:'sendMessage',params:{...params,chat_id:target}},{local:'dmit-relay-delivered',id,target,sourceMessageId:null}],entry:{action:'dmit-channel-relay',channel:target,reasons:['DMIT 库存或官方公告推送'],event}};
      queued+=this.sql.exec('INSERT OR IGNORE INTO jobs(id,payload,plan,due,created) VALUES (?,?,?,?,?) RETURNING id',id,'{}',JSON.stringify(plan),Date.now(),Date.now()).toArray().length;
    }return queued;
  }

  markDmitRelayDelivered(op,result) {
    this.write('delivered:'+op.id,true,180*DAY);
    const delivery={sourceMessageId:op.sourceMessageId,targetMessageId:result?.message_id||null,target:op.target,at:new Date().toISOString()};this.write('dmit-relay:last-delivery',delivery);this.write('dmit-relay:last-delivery:'+op.target,delivery);
  }
  async retryDmitRelays(){const jobs=this.sql.exec("SELECT id FROM jobs WHERE status='failed' AND (id LIKE 'dmit-relay:%' OR id LIKE 'dmit-notify:%') ORDER BY created DESC LIMIT 50").toArray();for(const row of jobs)await this.retryJob(row.id);return {queued:jobs.length};}
  async checkDmitRelayPermissions(){
    const config=this.relayConfig(),tg=telegram(this.env.BOT_TOKEN),me=await this.me(tg);const targets=[];
    for(const target of config.targets){
      try{const chat=await tg('getChat',{chat_id:target}),member=await tg('getChatMember',{chat_id:target,user_id:me.id});const admin=['creator','administrator'].includes(member.status);const canPost=chat.type==='channel'?member.status==='creator'||(admin&&member.can_post_messages===true):admin||(['member','restricted'].includes(member.status)&&member.can_send_messages!==false&&chat.permissions?.can_send_messages!==false);targets.push({target,type:chat.type,status:member.status,canPost,lastDelivery:this.read('dmit-relay:last-delivery:'+target)});}
      catch(error){targets.push({target,canPost:false,error:String(error.message).slice(0,200)});}
    }
    let sourceStatus;try{sourceStatus=(await tg('getChatMember',{chat_id:config.source,user_id:me.id})).status;}catch{sourceStatus='unknown';}
    const permissions={sourceStatus,targetCanPost:targets.every(x=>x.canPost),targets,checkedAt:new Date().toISOString()};
    this.write('dmit-relay:permissions',permissions);this.write('dmit-relay:permission-check',true,permissions.targetCanPost?3600000:300000);
    for(const target of targets.filter(x=>!x.canPost))await this.alertOwner('dmit-relay-permissions:'+target.target,'补货同步权限检查未通过\n目标：'+target.target+'；频道需要机器人为管理员并允许发布，群组需要允许机器人发消息。').catch(()=>{});
    return permissions;
  }

  async monitorDmitRelay() {
    if(this.relayPolling)return;const config=this.relayConfig();if(!config.enabled)return;
    if(!/^@[a-zA-Z0-9_]{5,32}$/.test(config.source)||config.targets.includes(config.source.toLowerCase()))throw Error('补货同步频道配置无效');
    this.relayPolling=true;
    try {
      if(!this.read('dmit-relay:permission-check'))await this.checkDmitRelayPermissions();
      const response=await fetch('https://t.me/s/'+config.source.slice(1),{headers:{Accept:'text/html'},signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw Error('来源频道返回 HTTP '+response.status);
      const posts=relayPosts(await response.text(),config.source.slice(1));if(!posts.length)throw Error('来源频道未返回有效消息');
      let previous=this.read('dmit-relay:cursor');const initial=Number(this.env.DMIT_RELAY_START_AFTER_MESSAGE_ID);if(previous===null&&Number.isSafeInteger(initial)&&initial>0)previous=initial;const last=Math.max(...posts.map(x=>x.id));let queued=0;
      // First poll establishes a baseline; already forwarded historical posts are not republished.
      if(previous!==null)for(const post of posts.filter(x=>x.id>previous).sort((a,b)=>a.id-b.id)){
        const result=await this.queueDmitRelay({chat:{type:'channel',username:config.source.slice(1)},message_id:post.id,text:post.text});if(result.accepted&&!result.duplicate)queued++;
      }
      this.write('dmit-relay:cursor',Math.max(previous||0,last));
      this.write('dmit-relay:status',{state:'正常',baseline:previous===null,lastSeen:last,queued,lastChecked:new Date().toISOString()});
    }catch(error){this.write('dmit-relay:status',{...this.read('dmit-relay:status',{}),state:'读取失败',lastChecked:new Date().toISOString(),error:String(error.message).slice(0,200)});await this.alertOwner('dmit-relay-read','补货频道同步读取失败\n'+String(error.message)).catch(()=>{});}
    finally{this.relayPolling=false;}
  }
}
