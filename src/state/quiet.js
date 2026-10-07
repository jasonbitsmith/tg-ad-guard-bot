// Quiet hours: scheduled group muting and its notices.
// Methods are copied onto GuardState.prototype in ../state.js.
import { telegram } from '../telegram.js';

export class QuietMethods {
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

  async runQuietMaintenance() {
    const chats = this.listChats();
    const attempts = await Promise.allSettled(chats.map(chat => this.env.GUARD_STATE.getByName(`chat:${chat.id}`).quietTick()));
    const switched = attempts.filter(item => item.status === 'fulfilled' && item.value === true).length;
    const failed = attempts.filter(item => item.status === 'rejected').length;
    if (failed) this.log({ action: 'quiet-maintenance', outcome: 'failed', errors: failed });
    return { checked: chats.length, switched, failed };
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
}
