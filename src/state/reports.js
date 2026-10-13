// Daily report and per-group health summaries.
// Methods are copied onto GuardState.prototype in ../state.js.
import { telegram } from '../telegram.js';
import { DAY } from './shared.js';

export class ReportsMethods {
  dailySummary(from, to) {
    const result = { intercepted:0, banned:0, federationBanned:0, adUsers:[], reversals:0, reports:0, ocr:0, ocrSkipped:0, failedOperations:0, retries:0, ocrFailures:0, latencyTotal:0, completed:0 };
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
        if(action==='federation-ban')result.federationBanned++;
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
      try {
        const member = await tg('getChatMember', { chat_id: Number(chat.id), user_id: me.id });
        if (member.status !== 'administrator') return { title: chat.title, problem: '机器人不是管理员，广告删不掉也封不了', fix: '请在群设置里把机器人设为管理员。' };
        const missing = [!member.can_delete_messages && '删除消息', !member.can_restrict_members && '封禁成员'].filter(Boolean);
        return missing.length ? { title: chat.title, problem: `机器人缺少「${missing.join('」「')}」权限`, fix: '请到群设置 → 管理员 → 机器人，把它打开。' } : null;
      }
      catch { return { title: chat.title, problem: '查不到机器人的权限，可能已被移出群', fix: '请确认机器人还在群里并且是管理员。' }; }
    }));
    const exceptions = checks.filter(Boolean);
    const health=summaries.reduce((a,x)=>({failed:a.failed+x.failedOperations,retries:a.retries+x.retries,ocrFailures:a.ocrFailures+x.ocrFailures,latency:a.latency+x.latencyTotal,completed:a.completed+x.completed}),{failed:0,retries:0,ocrFailures:0,latency:0,completed:0});
    const queues=await Promise.all(chats.map(chat=>this.env.GUARD_STATE.getByName('chat:'+chat.id).healthSummary()));
    const text=formatDailyReport({targetDate,chats,summaries,totals,adUsers:adUsers.size,exceptions,health,queues,dmit:this.dmitStatus(),now});
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

const WEEKDAYS='日一二三四五六';
const beijingTime=iso=>{
  const time=Date.parse(iso);if(!Number.isFinite(time))return '';
  const d=new Date(time+8*3600000);return `${d.getUTCMonth()+1}月${d.getUTCDate()}日 ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
};
// Plain-language daily report: what needs attention first, then yesterday's numbers, zero values hidden.
export function formatDailyReport({targetDate,chats,summaries,totals,adUsers,exceptions,health,queues,dmit}){
  const day=new Date(targetDate+'T00:00:00Z');
  const title=`🛡 群防日报｜${day.getUTCMonth()+1}月${day.getUTCDate()}日（周${WEEKDAYS[day.getUTCDay()]}）`;
  const backlog=queues.reduce((n,x)=>n+x.pending,0), oldest=Math.max(0,...queues.map(x=>x.oldestPendingSeconds));
  const todo=exceptions.map(x=>`• 「${x.title}」：${x.problem}。${x.fix||''}`);
  if(health.failed)todo.push(`• 有 ${health.failed} 个操作最终没有成功，可以在后台「日志」里查看原因。`);
  if(backlog && oldest>=300)todo.push(`• 还有 ${backlog} 个任务在排队，最久的已等了 ${Math.round(oldest/60)} 分钟。`);
  if(health.ocrFailures)todo.push(`• 图片识别失败 ${health.ocrFailures} 次，带图广告可能漏掉。`);
  if(dmit?.enabled && dmit.state==='读取失败')todo.push('• DMIT 补货监控读取失败，暂时收不到补货提醒。');
  const head=todo.length?[`⚠️ 有 ${todo.length} 件事需要你处理`,...todo]:['✅ 一切正常，今天不需要你处理什么。'];
  const federated=summaries.reduce((n,x)=>n+(x.federationBanned||0),0);
  const stats=[];
  if(totals.intercepted)stats.push(`🗑 删除广告消息：${totals.intercepted} 条`);
  if(adUsers)stats.push(`🚫 封禁广告账号：${adUsers} 个`);
  if(federated){const groups=summaries.filter(x=>x.federationBanned).length;stats.push(`🔗 联防同步：把这些账号同步封到了 ${groups} 个群，共 ${federated} 次（同一个账号在每个群各算一次）`);}
  if(totals.reports)stats.push(`🙋 群友举报：${totals.reports} 次`);
  if(totals.reversals)stats.push(`↩️ 误封撤销：${totals.reversals} 次`);
  if(totals.ocr)stats.push(`🖼 识别图片：${totals.ocr} 张`);
  const body=[`📊 昨天（共 ${chats.length} 个群）`,...(stats.length?stats:['风平浪静，没有发现广告。'])];
  const active=summaries.map(x=>({title:x.chat.title,parts:[x.intercepted&&`删 ${x.intercepted} 条`,(x.banned-(x.federationBanned||0))>0&&`封 ${x.banned-(x.federationBanned||0)} 人`,x.reports&&`举报 ${x.reports} 次`,x.reversals&&`撤销 ${x.reversals} 次`].filter(Boolean)})).filter(x=>x.parts.length);
  const detail=active.length?['','📍 广告出现在这些群',...active.map(x=>`• ${x.title}：${x.parts.join(' · ')}`)]:[];
  const avg=health.completed?Math.round(health.latency/health.completed):0;
  const system=[`⚙️ 机器人：${health.failed||health.retries||backlog?`失败 ${health.failed} · 重试 ${health.retries} · 排队 ${backlog}`:'运行正常'}${avg?`，平均 ${(avg/1000).toFixed(1)} 秒处理一条`:''}`];
  if(dmit?.enabled){const at=beijingTime(dmit.lastChecked);system.push(`📦 DMIT 补货监控：${dmit.state||'尚未执行'}${at?`（最近检查 ${at}）`:''}`);}
  return [title,'',...head,'',...body,...detail,'',...system].join('\n');
}
