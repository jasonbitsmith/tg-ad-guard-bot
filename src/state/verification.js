// New-member verification and member records.
// Methods are copied onto GuardState.prototype in ../state.js.
import { telegram } from '../telegram.js';
import { DAY, ADMIN_STATUS } from './shared.js';

export class VerificationMethods {
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
}
