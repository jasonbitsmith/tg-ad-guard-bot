import { DurableObject } from 'cloudflare:workers';
import { telegram } from './telegram.js';
import { DEFAULT_KEYWORDS, DEFAULT_POLICY } from './filters.js';
import { draftPost, inspectPost, previewPost, publishPost } from './bookscape.js';
import { DAY, ADMIN_STATUS, LEGACY_CHATS } from './state/shared.js';
import { QuietMethods } from './state/quiet.js';
import { RegistryMethods } from './state/registry.js';
import { FederationMethods } from './state/federation.js';
import { ReportsMethods } from './state/reports.js';
import { SamplesMethods } from './state/samples.js';
import { MonitorsMethods } from './state/monitors.js';
import { VerificationMethods, maxAttempts } from './state/verification.js';
import { ModerationMethods } from './state/moderation.js';
import { SettingsMethods } from './state/settings.js';
import { BackupMethods } from './state/backup.js';
import { AuthMethods } from './state/auth.js';
import { ScreeningMethods } from './state/screening.js';
import { NoticesMethods } from './state/notices.js';
import { CommunityMethods } from './state/community.js';
import { AppealMethods } from './state/appeals.js';
import { OperationsMethods, operationSteps } from './state/operations.js';

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
    // Columns added after the table first shipped.
    const columns = this.sql.exec('PRAGMA table_info(verifications)').toArray().map(row => row.name);
    if (!columns.includes('attempts')) this.sql.exec('ALTER TABLE verifications ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
    if (!columns.includes('via')) this.sql.exec("ALTER TABLE verifications ADD COLUMN via TEXT NOT NULL DEFAULT 'group'");
    if (!columns.includes('prompt_chat_id')) this.sql.exec('ALTER TABLE verifications ADD COLUMN prompt_chat_id INTEGER');
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

  async enqueue(update) {
    // Register with the global admin object only when the title changes (and
    // at least daily), instead of on every message, so group traffic does not
    // all funnel through that single object.
    const source = update.chat_member?.chat || update.chat_join_request?.chat || (update.message || update.edited_message || update.callback_query?.message)?.chat;
    // Callbacks from a private verification chat are routed here too; never
    // register that private chat as a group.
    const chat = ['group', 'supergroup'].includes(source?.type) ? source : null;
    const title = chat ? String(chat.title || chat.id) : null;
    if (title !== null && this.read('registered-title') !== title) {
      await this.env.GUARD_STATE.getByName('admin').register(chat);
      this.write('registered-title', title, DAY);
    }
    // Schedule before acknowledging durable receipt; an alarm survives request termination.
    await this.schedule(Date.now() + 200);
    const id = `u:${update.update_id}`;
    this.write('health:last-received',new Date().toISOString());
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
        const job = this.sql.exec("SELECT * FROM jobs WHERE status='pending' AND id NOT LIKE 'verification-release:%' AND ((id NOT LIKE 'verification-timeout:%' AND id NOT LIKE 'federation:%' AND id NOT LIKE 'undo:%' AND id NOT LIKE 'verification-release:%' AND id NOT LIKE 'cleanup:%') OR due<=?) ORDER BY rowid LIMIT 1",Date.now()).toArray()[0];
        if (!job || job.due > Date.now()) break;
        await this.runJob(job);
      }
      const expired=this.sql.exec("SELECT user_id,prompt_message_id,prompt_chat_id,via,mode,expires FROM verifications WHERE expires<=? AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.id='verification-timeout:' || verifications.user_id || ':' || verifications.expires) LIMIT 50",Date.now()).toArray();
      const chat=this.read('chat'),timeoutAction=expired.length?this.timeoutAction(await this.config()):'ban';
      if(chat?.id)for(const pending of expired){
        const id=`verification-timeout:${pending.user_id}:${pending.expires}`;
        if(this.sql.exec('SELECT id FROM jobs WHERE id=?',id).toArray().length)continue;
        const user=Number(pending.user_id),clear={local:'clearVerification',userId:pending.user_id,expires:pending.expires},failed=Number(this.verification(pending.user_id)?.attempts||0)>=maxAttempts(pending.mode,pending.via)?'答错次数用完':'未在验证时限内完成验证';
        let plan;
        if(pending.via==='request'){
          // A join request is only declined; the person can apply again.
          const ops=[{method:'declineChatJoinRequest',params:{chat_id:chat.id,user_id:user},optional:true},clear];
          if(pending.prompt_message_id&&pending.prompt_chat_id)ops.push({method:'editMessageText',params:{chat_id:pending.prompt_chat_id,message_id:pending.prompt_message_id,text:`⌛ <b>验证未通过</b>\n\n${failed}，本次入群申请已拒绝。\n你可以随时重新申请加入。`,parse_mode:'HTML'},optional:true});
          plan={ops,entry:{chatId:chat.id,chatTitle:chat.title||'',userId:pending.user_id,action:'join-request-declined',reasons:[failed]}};
        } else {
          const ops=[{method:'banChatMember',params:{chat_id:chat.id,user_id:user,until_date:0}}];
          if(timeoutAction==='kick')ops.push({method:'unbanChatMember',params:{chat_id:chat.id,user_id:user,only_if_banned:true}});
          ops.push(clear);
          if(pending.prompt_message_id)ops.push({method:'deleteMessage',params:{chat_id:chat.id,message_id:pending.prompt_message_id}});
          plan={ops,entry:{chatId:chat.id,chatTitle:chat.title||'',userId:pending.user_id,action:timeoutAction==='kick'?'verification-timeout-kick':'verification-timeout-ban',reasons:[failed]}};
        }
        this.sql.exec('INSERT OR IGNORE INTO jobs(id,payload,plan,due,created) VALUES (?,?,?,?,?)',id,'{}',JSON.stringify(plan),Date.now(),Date.now());
        const job=this.sql.exec('SELECT * FROM jobs WHERE id=?',id).toArray()[0];await this.runJob(job);
      }
      this.sql.exec('DELETE FROM records WHERE expires<=?', Date.now());
      this.sql.exec("DELETE FROM jobs WHERE status!='pending' AND created<?", Date.now() - 7 * DAY);
      this.sql.exec('DELETE FROM logs WHERE ts<?', Date.now() - 30 * DAY);
      this.sql.exec('DELETE FROM member_profiles WHERE seen<?',Date.now()-90*DAY);
      await this.quietTick().catch(error => this.log({ action: 'quiet-switch', outcome: 'failed', error: String(error.message || '').slice(0, 200) }));
      await this.announceTick().catch(error => this.log({ action: 'announcement-sent', outcome: 'failed', error: String(error.message || '').slice(0, 200) }));
      this.pruneActivity();
    } finally {
      this.running = false;
      const next = this.sql.exec("SELECT due FROM jobs WHERE status='pending' AND id NOT LIKE 'verification-timeout:%' AND id NOT LIKE 'federation:%' AND id NOT LIKE 'undo:%' AND id NOT LIKE 'verification-release:%' AND id NOT LIKE 'cleanup:%' ORDER BY rowid LIMIT 1").toArray()[0]?.due;
      const timeoutDue=this.sql.exec("SELECT MIN(due) AS due FROM jobs WHERE status='pending' AND (id LIKE 'verification-timeout:%' OR id LIKE 'federation:%' OR id LIKE 'undo:%' OR id LIKE 'verification-release:%' OR id LIKE 'cleanup:%')").toArray()[0]?.due;
      const verificationDue = this.sql.exec("SELECT expires FROM verifications WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.id='verification-timeout:' || verifications.user_id || ':' || verifications.expires) ORDER BY expires LIMIT 1").toArray()[0]?.expires;
      const due = [next, timeoutDue, verificationDue].filter(value => Number.isFinite(value)).sort((a, b) => a - b)[0];
      const config = await this.config();
      const fallback = (config.quietEnabled || this.read('quiet:active',false) || this.quietNotices().length || (config.announcements||[]).some(item=>item.enabled)) ? Date.now() + 60000 : Date.now() + DAY;
      await this.ctx.storage.setAlarm(due === undefined ? fallback : Math.max(Date.now() + 100, due));
    }
  }
  async runJob(job) {
    let plan = job.plan ? JSON.parse(job.plan) : null;
    let activeOp;
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
      let deferredDeleteError;
      if(job.id.startsWith('federation:') && await this.env.GUARD_STATE.getByName('admin').caseReversed(plan.entry.caseId)){
        this.sql.exec("UPDATE jobs SET status='done',payload='{}',plan=NULL WHERE id=?",job.id);
        await this.env.GUARD_STATE.getByName('admin').caseStatus(plan.entry.caseId,plan.entry.chatId,{status:'cancelled'});return;
      }
      for (const op of plan.ops) {
        if (op.done) continue;
        activeOp=op;
        if(plan.recovery && JSON.stringify(this.memberBan(plan.recovery.userId))!==JSON.stringify(plan.recovery.ban)){throw Object.assign(Error('成员已有新的处罚，验证解封已停止，请重新核对'),{retryable:false});}
        if(['banChatMember','unbanChatMember','declineChatJoinRequest'].includes(op.method)&&job.id.startsWith('verification-timeout:')&&!this.verification(op.params.user_id)){op.skipped='验证已由管理员通过';op.done=true;continue;}
        if(op.verificationPromptFor&&!this.verification(op.verificationPromptFor)){op.skipped='验证已完成，不发送旧验证提示';op.done=true;continue;}
        if(op.method==='restrictChatMember'&&plan.entry?.action==='welcome-and-verification-started'&&!this.verification(op.params.user_id)){op.skipped='验证已完成';op.done=true;continue;}
        if(op.local==='verification-release-complete'){this.write(`verification-pass:${op.userId}`,true,DAY);this.write(`member-ban:${op.userId}`,{action:'verification-released',jobId:job.id});plan.recovery.ban=this.memberBan(op.userId);
        } else if(op.local==='case-register'){await this.env.GUARD_STATE.getByName('admin').ensureCase(op.body);
        } else if(op.local==='federation-dispatch'){await this.env.GUARD_STATE.getByName('admin').dispatchFederation(op.caseId);
        } else if(op.local==='case-unban'){
          if(this.read(`ban-owner:${op.userId}`)===op.caseId){await tg('unbanChatMember',{chat_id:Number(op.chatId),user_id:Number(op.userId),only_if_banned:true});this.remove(`ban-owner:${op.userId}`);this.write(`member-ban:${op.userId}`,{action:'unbanned',jobId:job.id});this.allowMember(op.userId);op.undoOutcome='success';}
          else {op.skipped='没有本次封禁的所有权，保留其他封禁';op.undoOutcome='skipped';}
        } else if(op.local==='missed-record'){this.saveMissedRecord(op.body);
        } else if(op.local==='clearVerification'){
          if(this.verification(op.userId)?.expires===op.expires)this.clearVerification(op.userId);
        } else if(op.local==='notice-progress'){await this.env.GUARD_STATE.getByName('admin').noticeProgress(op.noticeId,op.line,true);
        } else if(op.local==='owner-report'){await this.env.GUARD_STATE.getByName('admin').noticeReport(op.body);
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
                if(job.id.startsWith('federation:')&&this.read('allow:'+op.params.user_id))op.skipped='管理员已信任该成员，不再次联防封禁';
                if(op.previouslyBanned===undefined){const member=await this.member(tg,op.params.chat_id,op.params.user_id);if(ADMIN_STATUS.includes(member.status)||this.owners().includes(String(op.params.user_id))) {op.skipped='目标是管理员或所有者';}op.previouslyBanned=member.status==='kicked';this.sql.exec('UPDATE jobs SET plan=? WHERE id=?',JSON.stringify(plan),job.id);}
                if(await this.env.GUARD_STATE.getByName('admin').caseReversed(op.trackCase))op.skipped='联防记录已撤销';
              }
              if(op.recoveryRestore){const fresh=await this.restoreMember(op.params.chat_id,op.params.user_id,tg);op.params=fresh.params;if(JSON.stringify(this.memberBan(plan.recovery.userId))!==JSON.stringify(plan.recovery.ban))throw Object.assign(Error('成员已有新的处罚，验证解封已停止'),{retryable:false});}
              if(!op.skipped){op.result = await tg(op.method, op.params);
                if(op.method==='banChatMember'){this.write(`member-ban:${op.params.user_id}`,{action:plan.entry?.action||'ban',jobId:job.id});if(op.trackCase && !op.previouslyBanned)this.write(`ban-owner:${op.params.user_id}`,op.trackCase);else this.remove(`ban-owner:${op.params.user_id}`);}
                if(op.method==='unbanChatMember'){this.remove(`ban-owner:${op.params.user_id}`);if(!plan.recovery)this.write(`member-ban:${op.params.user_id}`,{action:'unbanned',jobId:job.id});}
              }
              if (op.verificationPromptFor && Number.isSafeInteger(op.result?.message_id)) this.sql.exec('UPDATE verifications SET prompt_message_id=? WHERE user_id=?', op.result.message_id, String(op.verificationPromptFor));
              // Short-lived bot replies are removed later by a delayed job.
              if (op.cleanupAfter && Number.isSafeInteger(op.result?.message_id)) this.sql.exec('INSERT OR IGNORE INTO jobs(id,payload,plan,due,created) VALUES (?,?,?,?,?)', `cleanup:${op.params.chat_id}:${op.result.message_id}`, '{}', JSON.stringify({ ops: [{ method: 'deleteMessage', params: { chat_id: op.params.chat_id, message_id: op.result.message_id } }] }), Date.now() + op.cleanupAfter, Date.now());
            }
            catch (error) {
              if (op.method === 'deleteMessage' && error.code === 400 && /message to delete not found/i.test(error.message)) op.result = { alreadyAbsent: true };
              // Best-effort steps (a private prompt, a join request someone
              // else already handled) must not block or retry the whole plan.
              else if (op.optional && [400, 403].includes(error.code)) { op.skipped = String(error.message || '').slice(0, 120) || '未完成'; }
              else if(op.method==='deleteMessage' && plan.ops.some(x=>x.method==='banChatMember')){op.error=String(error.message).slice(0,200);this.sql.exec('UPDATE jobs SET plan=? WHERE id=?',JSON.stringify(plan),job.id);deferredDeleteError=error;continue;}
              else throw error;
            }
          }
        }
        op.done = true;op.doneAt=Date.now();delete op.error;
        this.sql.exec('UPDATE jobs SET plan=? WHERE id=?', JSON.stringify(plan), job.id);
        if(op.trackCase)await this.env.GUARD_STATE.getByName('admin').caseStatus(op.trackCase,op.params.chat_id,{status:op.skipped?'skipped':'success',error:null,owned:this.read(`ban-owner:${op.params.user_id}`)===op.trackCase});
      }
      if(deferredDeleteError)throw deferredDeleteError;
      for(const op of plan.ops.filter(x=>x.trackCase))await this.env.GUARD_STATE.getByName('admin').caseStatus(op.trackCase,op.params.chat_id,{status:op.skipped?'skipped':'success',error:null,owned:this.read(`ban-owner:${op.params.user_id}`)===op.trackCase});
      for(const op of plan.ops.filter(x=>x.local==='case-unban'))await this.env.GUARD_STATE.getByName('admin').caseStatus(op.caseId,op.chatId,{undoStatus:op.undoOutcome});
      if(plan.entry)this.recordInviteOutcome(plan.entry,plan.ops);
      this.write('health:last-completion',{at:new Date().toISOString(),latencyMs:Date.now()-job.created});
      if (plan.entry) this.log({ ...plan.entry, updateId:job.id, latencyMs:Date.now()-job.created, operationSteps:operationSteps(plan.ops,'done'), outcome: plan.ops.some(x => x.skipped) ? 'partial' : 'success', steps: plan.ops.map(x => ({ method: x.serviceCleanup ? 'deleteServiceMessage' : x.method || x.local, done: x.done, skipped: x.skipped, undoOutcome:x.undoOutcome, doneAt:x.doneAt })) });
      this.sql.exec("UPDATE jobs SET status='done',payload='{}',plan=NULL WHERE id=?", job.id);
      // Owner notice with an undo button. Manual admin bans and per-group
      // federation copies are left out; the source group's ban covers the case.
      if(plan.entry && !job.id.startsWith('federation:') && !['ban','kick','review-resolve-ban','verification-timeout-kick'].includes(plan.entry.action) && plan.ops.some(x=>x.method==='banChatMember'&&x.done&&!x.skipped))
        await this.env.GUARD_STATE.getByName('admin').noticeBan(this.withProfile(plan.entry)).catch(error=>this.log({action:'owner-notice',outcome:'failed',error:String(error.message||'').slice(0,200)}));
    } catch (error) {
      if(plan){if(plan.entry)this.recordInviteOutcome(plan.entry,plan.ops);const failedOp=activeOp&&!activeOp.done&&!activeOp.skipped?activeOp:plan.ops.find(x=>!x.done&&!x.skipped&&!x.error);if(failedOp)failedOp.error=String(error.message).slice(0,200);this.sql.exec('UPDATE jobs SET plan=? WHERE id=?',JSON.stringify(plan),job.id);}
      if(job.id.startsWith('verification-timeout:') && error.code===403){error.retryable=true;error.retryAfter=1800;}
      const attempts = job.attempts + 1;
      const retry = error.retryable !== false && attempts < 6 && Date.now() - job.created < DAY;
      const tracked=plan?.ops?.find(x=>x.trackCase && String(x.params.chat_id)===String(plan.entry?.chatId));
      if(plan?.entry?.caseId)await this.env.GUARD_STATE.getByName('admin').caseStatus(plan.entry.caseId,plan.entry.chatId,plan.entry.action==='federation-undo'?{undoStatus:retry?'retrying':'failed'}:tracked?.done?{status:tracked.skipped?'skipped':'success',owned:this.read(`ban-owner:${tracked.params.user_id}`)===tracked.trackCase,dispatchError:String(error.message||'').slice(0,200)}:{status:retry?'retrying':'failed',error:String(error.message||'').slice(0,200)}).catch(()=>{});
      const delay = Math.max(Number(error.retryAfter || 0) * 1000, Math.min(300000, 2000 * 2 ** attempts));
      this.sql.exec('UPDATE jobs SET attempts=?,status=?,due=? WHERE id=?', attempts, retry ? 'pending' : 'failed', Date.now() + delay, job.id);
      const failedUpdate = JSON.parse(job.payload); const msg = failedUpdate.message || failedUpdate.edited_message || failedUpdate.callback_query?.message;
      this.log({ ...(plan?.entry || {}), chatId: plan?.entry?.chatId || msg?.chat?.id, userId: plan?.entry?.userId || msg?.from?.id, action: plan?.entry?.action || '处理消息', outcome: retry ? 'retrying' : 'failed', error: String(error.message || 'unknown error').slice(0, 400), updateId: job.id, attempts, operationSteps:operationSteps(plan?.ops,retry?'pending':'failed'), steps: plan?.ops.map(x => ({ method: x.method || x.local, done: !!x.done, skipped:x.skipped, undoOutcome:x.undoOutcome, doneAt:x.doneAt })) || [] });
      // Permanent failures remain visible without retaining full incoming messages indefinitely.
      if (!retry) {
        this.sql.exec("UPDATE jobs SET payload='{}' WHERE id=?", job.id);
        if(plan?.entry?.noticeId)await this.env.GUARD_STATE.getByName('admin').noticeProgress(plan.entry.noticeId,'❌ 解封失败：'+String(error.message||'未知错误').slice(0,150)+'。请到群里手动解封，或检查机器人是否还有封禁权限。',true).catch(()=>{});
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
  // Fill in the name and @username remembered for a member, for owner notices.
  withProfile(entry) {
    const profile = /^\d{1,16}$/.test(String(entry.userId)) ? this.sql.exec('SELECT username,name FROM member_profiles WHERE user_id=?', String(entry.userId)).toArray()[0] : null;
    return { ...entry, userName: entry.userName || profile?.name || '', userUsername: entry.userUsername || profile?.username || '' };
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
  async privileged(tg, chatId, userId) {
    if (this.owners().includes(String(userId))) return true;
    // Do not interpret an API error as "not an admin".
    return ADMIN_STATUS.includes((await this.member(tg, chatId, userId)).status);
  }
}

// GuardState is split across src/state/*.js by feature. Copy each module's
// methods onto the class so RPC callers and `this.method()` see one object.
for (const mixin of [QuietMethods, RegistryMethods, FederationMethods, ReportsMethods, SamplesMethods, MonitorsMethods, VerificationMethods, ModerationMethods, SettingsMethods, BackupMethods, AuthMethods, ScreeningMethods, NoticesMethods, CommunityMethods, AppealMethods, OperationsMethods]) {
  for (const name of Object.getOwnPropertyNames(mixin.prototype)) {
    if (name === 'constructor') continue;
    if (Object.hasOwn(GuardState.prototype, name)) throw new Error('Duplicate GuardState method: ' + name);
    Object.defineProperty(GuardState.prototype, name, Object.getOwnPropertyDescriptor(mixin.prototype, name));
  }
}
