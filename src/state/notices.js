// Real-time notices to the owner: every automatic ban (with an undo button)
// and every member /report (with ban / ignore buttons).
// Runs on the global admin object. Methods are copied onto GuardState.prototype in ../state.js.
import { telegram } from '../telegram.js';
import { DAY } from './shared.js';

const NOTICE_HOURLY_LIMIT = 60;
const ACTION_LABELS = { cas: '全网广告号黑名单', profile: '昵称/简介广告', 'content-lock': '内容限制', 'verification-timeout-ban': '验证超时', 'spam-delete-and-permanent-ban': '管理员 /spam' };
const label = action => Object.entries(ACTION_LABELS).find(([key]) => String(action).startsWith(key))?.[1] || '广告命中';
const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
// Name opens the member's profile; @username (when known) is a plain t.me link
// that works even when their privacy settings hide the profile link.
const person = (name, userId, username) => {
  const id = String(userId || '');
  const label = esc(name || '用户');
  const linked = /^\d{1,16}$/.test(id) ? `<a href="tg://user?id=${id}">${label}</a>` : label;
  const handle = /^[a-zA-Z][a-zA-Z0-9_]{3,31}$/.test(String(username || '')) ? ` <a href="https://t.me/${username}">@${esc(username)}</a>` : '';
  return `${linked}${handle}（${esc(id)}）`;
};
const ACTION_NAMES = [['user-report', '被群友举报'], ['verification-timeout', '验证超时被封'], ['verification-passed', '通过入群验证'], ['verification-left', '验证前自行退群'], ['welcome', '入群'], ['owner-undo', '被你解封'], ['federation-undo', '联防解封'], ['federation-ban', '联防封禁'], ['permanent-ban', '因广告被封'], ['delete-channel', '频道消息被删'], ['media-quarantine', '新成员媒体被删'], ['content-lock-delete', '违反内容限制被删'], ['review', '可疑消息待复核'], ['knowledge', '触发自动回复']];
const actionName = action => ACTION_NAMES.find(([key]) => String(action).includes(key))?.[1] || String(action);
const profileLink = profile => /^[a-zA-Z][a-zA-Z0-9_]{3,31}$/.test(String(profile?.username || '')) ? `https://t.me/${profile.username}` : /^\d{1,16}$/.test(String(profile?.userId || '')) ? `tg://user?id=${profile.userId}` : null;
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

  async sendNotice(recipients, text, buttons, record, link, profile) {
    const id = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
    const actions = buttons?.length ? [buttons.map(([caption, act]) => ({ text: caption, callback_data: `n:${id}:${act}` }))] : [];
    const tg = telegram(this.env.BOT_TOKEN), body = text.slice(0, 3500);
    const profileUrl = profileLink(profile);
    const keyboard = direct => record ? [...this.profileRows(id, direct ? profileUrl : null), ...actions, ...(link ? [[{ text: '查看原消息', url: link }]] : [])] : link ? [[{ text: '查看原消息', url: link }]] : [];
    const send = (chatId, rows) => tg('sendMessage', { chat_id: chatId, text: body, parse_mode: 'HTML', disable_web_page_preview: true, ...(rows.length ? { reply_markup: { inline_keyboard: rows } } : {}) });
    let direct = !!profileUrl;
    const sent = await Promise.allSettled(recipients.map(async chatId => {
      try { return await send(chatId, keyboard(direct)); }
      catch (error) {
        // tg://user buttons are refused when the member's privacy settings
        // hide them; fall back to the bot-sent profile card button.
        if (!direct || !/BUTTON|privacy|url/i.test(error.message || '')) throw error;
        direct = false;
        return send(chatId, keyboard(false));
      }
    }));
    // Keep every copy so a later result can be written onto each of them.
    if (record) this.write(`notice:${id}`, { ...record, text: body, html: true, link: link || null, profileUrl: direct ? profileUrl : null, messages: sent.map(item => item.status === 'fulfilled' && Number.isSafeInteger(item.value?.message_id) ? { chatId: item.value.chat?.id ?? null, messageId: item.value.message_id } : null).map((item, index) => item && { ...item, chatId: item.chatId ?? recipients[index] }).filter(Boolean) }, 14 * DAY);
    return sent.some(item => item.status === 'fulfilled');
  }
  noticeTime() { return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date()); }
  // Rewrites every copy of a notice with its current status and removes the
  // action buttons, so a tap always leaves a visible result on the message.
  async renderNotice(id, fallbackMessage) {
    const record = this.read(`notice:${id}`);
    if (!record) return false;
    const status = record.status?.length ? record.status : record.done ? [`✅ ${record.done}`] : [];
    const text = record.html ? `${record.text}\n\n${status.map(esc).join('\n')}`.slice(0, 4000) : `${record.text || fallbackMessage?.text || ''}\n\n${status.join('\n')}`.slice(0, 4000);
    const markup = { reply_markup: { inline_keyboard: [...this.profileRows(id, record.profileUrl), ...(record.link ? [[{ text: '查看原消息', url: record.link }]] : [])] } };
    const messages = record.messages?.length ? record.messages : fallbackMessage?.chat?.id ? [{ chatId: fallbackMessage.chat.id, messageId: fallbackMessage.message_id }] : [];
    const tg = telegram(this.env.BOT_TOKEN);
    const results = await Promise.allSettled(messages.map(item => tg('editMessageText', { chat_id: item.chatId, message_id: item.messageId, text, disable_web_page_preview: true, ...(record.html ? { parse_mode: 'HTML' } : {}), ...markup })));
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
    const text = [`🚫 已封禁：${person(entry.userName, entry.userId, entry.userUsername)}`, `群：${esc(entry.chatTitle || entry.chatId)}`, `原因：${esc(label(entry.action))}${entry.reasons?.length ? ' · ' + esc(entry.reasons.slice(0, 3).join('；')) : ''}`, entry.federationTargets?.length ? `联防：已同步到另外 ${entry.federationTargets.length} 个群` : '', entry.text ? `内容：${esc(String(entry.text).slice(0, 200))}` : ''].filter(Boolean).join('\n');
    return this.sendNotice(recipients, text, [['↩️ 误封，解封并信任', 'undo']], { kind: 'ban', chatId: String(entry.chatId), userId: String(entry.userId), caseId: entry.caseId || null }, null, { userId: entry.userId, username: entry.userUsername });
  }

  async noticeReport(report) {
    const recipients = this.ownerChats();
    if (!recipients.length) return false;
    const text = [`📣 群友举报`, `群：${esc(report.chatTitle || report.chatId)}`, `被举报：${person(report.userName, report.userId, report.userUsername)}`, `举报人：${person(report.reporterName, report.reporterId, report.reporterUsername)}`, report.reason ? `理由：${esc(report.reason)}` : '', `内容：${esc(String(report.text || '（非文字消息）').slice(0, 300))}`].filter(Boolean).join('\n');
    return this.sendNotice(recipients, text, [['🚫 删除并封禁', 'ban'], ['✅ 不是广告', 'ignore']], { kind: 'report', chatId: String(report.chatId), userId: String(report.userId), messageId: Number(report.messageId) }, messageLink(report.chatId, report.messageId), { userId: report.userId, username: report.userUsername });
  }

  // Buttons only work if Telegram delivers callback_query updates. A webhook
  // registered with a narrow allowed_updates list silently drops them, so
  // widen it (keeping the URL and secret) when something needed is missing.
  async ensureWebhookUpdates(now = Date.now()) {
    if (this.read('webhook-updates-checked')) return null;
    this.write('webhook-updates-checked', true, 3600000);
    const needed = ['message', 'edited_message', 'callback_query', 'my_chat_member', 'chat_join_request'];
    const tg = telegram(this.env.BOT_TOKEN);
    const info = await tg('getWebhookInfo').catch(() => null);
    const current = Array.isArray(info?.allowed_updates) ? info.allowed_updates : null;
    if (!info?.url || !current || !this.env.WEBHOOK_VERIFY_TOKEN) return { ok: true, allowed: current };
    const missing = needed.filter(type => !current.includes(type));
    if (!missing.length) return { ok: true, allowed: current };
    const allowed = [...new Set([...current, ...needed])];
    await tg('setWebhook', { url: info.url, secret_token: this.env.WEBHOOK_VERIFY_TOKEN, allowed_updates: allowed, ...(info.max_connections ? { max_connections: info.max_connections } : {}) });
    this.log({ action: 'webhook-updates-fixed', outcome: 'success', text: missing.join(',') });
    await this.alertOwner('webhook-updates-fixed', `已修复：Telegram 之前没有把这些类型的消息发给机器人：${missing.join('、')}。通知上的按钮现在应该能用了，请再点一次试试。`).catch(() => {});
    return { ok: true, fixed: missing, allowed };
  }
  // Profile links in the text depend on the owner's Telegram client having
  // seen the member, so this button always works: the bot sends the details.
  // A direct link opens the profile in one tap; the callback button makes the
  // bot send a profile card instead, for when no direct link is allowed.
  profileRows(id, url) { return [[url ? { text: '👤 查看用户资料', url } : { text: '👤 查看用户资料', callback_data: `n:${id}:info` }]]; }
  // Without a known group, use the group that remembers the most about them.
  async findMemberSummary(userId) {
    const results = await Promise.allSettled((await this.listChats()).map(chat => this.env.GUARD_STATE.getByName('chat:' + chat.id).memberSummary(userId)));
    const found = results.filter(item => item.status === 'fulfilled' && item.value).map(item => item.value);
    return found.sort((a, b) => b.messages.length - a.messages.length || (b.seen || 0) - (a.seen || 0))[0] || null;
  }
  // Owner replies to any older notice (or sends /who <ID>) to get the card.
  async profileLookup(text, replyText, toChatId) {
    const userId = /^\/who(?:@\w+)?\s+(\d{1,16})\s*$/i.exec(String(text || '').trim())?.[1] || /（(\d{1,16})）/.exec(String(replyText || '').split('\n').find(line => /^(?:🚫|被举报|👤)/.test(line)) || '')?.[1];
    if (!userId) {
      await telegram(this.env.BOT_TOKEN)('sendMessage', { chat_id: toChatId, text: '查看某人资料：回复一条封禁或举报通知（随便发个字），或者发送 /who 用户ID。' });
      return false;
    }
    const title = /群：(.+)/.exec(String(replyText || ''))?.[1]?.trim();
    const chat = title ? (await this.listChats()).find(item => item.title === title) : null;
    await this.sendProfileCard({ userId, chatId: chat?.id || null }, toChatId);
    return true;
  }
  async sendProfileCard(record, chatId) {
    const tg = telegram(this.env.BOT_TOKEN), userId = Number(record.userId);
    const [chat, photos, local] = await Promise.all([
      tg('getChat', { chat_id: userId }).catch(() => null),
      tg('getUserProfilePhotos', { user_id: userId, limit: 1 }).catch(() => null),
      record.chatId ? this.env.GUARD_STATE.getByName('chat:' + record.chatId).memberSummary(userId).catch(() => null) : this.findMemberSummary(userId),
    ]);
    const name = [chat?.first_name, chat?.last_name].filter(Boolean).join(' ') || local?.name || '';
    const username = chat?.username || local?.username || '';
    const lines = [`👤 ${person(name, userId, username)}`];
    lines.push(username ? `用户名：<a href="https://t.me/${username}">@${esc(username)}</a>（点开可直接看资料）` : '用户名：没有设置');
    if (chat?.bio) lines.push(`简介：${esc(chat.bio)}`);
    else if (!chat) lines.push('简介：Telegram 不允许机器人读取此人的资料');
    if (photos) lines.push(`头像：${photos.total_count ? `共 ${photos.total_count} 张` : '没有头像'}`);
    if (local?.casListed) lines.push('⚠️ 在全网广告号黑名单（CAS）上');
    if (local?.seen) lines.push(`机器人最后见到他：${new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(local.seen))}`);
    if (local?.messages?.length) lines.push('', '最近在本群的记录：', ...local.messages.map(item => `· ${esc(item.time)} ${esc(actionName(item.action))}${item.text ? '：' + esc(item.text) : ''}`));
    const text = lines.join('\n').slice(0, 1000);
    const fileId = photos?.photos?.[0]?.at(-1)?.file_id;
    if (fileId) {
      try { return await tg('sendPhoto', { chat_id: chatId, photo: fileId, caption: text, parse_mode: 'HTML' }); } catch { /* Fall back to text. */ }
    }
    return tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
  }

  async noticeAction(callback) {
    const tg = telegram(this.env.BOT_TOKEN);
    // A callback can be answered only once; the first answer stops the
    // spinner, later results are written onto the notice itself.
    let answered = false;
    const answer = (text, alert = false) => { if (answered) return Promise.resolve(); answered = true; return tg('answerCallbackQuery', { callback_query_id: callback.id, text: text.slice(0, 190), show_alert: alert }).catch(() => {}); };
    this.write('health:last-button', { at: Date.now() });
    const match = /^n:([a-f0-9]{16}):(ban|ignore|undo|info|accept|reject)$/.exec(String(callback.data || ''));
    if (!match || !this.owners().includes(String(callback.from?.id))) return answer('只有机器人所有者可以操作。', true);
    const id = match[1], key = `notice:${id}`, record = this.read(key);
    if (!record) return answer('这条记录已过期，请到管理后台处理。', true);
    // Notices sent before message tracking existed: adopt the tapped copy.
    if (!record.messages?.length && callback.message?.chat?.id) { record.messages = [{ chatId: callback.message.chat.id, messageId: callback.message.message_id }]; record.text = record.text || String(callback.message.text || '').split('\n\n✅')[0]; this.write(key, record, 14 * DAY); }
    if (match[2] === 'info') {
      try { await this.sendProfileCard(record, callback.message?.chat?.id || Number(callback.from.id)); return answer('资料已发送'); }
      catch (error) { return answer('读取资料失败：' + String(error.message || '').slice(0, 120), true); }
    }
    if (record.done) { await answer('已经处理过了：' + record.done, true); await this.renderNotice(id, callback.message); return; }
    await answer('⏳ 正在处理，结果会写在这条通知下面');
    const group = record.chatId ? this.env.GUARD_STATE.getByName('chat:' + record.chatId) : null;
    const who = [callback.from.first_name, callback.from.last_name].filter(Boolean).join(' ') || String(callback.from.id), when = this.noticeTime();
    let result, pending;
    try {
      if (record.kind === 'appeal' && ['accept', 'reject'].includes(match[2])) ({ result, pending } = await this.resolveAppeal(record, match[2] === 'accept', 'telegram:' + callback.from.id));
      else if (record.kind === 'report' && match[2] === 'ignore') result = '已忽略，不做处理';
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
