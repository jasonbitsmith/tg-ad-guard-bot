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
    const rows = [];
    if (buttons?.length) rows.push(buttons.map(([caption, act]) => ({ text: caption, callback_data: `n:${id}:${act}` })));
    if (link) rows.push([{ text: '查看原消息', url: link }]);
    const tg = telegram(this.env.BOT_TOKEN), body = text.slice(0, 3500);
    const sent = await Promise.allSettled(recipients.map(chatId => tg('sendMessage', { chat_id: chatId, text: body, disable_web_page_preview: true, ...(rows.length ? { reply_markup: { inline_keyboard: rows } } : {}) })));
    // Keep every copy so a later result can be written onto each of them.
    if (record) this.write(`notice:${id}`, { ...record, text: body, link: link || null, messages: sent.map(item => item.status === 'fulfilled' && Number.isSafeInteger(item.value?.message_id) ? { chatId: item.value.chat?.id ?? null, messageId: item.value.message_id } : null).map((item, index) => item && { ...item, chatId: item.chatId ?? recipients[index] }).filter(Boolean) }, 14 * DAY);
    return sent.some(item => item.status === 'fulfilled');
  }
  noticeTime() { return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date()); }
  // Rewrites every copy of a notice with its current status and removes the
  // action buttons, so a tap always leaves a visible result on the message.
  async renderNotice(id, fallbackMessage) {
    const record = this.read(`notice:${id}`);
    if (!record) return false;
    const status = record.status?.length ? record.status : record.done ? [`✅ ${record.done}`] : [];
    const text = `${record.text || fallbackMessage?.text || ''}\n\n${status.join('\n')}`.slice(0, 4000);
    const markup = record.link ? { reply_markup: { inline_keyboard: [[{ text: '查看原消息', url: record.link }]] } } : {};
    const messages = record.messages?.length ? record.messages : fallbackMessage?.chat?.id ? [{ chatId: fallbackMessage.chat.id, messageId: fallbackMessage.message_id }] : [];
    const tg = telegram(this.env.BOT_TOKEN);
    const results = await Promise.allSettled(messages.map(item => tg('editMessageText', { chat_id: item.chatId, message_id: item.messageId, text, disable_web_page_preview: true, ...markup })));
    // If the original cannot be edited, the result still reaches the owner.
    for (const [index, result] of results.entries()) if (result.status === 'rejected' && !/message is not modified/i.test(result.reason?.message || '')) await tg('sendMessage', { chat_id: messages[index].chatId, text: status.at(-1) || '已处理', reply_to_message_id: messages[index].messageId, allow_sending_without_reply: true }).catch(() => {});
    return true;
  }
  async noticeProgress(id, line, final) {
    const key = `notice:${id}`, record = this.read(key);
    if (!record) return false;
    record.status = [...(record.status || []).filter(item => !item.startsWith('⏳')), line];
    if (final) record.finished = true;
    this.write(key, record, 14 * DAY);
    return this.renderNotice(id);
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
    const answer = (text, alert = false) => tg('answerCallbackQuery', { callback_query_id: callback.id, text: text.slice(0, 190), show_alert: alert }).catch(() => {});
    const match = /^n:([a-f0-9]{16}):(ban|ignore|undo)$/.exec(String(callback.data || ''));
    if (!match || !this.owners().includes(String(callback.from?.id))) return answer('只有机器人所有者可以操作。', true);
    const id = match[1], key = `notice:${id}`, record = this.read(key);
    if (!record) return answer('这条记录已过期，请到管理后台处理。', true);
    // Notices sent before message tracking existed: adopt the tapped copy.
    if (!record.messages?.length && callback.message?.chat?.id) { record.messages = [{ chatId: callback.message.chat.id, messageId: callback.message.message_id }]; record.text = record.text || String(callback.message.text || '').split('\n\n✅')[0]; this.write(key, record, 14 * DAY); }
    if (record.done) { await this.renderNotice(id, callback.message); return answer('已经处理过了：' + record.done, true); }
    const group = this.env.GUARD_STATE.getByName('chat:' + record.chatId);
    const who = [callback.from.first_name, callback.from.last_name].filter(Boolean).join(' ') || String(callback.from.id), when = this.noticeTime();
    let result, pending;
    try {
      if (record.kind === 'report' && match[2] === 'ignore') result = '已忽略，不做处理';
      else if (record.kind === 'report' && match[2] === 'ban') { await group.queueReview(record.chatId, Number(record.userId), record.messageId); result = '已提交删除消息并永久封禁，执行结果可在管理后台查看'; }
      else if (record.kind === 'ban' && match[2] === 'undo') {
        if (record.caseId && this.read(`federation-case:${record.caseId}`)) {
          const reversed = await this.reverseCase(record.caseId);
          await Promise.allSettled(reversed.record.groups.map(item => this.env.GUARD_STATE.getByName('chat:' + item.chatId).allowMember(record.userId)));
          result = `已撤销封禁并信任此人（联防的 ${reversed.record.groups.length} 个群）`;
          pending = reversed.failed ? `⚠️ 有 ${reversed.failed} 个群没能提交解封，请到管理后台“联防记录”重试` : 'ℹ️ 各群正在解封，结果可在管理后台“联防记录”查看';
        } else {
          await group.queueManualUnban(record.userId, 'telegram:' + callback.from.id, id);
          result = '已撤销封禁并信任此人';
          pending = '⏳ 正在解封…';
        }
      } else return answer('操作无效。', true);
    } catch (error) {
      const reason = String(error.message || '未知错误').slice(0, 150);
      record.status = [...(record.status || []), `❌ 操作失败（${when}）：${reason}`];
      this.write(key, record, 14 * DAY);
      await this.renderNotice(id, callback.message);
      return answer('操作失败：' + reason, true);
    }
    record.done = result;
    record.status = [...(record.status || []), `✅ ${result}（${who} · ${when}）`, ...(pending ? [pending] : [])];
    this.write(key, record, 14 * DAY);
    this.log({ action: `notice-${record.kind}-${match[2]}`, chatId: record.chatId, userId: record.userId, actorId: 'telegram:' + callback.from.id, outcome: 'success' });
    await this.renderNotice(id, callback.message);
    return answer('✅ ' + result);
  }
}
