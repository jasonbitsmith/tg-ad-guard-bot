// Daily report and per-group health summaries.
// Methods are copied onto GuardState.prototype in ../state.js.
import { telegram } from '../telegram.js';
import { DAY } from './shared.js';

export class ReportsMethods {
  dailySummary(from, to) {
    const result = { intercepted:0, banned:0, adUsers:[], reversals:0, reports:0, ocr:0, ocrSkipped:0, failedOperations:0, retries:0, ocrFailures:0, latencyTotal:0, completed:0 };
    const jobs=new Map(), users=new Set();
    for(const row of this.sql.exec('SELECT id,data FROM logs WHERE ts>=? AND ts<? ORDER BY id',from,to).toArray()){
      const log=JSON.parse(row.data), action=String(log.action||'');
      if(log.outcome==='failed')result.failedOperations++;
      if(log.outcome==='retrying')result.retries++;
      if(action==='ocr' && log.outcome==='failed')result.ocrFailures++;
      if(action==='ocr-quota-exhausted')result.ocrSkipped++;
      jobs.set(log.updateId || 'log:'+row.id,log);
    }
    for(const log of jobs.values()){
      const action=String(log.action||''), success=log.outcome==='success';
      if(success && Number.isFinite(log.latencyMs)){result.latencyTotal+=log.latencyMs;result.completed++;}
      const executed=x=>x.done && !x.skipped && (!x.doneAt || (x.doneAt>=from && x.doneAt<to));
      const ban=log.steps?.some(x=>x.method==='banChatMember' && executed(x));
      const deleted=log.steps?.some(x=>x.method==='deleteMessage' && executed(x));
      if(deleted || (!log.steps && success && (action.includes('delete-and-') || action==='delete-channel-message' || action==='review-resolve-ban')))result.intercepted++;
      if(ban || (!log.steps && success && (action.includes('permanent-ban') || action==='verification-timeout-ban' || action==='review-resolve-ban' || action==='federation-ban'))){
        result.banned++;
        if((action.includes('permanent-ban') || action==='federation-ban' || action==='review-resolve-ban') && log.userId)users.add(String(log.userId));
      }
      if(action==='federation-undo' && log.steps?.some(x=>x.method==='case-unban' && executed(x) && x.undoOutcome==='success'))result.reversals++;
      if(success && action==='user-report')result.reports++;
      if(success && action==='ocr')result.ocr++;
    }
    result.adUsers=[...users];return result;
  }
  async sendDailyReport(now = Date.now()) {
    if(this.reporting)return false;this.reporting=true;
    try{return await this.deliverDailyReport(now);}finally{this.reporting=false;}
  }
  async deliverDailyReport(now) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now)).filter(item => item.type !== 'literal').map(item => [item.type, item.value]));
    if (Number(parts.hour) < 9) return false;
    const reportKey = `daily-report:${parts.year}-${parts.month}-${parts.day}`;
    if (this.read(reportKey, false)) return false;
    const localTodayUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
    const previous = new Date(localTodayUtc - DAY);
    const targetDate = previous.toISOString().slice(0, 10);
    const from = previous.getTime() - 8 * 3600000, to = localTodayUtc - 8 * 3600000;
    const chats = await this.listChats();
    const summaries = await Promise.all(chats.map(async chat => ({ chat, ...(await this.env.GUARD_STATE.getByName('chat:' + chat.id).dailySummary(from, to)) })));
    const totals = summaries.reduce((all, item) => ({ intercepted: all.intercepted + item.intercepted, banned: all.banned + item.banned, reversals: all.reversals + item.reversals, reports: all.reports + item.reports, ocr: all.ocr + item.ocr }), { intercepted: 0, banned: 0, reversals:0, reports: 0, ocr: 0 });
    const adUsers=new Set(summaries.flatMap(item=>item.adUsers));
    const tg = telegram(this.env.BOT_TOKEN); const me = await this.me(tg);
    const checks = await Promise.all(chats.map(async chat => {
      try { const member = await tg('getChatMember', { chat_id: Number(chat.id), user_id: me.id }); return !member.can_delete_messages || !member.can_restrict_members ? chat.title : null; }
      catch { return chat.title; }
    }));
    const exceptions = checks.filter(Boolean);
    const health=summaries.reduce((a,x)=>({failed:a.failed+x.failedOperations,retries:a.retries+x.retries,ocrFailures:a.ocrFailures+x.ocrFailures,latency:a.latency+x.latencyTotal,completed:a.completed+x.completed}),{failed:0,retries:0,ocrFailures:0,latency:0,completed:0});
    const queues=await Promise.all(chats.map(chat=>this.env.GUARD_STATE.getByName('chat:'+chat.id).healthSummary()));
    const dmit=this.dmitStatus();
    const lines = summaries.filter(item => item.intercepted || item.banned || item.reports || item.ocr).map(item => `• ${item.chat.title}：拦截 ${item.intercepted} · 群内封禁 ${item.banned} · 撤销 ${item.reversals} · OCR 跳过 ${item.ocrSkipped} · 举报 ${item.reports} · OCR ${item.ocr}`);
    const text = [`🛡 群防日报｜${targetDate}`, '', `已登记群：${chats.length}`, `运行：失败 ${health.failed} · 重试 ${health.retries} · OCR 失败 ${health.ocrFailures}`, `队列积压 ${queues.reduce((n,x)=>n+x.pending,0)} · 最久等待 ${Math.max(0,...queues.map(x=>x.oldestPendingSeconds))} 秒 · 平均处理 ${health.completed?Math.round(health.latency/health.completed):0} 毫秒`, `DMIT：${dmit.state || '未启用'} · 最近检查 ${dmit.lastChecked || '无'}`, `拦截：${totals.intercepted}｜广告账号：${adUsers.size}｜各群封禁次数：${totals.banned}｜误封撤销：${totals.reversals}｜举报：${totals.reports}｜OCR：${totals.ocr}`, exceptions.length ? `⚠️ 权限异常：${exceptions.join('、')}` : '✅ 所有已登记群的删消息与封禁权限正常。', lines.length ? `\n群明细\n${lines.join('\n')}` : '\n昨日无拦截与举报记录。'].join('\n');
    const recipients = this.owners().filter(id => /^\d{1,16}$/.test(id));
    const snapshotKey=reportKey+':text';let snapshot=this.read(snapshotKey);if(!snapshot){snapshot=text;this.write(snapshotKey,snapshot,3*DAY);}
    const chunks=[];let rest=snapshot;while(rest.length){let end=Math.min(3800,rest.length);if(end<rest.length){const split=rest.lastIndexOf('\n',end);if(split>0)end=split+1;}chunks.push(rest.slice(0,end));rest=rest.slice(end);}
    const sent=await Promise.allSettled(recipients.map(async chatId=>{
      const key=reportKey+':recipient:'+chatId;
      let delivered=this.read(key,0);
      for(;delivered<chunks.length;delivered++){
        await tg('sendMessage',{chat_id:Number(chatId),text:chunks[delivered],disable_web_page_preview:true});
        this.write(key,delivered+1,3*DAY);
      }
    }));
    const complete=recipients.length>0 && sent.every(item=>item.status==='fulfilled');
    if(complete)this.write(reportKey,true,3*DAY);
    this.log({action:'daily-report',outcome:complete?'success':'retrying',text:targetDate,recipients:recipients.length,errors:sent.filter(item=>item.status==='rejected').length});
    return complete;
  }
  healthSummary() {
    const rows = this.sql.exec("SELECT status,COUNT(*) AS n,MIN(created) AS oldest FROM jobs GROUP BY status").toArray();
    const pending = rows.find(x => x.status === 'pending');
    const overdue=this.sql.exec("SELECT MIN(created) AS oldest FROM jobs WHERE status='pending' AND due<=?",Date.now()).toArray()[0]?.oldest;
    return { overdueSeconds:overdue?Math.round((Date.now()-overdue)/1000):0, pending: pending?.n || 0, failed: rows.find(x => x.status === 'failed')?.n || 0, oldestPendingSeconds: pending ? Math.round((Date.now()-pending.oldest)/1000) : 0, lastCompletion: this.read('health:last-completion') };
  }
}
