import { validateBackup, validateConfig, diffValues } from './operations.js';
import { digest } from './telegram.js';
import { DurableObject } from 'cloudflare:workers';
import { telegram } from './telegram.js';
import { classify, normalize, normalizeDomain, DEFAULT_KEYWORDS, DEFAULT_POLICY, CONTENT_LOCK_TYPES, parseCommand, validateWord } from './filters.js';
import { dmitNotification, dmitOfficialNotification, parseDmitOfficialRestocks, parseDmitPricing, withDmitAffiliate } from './dmit.js';
import { sampleMatches, validateSample } from './samples.js';
import { draftPost, inspectPost, previewPost, publishPost } from './bookscape.js';

const DAY = 86400000;
const ADMIN_STATUS = ['administrator', 'creator'];
// Groups discovered in the v1 interception history. Telegram has no Bot API
// endpoint that lists every group containing a bot, so these are explicitly
// seeded once into the v2 admin registry during the migration.
const LEGACY_CHATS = [
  { id: '-100999888777', title: '模拟VPS群' },
  { id: '-1003510391132', title: 'Jason 的全球手机号保号实验室' },
  { id: '-1003941419403', title: 'Jason-AI调教实验室' },
  { id: '-1003590410271', title: 'Jason - VPS 交流互助交流' },
  { id: '-1003336565693', title: 'Jason海外收款互助交流群' },
  { id: '-1003495086337', title: 'Jason - 数字生活指南' },
];
const HELP = '群管理指令（管理员使用）\n/status 状态及权限检查\n/addword 词、/removeword 词、/listwords（仅本群）\n回复消息或指定用户 ID：\n/warnings、/clearwarn、/allow、/unallow、/unban、/unmute\n/spam 回复广告：删除并封禁，存入待审核样本\n/ban 手动封禁、/kick 移出（会涉及删除历史消息）\n自动策略：广告命中后直接删消息并永久封禁账号，不发送或累计警告。';
function normalizeKnowledge(items) {
  if (!Array.isArray(items)) return [];
  const used = new Set(), result = [];
  for (const raw of items.slice(0, 50)) {
    const command = String(raw?.command || '').trim().toLowerCase().replace(/^\//, '');
    const title = String(raw?.title || command || '').trim().slice(0, 40);
    const triggers = [...new Set((Array.isArray(raw?.triggers) ? raw.triggers : String(raw?.triggers || '').split(/[,，\n]/)).map(value => String(value).trim()).filter(value => value && value.length <= 80))].slice(0, 12);
    const response = String(raw?.response || '').trim();
    if ((!command && !triggers.length) || !response || response.length > 2500 || (command && !/^[a-z][a-z0-9_]{0,31}$/.test(command)) || (command && used.has(command))) continue;
    if (command) used.add(command);
    result.push({ id: String(raw?.id || crypto.randomUUID()), title: title || triggers[0], command, triggers, response, enabled: raw?.enabled !== false });
  }
  return result;
}

export class GuardState extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.running = false;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, payload TEXT NOT NULL, plan TEXT, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL, created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status,due);
      CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS logs_time ON logs(ts);
      CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, title TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS samples (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, value TEXT NOT NULL, label TEXT NOT NULL, created INTEGER NOT NULL, UNIQUE(kind,value));
      CREATE TABLE IF NOT EXISTS federation (chat_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS member_profiles (user_id TEXT PRIMARY KEY, username TEXT, name TEXT, seen INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS member_username ON member_profiles(username);
      CREATE TABLE IF NOT EXISTS verifications (user_id TEXT PRIMARY KEY, answer TEXT, prompt_message_id INTEGER, expires INTEGER NOT NULL, mode TEXT NOT NULL, channel TEXT);
      CREATE TABLE IF NOT EXISTS config_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, created INTEGER NOT NULL, reason TEXT NOT NULL, config TEXT NOT NULL);`);
    for (const chat of LEGACY_CHATS) {
      this.sql.exec('INSERT OR IGNORE INTO chats VALUES (?,?)', chat.id, chat.title);
    }
  }
  read(key, fallback = null) {
    const row = this.sql.exec('SELECT value FROM records WHERE key=? AND expires>?', key, Date.now()).toArray()[0];
    return row ? JSON.parse(row.value) : fallback;
  }
  write(key, value, ttl = 3650 * DAY) {
    this.sql.exec('INSERT INTO records VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires=excluded.expires', key, JSON.stringify(value), Date.now() + ttl);
  }
  saveConfig(config, reason) {
    const previous = this.read('config');
    if (previous && JSON.stringify(previous) !== JSON.stringify(config)) {
      this.sql.exec('INSERT INTO config_versions(created,reason,config) VALUES (?,?,?)', Date.now(), String(reason).slice(0, 100), JSON.stringify(previous));
      this.sql.exec('DELETE FROM config_versions WHERE id NOT IN (SELECT id FROM config_versions ORDER BY id DESC LIMIT 20)');
    }
    this.write('config', config);
  }
  configVersions() { return this.sql.exec('SELECT id,created,reason,config FROM config_versions ORDER BY id DESC LIMIT 20').toArray().map(row => { const config = JSON.parse(row.config); return { id: row.id, created: row.created, reason: row.reason, keywordCount: config.keywords?.length || 0, verificationMode: config.verificationMode || 'off', linkGuard: config.newMemberLinkGuard !== false }; }); }
  restoreConfig(id) {
    const row = this.sql.exec('SELECT config FROM config_versions WHERE id=?', Number(id)).toArray()[0];
    if (!row) throw new Error('未找到该规则版本');
    const restored = { ...DEFAULT_POLICY, ...JSON.parse(row.config), keywords: Array.isArray(JSON.parse(row.config).keywords) ? JSON.parse(row.config).keywords : DEFAULT_KEYWORDS };
    this.saveConfig(restored, `恢复版本 #${id}`);
    this.log({ action: 'config-restore', actorId: 'web-admin', outcome: 'success', text: String(id) });
    return { config: restored, versions: this.configVersions() };
  }
  remove(key) { this.sql.exec('DELETE FROM records WHERE key=?', key); }
  log(entry) {
    const record = { ...entry, ts: new Date().toISOString() };
    this.sql.exec('INSERT INTO logs(ts,data) VALUES (?,?)', Date.now(), JSON.stringify(record));
    // Analytics Engine only receives compact operational labels, never message
    // text, usernames, image OCR results, or Telegram user IDs.
    try {
      this.env.ANALYTICS?.writeDataPoint({
        indexes: [String(record.chatId || 'global').slice(0, 64)],
        blobs: [String(record.action || 'unknown').slice(0, 100), String(record.outcome || 'pending').slice(0, 32)],
        doubles: [1],
      });
    } catch { /* Metrics must never interrupt moderation. */ }
  }
  async alertOwner(kind, text) {
    const key = `owner-alert:${String(kind).slice(0, 60)}`;
    if (this.read(key, false)) return false;
    const recipients = this.owners().filter(id => /^\d{1,16}$/.test(id));
    if (!recipients.length) return false;
    const tg = telegram(this.env.BOT_TOKEN);
    const message = `⚠️ 机器人运行提醒\n\n${String(text).slice(0, 3400)}\n\n同类提醒 30 分钟内不会重复发送。`;
    const sent = await Promise.allSettled(recipients.map(chatId => tg('sendMessage', { chat_id: Number(chatId), text: message, disable_web_page_preview: true })));
    if(sent.some(item=>item.status==='fulfilled'))this.write(key,true,30*60000);
    this.log({ action: 'owner-alert', outcome: sent.some(item => item.status === 'fulfilled') ? 'success' : 'failed', text: String(kind).slice(0, 100), recipients: recipients.length });
    return sent.some(item => item.status === 'fulfilled');
  }
  async schedule(when) {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > when) await this.ctx.storage.setAlarm(when);
  }
  quietActive(config, time) {
    if (!config.quietEnabled || config.quietStart === config.quietEnd) return false;
    return config.quietStart < config.quietEnd ? time >= config.quietStart && time < config.quietEnd : time >= config.quietStart || time < config.quietEnd;
  }
  quietNotices() {
    const notices=this.read('quiet:notices',[]),legacy=this.read('quiet:notice-message-id');
    if(Number.isSafeInteger(legacy) && !notices.some(x=>x.id===legacy)) notices.push({id:legacy,retryAt:0,attempts:0});
    if(Number.isSafeInteger(legacy)){this.write('quiet:notices',notices);this.remove('quiet:notice-message-id');}
    return notices;
  }
  async clearQuietNotice(tg, chat) {
    if(!chat?.id)return false;
    const notices=this.quietNotices();let deleted=false;
    for(const notice of notices){
      if(notice.retryAt>Date.now())continue;
      try {
        await tg('deleteMessage',{chat_id:chat.id,message_id:notice.id});notice.deleted=true;deleted=true;
        this.log({chatId:chat.id,action:'quiet-notice-delete',messageId:notice.id,outcome:'success'});
      } catch(error){
        if(error.code===400 && /message to delete not found/i.test(error.message)) {notice.deleted=true;deleted=true;this.log({chatId:chat.id,action:'quiet-notice-delete',messageId:notice.id,outcome:'success',alreadyAbsent:true});continue;}
        notice.attempts=(notice.attempts||0)+1;
        notice.retryAt=Date.now()+Math.max(Number(error.retryAfter||0)*1000,error.retryable===false?30*60000:Math.min(30*60000,60000*2**(notice.attempts-1)));
        this.log({chatId:chat.id,messageId:notice.id,action:'quiet-notice-delete',outcome:error.retryable===false?'failed':'retrying',attempts:notice.attempts,nextRetryAt:new Date(notice.retryAt).toISOString(),error:String(error.message||'').slice(0,200)});
      }
    }
    this.write('quiet:notices',notices.filter(x=>!x.deleted));return deleted;
  }
  async quietTick(time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date())) {
    const config = await this.config();
    const shouldMute = this.quietActive(config, time);
    const chat = this.read('chat');
    if (!chat?.id) return false;
    const tg = telegram(this.env.BOT_TOKEN);
    if (this.read('quiet:active', false) === shouldMute) {
      if (!shouldMute) await this.clearQuietNotice(tg, chat);
      return false;
    }
    if (shouldMute) {
      const current = await tg('getChat', { chat_id: chat.id });
      const permissions = current.permissions || { can_send_messages: true, can_send_audios: true, can_send_documents: true, can_send_photos: true, can_send_videos: true, can_send_video_notes: true, can_send_voice_notes: true, can_send_polls: true, can_send_other_messages: true, can_add_web_page_previews: true, can_change_info: false, can_invite_users: true, can_pin_messages: false, can_manage_topics: false };
      if(!this.read('quiet:baseline')) this.write('quiet:baseline', permissions);
      await tg('setChatPermissions', { chat_id: chat.id, permissions: { ...permissions, can_send_messages: false }, use_independent_chat_permissions: true });
    } else {
      const permissions = this.read('quiet:baseline');
      if (!permissions) return false;
      await tg('setChatPermissions', { chat_id: chat.id, permissions, use_independent_chat_permissions: true });
      this.remove('quiet:baseline');
    }
    this.write('quiet:active', shouldMute);
    if (!shouldMute) await this.clearQuietNotice(tg,chat);
    if (config.quietNotify) {
      const text = shouldMute
        ? `🌙 夜间静默通知\n\n为防范深夜诈骗信息及冒充官方账号的错误引导，本群将于北京时间 ${config.quietStart} 至 ${config.quietEnd} 开启静默模式。期间普通成员暂时不能发言，管理员不受影响；到点后将自动恢复。\n\n请勿轻信任何私聊、开户链接、转账或索要验证码的请求。感谢大家的理解与配合。`
        : '☀️ 夜间静默已结束，群聊发言已恢复。请继续警惕私聊诈骗，官方不会私信索要验证码、密码或转账。';
      await tg('sendMessage', { chat_id: chat.id, text, disable_web_page_preview: true })
        .then(result => { if (shouldMute && Number.isSafeInteger(result?.message_id)) {const notices=this.quietNotices();if(!notices.some(x=>x.id===result.message_id))notices.push({id:result.message_id,created:Date.now(),retryAt:0,attempts:0});this.write('quiet:notices',notices);} })
        .catch(error => this.log({ chatId: chat.id, action: 'quiet-notice', outcome: 'failed', error: String(error.message || '').slice(0, 200) }));
    }
    this.log({ chatId: chat.id, chatTitle: chat.title || '', action: shouldMute ? 'quiet-started' : 'quiet-ended', outcome: 'success', reasons: [`北京时间 ${time}`] });
    return true;
  }
  async register(chat) {
    this.sql.exec('INSERT INTO chats VALUES (?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title WHERE title != excluded.title', String(chat.id), String(chat.title || chat.id));
  }
  listChats() { return this.sql.exec('SELECT * FROM chats ORDER BY title COLLATE NOCASE LIMIT 1000').toArray(); }

  bookscapeDraft(body) { return draftPost(this, body); }
  bookscapeInspect(id) { return inspectPost(this, id); }
  bookscapePreview(id) { return previewPost(this, id); }
  bookscapePublish(body) { return publishPost(this, body); }

  async fetch(request) {
    const url = new URL(request.url);
    try {
      let result;
      if (request.method === 'GET' && url.pathname === '/receipt') result = await inspectPost(this, url.searchParams.get('id'));
      else if (request.method === 'POST') {
        const body = await request.json();
        if (url.pathname === '/draft') result = await draftPost(this, body);
        else if (url.pathname === '/preview') result = await previewPost(this, body.id);
        else if (url.pathname === '/publish') result = await publishPost(this, body);
      }
      if (result === undefined) return Response.json({ error: 'Not found' }, { status: 404 });
      return Response.json(result);
    } catch (error) {
      return Response.json({ error: String(error.message || error).slice(0, 300) }, { status: 400 });
    }
  }
  federation() { return this.sql.exec('SELECT chat_id FROM federation WHERE enabled=1 ORDER BY chat_id').toArray().map(row => row.chat_id); }
  setFederation(chatId, enabled) {
    if (!/^-[0-9]{1,16}$/.test(String(chatId))) throw new Error('无效群 ID');
    if (enabled) {this.sql.exec('INSERT OR IGNORE INTO chats VALUES (?,?)',String(chatId),String(chatId));this.sql.exec('INSERT OR REPLACE INTO federation(chat_id,enabled) VALUES (?,1)', String(chatId));}
    else this.sql.exec('DELETE FROM federation WHERE chat_id=?', String(chatId));
    this.log({ action: enabled ? 'federation-join' : 'federation-leave', actorId: 'web-admin', chatId: String(chatId), outcome: 'success' });
    return this.federation();
  }
  federationTargets(sourceChatId) { const chats=this.federation();return chats.includes(String(sourceChatId))?chats.filter(chatId=>chatId!==String(sourceChatId)):[]; }
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

  listSamples() { return this.sql.exec('SELECT id,kind,value,label,created FROM samples ORDER BY id DESC LIMIT 300').toArray().map(row => ({ ...row, status: row.kind==='text' && [...row.value].length<6 ? 'disabled' : this.read(`sample-status:${row.id}`, 'active') })); }
  listReviewExamples(){return this.sql.exec("SELECT value FROM records WHERE key LIKE 'review-example:%' AND expires>? ORDER BY rowid DESC LIMIT 500",Date.now()).toArray().map(x=>JSON.parse(x.value));}
  editReviewExample(action,body){
    if(action==='remove'){this.sql.exec("DELETE FROM records WHERE key LIKE 'sample-preview:%'");this.remove('review-example:'+String(body.id));return this.listReviewExamples();}
    if(!['normal','advertisement'].includes(body.verdict) || body.confirmed!==true)throw new Error('必须人工确认案例分类');
    if(typeof body.text!=='string' || body.text.length>4000)throw new Error('案例内容须为 6–4000 个字符');
    const text=body.text.normalize('NFKC').trim().slice(0,4000)
      .replace(/https?:\/\/[^\s]+/gi,value=>{try{return new URL(value).origin;}catch{return '[链接]';}})
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[邮箱]')
      .replace(/@[a-zA-Z0-9_]{5,}/g,'@user')
      .replace(/\d{7,}/g,'[号码]');
    if(text.length<6)throw new Error('案例至少 6 个字符');
    this.sql.exec("DELETE FROM records WHERE key LIKE 'sample-preview:%'");
    const id=crypto.randomUUID();this.write('review-example:'+id,{id,text,verdict:body.verdict,created:new Date().toISOString()},90*DAY);
    const rows=this.sql.exec("SELECT key FROM records WHERE key LIKE 'review-example:%' ORDER BY rowid DESC LIMIT -1 OFFSET 500").toArray();for(const row of rows)this.remove(row.key);
    return this.listReviewExamples();
  }
  previewSample(id) {
    const sample=this.listSamples().find(x=>x.id===Number(id));if(!sample)throw new Error('样本不存在');
    let reason='';try{validateSample(sample.kind,sample.value,sample.label);}catch(error){reason=error.message;}
    const examples=['有没有服务器推荐？香港节点怎么样？','这个服务器怎么买，有没有官网吗？','我今天赚了钱，准备续费 VPS。','可以私聊发一下官网链接吗？','不要相信日结兼职、稳赚和刷单广告。','手机拍照怎么导出？','频道订阅之后还是无法验证。','感谢分享，官网价格和配置在哪里看？'];
    const matches=examples.filter(text=>sampleMatches({text},[{...sample,status:'active'}]).length);
    const token=crypto.randomUUID();this.write(`sample-preview:${sample.id}`,token,15*60000);
    const cases=this.listReviewExamples().map(item=>({...item,matched:sampleMatches({text:item.text},[{...sample,status:'active'}]).length>0}));
    return {eligible:!reason,reason,examples,matches,cases,previewToken:token};
  }
  testSample(body) { const sample = validateSample(body.kind, body.value, body.label || ''); return { matched: sampleMatches({text:String(body.text || '').slice(0,4000)}, [sample]).length > 0 }; }
  healthSummary() {
    const rows = this.sql.exec("SELECT status,COUNT(*) AS n,MIN(created) AS oldest FROM jobs GROUP BY status").toArray();
    const pending = rows.find(x => x.status === 'pending');
    const overdue=this.sql.exec("SELECT MIN(created) AS oldest FROM jobs WHERE status='pending' AND due<=?",Date.now()).toArray()[0]?.oldest;
    return { overdueSeconds:overdue?Math.round((Date.now()-overdue)/1000):0, pending: pending?.n || 0, failed: rows.find(x => x.status === 'failed')?.n || 0, oldestPendingSeconds: pending ? Math.round((Date.now()-pending.oldest)/1000) : 0, lastCompletion: this.read('health:last-completion') };
  }
  listCases(){return this.sql.exec("SELECT value FROM records WHERE key LIKE 'federation-case:%' AND expires>? ORDER BY rowid DESC LIMIT 100",Date.now()).toArray().map(x=>JSON.parse(x.value));}
  searchCases(filters={}){
    const clauses=["key LIKE 'federation-case:%'",'expires>?'], args=[Date.now()];
    if(filters.chatId){if(!/^-[0-9]+$/.test(String(filters.chatId)))throw new Error('群 ID 无效');clauses.push("EXISTS (SELECT 1 FROM json_each(records.value,'$.groups') g WHERE json_extract(g.value,'$.chatId')=?)");args.push(String(filters.chatId));}
    if(filters.userId){if(!/^\d{1,16}$/.test(String(filters.userId)))throw new Error('用户 ID 无效');clauses.push("CAST(json_extract(value,'$.userId') AS TEXT)=?");args.push(String(filters.userId));}
    if(filters.status){if(!['pending','retrying','success','failed','cancelled','skipped','reversed'].includes(filters.status))throw new Error('记录状态无效');
      if(filters.status==='reversed')clauses.push("json_extract(value,'$.reversed')=1");
      else{clauses.push("EXISTS (SELECT 1 FROM json_each(records.value,'$.groups') g WHERE (json_extract(g.value,'$.status')=? OR json_extract(g.value,'$.undoStatus')=?)"+(filters.chatId?" AND json_extract(g.value,'$.chatId')=?":"")+")");args.push(filters.status,filters.status);if(filters.chatId)args.push(String(filters.chatId));}
    }
    if(filters.before){const before=Number(filters.before);if(!Number.isSafeInteger(before)||before<=0)throw new Error('分页参数无效');clauses.push('rowid<?');args.push(before);}
    const rows=this.sql.exec('SELECT rowid AS cursor,value FROM records WHERE '+clauses.join(' AND ')+' ORDER BY rowid DESC LIMIT 51',...args).toArray();
    return {cases:rows.slice(0,50).map(x=>JSON.parse(x.value)),next:rows.length>50?rows[49].cursor:null};
  }
  ensureCase(body){
    const key=`federation-case:${body.id}`;if(this.read(key))return this.read(key);
    const record={id:body.id,userId:Number(body.userId),sourceChatId:String(body.chatId),sampleIds:body.sampleIds||[],created:new Date().toISOString(),reversed:false,groups:[String(body.chatId),...(body.federationTargets||[]).map(String)].map(chatId=>({chatId,status:'pending',owned:false}))};
    this.write(key,record,90*DAY);return record;
  }
  caseStatus(id,chatId,patch){const key=`federation-case:${id}`,record=this.read(key);if(!record)return;const item=record.groups.find(x=>x.chatId===String(chatId));if(item)Object.assign(item,patch);this.write(key,record,90*DAY);}
  caseReversed(id){return this.read(`federation-case:${id}`)?.reversed===true;}
  async dispatchFederation(id){
    const record=this.read(`federation-case:${id}`);if(!record || record.reversed)return;
    const results=await Promise.allSettled(record.groups.filter(x=>x.chatId!==record.sourceChatId).map(x=>this.env.GUARD_STATE.getByName('chat:'+x.chatId).queueFederation(id,x.chatId,record.userId,record.sourceChatId)));
    if(results.some(x=>x.status==='rejected'))throw new Error('部分联防任务入队失败，正在重试');
  }
  async queueFederation(caseId,chatId,userId,sourceChatId){
    const id=`federation:${caseId}:${chatId}`;
    const plan={ops:[{method:'banChatMember',params:{chat_id:Number(chatId),user_id:userId,until_date:0},trackCase:caseId}],entry:{chatId:String(chatId),userId,sourceChatId,caseId,action:'federation-ban'}};
    await this.schedule(Date.now()+100);this.sql.exec('INSERT OR IGNORE INTO jobs(id,payload,plan,due,created) VALUES (?,?,?,?,?)',id,'{}',JSON.stringify(plan),Date.now(),Date.now());
  }
  async retryCase(id,chatId){const record=this.read(`federation-case:${id}`);if(!record || record.reversed || !record.groups.some(x=>x.chatId===String(chatId)))throw new Error('联防记录无效或已撤销');return this.env.GUARD_STATE.getByName('chat:'+chatId).retryJob(String(chatId)===record.sourceChatId?id.slice(String(chatId).length+1):`federation:${id}:${chatId}`);}
  async reverseCase(id){
    const key=`federation-case:${id}`,record=this.read(key);if(!record)throw new Error('此记录没有可核验的联防封禁信息');
    record.reversed=true;this.write(key,record,90*DAY);
    for(const sampleId of record.sampleIds){if(this.listSamples().some(x=>x.id===sampleId))await this.editSample('disable',{id:sampleId});}
    const results=await Promise.allSettled(record.groups.map(x=>this.env.GUARD_STATE.getByName('chat:'+x.chatId).queueCaseUndo(id,x.chatId,record.userId)));
    this.log({action:'federation-undo-request',caseId:id,userId:record.userId,actorId:'web-admin',outcome:results.some(x=>x.status==='rejected')?'partial':'success'});
    return {queued:results.filter(x=>x.status==='fulfilled').length,failed:results.filter(x=>x.status==='rejected').length,record:this.read(key)};
  }
  async queueCaseUndo(caseId,chatId,userId){
    const id=`undo:${caseId}:${chatId}`,plan={ops:[{local:'case-unban',caseId,userId,chatId}],entry:{action:'federation-undo',caseId,chatId:String(chatId),userId,actorId:'web-admin'}};
    await this.schedule(Date.now()+100);this.sql.exec('INSERT OR IGNORE INTO jobs(id,payload,plan,due,created) VALUES (?,?,?,?,?)',id,'{}',JSON.stringify(plan),Date.now(),Date.now());
    this.sql.exec("UPDATE jobs SET status='pending',attempts=0,due=?,created=? WHERE id=? AND status='failed'",Date.now(),Date.now(),id);
  }
  async queueReview(chatId,userId,messageId) {
    const tg=telegram(this.env.BOT_TOKEN), member=await this.member(tg,Number(chatId),userId);
    if(ADMIN_STATUS.includes(member.status) || this.owners().includes(String(userId))) throw new Error('不能处理群管理员或机器人所有者');
    const targets=await this.env.GUARD_STATE.getByName('admin').federationTargets(chatId);
    const ops=[{method:'deleteMessage',params:{chat_id:Number(chatId),message_id:messageId}},{method:'banChatMember',params:{chat_id:Number(chatId),user_id:userId,until_date:0}}];
    const id=`review:${chatId}:${messageId}:${userId}`;
    await this.schedule(Date.now()+100);
    this.sql.exec('INSERT OR IGNORE INTO jobs(id,payload,plan,due,created) VALUES (?,?,?,?,?)',id,'{}',JSON.stringify({ops,entry:{chatId,actorId:'web-admin',userId:String(userId),messageId,action:'review-resolve-ban',federationTargets:targets}}),Date.now(),Date.now());
    return {ok:true,queued:true,federationTargets:targets.length};
  }
  async retryJob(id) {
    const job=this.sql.exec("SELECT * FROM jobs WHERE id=? AND status='failed'", String(id)).toArray()[0];
    if (!job?.plan) throw new Error('没有可重试的执行计划');
    this.sql.exec("UPDATE jobs SET status='pending',attempts=0,due=?,created=? WHERE id=?",Date.now(),Date.now(),job.id);
    await this.schedule(Date.now()+100); return {ok:true,queued:true};
  }
  // Groups cache the sample list (see cachedSamples); tell them to drop it so
  // an edit takes effect on the next message rather than after the cache ages out.
  async broadcastSamplesChanged() {
    await Promise.allSettled(this.listChats().map(chat => this.env.GUARD_STATE.getByName('chat:' + chat.id).invalidateSamples()));
  }
  async editSample(action, body) {
    const result = await this.applySampleEdit(action, body);
    // New samples start as pending and do not match until activated.
    if (action !== 'add') await this.broadcastSamplesChanged();
    return result;
  }
  async applySampleEdit(action, body) {
    if (action === 'remove') { this.sql.exec('DELETE FROM samples WHERE id=?', Number(body.id)); return this.listSamples(); }
    if (action === 'activate' || action === 'disable') {
      if (!this.sql.exec('SELECT id FROM samples WHERE id=?', Number(body.id)).toArray().length) throw new Error('样本不存在');
      if(action==='activate'){const sample=this.listSamples().find(x=>x.id===Number(body.id));validateSample(sample.kind,sample.value,sample.label);if(!body.previewToken || this.read(`sample-preview:${sample.id}`)!==body.previewToken)throw new Error('请先预览样本命中结果，再启用');this.remove(`sample-preview:${sample.id}`);}
      this.write(`sample-status:${Number(body.id)}`, action === 'activate' ? 'active' : 'disabled');
      this.log({action:'sample-'+action,actorId:'web-admin',outcome:'success',sampleId:Number(body.id)}); return this.listSamples();
    }
    const sample = validateSample(body.kind, body.value, body.label,body.pending===true);
    const existing=this.sql.exec('SELECT id FROM samples WHERE kind=? AND value=?',sample.kind,sample.value).toArray()[0];
    this.sql.exec('INSERT OR IGNORE INTO samples(kind,value,label,created) VALUES (?,?,?,?)', sample.kind, sample.value, sample.label, Date.now());
    const row=this.sql.exec('SELECT id FROM samples WHERE kind=? AND value=?',sample.kind,sample.value).toArray()[0];
    if (!existing) this.write(`sample-status:${row.id}`, 'pending');
    this.log({ action: 'sample-add', actorId: 'web-admin', sample: sample.kind, text: sample.value, outcome: 'success' });
    return this.listSamples();
  }

  async runQuietMaintenance() {
    const chats = this.listChats();
    const attempts = await Promise.allSettled(chats.map(chat => this.env.GUARD_STATE.getByName(`chat:${chat.id}`).quietTick()));
    const switched = attempts.filter(item => item.status === 'fulfilled' && item.value === true).length;
    const failed = attempts.filter(item => item.status === 'rejected').length;
    if (failed) this.log({ action: 'quiet-maintenance', outcome: 'failed', errors: failed });
    return { checked: chats.length, switched, failed };
  }
  async cachedSamples() {
    if (this.samplesCache && this.samplesCache.at > Date.now() - 60000) return this.samplesCache.rules;
    const rules = await this.env.GUARD_STATE.getByName('admin').listSamples();
    this.samplesCache = { at: Date.now(), rules };
    return rules;
  }
  invalidateSamples() { this.samplesCache = null; }
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

  async enqueue(update) {
    // Register with the global admin object only when the title changes (and
    // at least daily), instead of on every message, so group traffic does not
    // all funnel through that single object.
    const chat = (update.message || update.edited_message || update.callback_query?.message)?.chat;
    const title = chat ? String(chat.title || chat.id) : null;
    if (title !== null && this.read('registered-title') !== title) {
      await this.env.GUARD_STATE.getByName('admin').register(chat);
      this.write('registered-title', title, DAY);
    }
    // Schedule before acknowledging durable receipt; an alarm survives request termination.
    await this.schedule(Date.now() + 200);
    const id = `u:${update.update_id}`;
    this.sql.exec('INSERT OR IGNORE INTO jobs(id,payload,due,created) VALUES (?,?,?,?)', id, JSON.stringify(update), Date.now(), Date.now());
    return { accepted: true };
  }
  async alarm() {
    if (this.running) { await this.schedule(Date.now() + 1000); return; }
    this.running = true;
    try {
      await this.ctx.storage.setAlarm(Date.now() + 60000);
      const started = Date.now();
      for(let n=0;n<5;n++){const rescue=this.sql.exec("SELECT * FROM jobs WHERE status='pending' AND id LIKE 'verification-release:%' AND due<=? ORDER BY rowid LIMIT 1",Date.now()).toArray()[0];if(!rescue)break;await this.runJob(rescue);}
      for (let n = 0; n < 10 && Date.now() - started < 20000; n++) {
        // Keep each group's processing order across retries. Otherwise a later warning
        // could be overwritten by a previously planned event that was rate-limited.
        const job = this.sql.exec("SELECT * FROM jobs WHERE status='pending' AND id NOT LIKE 'verification-release:%' AND ((id NOT LIKE 'verification-timeout:%' AND id NOT LIKE 'federation:%' AND id NOT LIKE 'undo:%' AND id NOT LIKE 'verification-release:%') OR due<=?) ORDER BY rowid LIMIT 1",Date.now()).toArray()[0];
        if (!job || job.due > Date.now()) break;
        await this.runJob(job);
      }
      const expired=this.sql.exec("SELECT user_id,prompt_message_id,mode,expires FROM verifications WHERE expires<=? AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.id='verification-timeout:' || verifications.user_id || ':' || verifications.expires) LIMIT 50",Date.now()).toArray();
      const chat=this.read('chat');
      if(chat?.id)for(const pending of expired){
        const id=`verification-timeout:${pending.user_id}:${pending.expires}`;
        if(this.sql.exec('SELECT id FROM jobs WHERE id=?',id).toArray().length)continue;
        const ops=[{method:'banChatMember',params:{chat_id:chat.id,user_id:Number(pending.user_id),until_date:0}}, {local:'clearVerification',userId:pending.user_id,expires:pending.expires}];
        if(pending.prompt_message_id)ops.push({method:'deleteMessage',params:{chat_id:chat.id,message_id:pending.prompt_message_id}});
        const plan={ops,entry:{chatId:chat.id,chatTitle:chat.title||'',userId:pending.user_id,action:'verification-timeout-ban',reasons:['未在验证时限内完成验证']}};
        this.sql.exec('INSERT OR IGNORE INTO jobs(id,payload,plan,due,created) VALUES (?,?,?,?,?)',id,'{}',JSON.stringify(plan),Date.now(),Date.now());
        const job=this.sql.exec('SELECT * FROM jobs WHERE id=?',id).toArray()[0];await this.runJob(job);
      }
      this.sql.exec('DELETE FROM records WHERE expires<=?', Date.now());
      this.sql.exec("DELETE FROM jobs WHERE status!='pending' AND created<?", Date.now() - 7 * DAY);
      this.sql.exec('DELETE FROM logs WHERE ts<?', Date.now() - 30 * DAY);
      this.sql.exec('DELETE FROM member_profiles WHERE seen<?',Date.now()-90*DAY);
      await this.quietTick().catch(error => this.log({ action: 'quiet-switch', outcome: 'failed', error: String(error.message || '').slice(0, 200) }));
    } finally {
      this.running = false;
      const next = this.sql.exec("SELECT due FROM jobs WHERE status='pending' AND id NOT LIKE 'verification-timeout:%' AND id NOT LIKE 'federation:%' AND id NOT LIKE 'undo:%' AND id NOT LIKE 'verification-release:%' ORDER BY rowid LIMIT 1").toArray()[0]?.due;
      const timeoutDue=this.sql.exec("SELECT MIN(due) AS due FROM jobs WHERE status='pending' AND (id LIKE 'verification-timeout:%' OR id LIKE 'federation:%' OR id LIKE 'undo:%' OR id LIKE 'verification-release:%')").toArray()[0]?.due;
      const verificationDue = this.sql.exec("SELECT expires FROM verifications WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.id='verification-timeout:' || verifications.user_id || ':' || verifications.expires) ORDER BY expires LIMIT 1").toArray()[0]?.expires;
      const due = [next, timeoutDue, verificationDue].filter(value => Number.isFinite(value)).sort((a, b) => a - b)[0];
      const config = await this.config();
      const fallback = (config.quietEnabled || this.read('quiet:active',false) || this.quietNotices().length) ? Date.now() + 60000 : Date.now() + DAY;
      await this.ctx.storage.setAlarm(due === undefined ? fallback : Math.max(Date.now() + 100, due));
    }
  }
  async runJob(job) {
    let plan = job.plan ? JSON.parse(job.plan) : null;
    if(job.id.startsWith('verification-timeout:') && !plan?.ops?.[0]?.done){
      const clear=plan?.ops?.find(x=>x.local==='clearVerification');
      if(!clear || this.verification(clear.userId)?.expires!==clear.expires){
        this.sql.exec("UPDATE jobs SET status='done',payload='{}',plan=NULL WHERE id=?",job.id);
        this.log({...plan?.entry,outcome:'cancelled',reasons:['验证状态已变更，旧超时任务不再执行']});return;
      }
    }

    try {
      if (!plan) {
        const update = JSON.parse(job.payload);
        plan = update.callback_query ? await this.callbackPlan(update.callback_query) : await this.plan(update);
        // No await between state decisions and recording the plan.
        this.sql.exec('UPDATE jobs SET plan=? WHERE id=?', JSON.stringify(plan), job.id);
      }
      if(plan.entry?.federationTargets?.length && !plan.entry.caseId){
        const caseId=`${plan.entry.chatId}:${job.id}`;plan.entry.caseId=caseId;
        plan.ops=plan.ops.filter(x=>x.method!=='banChatMember'||String(x.params.chat_id)===String(plan.entry.chatId));
        for(const op of plan.ops)if(op.method==='banChatMember')op.trackCase=caseId;
        plan.ops.unshift({local:'case-register',body:{...plan.entry,id:caseId}});plan.ops.push({local:'federation-dispatch',caseId});
        this.sql.exec('UPDATE jobs SET plan=? WHERE id=?',JSON.stringify(plan),job.id);
      }
      const tg = telegram(this.env.BOT_TOKEN);
      if(job.id.startsWith('federation:') && await this.env.GUARD_STATE.getByName('admin').caseReversed(plan.entry.caseId)){
        this.sql.exec("UPDATE jobs SET status='done',payload='{}',plan=NULL WHERE id=?",job.id);
        await this.env.GUARD_STATE.getByName('admin').caseStatus(plan.entry.caseId,plan.entry.chatId,{status:'cancelled'});return;
      }
      for (const op of plan.ops) {
        if (op.done) continue;
        if(plan.recovery && JSON.stringify(this.memberBan(plan.recovery.userId))!==JSON.stringify(plan.recovery.ban)){throw Object.assign(Error('成员已有新的处罚，验证解封已停止，请重新核对'),{retryable:false});}
        if(op.method==='banChatMember'&&job.id.startsWith('verification-timeout:')&&!this.verification(op.params.user_id)){op.skipped='验证已由管理员通过';op.done=true;continue;}
        if(op.verificationPromptFor&&!this.verification(op.verificationPromptFor)){op.skipped='验证已完成，不发送旧验证提示';op.done=true;continue;}
        if(op.method==='restrictChatMember'&&plan.entry?.action==='welcome-and-verification-started'&&!this.verification(op.params.user_id)){op.skipped='验证已完成';op.done=true;continue;}
        if(op.local==='verification-release-complete'){this.write(`verification-pass:${op.userId}`,true,DAY);this.write(`member-ban:${op.userId}`,{action:'verification-released',jobId:job.id});plan.recovery.ban=this.memberBan(op.userId);
        } else if(op.local==='case-register'){await this.env.GUARD_STATE.getByName('admin').ensureCase(op.body);
        } else if(op.local==='federation-dispatch'){await this.env.GUARD_STATE.getByName('admin').dispatchFederation(op.caseId);
        } else if(op.local==='case-unban'){
          if(this.read(`ban-owner:${op.userId}`)===op.caseId){await tg('unbanChatMember',{chat_id:Number(op.chatId),user_id:Number(op.userId),only_if_banned:true});this.remove(`ban-owner:${op.userId}`);this.write(`member-ban:${op.userId}`,{action:'unbanned',jobId:job.id});op.undoOutcome='success';}
          else {op.skipped='没有本次封禁的所有权，保留其他封禁';op.undoOutcome='skipped';}
        } else if(op.local==='clearVerification'){
          if(this.verification(op.userId)?.expires===op.expires)this.clearVerification(op.userId);
        } else if (op.local === 'sample') {
          await this.env.GUARD_STATE.getByName('admin').editSample('add',op.sample);
        } else if (op.local === 'warning') {
          if (!this.read(`offence:${op.messageId}`)) {
            this.write(`warn:${op.userId}`, op.count, DAY);
            this.write(`offence:${op.messageId}`, true, DAY);
          }
        } else if (op.local === 'processed') {
          this.write(`offence:${op.messageId}`, true, DAY);
        } else {
          // A retry must never turn an expired temporary mute into a permanent restriction.
          if (op.method === 'restrictChatMember' && op.params.until_date && op.params.until_date < Date.now() / 1000 + 35) {
            op.skipped = '临时禁言时段已过';
          } else {
            try {
              if(op.trackCase){
                if(op.previouslyBanned===undefined){const member=await this.member(tg,op.params.chat_id,op.params.user_id);if(ADMIN_STATUS.includes(member.status)||this.owners().includes(String(op.params.user_id))) {op.skipped='目标是管理员或所有者';}op.previouslyBanned=member.status==='kicked';this.sql.exec('UPDATE jobs SET plan=? WHERE id=?',JSON.stringify(plan),job.id);}
                if(await this.env.GUARD_STATE.getByName('admin').caseReversed(op.trackCase))op.skipped='联防记录已撤销';
              }
              if(op.recoveryRestore){const fresh=await this.restoreMember(op.params.chat_id,op.params.user_id,tg);op.params=fresh.params;if(JSON.stringify(this.memberBan(plan.recovery.userId))!==JSON.stringify(plan.recovery.ban))throw Object.assign(Error('成员已有新的处罚，验证解封已停止'),{retryable:false});}
              if(!op.skipped){op.result = await tg(op.method, op.params);
                if(op.method==='banChatMember'){this.write(`member-ban:${op.params.user_id}`,{action:plan.entry?.action||'ban',jobId:job.id});if(op.trackCase && !op.previouslyBanned)this.write(`ban-owner:${op.params.user_id}`,op.trackCase);else this.remove(`ban-owner:${op.params.user_id}`);}
                if(op.method==='unbanChatMember'){this.remove(`ban-owner:${op.params.user_id}`);if(!plan.recovery)this.write(`member-ban:${op.params.user_id}`,{action:'unbanned',jobId:job.id});}
              }
              if (op.verificationPromptFor && Number.isSafeInteger(op.result?.message_id)) this.sql.exec('UPDATE verifications SET prompt_message_id=? WHERE user_id=?', op.result.message_id, String(op.verificationPromptFor));
            }
            catch (error) {
              if (op.method === 'deleteMessage' && error.code === 400 && /message to delete not found/i.test(error.message)) op.result = { alreadyAbsent: true };
              else throw error;
            }
          }
        }
        op.done = true;op.doneAt=Date.now();
        this.sql.exec('UPDATE jobs SET plan=? WHERE id=?', JSON.stringify(plan), job.id);
        if(op.trackCase)await this.env.GUARD_STATE.getByName('admin').caseStatus(op.trackCase,op.params.chat_id,{status:op.skipped?'skipped':'success',error:null,owned:this.read(`ban-owner:${op.params.user_id}`)===op.trackCase});
      }
      for(const op of plan.ops.filter(x=>x.trackCase))await this.env.GUARD_STATE.getByName('admin').caseStatus(op.trackCase,op.params.chat_id,{status:op.skipped?'skipped':'success',error:null,owned:this.read(`ban-owner:${op.params.user_id}`)===op.trackCase});
      for(const op of plan.ops.filter(x=>x.local==='case-unban'))await this.env.GUARD_STATE.getByName('admin').caseStatus(op.caseId,op.chatId,{undoStatus:op.undoOutcome});
      this.write('health:last-completion',{at:new Date().toISOString(),latencyMs:Date.now()-job.created});
      if (plan.entry) this.log({ ...plan.entry, updateId:job.id, latencyMs:Date.now()-job.created, outcome: plan.ops.some(x => x.skipped) ? 'partial' : 'success', steps: plan.ops.map(x => ({ method: x.method || x.local, done: x.done, skipped: x.skipped, undoOutcome:x.undoOutcome, doneAt:x.doneAt })) });
      this.sql.exec("UPDATE jobs SET status='done',payload='{}',plan=NULL WHERE id=?", job.id);
    } catch (error) {
      if(job.id.startsWith('verification-timeout:') && error.code===403){error.retryable=true;error.retryAfter=1800;}
      const attempts = job.attempts + 1;
      const retry = error.retryable !== false && attempts < 6 && Date.now() - job.created < DAY;
      const tracked=plan?.ops?.find(x=>x.trackCase && String(x.params.chat_id)===String(plan.entry?.chatId));
      if(plan?.entry?.caseId)await this.env.GUARD_STATE.getByName('admin').caseStatus(plan.entry.caseId,plan.entry.chatId,plan.entry.action==='federation-undo'?{undoStatus:retry?'retrying':'failed'}:tracked?.done?{status:tracked.skipped?'skipped':'success',owned:this.read(`ban-owner:${tracked.params.user_id}`)===tracked.trackCase,dispatchError:String(error.message||'').slice(0,200)}:{status:retry?'retrying':'failed',error:String(error.message||'').slice(0,200)}).catch(()=>{});
      const delay = Math.max(Number(error.retryAfter || 0) * 1000, Math.min(300000, 2000 * 2 ** attempts));
      this.sql.exec('UPDATE jobs SET attempts=?,status=?,due=? WHERE id=?', attempts, retry ? 'pending' : 'failed', Date.now() + delay, job.id);
      const failedUpdate = JSON.parse(job.payload); const msg = failedUpdate.message || failedUpdate.edited_message || failedUpdate.callback_query?.message;
      this.log({ ...(plan?.entry || {}), chatId: plan?.entry?.chatId || msg?.chat?.id, userId: plan?.entry?.userId || msg?.from?.id, action: plan?.entry?.action || '处理消息', outcome: retry ? 'retrying' : 'failed', error: String(error.message || 'unknown error').slice(0, 400), updateId: job.id, attempts, steps: plan?.ops.map(x => ({ method: x.method || x.local, done: !!x.done, skipped:x.skipped, undoOutcome:x.undoOutcome, doneAt:x.doneAt })) || [] });
      // Permanent failures remain visible without retaining full incoming messages indefinitely.
      if (!retry) {
        this.sql.exec("UPDATE jobs SET payload='{}' WHERE id=?", job.id);
        await this.env.GUARD_STATE.getByName('admin').alertOwner('telegram-operation-failure', `Telegram 操作连续失败，已停止重试\n群：${msg?.chat?.title || msg?.chat?.id || '未知'}\n操作：${plan?.entry?.action || '未知'}\n原因：${String(error.message || '未知错误').slice(0, 300)}`).catch(() => {});
      }
    }
  }

  async config() {
    const config = this.read('config');
    if (config) {
      const merged = { ...DEFAULT_POLICY, ...config, keywords: Array.isArray(config.keywords) ? config.keywords : DEFAULT_KEYWORDS };
      if (JSON.stringify(merged) !== JSON.stringify(config)) this.write('config', merged);
      return merged;
    }
    const legacy = await this.env.BOT_KV.get('keywords', 'json');
    const initial = { keywords: Array.isArray(legacy) ? legacy.filter(w => typeof w === 'string' && w.trim() && w.length <= 80).slice(0, 500) : DEFAULT_KEYWORDS, ...DEFAULT_POLICY };
    // Another RPC may have completed initialization while KV was being read.
    const winner = this.read('config');
    if (winner) return winner;
    this.write('config', initial);
    return initial;
  }
  owners() { return (this.env.ADMIN_IDS || '').split(',').map(x => x.trim()).filter(Boolean); }
  async me(tg) {
    let me = this.read('me');
    if (!me) { me = await tg('getMe'); this.write('me', me, 3600000); }
    return me;
  }
  async member(tg, chatId, userId) {
    return tg('getChatMember', { chat_id: chatId, user_id: userId });
  }
  verificationPermissions() {
    return { can_send_messages: true, can_send_audios: false, can_send_documents: false, can_send_photos: false, can_send_videos: false, can_send_video_notes: false, can_send_voice_notes: false, can_send_polls: false, can_send_other_messages: false, can_add_web_page_previews: false, can_change_info: false, can_invite_users: false, can_pin_messages: false, can_manage_topics: false };
  }
  verificationMode(config) { return ['math', 'channel'].includes(config.verificationMode) ? config.verificationMode : 'off'; }
  rememberMember(user) {
    if (!Number.isSafeInteger(user?.id) || user.id<=0 || user.is_bot) return;
    this.sql.exec('INSERT INTO member_profiles VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET username=excluded.username,name=excluded.name,seen=excluded.seen',String(user.id),String(user.username||'').toLowerCase(),[user.first_name,user.last_name].filter(Boolean).join(' ').slice(0,120),Date.now());
  }
  memberBan(userId) {
    const marker=this.read(`member-ban:${userId}`);
    if(marker)return ['unbanned','verification-released'].includes(marker.action)?null:marker;
    // Compatibility with bans made before member recovery was introduced.
    const rows=this.sql.exec("SELECT id,data FROM logs WHERE CAST(json_extract(data,'$.userId') AS TEXT)=? ORDER BY id DESC LIMIT 100",String(userId)).toArray();
    for(const row of rows){const log=JSON.parse(row.data);const steps=log.steps||[];
      if(steps.some(x=>x.method==='unbanChatMember'&&x.done&&!x.skipped))return null;
      if(steps.some(x=>x.method==='banChatMember'&&x.done&&!x.skipped) || (!log.steps&&log.outcome==='success'&&log.action==='verification-timeout-ban'))return {action:log.action,jobId:log.updateId||'legacy:'+row.id};
    }
    return null;
  }
  verificationMembers(query='') {
    const raw=String(query).trim();if(raw && !/^@?[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(raw)&&!/^\d{1,16}$/.test(raw))throw Error('请输入完整用户名（@username）或数字用户 ID');
    const ids=new Set();
    if(/^\d+$/.test(raw))ids.add(raw);
    else if(raw){for(const row of this.sql.exec('SELECT user_id FROM member_profiles WHERE username=?',raw.replace(/^@/,'').toLowerCase()).toArray())ids.add(row.user_id);}
    else {
      for(const row of this.sql.exec('SELECT user_id FROM verifications LIMIT 200').toArray())ids.add(row.user_id);
      for(const row of this.sql.exec("SELECT key FROM records WHERE key LIKE 'verification-release:%' AND expires>? ORDER BY rowid DESC LIMIT 200",Date.now()).toArray())ids.add(row.key.slice('verification-release:'.length));
      for(const row of this.sql.exec("SELECT DISTINCT CAST(json_extract(data,'$.userId') AS TEXT) AS user_id FROM logs WHERE json_extract(data,'$.action')='verification-timeout-ban' ORDER BY id DESC LIMIT 200").toArray())if(/^\d+$/.test(row.user_id))ids.add(row.user_id);
    }
    const chat=this.read('chat',{}),result=[];
    for(const userId of ids){const pending=this.verification(userId),ban=this.memberBan(userId),release=this.read(`verification-release:${userId}`),profile=this.sql.exec('SELECT * FROM member_profiles WHERE user_id=?',userId).toArray()[0]||{};
      if(!pending&&ban?.action!=='verification-timeout-ban'&&!release)continue;
      const job=release?this.sql.exec('SELECT status,plan FROM jobs WHERE id=?',release).toArray()[0]:null;
      const lastError=job?.status==='failed'||job?.status==='pending'?this.sql.exec("SELECT json_extract(data,'$.error') AS error FROM logs WHERE json_extract(data,'$.updateId')=? ORDER BY id DESC LIMIT 1",release).toArray()[0]?.error:null;
      result.push({error:lastError||null,chatId:String(chat.id||''),chatTitle:chat.title||'',userId,username:profile.username||'',name:profile.name||'',state:job?.status==='pending'?'processing':job?.status==='failed'?'failed':pending?'pending':ban?.action==='verification-timeout-ban'?'timeout': 'released',expires:pending?.expires||null,jobId:release||null,canRelease:job?.status!=='pending'&&(!!pending||ban?.action==='verification-timeout-ban'||(job?.status==='failed'&&JSON.stringify(JSON.parse(job.plan||'{}').recovery?.ban)===JSON.stringify(ban)))});
    }
    return result;
  }
  async findVerificationMembers(query='') {
    if(String(query).trim()&&!/^@?[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(String(query).trim())&&!/^\d{1,16}$/.test(String(query).trim()))throw Error('请输入完整用户名（@username）或数字用户 ID');
    const chats=await this.listChats(),members=[],errors=[];
    for(let i=0;i<chats.length;i+=10){const batch=chats.slice(i,i+10);const results=await Promise.allSettled(batch.map(chat=>this.env.GUARD_STATE.getByName('chat:'+chat.id).verificationMembers(query)));
      results.forEach((r,n)=>{if(r.status==='fulfilled')members.push(...r.value.map(x=>({...x,chatId:batch[n].id,chatTitle:batch[n].title})));else errors.push(batch[n].title);});
    }
    return {members:members.slice(0,300),truncated:members.length>300,errors};
  }
  async releaseVerification(chatId,userId,actor='web-admin') {
    if(!/^\d{1,16}$/.test(String(userId))||!Number.isSafeInteger(Number(userId))||Number(userId)<=0)throw Error('用户 ID 无效');
    userId=String(userId);const tg=telegram(this.env.BOT_TOKEN),status=await this.member(tg,Number(chatId),Number(userId));
    if(ADMIN_STATUS.includes(status.status)||this.owners().includes(userId))throw Error('该成员是管理员，无需验证解封');
    const pending=this.verification(userId),ban=this.memberBan(userId);
    if(ban&&ban.action!=='verification-timeout-ban')throw Error('该成员存在广告或其他封禁，请在对应处罚记录中处理，不能用验证入口解除');
    const existing=this.read(`verification-release:${userId}`);
    const previous=existing?this.sql.exec('SELECT status,plan FROM jobs WHERE id=?',existing).toArray()[0]:null;
    if(previous?.status==='failed'&&JSON.stringify(JSON.parse(previous.plan||'{}').recovery?.ban)===JSON.stringify(ban))return {...await this.retryJob(existing),id:existing};
    if(!pending&&ban?.action!=='verification-timeout-ban'&&previous?.status!=='pending')throw Error('未找到该成员的验证隔离或超时封禁记录');
    if(existing&&this.sql.exec("SELECT id FROM jobs WHERE id=? AND status='pending'",existing).toArray().length)return {queued:true,id:existing};
    const restore=status.status==='restricted'?await this.restoreMember(Number(chatId),userId,tg):null;
    // Awaited permission reads may allow moderation to advance: never release a newer ban.
    if(JSON.stringify(this.memberBan(userId))!==JSON.stringify(ban)||this.verification(userId)?.expires!==pending?.expires)throw Error('成员状态已变化，请重新搜索后操作');
    const id='verification-release:'+crypto.randomUUID(),ops=[];
    if(status.status==='kicked')ops.push({method:'unbanChatMember',params:{chat_id:Number(chatId),user_id:Number(userId),only_if_banned:true}});
    if(restore)ops.push({...restore,recoveryRestore:true});
    if(pending?.prompt_message_id)ops.push({method:'deleteMessage',params:{chat_id:Number(chatId),message_id:pending.prompt_message_id}});
    ops.push({local:'verification-release-complete',userId});
    const plan={ops,recovery:{userId,ban},entry:{chatId:Number(chatId),userId,actorId:actor,action:'verification-manual-release',reasons:['管理员手动通过验证，24 小时内允许免验证重新加入一次']}};
    await this.schedule(Date.now()+200);
    if(JSON.stringify(this.memberBan(userId))!==JSON.stringify(ban)||this.verification(userId)?.expires!==pending?.expires)throw Error('成员状态已变化，请重新搜索');
    this.clearVerification(userId);
    this.sql.exec("UPDATE jobs SET status='done',payload='{}',plan=NULL WHERE status='pending' AND id LIKE ?",'verification-timeout:'+userId+':%');
    this.sql.exec('INSERT INTO jobs(id,payload,plan,due,created) VALUES (?,?,?,?,?)',id,'{}',JSON.stringify(plan),Date.now(),Date.now());
    this.write(`verification-release:${userId}`,id,30*DAY);
    this.log({...plan.entry,outcome:'queued',updateId:id});return {queued:true,id};
  }
  async startVerification(member, msg, config, tg, forceMath = false) {
    const pass=this.read(`verification-pass:${member.id}`);
    if(pass){this.remove(`verification-pass:${member.id}`);return null;}
    const mode = forceMath ? 'math' : this.verificationMode(config);
    if (mode === 'off' || member.is_bot) return null;
    const status = await this.member(tg, msg.chat.id, member.id);
    if (ADMIN_STATUS.includes(status.status) || this.owners().includes(String(member.id))) return null;
    const expires = Date.now() + Math.max(1, Math.min(60, Number(config.verificationMinutes || 10))) * 60000;
    let answer = null, text;
    if (mode === 'math') {
      const left = 2 + Math.floor(Math.random() * 8), right = 1 + Math.floor(Math.random() * 8);
      answer = String(left + right);
      text = `🛡 新成员验证\n请在 ${Math.round((expires - Date.now()) / 60000)} 分钟内发送答案：${left} + ${right} = ?\n验证期间仅可发送文字；超时将自动封禁。`;
    } else {
      const channel = String(config.verificationChannel || '').trim();
      if (!/^@[a-zA-Z0-9_]{5,}$/.test(channel)) return null;
      text = `🛡 新成员验证\n欢迎 ${String(member.first_name || '新朋友').slice(0,40)}！为防止广告账号，请完成以下两步：\n\n① 点击下方第一个按钮，打开 ${channel}，在频道底部点击“加入 / Join”。\n② 返回本群，点击“已加入，完成验证”，即可恢复正常发言。\n\n已订阅的用户可直接点击第二个按钮。\n请在 ${Math.max(1,Math.round((expires-Date.now())/60000))} 分钟内完成；超时将自动封禁。`;
    }
    this.sql.exec('INSERT OR REPLACE INTO verifications(user_id,answer,prompt_message_id,expires,mode,channel) VALUES (?,?,?,?,?,?)', String(member.id), answer, null, expires, mode, mode === 'channel' ? config.verificationChannel.trim() : null);
    return { member, mode, text, expires, channel: config.verificationChannel?.trim() || '' };
  }
  verification(userId) { return this.sql.exec('SELECT * FROM verifications WHERE user_id=?', String(userId)).toArray()[0]; }
  clearVerification(userId) { this.sql.exec('DELETE FROM verifications WHERE user_id=?', String(userId)); }
  async restoreMember(chatId, userId, tg) {
    const chat = await tg('getChat', { chat_id: chatId });
    if (!chat.permissions) throw new Error('无法读取群默认权限，未解除验证限制');
    return { method: 'restrictChatMember', params: { chat_id: chatId, user_id: Number(userId), permissions: chat.permissions, use_independent_chat_permissions: true } };
  }
  async privileged(tg, chatId, userId) {
    if (this.owners().includes(String(userId))) return true;
    // Do not interpret an API error as "not an admin".
    return ADMIN_STATUS.includes((await this.member(tg, chatId, userId)).status);
  }
  async plan(update) {
    const empty = { ops: [] };
    const msg = update.message || update.edited_message;
    if (!msg || !['group','supergroup'].includes(msg.chat?.type)) return empty;
    const tg = telegram(this.env.BOT_TOKEN);
    const chatId = msg.chat.id;
    this.write('chat', msg.chat);
    this.rememberMember(msg.from);
    for(const user of msg.new_chat_members||[])this.rememberMember(user);
    this.rememberMember(msg.reply_to_message?.from);
    if (msg.new_chat_members) {
      for (const member of msg.new_chat_members) this.write(`join:${member.id}`, Date.now(), DAY);
      const config = await this.config();
      const recentJoins = this.read('raid:joins', []).filter(at => at > Date.now() - 5 * 60000);
      for (const member of msg.new_chat_members) if (!member.is_bot) recentJoins.push(Date.now());
      this.write('raid:joins', recentJoins.slice(-100), 5 * 60000);
      const raidStarted = config.raidEnabled && recentJoins.length >= config.raidJoinLimit;
      if (raidStarted) this.write('raid:until', Date.now() + config.raidMinutes * 60000, config.raidMinutes * 60000);
      const raidActive = this.read('raid:until', 0) > Date.now();
      const names = msg.new_chat_members.filter(member => !member.is_bot).map(member => [member.first_name, member.last_name].filter(Boolean).join(' ') || '新成员');
      const message = [config.welcomeMessage && config.welcomeMessage.replaceAll('{name}', names.join('、')).replaceAll('{group}', msg.chat.title || ''), config.rulesMessage && `群规：${config.rulesMessage}`].filter(Boolean).join('\n\n').slice(0, 4000);
      const ops = message ? [{ method: 'sendMessage', params: { chat_id: chatId, text: message } }] : [];
      const started = [];
      for (const member of msg.new_chat_members) {
        const verification = await this.startVerification(member, msg, config, tg, raidActive && this.verificationMode(config) === 'off');
        if (!verification) continue;
        started.push(member.id);
        ops.push({ method: 'restrictChatMember', params: { chat_id: chatId, user_id: member.id, permissions: this.verificationPermissions(), use_independent_chat_permissions: true } });
        const replyMarkup = verification.mode === 'channel' ? { reply_markup: { inline_keyboard: [[{ text: '① 打开频道，点击加入', url: `https://t.me/${verification.channel.slice(1)}` }], [{ text: '② 已加入，完成验证', callback_data: `verify:channel:${member.id}` }]] } } : {};
        ops.push({ method: 'sendMessage', params: { chat_id: chatId, text: verification.text, ...replyMarkup }, verificationPromptFor: member.id });
      }
      return ops.length ? { ops, entry: { chatId, chatTitle: msg.chat.title || '', action: started.length ? 'welcome-and-verification-started' : 'welcome-and-rules', outcome: 'pending', userId: started.join(','), reasons: started.length ? [raidActive && this.verificationMode(config) === 'off' ? '反入群轰炸：临时算术验证已开启' : `${this.verificationMode(config)} 验证已开启`] : undefined } } : empty;
    }
    // Anonymous group admins and automatic linked-channel posts are trusted separately.
    if (msg.sender_chat?.id === chatId || msg.is_automatic_forward) return empty;
    if (!msg.sender_chat && (!msg.from || msg.from.is_bot)) return empty;
    const senderId = msg.sender_chat ? `channel:${msg.sender_chat.id}` : String(msg.from.id);
    const text = msg.text || msg.caption || '';
    if (!msg.sender_chat && text.startsWith('/')) {
      const me = await this.me(tg);
      const command = parseCommand(text, me.username || '');
      if (command) {
        // Editing an old command must not re-run a destructive operation.
        if (update.edited_message) return empty;
        if (command.command === 'spam' && await this.privileged(tg, chatId, msg.from.id)) return this.spamPlan(msg,tg);
        if (command.command === 'report') return this.reportPlan(msg, tg, command.arg);
        if (['start','help','status','addword','removeword','listwords','warnings','clearwarn','allow','unallow','unban','unmute','ban','kick'].includes(command.command) && await this.privileged(tg, chatId, msg.from.id)) return this.commandPlan(command, msg, tg);
        const note = this.findKnowledgeCommand(command.command, await this.config());
        if (note) return { ops: [{ method: 'sendMessage', params: { chat_id: chatId, text: note.response, reply_to_message_id: msg.message_id, allow_sending_without_reply: true, disable_web_page_preview: true } }], entry: { chatId, chatTitle: msg.chat.title || '', userId: msg.from.id, action: 'knowledge-command', outcome: 'pending', text: note.title, reasons: [`/${note.command}`] } };
        // Non-admin slash commands still pass through spam detection.
      }
    }
    let membership;
    if (!msg.sender_chat) {
      if (this.owners().includes(String(msg.from.id))) return empty;
      membership = await this.member(tg, chatId, msg.from.id);
      if (ADMIN_STATUS.includes(membership.status)) return empty;
    }
    const pendingVerification = !msg.sender_chat && this.verification(msg.from.id);
    if(pendingVerification && pendingVerification.expires<=Date.now())return {ops:[{method:'deleteMessage',params:{chat_id:chatId,message_id:msg.message_id}}]};
    if (pendingVerification?.mode === 'math') {
      if (String(msg.text || '').trim() === pendingVerification.answer) {
        this.clearVerification(msg.from.id);
        const restore = await this.restoreMember(chatId, msg.from.id, tg);
        const ops = [{ method: 'deleteMessage', params: { chat_id: chatId, message_id: msg.message_id } }];
        if (pendingVerification.prompt_message_id) ops.push({ method: 'deleteMessage', params: { chat_id: chatId, message_id: pendingVerification.prompt_message_id } });
        ops.push(restore, { method: 'sendMessage', params: { chat_id: chatId, text: '✅ 验证通过，已解除新成员限制。' } });
        return { ops, entry: { chatId, chatTitle: msg.chat.title || '', userId: msg.from.id, action: 'verification-passed', outcome: 'pending', reasons: ['算术验证'] } };
      }
      return { ops: [{ method: 'deleteMessage', params: { chat_id: chatId, message_id: msg.message_id } }], entry: { chatId, chatTitle: msg.chat.title || '', userId: msg.from.id, action: 'verification-answer-rejected', outcome: 'pending', reasons: ['算术答案不正确'] } };
    }
    if (this.read(`allow:${senderId}`) || this.read(`offence:${msg.message_id}`)) return empty;
    const policy = await this.config();
    const contentLock = this.contentLock(msg, policy.contentLocks);
    if (contentLock) {
      const entry = { chatId, chatTitle: msg.chat.title || '', userId: senderId, userName: msg.sender_chat?.title || [msg.from?.first_name,msg.from?.last_name].filter(Boolean).join(' '), messageId: msg.message_id, text: text.slice(0, 300), reasons: [`内容限制：${contentLock.label}`] };
      const ops = [{ method: 'deleteMessage', params: { chat_id: chatId, message_id: msg.message_id } }];
      if (contentLock.action === 'ban' && !msg.sender_chat) {
        ops.push({ method: 'banChatMember', params: { chat_id: chatId, user_id: msg.from.id, until_date: 0 } });
        const federationTargets = await this.env.GUARD_STATE.getByName('admin').federationTargets(chatId);
        // Linked groups are dispatched to independent durable jobs by runJob.
        return { ops, entry: { ...entry, action: federationTargets.length ? 'content-lock-delete-and-federated-permanent-ban' : 'content-lock-delete-and-permanent-ban', federationTargets } };
      }
      ops.push({ local: 'processed', messageId: msg.message_id });
      return { ops, entry: { ...entry, action: 'content-lock-delete' } };
    }
    this.observeTrials(msg);
    const joined = this.read(`join:${senderId}`, 0);
    const verdict = classify(msg, policy.keywords, joined > Date.now() - policy.newMemberMinutes * 60000, { allowlist: policy.domainAllowlist, denylist: policy.domainDenylist });
    // Only same-user, same-group text from the last three minutes. Never quoted reply text.
    const recent=this.read(`context:${senderId}`,[]).filter(x=>x.at>Date.now()-180000 && x.id!==msg.message_id).slice(-4);
    if(text) recent.push({id:msg.message_id,at:Date.now(),text:text.slice(0,800)});
    this.write(`context:${senderId}`,recent,180000);
    if(recent.length>1 && verdict.score<7) {
      const combined=classify({...msg,text:recent.map(x=>x.text).join(' ')},[],false,{allowlist:policy.domainAllowlist,denylist:policy.domainDenylist});
      if(combined.permanentBan && combined.score>=4) {
        Object.assign(verdict,combined); verdict.reasons.push('同一账号 3 分钟内分段广告');
        verdict.contextMessageIds=recent.map(x=>x.id);
      }
    }
    const linkQuarantine = policy.newMemberLinkGuard && joined > Date.now() - policy.newMemberLinkMinutes * 60000 && verdict.hasLink;
    const hasMedia = !!(msg.photo?.length || msg.video || msg.animation || msg.document || msg.audio || msg.voice || msg.video_note || msg.sticker);
    const mediaQuarantine = policy.newMemberMediaGuard && joined > Date.now() - policy.newMemberMediaMinutes * 60000 && hasMedia;
    if (linkQuarantine) { verdict.score = Math.max(4, verdict.score); verdict.reasons.push(`新成员链接隔离（入群 ${policy.newMemberLinkMinutes} 分钟内）`); }
    const sampleRules = await this.cachedSamples();
    const sampleHits = sampleMatches(msg, sampleRules);
    if (sampleHits.length) {
      verdict.score = Math.max(7, verdict.score);
      verdict.reasons.push(`样本库：${sampleHits.slice(0, 3).map(sample => sample.label || sample.value).join('、')}`);
    }
    if (!sampleHits.some(sample => sample.kind === 'photo')) {
      const ocrText = await this.ocr(msg, tg);
      if (ocrText) {
        const ocrMsg = { ...msg, text: [text, ocrText].filter(Boolean).join('\n') };
        this.observeTrials(ocrMsg);
        const ocrVerdict = classify(ocrMsg, policy.keywords, joined > Date.now() - policy.newMemberMinutes * 60000, { allowlist: policy.domainAllowlist, denylist: policy.domainDenylist });
        const ocrSampleHits = sampleMatches(ocrMsg, sampleRules, ocrText);
        if (ocrSampleHits.length) { ocrVerdict.sampleIds=ocrSampleHits.map(x=>x.id);ocrVerdict.score = Math.max(7, ocrVerdict.score); ocrVerdict.reasons.push(`OCR 样本库：${ocrSampleHits.slice(0, 3).map(sample => sample.label || sample.value).join('、')}`); }
        if (ocrVerdict.score > verdict.score) Object.assign(verdict, ocrVerdict);
      }
    }
    let samples = this.read(`flood:${senderId}`, []).filter(x => x.at > Date.now() - 60000 && x.id !== msg.message_id);
    const fingerprint = normalize(text) || msg.sticker?.file_unique_id || msg.photo?.at(-1)?.file_unique_id || msg.document?.file_unique_id || msg.video?.file_unique_id || '';
    if (fingerprint) samples.push({ id: msg.message_id, at: Date.now(), text: fingerprint });
    samples = samples.slice(-50);
    this.write(`flood:${senderId}`, samples, 120000);
    const repeat = fingerprint ? samples.filter(x => x.text === fingerprint).length : 0;
    if (repeat >= policy.repeatThreshold || samples.length >= policy.floodThreshold) {
      verdict.score = Math.max(4, verdict.score);
      verdict.reasons.push(repeat >= policy.repeatThreshold ? `60 秒内相同内容 ${repeat} 次（含交替刷屏）` : `60 秒内消息 ${samples.length} 条`);
    }
    // Coordinated spam often rotates accounts to evade per-sender flood limits.
    // Keep a short group-scoped fingerprint window only for substantial text.
    if (fingerprint.length >= 6) {
      const key = `groupflood:${fingerprint.slice(0, 160)}`;
      let groupSamples = this.read(key, []).filter(x => x.at > Date.now() - 10 * 60000 && x.id !== msg.message_id);
      groupSamples.push({ id: msg.message_id, at: Date.now(), senderId });
      groupSamples = groupSamples.slice(-50); this.write(key, groupSamples, 15 * 60000);
      if (new Set(groupSamples.map(x => x.senderId)).size >= 2) {
        verdict.score = Math.max(4, verdict.score);
        verdict.reasons.push('10 分钟内多个账号重复相同内容');
      }
    }
    const knowledge = this.findKnowledgeTrigger(text, policy);
    if (!verdict.score && !verdict.deleteOnKeyword && !mediaQuarantine && knowledge) {
      const cooldown = `knowledge:${senderId}:${knowledge.id}`;
      if (!this.read(cooldown)) {
        this.write(cooldown, true, 60000);
        return { ops: [{ method: 'sendMessage', params: { chat_id: chatId, text: knowledge.response, reply_to_message_id: msg.message_id, allow_sending_without_reply: true, disable_web_page_preview: true } }], entry: { chatId, chatTitle: msg.chat.title || '', userId: senderId, messageId: msg.message_id, action: 'knowledge-auto-reply', reasons: [knowledge.title], text: knowledge.response.slice(0, 120) } };
      }
    }
    if (!verdict.score && !verdict.deleteOnKeyword && !mediaQuarantine) return empty;
    const entry = { sampleIds:[...new Set(verdict.sampleIds||sampleHits.map(x=>x.id))], chatId, chatTitle: msg.chat.title || '', userId: senderId, userName: msg.sender_chat?.title || [msg.from?.first_name,msg.from?.last_name].filter(Boolean).join(' '), messageId: msg.message_id, text: text.slice(0, 300), score: verdict.score, reasons: verdict.reasons, keywordHits: verdict.hits, domains: verdict.domains };
    if (mediaQuarantine && verdict.score < 4 && !verdict.deleteOnKeyword) return { ops: [{ method: 'deleteMessage', params: { chat_id: chatId, message_id: msg.message_id } }, { local: 'processed', messageId: msg.message_id }], entry: { ...entry, action: 'new-member-media-quarantine', reasons: [...entry.reasons, `新成员媒体隔离（入群 ${policy.newMemberMediaMinutes} 分钟内）`] } };
    if (verdict.score < 4 && !verdict.deleteOnKeyword) return { ops: [], entry: { ...entry, action: 'review' } };
    const ops = [...new Set(verdict.contextMessageIds || [msg.message_id])].map(id=>({method:'deleteMessage',params:{chat_id:chatId,message_id:id}}));
    if (msg.sender_chat) {
      ops.push({ local: 'processed', messageId: msg.message_id });
      return { ops, entry: { ...entry, action: 'delete-channel-message' } };
    }
    ops.push({ method: 'banChatMember', params: { chat_id: chatId, user_id: msg.from.id, until_date: 0 } });
    const federationTargets = await this.env.GUARD_STATE.getByName('admin').federationTargets(chatId);
    // Linked groups are dispatched to independent durable jobs by runJob.
    ops.push({ local: 'processed', messageId: msg.message_id });
    return { ops, entry: { ...entry, action: federationTargets.length ? 'delete-and-federated-permanent-ban' : 'delete-and-permanent-ban', federationTargets } };
  }

  contentLock(msg, locks = {}) {
    const active = type => locks?.[type]?.enabled === true ? locks[type] : null;
    const kinds = [
      ['invite', /(?:https?:\/\/)?t\.me\/(?:joinchat\/|\+)/i.test([msg.text, msg.caption, ...(msg.entities || []).map(item => item.url || '')].filter(Boolean).join(' ')), 'Telegram 群邀请链接'],
      ['forward', !!(msg.forward_origin || msg.forward_date || msg.forward_from || msg.forward_from_chat), '转发消息'],
      ['inline', !!msg.via_bot, '内联机器人消息'],
      ['link', (msg.entities || msg.caption_entities || []).some(item => item.type === 'url' || item.type === 'text_link') || /(?:https?:\/\/|www\.)/i.test(msg.text || msg.caption || ''), '网址链接'],
      ['photo', !!msg.photo?.length, '图片'],
      ['video', !!msg.video || !!msg.video_note, '视频'],
      ['gif', !!msg.animation, 'GIF 动图'],
      ['file', !!msg.document, '文件'],
      ['audio', !!msg.audio || !!msg.voice, '音频或语音'],
      ['sticker', !!msg.sticker, '贴纸'],
    ];
    for (const [type, matched, label] of kinds) { const lock = active(type); if (matched && lock) return { action: lock.action === 'ban' ? 'ban' : 'delete', label }; }
    return null;
  }

  findKnowledgeCommand(command, config) { return normalizeKnowledge(config.knowledgeBase).find(item => item.enabled && item.command === command); }
  findKnowledgeTrigger(text, config) {
    const body = normalize(text);
    if (!body || body.startsWith('/')) return null;
    return normalizeKnowledge(config.knowledgeBase).find(item => item.enabled && item.triggers.some(trigger => body.includes(normalize(trigger)))) || null;
  }

  async callbackPlan(callback) {
    const message = callback?.message;
    const match = /^verify:channel:(\d{1,16})$/.exec(String(callback?.data || ''));
    if (!match || !message?.chat || String(callback.from?.id) !== match[1]) return { ops: [{ method: 'answerCallbackQuery', params: { callback_query_id: callback.id, text: '验证请求无效。', show_alert: true } }] };
    const pending = this.verification(callback.from.id);
    if (!pending || pending.expires<=Date.now() || pending.mode !== 'channel' || !pending.channel) return { ops: [{ method: 'answerCallbackQuery', params: { callback_query_id: callback.id, text: '该验证已失效，请联系管理员。', show_alert: true } }] };
    const tg = telegram(this.env.BOT_TOKEN);
    const joined = await this.member(tg, pending.channel, callback.from.id).catch(() => null);
    if (!joined) return { ops: [{ method: 'answerCallbackQuery', params: { callback_query_id: callback.id, text: '暂时无法检查订阅状态，请稍后重试；若一直失败，请联系管理员检查频道权限。', show_alert: true } }] };
    if (['left', 'kicked'].includes(joined.status) || joined.status==='restricted' && joined.is_member!==true) return { ops: [{ method: 'answerCallbackQuery', params: { callback_query_id: callback.id, text: `还没有检测到订阅。请点击第一个按钮打开 ${pending.channel}，在频道底部点击“加入 / Join”，再返回本群点击第二个按钮。`, show_alert: true } }] };
    this.clearVerification(callback.from.id);
    const restore = await this.restoreMember(message.chat.id, callback.from.id, tg);
    return { ops: [{ method: 'answerCallbackQuery', params: { callback_query_id: callback.id, text: '验证通过，欢迎加入！' } }, restore, { method: 'deleteMessage', params: { chat_id: message.chat.id, message_id: message.message_id } }], entry: { chatId: message.chat.id, chatTitle: message.chat.title || '', userId: callback.from.id, action: 'verification-passed', outcome: 'pending', reasons: [`频道验证：${pending.channel}`] } };
  }

  async spamPlan(msg,tg) {
    const target=msg.reply_to_message;
    if (!target?.from?.id || target.from.is_bot || target.sender_chat || target.chat?.id && target.chat.id!==msg.chat.id) throw new Error('请回复普通用户的广告消息发送 /spam');
    if (!this.owners().includes(String(msg.from.id))) {
      const actor=await this.member(tg,msg.chat.id,msg.from.id);
      if(actor.status!=='creator' && !actor.can_restrict_members) throw new Error('缺少封禁成员权限');
    }
    const member=await this.member(tg,msg.chat.id,target.from.id);
    if(ADMIN_STATUS.includes(member.status) || this.owners().includes(String(target.from.id))) throw new Error('不能处理管理员或机器人所有者');
    const sample=target.photo?.at(-1)?.file_unique_id ? {kind:'photo',value:target.photo.at(-1).file_unique_id} : {kind:'text',value:(target.text || target.caption || '').slice(0,500)};
    const ops=[{method:'deleteMessage',params:{chat_id:msg.chat.id,message_id:target.message_id}}, {method:'banChatMember',params:{chat_id:msg.chat.id,user_id:target.from.id,until_date:0}}];
    if(sample.value) ops.push({local:'sample',sample:{...sample,label:'管理员 /spam 待审核',pending:true}});
    ops.push({method:'deleteMessage',params:{chat_id:msg.chat.id,message_id:msg.message_id}});
    return {ops,entry:{chatId:msg.chat.id,actorId:msg.from.id,userId:target.from.id,messageId:target.message_id,action:'spam-delete-and-permanent-ban',text:(target.text||target.caption||'').slice(0,300),reasons:['管理员确认广告；样本待审核']}};
  }

  async reportPlan(msg, tg, reason = '') {
    const target = msg.reply_to_message;
    const reply = text => ({ ops: [{ method: 'deleteMessage', params: { chat_id: msg.chat.id, message_id: msg.message_id } }, { method: 'sendMessage', params: { chat_id: msg.chat.id, text } }], entry: { chatId: msg.chat.id, chatTitle: msg.chat.title || '', actorId: msg.from.id, action: 'user-report', outcome: 'pending' } });
    if (!target?.from?.id || target.from.is_bot || target.sender_chat) return reply('请回复需要举报的普通用户消息后发送 /report。');
    if (target.from.id === msg.from.id) return reply('不能举报自己的消息。');
    const member = await this.member(tg, msg.chat.id, target.from.id);
    if (ADMIN_STATUS.includes(member.status) || this.owners().includes(String(target.from.id))) return reply('不能举报群管理员或机器人所有者。');
    return { ops: [{ method: 'deleteMessage', params: { chat_id: msg.chat.id, message_id: msg.message_id } }, { method: 'sendMessage', params: { chat_id: msg.chat.id, text: '✅ 举报已记录，管理员会在后台处理。' } }], entry: { chatId: msg.chat.id, chatTitle: msg.chat.title || '', actorId: msg.from.id, userId: target.from.id, messageId: target.message_id, action: 'user-report', outcome: 'success', text: (target.text || target.caption || '').slice(0, 300), reasons: [reason.slice(0, 100) || '成员举报'] } };
  }

  async commandPlan({ command, arg }, msg, tg) {
    const chatId = msg.chat.id;
    const entry = { chatId, chatTitle: msg.chat.title || '', actorId: msg.from.id, action: command, text: arg.slice(0, 100), reasons: ['管理员操作'] };
    const reply = text => ({ ops: [{ method: 'sendMessage', params: { chat_id: chatId, text: text.slice(0, 4000) } }], entry });
    if (['ban','kick','unban','unmute'].includes(command) && !this.owners().includes(String(msg.from.id))) {
      const actor = await this.member(tg, chatId, msg.from.id);
      if (actor.status !== 'creator' && !actor.can_restrict_members) return reply('你没有限制群成员的管理权限，未执行该操作。');
    }
    if (command === 'start' || command === 'help') return reply(HELP);
    if (command === 'status') {
      const me = await this.me(tg);
      const member = await this.member(tg, chatId, me.id);
      const policy = await this.config();
      return reply(`运行正常 · v2\n广告命中：删除消息并永久封禁账号，不发送或累计警告\n删消息权限：${member.can_delete_messages ? '有' : '无'}\n限制成员权限：${member.can_restrict_members ? '有' : '无'}\n群类型：${msg.chat.type}\n词库：本群独立 ${policy.keywords.length} 个词\n群内自动通知：关闭，处理结果在后台查看`);
    }
    if (['addword','removeword','listwords'].includes(command)) {
      const config = await this.config();
      if (command === 'listwords') return reply(`本群黑名单关键词（命中即删消息）：\n${config.keywords.join('、')}`);
      let word;
      try { word = validateWord(arg); } catch (e) { return reply(e.message); }
      if (command === 'addword') {
        if (config.keywords.length >= 500) return reply('词库已达 500 个，请先清理。');
        if (!config.keywords.includes(word)) config.keywords.push(word);
      } else config.keywords = config.keywords.filter(w => w !== word);
      this.saveConfig(config, `群内${command.command}`);
      return reply(`已${command === 'addword' ? '添加' : '移除'}本群关键词：${word}`);
    }
    const target = /^\d{1,16}$/.test(arg) ? Number(arg) : msg.reply_to_message?.from?.id;
    if (!target || !Number.isSafeInteger(target) || (msg.reply_to_message?.sender_chat && !arg)) return reply('请回复普通用户的消息，或在指令后填写数字用户 ID。频道身份请由管理员在 Telegram 中处理。');
    entry.userId = target;
    if (command === 'warnings') return reply(`用户 ${target}：${this.read(`warn:${target}`, 0)} 次警告；白名单：${this.read(`allow:${target}`) ? '是' : '否'}`);
    if (['clearwarn','allow','unallow'].includes(command)) {
      if (command === 'clearwarn' || command === 'allow') { this.remove(`warn:${target}`); this.remove(`flood:${target}`); }
      if (command === 'allow') this.write(`allow:${target}`, true);
      if (command === 'unallow') this.remove(`allow:${target}`);
      return reply(`已执行 ${command}：${target}。白名单不自动解除现有限制；需要时再使用 /unmute 或 /unban。`);
    }
    const member = await this.member(tg, chatId, target);
    if (ADMIN_STATUS.includes(member.status) || this.owners().includes(String(target)) || target === (await this.me(tg)).id) return reply('不能对群管理员、机器人所有者或机器人自身执行处罚。');
    const params = { chat_id: chatId, user_id: target };
    let ops = [];
    if (command === 'ban' || command === 'kick') {
      ops.push({ method: 'banChatMember', params });
      if (command === 'kick') ops.push({ method: 'unbanChatMember', params: { ...params, only_if_banned: true } });
    }
    if (command === 'unban') ops = [{ method: 'unbanChatMember', params: { ...params, only_if_banned: true } }];
    if (command === 'unmute') {
      if (msg.chat.type !== 'supergroup') return reply('普通群不支持禁言权限操作。');
      if (member.status === 'kicked') return reply('该用户已被封禁，请先使用 /unban。');
      const chat = await tg('getChat', { chat_id: chatId });
      if (!chat.permissions) return reply('无法读取群默认权限，未修改用户权限。');
      ops = [{ method: 'restrictChatMember', params: { ...params, permissions: chat.permissions, use_independent_chat_permissions: true } }];
    }
    ops.push({ method: 'sendMessage', params: { chat_id: chatId, text: `已成功执行 /${command}：${target}` } });
    return { ops, entry };
  }

  async adminData(before = 0) {
    const config = await this.config();
    const rows = this.sql.exec('SELECT id,data FROM logs WHERE id<? ORDER BY id DESC LIMIT 50', before > 0 ? before : Number.MAX_SAFE_INTEGER).toArray();
    return { health:this.healthSummary(), ocrQuota:this.ocrQuota(this.read('chat')?.id || ''), failedJobs:this.sql.exec("SELECT id,attempts,created,plan FROM jobs WHERE status='failed' ORDER BY created DESC LIMIT 20").toArray().map(x=>({id:x.id,attempts:x.attempts,created:x.created,action:JSON.parse(x.plan||'{}').entry?.action})), config, versions: this.configVersions(), logs: rows.map(r => ({ ...JSON.parse(r.data), id: r.id })), next: rows.length === 50 ? rows.at(-1).id : null, pending: this.sql.exec("SELECT COUNT(*) AS n FROM jobs WHERE status='pending'").toArray()[0].n, failed: this.sql.exec("SELECT COUNT(*) AS n FROM jobs WHERE status='failed'").toArray()[0].n };
  }
  async keywordStats() {
    const since = Date.now() - 30 * DAY;
    const counts = new Map();
    for (const row of this.sql.exec('SELECT data FROM logs WHERE ts>=? ORDER BY id DESC LIMIT 5000', since).toArray()) {
      const hits = JSON.parse(row.data).keywordHits;
      if (Array.isArray(hits)) for (const word of hits) counts.set(word, (counts.get(word) || 0) + 1);
    }
    return { periodDays: 30, total: [...counts.values()].reduce((sum, count) => sum + count, 0), keywords: [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN')).slice(0, 50).map(([word, count]) => ({ word, count })) };
  }
  async editWord(action, word) {
    word = validateWord(word);
    const config = await this.config();
    if (action === 'add' && !config.keywords.includes(word)) {
      if (config.keywords.length >= 500) throw new Error('最多 500 个关键词');
      config.keywords.push(word);
    } else if (action === 'remove') config.keywords = config.keywords.filter(w => w !== word);
    this.saveConfig(config, `关键词${action}`);
    this.log({ action: `keyword-${action}`, actorId: 'web-admin', text: word, outcome: 'success' });
    return { keywords: config.keywords };
  }
  async editDomain(action, domain, list) {
    domain = normalizeDomain(domain);
    if (!['allow', 'deny'].includes(list)) throw new Error('无效名单类型');
    const config = await this.config();
    const key = list === 'allow' ? 'domainAllowlist' : 'domainDenylist';
    if (action === 'add' && !config[key].includes(domain)) {
      if (config[key].length >= 300) throw new Error('名单最多 300 个域名');
      config[key].push(domain);
    } else if (action === 'remove') config[key] = config[key].filter(item => item !== domain);
    this.saveConfig(config, `域名${list}${action}`);
    this.log({ action: `domain-${list}-${action}`, actorId: 'web-admin', text: domain, outcome: 'success' });
    return { allowlist: config.domainAllowlist, denylist: config.domainDenylist };
  }
  async editWelcome(welcomeMessage, rulesMessage) {
    if (typeof welcomeMessage !== 'string' || typeof rulesMessage !== 'string' || welcomeMessage.length > 2500 || rulesMessage.length > 2500) throw new Error('欢迎语和群规均不能超过 2500 个字符');
    const config = await this.config();
    config.welcomeMessage = welcomeMessage.trim(); config.rulesMessage = rulesMessage.trim();
    this.saveConfig(config, '欢迎语与群规');
    this.log({ action: 'welcome-rules-update', actorId: 'web-admin', outcome: 'success' });
    return { welcomeMessage: config.welcomeMessage, rulesMessage: config.rulesMessage };
  }
  async editVerification(mode, minutes, channel) {
    if (!['off', 'math', 'channel'].includes(mode)) throw new Error('无效验证方式');
    const value = Math.max(1, Math.min(60, Number(minutes)));
    if (!Number.isInteger(value)) throw new Error('验证时限须为 1–60 分钟');
    let normalizedChannel = String(channel || '').trim();
    if (normalizedChannel && !normalizedChannel.startsWith('@')) normalizedChannel = '@' + normalizedChannel;
    if (mode === 'channel' && !/^@[a-zA-Z0-9_]{5,}$/.test(normalizedChannel)) throw new Error('频道验证请填写公开频道用户名，例如 @jason_vps_deal');
    const config = await this.config();
    config.verificationMode = mode; config.verificationMinutes = value; config.verificationChannel = mode === 'channel' ? normalizedChannel : '';
    this.saveConfig(config, '新成员验证');
    this.log({ action: 'verification-update', actorId: 'web-admin', outcome: 'success', text: `${mode}:${value}:${config.verificationChannel}` });
    return { verificationMode: config.verificationMode, verificationMinutes: config.verificationMinutes, verificationChannel: config.verificationChannel };
  }
  async editRaid(enabled, limit, minutes) {
    const joins = Number(limit), duration = Number(minutes);
    if (typeof enabled !== 'boolean' || !Number.isInteger(joins) || joins < 2 || joins > 30 || !Number.isInteger(duration) || duration < 5 || duration > 120) throw new Error('入群阈值须为 2–30 人，防护时长须为 5–120 分钟');
    const config = await this.config();
    config.raidEnabled = enabled; config.raidJoinLimit = joins; config.raidMinutes = duration;
    this.saveConfig(config, '反入群轰炸');
    this.log({ action: 'raid-update', actorId: 'web-admin', outcome: 'success', text: `${enabled}:${joins}:${duration}` });
    return { raidEnabled: config.raidEnabled, raidJoinLimit: config.raidJoinLimit, raidMinutes: config.raidMinutes };
  }
  async editNewMemberLinkGuard(enabled, minutes) {
    const duration = Number(minutes);
    if (typeof enabled !== 'boolean' || !Number.isInteger(duration) || duration < 1 || duration > 1440) throw new Error('链接隔离时长须为 1–1440 分钟');
    const config = await this.config();
    config.newMemberLinkGuard = enabled; config.newMemberLinkMinutes = duration;
    this.saveConfig(config, '新人链接隔离');
    this.log({ action: 'new-member-link-guard-update', actorId: 'web-admin', outcome: 'success', text: `${enabled}:${duration}` });
    return { newMemberLinkGuard: config.newMemberLinkGuard, newMemberLinkMinutes: config.newMemberLinkMinutes };
  }
  async editNewMemberMediaGuard(enabled, minutes) {
    const duration = Number(minutes);
    if (typeof enabled !== 'boolean' || !Number.isInteger(duration) || duration < 1 || duration > 1440) throw new Error('媒体隔离时长须为 1–1440 分钟');
    const config = await this.config();
    config.newMemberMediaGuard = enabled; config.newMemberMediaMinutes = duration;
    this.saveConfig(config, '新人媒体隔离');
    this.log({ action: 'new-member-media-guard-update', actorId: 'web-admin', outcome: 'success', text: `${enabled}:${duration}` });
    return { newMemberMediaGuard: config.newMemberMediaGuard, newMemberMediaMinutes: config.newMemberMediaMinutes };
  }
  async editContentLocks(locks) {
    if (!locks || typeof locks !== 'object' || Array.isArray(locks)) throw new Error('内容限制设置无效');
    const normalized = {};
    for (const type of CONTENT_LOCK_TYPES) {
      const item = locks[type];
      if (!item || item.enabled !== true) continue;
      normalized[type] = { enabled: true, action: item.action === 'ban' ? 'ban' : 'delete' };
    }
    const config = await this.config(); config.contentLocks = normalized;
    this.saveConfig(config, '内容类型限制');
    this.log({ action: 'content-locks-update', actorId: 'web-admin', outcome: 'success', text: JSON.stringify(normalized) });
    return { contentLocks: normalized };
  }
  async editKnowledge(action, item) {
    const config = await this.config();
    const current = normalizeKnowledge(config.knowledgeBase);
    if (action === 'remove') {
      const id = String(item?.id || '');
      config.knowledgeBase = current.filter(entry => entry.id !== id);
    } else if (action === 'upsert') {
      const candidate = normalizeKnowledge([{ ...item, id: item?.id || crypto.randomUUID() }])[0];
      if (!candidate) throw new Error('请填写有效标题、回复内容，以及 /英文指令或触发关键词');
      const next = current.filter(entry => entry.id !== candidate.id && (!candidate.command || entry.command !== candidate.command));
      if (next.length >= 50) throw new Error('每群最多 50 条知识库内容');
      next.push(candidate); config.knowledgeBase = next;
    } else throw new Error('无效知识库操作');
    this.saveConfig(config, '群知识库');
    this.log({ action: `knowledge-${action}`, actorId: 'web-admin', outcome: 'success', text: String(item?.title || item?.id || '') });
    return { knowledgeBase: config.knowledgeBase };
  }
  async editQuiet(chat, enabled, start, end, notify) {
    const valid = value => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
    if (typeof enabled !== 'boolean' || typeof notify !== 'boolean' || !valid(String(start)) || !valid(String(end))) throw new Error('请填写有效的 24 小时时间');
    if (enabled && start === end) throw new Error('开始和结束时间不能相同');
    const config = await this.config();
    config.quietEnabled = enabled; config.quietStart = start; config.quietEnd = end; config.quietNotify = notify;
    this.saveConfig(config, '夜间静默');
    this.write('chat', { id: Number(chat.id), title: String(chat.title || chat.id) });
    await this.schedule(Date.now() + 100);
    if(!enabled && this.read('quiet:active',false))await this.quietTick().catch(error=>this.log({chatId:chat.id,action:'quiet-switch',outcome:'retrying',error:String(error.message||'').slice(0,200)}));
    this.log({ action: 'quiet-update', actorId: 'web-admin', outcome: 'success', text: `${enabled}:${start}-${end}` });
    return { quietRestorePending:!enabled && this.read('quiet:active',false), quietEnabled: config.quietEnabled, quietStart: config.quietStart, quietEnd: config.quietEnd, quietNotify: config.quietNotify };
  }

  recordAudit(entry){
    this.sql.exec('CREATE TABLE IF NOT EXISTS admin_audit (id INTEGER PRIMARY KEY AUTOINCREMENT,created INTEGER NOT NULL,data TEXT NOT NULL)');
    this.sql.exec('INSERT INTO admin_audit(created,data) VALUES (?,?)',Date.now(),JSON.stringify({...entry,at:new Date().toISOString()}));
    this.sql.exec('DELETE FROM admin_audit WHERE created<?',Date.now()-90*DAY);
  }
  listAudit(before=0){
    this.sql.exec('CREATE TABLE IF NOT EXISTS admin_audit (id INTEGER PRIMARY KEY AUTOINCREMENT,created INTEGER NOT NULL,data TEXT NOT NULL)');
    this.sql.exec("CREATE INDEX IF NOT EXISTS admin_audit_operation ON admin_audit(json_extract(data,'$.operation'),id)");
    const rows=this.sql.exec("SELECT a.id,a.data FROM admin_audit a WHERE a.id<? AND NOT EXISTS (SELECT 1 FROM admin_audit b WHERE json_extract(b.data,'$.operation')=json_extract(a.data,'$.operation') AND b.id>a.id) ORDER BY a.id DESC LIMIT 51",Number(before)>0?Number(before):Number.MAX_SAFE_INTEGER).toArray();
    return {entries:rows.slice(0,50).map(x=>({id:x.id,...JSON.parse(x.data)})),next:rows.length>50?rows[49].id:null};
  }
  async auditSnapshot(path,body){
    if(path==='quiet' && body.scope==='all'){const result={};for(const chat of this.listChats()){const config=await this.env.GUARD_STATE.getByName('chat:'+chat.id).config();result['quiet:'+chat.id]={quietEnabled:config.quietEnabled,quietStart:config.quietStart,quietEnd:config.quietEnd,quietNotify:config.quietNotify};}return result;}
    if(body.chatId && /^-[0-9]{1,16}$/.test(String(body.chatId)))return {...await this.env.GUARD_STATE.getByName('chat:'+String(body.chatId)).config(),trials:await this.env.GUARD_STATE.getByName('chat:'+String(body.chatId)).listTrials()};
    if(path.startsWith('samples/'))return {samples:this.listSamples()};
    if(path.startsWith('review-examples/'))return {examples:this.listReviewExamples().map(x=>({id:x.id,verdict:x.verdict}))};
    if(path.startsWith('federation/'))return {case:this.read('federation-case:'+String(body.id))};
    if(path==='federation')return {federation:this.federation()};
    if(path==='quiet' || path==='backup/restore'){const backup=await this.exportBackup();delete backup.created;return {backup};}
    return {};
  }
  async exportBackup(){
    const chats=await this.listChats();for(const id of this.federation())if(!chats.some(x=>x.id===id))chats.push({id,title:id});if(chats.length>100)throw Error('超过 100 群备份上限');
    const groups=[];for(const chat of chats)groups.push({...chat,config:await this.env.GUARD_STATE.getByName('chat:'+chat.id).config()});
    const rows=this.sql.exec('SELECT * FROM samples ORDER BY id LIMIT 1001').toArray();if(rows.length>1000)throw Error('超过 1000 样本备份上限');
    const samples=rows.map(row=>({kind:row.kind,value:row.value,label:row.label,status:row.kind==='text'&&[...row.value].length<6?'disabled':this.read('sample-status:'+row.id,'active')}));
    return validateBackup({schema:1,created:new Date().toISOString(),groups,samples,federation:this.federation()});
  }
  async backupFingerprint(){const backup=await this.exportBackup();delete backup.created;return digest(JSON.stringify(backup));}
  async previewBackup(input){
    const backup=validateBackup(input), current=await this.exportBackup(), token=crypto.randomUUID();
    const differences=backup.groups.map(item=>({id:item.id,title:item.title,changes:diffValues(current.groups.find(x=>x.id===item.id)?.config||{},item.config)})).filter(x=>x.changes.length);
    const key=x=>JSON.stringify([x.kind,x.value]);
    const target=new Set(backup.samples.map(key));
    const samples={restore:backup.samples.length,disable:current.samples.filter(x=>!target.has(key(x))&&x.status!=='disabled').length};
    this.write('backup-preview:'+token,{backup,baseline:await this.backupFingerprint()},15*60000);
    return {token,groups:differences,samples,federation:{before:current.federation,after:backup.federation},notes:'恢复只覆盖备份中的群；未包含的样本会停用。不会恢复密钥、会话、消息、执行队列或用户封禁。'};
  }
  async replaceBackupConfig(chat,expected){
    const config=validateConfig(chat.config), current=validateConfig(await this.config());if(expected && JSON.stringify(current)!==JSON.stringify(validateConfig(expected)) && JSON.stringify(current)!==JSON.stringify(config))throw Error('群 '+chat.id+' 配置在恢复过程中已变化，请重新预览');this.saveConfig(config,'从备份恢复');this.write('chat',{id:Number(chat.id),title:chat.title});
    await this.schedule(Date.now()+100);
    if(!config.quietEnabled && this.read('quiet:active'))await this.quietTick();
    return {ok:true};
  }
  async restoreBackup(token){
    if(this.restoring)throw Error('已有恢复操作正在执行，请稍后核对结果');this.restoring=true;
    try{return await this.applyBackup(token);}finally{this.restoring=false;}
  }
  async applyBackup(token){
    const result = await this.applyBackupJob(token);
    await this.broadcastSamplesChanged();
    return result;
  }
  async applyBackupJob(token){
    const key='backup-preview:'+String(token);let job=this.read(key);if(!job)throw Error('恢复预览已过期，请重新预览');
    if(job.complete)return {ok:true,complete:true,restored:job.done.length};
    if(!job.started){if(await this.backupFingerprint()!==job.baseline)throw Error('配置已变化，请重新预览，避免覆盖新修改');job.rollback=await this.exportBackup();job.started=true;job.done=[];this.write(key,job,DAY);this.write('backup:last-rollback',job.rollback,7*DAY);this.write('backup:active',String(token),DAY);}
    if(this.read('backup:active')!==String(token))throw Error('该恢复任务已被后续恢复替代，请重新预览');
    // Each completed group is durable. A retry only resumes the remaining groups.
    for(const chat of job.backup.groups){if(job.done.includes(chat.id))continue;await this.env.GUARD_STATE.getByName('chat:'+chat.id).replaceBackupConfig(chat,job.rollback.groups.find(x=>x.id===chat.id)?.config);await this.register(chat);job.done.push(chat.id);this.write(key,job,DAY);}
    const currentSamples=this.sql.exec('SELECT * FROM samples ORDER BY id LIMIT 1001').toArray().map(row=>({kind:row.kind,value:row.value,label:row.label,status:row.kind==='text'&&[...row.value].length<6?'disabled':this.read('sample-status:'+row.id,'active')}));
    if(JSON.stringify(currentSamples)!==JSON.stringify(job.rollback.samples) || JSON.stringify(this.federation())!==JSON.stringify(job.rollback.federation))throw Error('全局样本或联防名单在恢复过程中已变化，请重新预览');
    this.ctx.storage.transactionSync(()=>{
    for(const sample of job.backup.samples){this.sql.exec('INSERT OR IGNORE INTO samples(kind,value,label,created) VALUES (?,?,?,?)',sample.kind,sample.value,sample.label,Date.now());const row=this.sql.exec('SELECT id FROM samples WHERE kind=? AND value=?',sample.kind,sample.value).toArray()[0];this.sql.exec('UPDATE samples SET label=? WHERE id=?',sample.label,row.id);this.write('sample-status:'+row.id,sample.status);}
    const targets=new Set(job.backup.samples.map(x=>JSON.stringify([x.kind,x.value])));for(const row of this.sql.exec('SELECT id,kind,value FROM samples').toArray())if(!targets.has(JSON.stringify([row.kind,row.value])))this.write('sample-status:'+row.id,'disabled');
    this.sql.exec('UPDATE federation SET enabled=0');for(const chatId of job.backup.federation)this.sql.exec('INSERT INTO federation(chat_id,enabled) VALUES (?,1) ON CONFLICT(chat_id) DO UPDATE SET enabled=1',chatId);
    this.sql.exec("DELETE FROM records WHERE key LIKE 'sample-preview:%'");job.complete=true;this.write(key,job,DAY);
    });
    return {ok:true,complete:true,restored:job.done.length};
  }
  lastRollback(){return this.read('backup:last-rollback');}
  listTrials(){return this.read('rule-trials',[]);}
  async editTrial(action,body){
    let trials=this.listTrials();
    if(action==='add'){
      if(!['keyword','domain'].includes(body.kind))throw Error('试运行支持关键词和黑名单域名');
      const value=body.kind==='keyword'?validateWord(body.value):normalizeDomain(body.value);
      if(trials.some(x=>x.kind===body.kind&&x.value===value))throw Error('试运行规则已存在');if(trials.length>=100)throw Error('每群最多 100 条试运行规则');
      trials.push({id:crypto.randomUUID(),kind:body.kind,value,created:Date.now(),hits:0,examples:[]});
    }else{
      const item=trials.find(x=>x.id===body.id);if(!item)throw Error('试运行规则不存在');
      if(action==='promote'){if(item.kind==='keyword')await this.editWord('add',item.value);else await this.editDomain('add',item.value,'deny');}
      else if(action!=='remove')throw Error('操作无效');
      trials=trials.filter(x=>x.id!==body.id);
    }
    this.write('rule-trials',trials);return {trials};
  }
  observeTrials(msg){
    const trials=this.listTrials();let changed=false;
    for(const trial of trials){
      const match=trial.kind==='keyword'?classify(msg,[trial.value],false).hits.includes(trial.value):classify(msg,[],false,{denylist:[trial.value]}).blockedDomains.length>0;
      const key='trial-seen:'+trial.id+':'+msg.message_id;
      if(!match || this.read(key))continue;this.write(key,true,30*DAY);trial.hits++;trial.examples.unshift({at:new Date().toISOString(),messageId:msg.message_id,text:String(msg.text||msg.caption||'').slice(0,300)});trial.examples=trial.examples.slice(0,20);changed=true;
      this.log({action:'rule-trial-hit',outcome:'observed',chatId:msg.chat.id,messageId:msg.message_id,trialId:trial.id,text:String(msg.text||msg.caption||'').slice(0,300),reasons:['仅试运行，不据此处罚']});
    }
    if(changed)this.write('rule-trials',trials);
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

  async loginAllowed(ip) {
    await this.schedule(Date.now() + 900000);
    // Use a fixed 15-minute window. This preserves brute-force protection while
    // ensuring an expired attempt bucket can never keep a user locked out.
    const key = `login:${ip}:${Math.floor(Date.now() / 900000)}`;
    const count = this.read(key, 0);
    return count < 10;
  }
  async recordLoginFailure(ip) { const key = `login:${ip}:${Math.floor(Date.now() / 900000)}`; this.write(key, this.read(key, 0) + 1, 900000); }
  createSession(hash, passwordHash) { this.write(`session:${hash}`, passwordHash, 8 * 3600000); }
  hasSession(hash, passwordHash) { return this.read(`session:${hash}`) === passwordHash; }
  deleteSession(hash) { this.remove(`session:${hash}`); }
}
