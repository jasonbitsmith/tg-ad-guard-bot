// Real-time notices to the owner: every automatic ban (with an undo button)
// and every member /report (with ban / ignore buttons).
// Runs on the global admin object. Methods are copied onto GuardState.prototype in ../state.js.
import { telegram } from '../telegram.js';
import { DAY } from './shared.js';

const NOTICE_HOURLY_LIMIT = 60;
const ACTION_LABELS = { cas: '全网广告号黑名单', profile: '昵称/简介广告', 'content-lock': '内容限制', 'verification-timeout-ban': '验证超时', 'spam-delete-and-permanent-ban': '管理员 /spam' };
const label = action => Object.entries(ACTION_LABELS).find(([key]) => String(action).startsWith(key))?.[1] || '广告命中';
const messageLink = (chatId, messageId) => /^-100\d+$/.test(String(chatId)) && Number.isSafeInteger(Number(messageId)) && Number(messageId) > 0 ? `https://t.me/c/${String(chatId).slice(4)}/${messageId}` : null;

export class NoticesMethods {
  logTarget() { return this.read('log-target', 'owners'); }
  async setLogTarget(value) {
    const raw = String(value || '').trim();
    const target = /^(off|关闭)$/i.test(raw) ? 'off' : /^(me|on|开启)$/i.test(raw) ? 'owners' : /^@[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(raw) || /^-100\d{5,16}$/.test(raw) ? raw : null;
    if (!target) throw new Error('请发送 /log me（发给我）、/log @频道用户名（发到频道）或 /log off（关闭）');
    if (target !== 'off' && target !== 'owners') {
      try { await telegram(this.env.BOT_TOKEN)('sendMessage', { chat_id: target, text: '✅ 处理记录将发送到这里。' }); }
      catch { throw new Error('无法向该频道发消息。请先把机器人加为频道管理员（需要“发消息”权限），再重试。'); }
    }
    this.write('log-target', target);
    this.log({ action: 'log-target', actorId: 'telegram-owner', outcome: 'success', text: target });
    return target;
  }
  describeLogTarget(target = this.logTarget()) { return target === 'off' ? '已关闭' : target === 'owners' ? '私信发给你' : `发到 ${target}`; }

  async sendNotice(recipients, text, buttons, record, link) {
    const id = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
    if (record) this.write(`notice:${id}`, record, 14 * DAY);
    const rows = [];
    if (buttons?.length) rows.push(buttons.map(([caption, act]) => ({ text: caption, callback_data: `n:${id}:${act}` })));
    if (link) rows.push([{ text: '查看原消息', url: link }]);
    const tg = telegram(this.env.BOT_TOKEN);
    const sent = await Promise.allSettled(recipients.map(chatId => tg('sendMessage', { chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true, ...(rows.length ? { reply_markup: { inline_keyboard: rows } } : {}) })));
    return sent.some(item => item.status === 'fulfilled');
  }
  ownerChats() { return this.owners().filter(id => /^\d{1,16}$/.test(id)).map(Number); }

  async noticeBan(entry) {
    const target = this.logTarget();
    if (target === 'off') return false;
    const recipients = target === 'owners' ? this.ownerChats() : [target];
    if (!recipients.length) return false;
    const hour = Math.floor(Date.now() / 3600000), rateKey = `notice-rate:${hour}`, count = this.read(rateKey, 0) + 1;
    this.write(rateKey, count, 2 * 3600000);
    if (count > NOTICE_HOURLY_LIMIT) {
      if (count === NOTICE_HOURLY_LIMIT + 1) await this.sendNotice(recipients, `⚠️ 这一小时处理次数超过 ${NOTICE_HOURLY_LIMIT} 次，暂停逐条通知，可在管理后台查看全部记录。`);
      return false;
    }
    const text = [`🚫 已封禁：${entry.userName || '用户'}（${entry.userId}）`, `群：${entry.chatTitle || entry.chatId}`, `原因：${label(entry.action)}${entry.reasons?.length ? ' · ' + entry.reasons.slice(0, 3).join('；') : ''}`, entry.federationTargets?.length ? `联防：已同步到另外 ${entry.federationTargets.length} 个群` : '', entry.text ? `内容：${String(entry.text).slice(0, 200)}` : ''].filter(Boolean).join('\n');
    return this.sendNotice(recipients, text, [['↩️ 误封，解封并信任', 'undo']], { kind: 'ban', chatId: String(entry.chatId), userId: String(entry.userId), caseId: entry.caseId || null }, null);
  }

  async noticeReport(report) {
    const recipients = this.ownerChats();
    if (!recipients.length) return false;
    const text = [`📣 群友举报`, `群：${report.chatTitle || report.chatId}`, `被举报：${report.userName || '用户'}（${report.userId}）`, `举报人：${report.reporterName || report.reporterId}`, report.reason ? `理由：${report.reason}` : '', `内容：${String(report.text || '（非文字消息）').slice(0, 300)}`].filter(Boolean).join('\n');
    return this.sendNotice(recipients, text, [['🚫 删除并封禁', 'ban'], ['✅ 不是广告', 'ignore']], { kind: 'report', chatId: String(report.chatId), userId: String(report.userId), messageId: Number(report.messageId) }, messageLink(report.chatId, report.messageId));
  }

  async noticeAction(callback) {
    const tg = telegram(this.env.BOT_TOKEN);
    const answer = text => tg('answerCallbackQuery', { callback_query_id: callback.id, text: text.slice(0, 190), show_alert: true }).catch(() => {});
    const match = /^n:([a-f0-9]{16}):(ban|ignore|undo)$/.exec(String(callback.data || ''));
    if (!match || !this.owners().includes(String(callback.from?.id))) return answer('只有机器人所有者可以操作。');
    const key = `notice:${match[1]}`, record = this.read(key);
    if (!record) return answer('这条记录已过期，请到管理后台处理。');
    if (record.done) return answer('已处理过：' + record.done);
    const group = this.env.GUARD_STATE.getByName('chat:' + record.chatId);
    let result;
    try {
      if (record.kind === 'report' && match[2] === 'ignore') result = '已忽略';
      else if (record.kind === 'report' && match[2] === 'ban') { await group.queueReview(record.chatId, Number(record.userId), record.messageId); result = '已删除消息并封禁'; }
      else if (record.kind === 'ban' && match[2] === 'undo') {
        if (record.caseId && this.read(`federation-case:${record.caseId}`)) {
          const reversed = await this.reverseCase(record.caseId);
          await Promise.allSettled(reversed.record.groups.map(item => this.env.GUARD_STATE.getByName('chat:' + item.chatId).allowMember(record.userId)));
        } else await group.queueManualUnban(record.userId, 'telegram:' + callback.from.id);
        result = '已解封并加入白名单';
      } else return answer('操作无效。');
    } catch (error) { return answer('操作未完成：' + String(error.message || '').slice(0, 150)); }
    record.done = result;
    this.write(key, record, 14 * DAY);
    this.log({ action: `notice-${record.kind}-${match[2]}`, chatId: record.chatId, userId: record.userId, actorId: 'telegram:' + callback.from.id, outcome: 'success' });
    if (callback.message?.chat?.id) await tg('editMessageText', { chat_id: callback.message.chat.id, message_id: callback.message.message_id, text: `${String(callback.message.text || '').slice(0, 3800)}\n\n✅ ${result}`, disable_web_page_preview: true }).catch(() => {});
    return answer(result);
  }
}
