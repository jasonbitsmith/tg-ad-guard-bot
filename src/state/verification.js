// New-member verification and member records.
// Methods are copied onto GuardState.prototype in ../state.js.
import { telegram } from '../telegram.js';
import { DAY, ADMIN_STATUS } from './shared.js';

export const VERIFICATION_MODES = ['channel', 'button', 'math'];
const MAX_ATTEMPTS = 3;
const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const verificationMinutes = config => Math.max(1, Math.min(60, Number(config.verificationMinutes || 10)));

export class VerificationMethods {
  // Math answers are typed into the group, so only that mode keeps text;
  // button and channel modes are answered with buttons and need no sending.
  verificationPermissions(mode = 'math') {
    return { can_send_messages: mode === 'math', can_send_audios: false, can_send_documents: false, can_send_photos: false, can_send_videos: false, can_send_video_notes: false, can_send_voice_notes: false, can_send_polls: false, can_send_other_messages: false, can_add_web_page_previews: false, can_change_info: false, can_invite_users: false, can_pin_messages: false, can_manage_topics: false };
  }
  verificationMode(config) { return VERIFICATION_MODES.includes(config.verificationMode) ? config.verificationMode : 'off'; }
  timeoutAction(config) { return config.verificationTimeoutAction === 'kick' ? 'kick' : 'ban'; }
  // Question, text and buttons for one challenge. `request` is set when the
  // challenge is sent privately for a join request instead of in the group.
  verificationChallenge(member, mode, minutes, config, request = null) {
    const name = esc(String(member.first_name || '新朋友').slice(0, 40));
    const who = request ? name : `<a href="tg://user?id=${member.id}">${name}</a>`;
    const channel = String(config.verificationChannel || '').trim();
    const ending = request ? '超时申请会被自动拒绝，之后可以重新申请。' : this.timeoutAction(config) === 'kick' ? '超时将被移出本群，之后可以重新加入。' : '超时将自动封禁。';
    const head = request ? `🛡 入群验证：${esc(request.title || '本群')}` : '🛡 新成员验证';
    if (mode === 'channel') {
      const check = request ? `vj:${request.id}:c` : `verify:channel:${member.id}`;
      const text = `${head}\n欢迎 ${who}！为防止广告账号，请完成以下两步：\n\n① 点击下方第一个按钮，打开 ${esc(channel)}，在频道底部点击“加入 / Join”。\n② 返回这里，点击“已加入，完成验证”${request ? '，即可自动通过入群申请' : '，即可恢复正常发言'}。\n\n已订阅的用户可直接点击第二个按钮。\n请在 ${minutes} 分钟内完成；${ending}`;
      return { answer: null, text, keyboard: [[{ text: '① 打开频道，点击加入', url: `https://t.me/${channel.slice(1)}` }], [{ text: '② 已加入，完成验证', callback_data: check }]] };
    }
    const left = 2 + Math.floor(Math.random() * 8), right = 1 + Math.floor(Math.random() * 8), answer = left + right;
    if (mode === 'math' && !request) {
      return { answer: String(answer), keyboard: null, text: `${head}\n${who}，请在 ${minutes} 分钟内直接发送答案：${left} + ${right} = ?\n最多可以答 ${MAX_ATTEMPTS} 次；验证期间仅可发送文字；${ending}` };
    }
    const choices = new Set([answer]);
    while (choices.size < 4) { const wrong = answer + Math.floor(Math.random() * 9) - 4; if (wrong > 0 && wrong !== answer) choices.add(wrong); }
    const buttons = [...choices].sort(() => Math.random() - 0.5).map(value => ({ text: String(value), callback_data: request ? `vj:${request.id}:p:${value}` : `verify:pick:${member.id}:${value}` }));
    return { answer: String(answer), keyboard: [buttons], text: `${head}\n${who}，请在 ${minutes} 分钟内点击正确答案：${left} + ${right} = ?\n最多可以点 ${MAX_ATTEMPTS} 次；${ending}` };
  }
  // Count a wrong answer. Once the attempts are used up the challenge expires
  // now, so the next alarm applies the same timeout handling.
  verificationWrongAnswer(userId) {
    const pending = this.verification(userId);
    if (!pending) return 0;
    const attempts = Number(pending.attempts || 0) + 1, left = Math.max(0, MAX_ATTEMPTS - attempts);
    this.sql.exec('UPDATE verifications SET attempts=?,expires=? WHERE user_id=?', attempts, left ? pending.expires : Date.now(), String(userId));
    return left;
  }
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
  async startVerification(member, msg, config, tg, forceMode = null) {
    const pass=this.read(`verification-pass:${member.id}`);
    if(pass){this.remove(`verification-pass:${member.id}`);return null;}
    const mode = forceMode || this.verificationMode(config);
    if (mode === 'off' || member.is_bot) return null;
    if (mode === 'channel' && !/^@[a-zA-Z0-9_]{5,}$/.test(String(config.verificationChannel || '').trim())) return null;
    const status = await this.member(tg, msg.chat.id, member.id);
    if (ADMIN_STATUS.includes(status.status) || this.owners().includes(String(member.id))) return null;
    const minutes = verificationMinutes(config), expires = Date.now() + minutes * 60000;
    const challenge = this.verificationChallenge(member, mode, minutes, config);
    this.sql.exec('INSERT OR REPLACE INTO verifications(user_id,answer,prompt_message_id,expires,mode,channel,attempts,via,prompt_chat_id) VALUES (?,?,?,?,?,?,0,?,?)', String(member.id), challenge.answer, null, expires, mode, mode === 'channel' ? config.verificationChannel.trim() : null, 'group', msg.chat.id);
    return { member, mode, expires, ...challenge };
  }
  // A join request (group set to "approve new members"): verify privately
  // first, then approve. Unverified accounts never get into the group.
  async joinRequestPlan(request) {
    const empty = { ops: [] }, chat = request.chat, user = request.from;
    if (!chat || !Number.isSafeInteger(user?.id) || user.is_bot) return empty;
    this.write('chat', chat);
    this.rememberMember(user);
    const config = await this.config(), mode = this.verificationMode(config);
    if (mode === 'off') return empty;
    const tg = telegram(this.env.BOT_TOKEN), entry = { chatId: chat.id, chatTitle: chat.title || '', userId: String(user.id), userName: [user.first_name, user.last_name].filter(Boolean).join(' ') };
    const decline = { method: 'declineChatJoinRequest', params: { chat_id: chat.id, user_id: user.id }, optional: true };
    const screen = await this.screenMember(user, config, tg);
    if (screen) return this.screenBanPlan(chat, user, screen, [], { ops: [decline] });
    const approve = { method: 'approveChatJoinRequest', params: { chat_id: chat.id, user_id: user.id }, optional: true };
    if (this.read(`verification-pass:${user.id}`) || this.read(`allow:${user.id}`) || this.owners().includes(String(user.id))) {
      return { ops: [approve], entry: { ...entry, action: 'join-request-approved', outcome: 'pending', reasons: ['已信任成员，免验证'] } };
    }
    if (mode === 'channel' && !/^@[a-zA-Z0-9_]{5,}$/.test(String(config.verificationChannel || '').trim())) return empty;
    const minutes = verificationMinutes(config), expires = Date.now() + minutes * 60000, dm = request.user_chat_id || user.id;
    const challenge = this.verificationChallenge(user, mode, minutes, config, { id: chat.id, title: chat.title });
    this.sql.exec('INSERT OR REPLACE INTO verifications(user_id,answer,prompt_message_id,expires,mode,channel,attempts,via,prompt_chat_id) VALUES (?,?,?,?,?,?,0,?,?)', String(user.id), challenge.answer, null, expires, mode, mode === 'channel' ? config.verificationChannel.trim() : null, 'request', dm);
    return { ops: [{ method: 'sendMessage', params: { chat_id: dm, text: challenge.text, parse_mode: 'HTML', reply_markup: { inline_keyboard: challenge.keyboard } }, verificationPromptFor: user.id, optional: true }], entry: { ...entry, action: 'join-request-verification-started', outcome: 'pending', reasons: [`${mode} 私聊验证`] } };
  }
  // Buttons on a challenge, in the group or in the private chat.
  async verificationCallbackPlan(callback) {
    const data = String(callback?.data || ''), message = callback?.message;
    const toast = (text, alert = false) => ({ method: 'answerCallbackQuery', params: { callback_query_id: callback.id, text, show_alert: alert } });
    const inGroup = /^verify:(channel|pick):(\d{1,16})(?::(\d{1,3}))?$/.exec(data), inPrivate = /^vj:(-\d{1,16}):(c|p)(?::(\d{1,3}))?$/.exec(data);
    if (!message?.chat || (!inGroup && !inPrivate)) return { ops: [toast('验证请求无效。', true)] };
    if (inGroup && String(callback.from?.id) !== inGroup[2]) return { ops: [toast('这是其他新成员的验证，请勿点击。', true)] };
    const kind = inGroup ? (inGroup[1] === 'channel' ? 'channel' : 'pick') : (inPrivate[2] === 'c' ? 'channel' : 'pick');
    const choice = (inGroup || inPrivate)[3], via = inGroup ? 'group' : 'request';
    const pending = this.verification(callback.from.id);
    if (!pending || pending.expires <= Date.now() || (pending.via || 'group') !== via || (kind === 'channel') !== (pending.mode === 'channel')) return { ops: [toast(via === 'request' ? '该验证已失效，请重新申请加入。' : '该验证已失效，请联系管理员。', true)] };
    const tg = telegram(this.env.BOT_TOKEN), chatId = via === 'group' ? message.chat.id : Number(inPrivate[1]);
    if (kind === 'channel') {
      const joined = await this.member(tg, pending.channel, callback.from.id).catch(() => null);
      if (!joined) return { ops: [toast('暂时无法检查订阅状态，请稍后重试；若一直失败，请联系管理员检查频道权限。', true)] };
      if (['left', 'kicked'].includes(joined.status) || joined.status === 'restricted' && joined.is_member !== true) return { ops: [toast(`还没有检测到订阅。请点击第一个按钮打开 ${pending.channel}，在频道底部点击“加入 / Join”，再点击第二个按钮。`, true)] };
    } else if (choice !== pending.answer) {
      const left = this.verificationWrongAnswer(callback.from.id);
      return { ops: [toast(left ? `答案不对，还可以再试 ${left} 次。` : (via === 'request' ? '答错次数过多，本次申请将被拒绝，之后可以重新申请。' : '答错次数过多，验证失败。'), true)], entry: { chatId, userId: callback.from.id, action: 'verification-answer-rejected', outcome: 'pending', reasons: [left ? `答案不正确，剩余 ${left} 次` : '答错次数用完'] } };
    }
    this.clearVerification(callback.from.id);
    const reason = pending.mode === 'channel' ? `频道验证：${pending.channel}` : '按钮答题验证';
    if (via === 'request') {
      this.write(`verification-pass:${callback.from.id}`, true, DAY);
      const chat = this.read('chat', {});
      return { ops: [toast('验证通过，已批准入群！'), { method: 'approveChatJoinRequest', params: { chat_id: chatId, user_id: callback.from.id } }, { method: 'editMessageText', params: { chat_id: message.chat.id, message_id: message.message_id, text: `✅ 验证通过，已批准你加入「${chat.title || '本群'}」。` }, optional: true }], entry: { chatId, chatTitle: chat.title || '', userId: callback.from.id, action: 'join-request-approved', outcome: 'pending', reasons: [reason] } };
    }
    const restore = await this.restoreMember(chatId, callback.from.id, tg);
    return { ops: [toast('验证通过，欢迎加入！'), restore, { method: 'deleteMessage', params: { chat_id: chatId, message_id: message.message_id } }], entry: { chatId, chatTitle: message.chat.title || '', userId: callback.from.id, action: 'verification-passed', outcome: 'pending', reasons: [reason] } };
  }
  verification(userId) { return this.sql.exec('SELECT * FROM verifications WHERE user_id=?', String(userId)).toArray()[0]; }
  clearVerification(userId) { this.sql.exec('DELETE FROM verifications WHERE user_id=?', String(userId)); }
  async restoreMember(chatId, userId, tg) {
    const chat = await tg('getChat', { chat_id: chatId });
    if (!chat.permissions) throw new Error('无法读取群默认权限，未解除验证限制');
    return { method: 'restrictChatMember', params: { chat_id: chatId, user_id: Number(userId), permissions: chat.permissions, use_independent_chat_permissions: true } };
  }
}
