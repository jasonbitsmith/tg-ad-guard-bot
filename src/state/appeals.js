// Ban appeals: a banned member messages the bot privately, taps a button,
// and the owner gets the appeal with 解封 / 驳回 buttons. Runs on the global
// admin object, except appealBanInfo which each group answers for itself.
// Methods are copied onto GuardState.prototype in ../state.js.
import { telegram } from '../telegram.js';
import { DAY } from './shared.js';

const APPEALS_PER_HOUR = 20;
const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const REASONS = [['cas', '全网广告号黑名单'], ['profile', '昵称或简介含广告'], ['verification-timeout', '入群验证超时'], ['content-lock', '违反内容限制'], ['federation', '其他群联防同步'], ['spam', '管理员确认广告'], ['review', '管理员确认广告'], ['ban', '管理员手动封禁']];
const reasonLabel = action => REASONS.find(([key]) => String(action).includes(key))?.[1] || '发布广告';

export class AppealMethods {
  // Group object: is this person banned here, and why.
  appealBanInfo(userId) {
    const ban = this.memberBan(userId), chat = this.read('chat');
    if (!ban || !chat?.id) return null;
    return { chatId: String(chat.id), title: chat.title || String(chat.id), reason: reasonLabel(ban.action) };
  }
  async appealBans(userId) {
    const chats = this.listChats();
    const results = await Promise.allSettled(chats.map(chat => this.env.GUARD_STATE.getByName('chat:' + chat.id).appealBanInfo(userId)));
    return results.filter(item => item.status === 'fulfilled' && item.value).map(item => item.value);
  }
  // A private /start or /appeal from someone who is not an owner.
  async appealStart(user, chatId) {
    const tg = telegram(this.env.BOT_TOKEN), userId = String(user.id);
    const bans = await this.appealBans(userId), state = this.read(`appeal:${userId}`);
    let text, keyboard;
    if (!bans.length) text = '👋 你好！你目前没有被本机器人封禁的记录。\n\n如果是在申请入群，请按之前收到的验证消息完成验证。';
    else if (state?.status === 'pending') text = '⏳ 你的申诉已经提交，管理员处理后会在这里通知你，请耐心等待。';
    else if (state?.status === 'rejected') text = '❌ 你的上一次申诉未通过。7 天后可以再次申诉。';
    else {
      text = ['🚫 <b>你在以下群被封禁</b>', '', ...bans.map(item => `• ${esc(item.title)}（原因：${esc(item.reason)}）`), '', '如果你认为是误封，点下面的按钮提交申诉，管理员会尽快处理。'].join('\n');
      keyboard = [[{ text: '📮 提交申诉', callback_data: 'ap:go' }]];
    }
    await tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}) });
    return { bans: bans.length };
  }
  async appealSubmit(callback) {
    const tg = telegram(this.env.BOT_TOKEN), user = callback.from, userId = String(user?.id || '');
    const answer = (text, alert = false) => tg('answerCallbackQuery', { callback_query_id: callback.id, text, show_alert: alert }).catch(() => {});
    if (callback.data !== 'ap:go' || !/^\d{1,16}$/.test(userId) || callback.message?.chat?.type !== 'private') return answer('无效操作。', true);
    const state = this.read(`appeal:${userId}`);
    if (state?.status === 'pending') return answer('申诉已提交，请等待管理员处理。', true);
    if (state?.status === 'rejected') return answer('上一次申诉未通过，7 天后可以再次申诉。', true);
    const bans = await this.appealBans(userId);
    if (!bans.length) return answer('你目前没有封禁记录，无需申诉。', true);
    const hour = Math.floor(Date.now() / 3600000), rateKey = `appeal-rate:${hour}`, count = this.read(rateKey, 0) + 1;
    this.write(rateKey, count, 2 * 3600000);
    if (count > APPEALS_PER_HOUR) return answer('现在申诉的人太多了，请一小时后再试。', true);
    const recipients = this.ownerChats();
    if (!recipients.length) return answer('暂时无法提交申诉，请稍后再试。', true);
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
    const person = `<a href="tg://user?id=${userId}">${esc(name || '用户')}</a>${user.username ? ` <a href="https://t.me/${user.username}">@${esc(user.username)}</a>` : ''}（${userId}）`;
    const text = ['📮 <b>解封申诉</b>', '', `申请人：${person}`, '被封的群：', ...bans.map(item => `• ${esc(item.title)}（${esc(item.reason)}）`), '', '确认是误封就点「解封」，此人会在这些群里被解封并加入信任名单。'].join('\n');
    const delivered = await this.sendNotice(recipients, text, [['✅ 解封并信任', 'accept'], ['❌ 驳回', 'reject']], { kind: 'appeal', userId, userChat: Number(callback.message.chat.id), chats: bans.map(item => item.chatId) }, null, { userId, username: user.username });
    if (!delivered) return answer('提交失败，请稍后再试。', true);
    this.write(`appeal:${userId}`, { status: 'pending', at: Date.now() }, 7 * DAY);
    this.log({ action: 'appeal-submitted', userId, outcome: 'success', text: bans.map(item => item.title).join('、').slice(0, 200) });
    await tg('editMessageText', { chat_id: callback.message.chat.id, message_id: callback.message.message_id, text: '✅ <b>申诉已提交</b>\n\n管理员处理后会在这里通知你。', parse_mode: 'HTML' }).catch(() => {});
    return answer('申诉已提交');
  }
  // Owner tapped 解封 or 驳回 on an appeal notice. Returns the result line.
  async resolveAppeal(record, accept, actor) {
    const tg = telegram(this.env.BOT_TOKEN);
    if (accept) {
      const results = await Promise.allSettled(record.chats.map(chatId => this.env.GUARD_STATE.getByName('chat:' + chatId).queueManualUnban(record.userId, actor, null)));
      const failed = results.filter(item => item.status === 'rejected').length;
      this.remove(`appeal:${record.userId}`);
      await tg('sendMessage', { chat_id: record.userChat, text: '✅ <b>申诉通过</b>\n\n你已被解封，现在可以重新申请加入群了。', parse_mode: 'HTML' }).catch(() => {});
      return { result: `已解封并信任此人（${record.chats.length - failed}/${record.chats.length} 个群已提交）`, pending: failed ? `⚠️ 有 ${failed} 个群没能提交解封，请到群里手动解封` : 'ℹ️ 已通知申请人' };
    }
    this.write(`appeal:${record.userId}`, { status: 'rejected', at: Date.now() }, 7 * DAY);
    await tg('sendMessage', { chat_id: record.userChat, text: '❌ <b>申诉未通过</b>\n\n管理员核实后维持封禁。7 天后可以再次申诉。', parse_mode: 'HTML' }).catch(() => {});
    return { result: '已驳回申诉', pending: 'ℹ️ 已通知申请人' };
  }
}
