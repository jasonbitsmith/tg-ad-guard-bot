// Owner broadcast: a private message becomes a confirmation, then copyMessage
// jobs (one per target) reuse the durable queue. Successful targets are stored
// so a later 撤回 deletes only those messages, and a retry never copies them again.
import { telegram } from '../telegram.js';
import { DAY } from './shared.js';

export const BROADCAST_TEST_CHAT = '5615131413';
const ALBUM_QUIET_MS = 1000;
const DRAFT_TTL = DAY;
const DELIVERY_TTL = 30 * DAY;
// Inline button labels are at most 64 characters, including the checkbox prefix.
export const BROADCAST_BUTTON_LIMIT = 64;
const BUTTON_PREFIX = '☐ ';

// id is the canonical send address. label keeps the configured spelling so the
// confirmation and picker can show @JasonSIMLab rather than a numeric chat id.
export function broadcastTargetEntries(env) {
  const values = String(env.BROADCAST_TARGETS || '').split(/[,\s]+/).filter(Boolean);
  const result = [];
  const seen = new Set();
  for (const raw of values) {
    if (!/^@[a-zA-Z0-9_]{5,32}$|^-\d{5,16}$/.test(raw)) throw new Error('广播目标必须是 @用户名或负数群 ID');
    const id = raw.startsWith('@') ? raw.toLowerCase() : raw;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push({ id, label: raw.startsWith('@') ? raw : id });
  }
  if (!result.length || result.length > 20) throw new Error('广播目标须为 1–20 个');
  return result;
}

export function broadcastTargets(env) {
  return broadcastTargetEntries(env).map(item => item.id);
}

// Test mode still validates the real list, then replaces the send set.
export function broadcastDestinations(env) {
  const targets = broadcastTargets(env);
  return env.BROADCAST_TEST_MODE === 'true' ? [BROADCAST_TEST_CHAT] : targets;
}

function chatIdOf(target) {
  return /^-?\d{5,16}$/.test(String(target)) ? Number(target) : target;
}

// '{title}（@username）', shortened so checkbox + label still fits one button.
// A missing title is just the @username.
export function broadcastDisplayLabel(title, handle) {
  const name = String(title || '').replace(/\s+/g, ' ').trim();
  const who = String(handle || '').trim();
  const max = BROADCAST_BUTTON_LIMIT - BUTTON_PREFIX.length;
  const clip = value => value.length <= max ? value : value.slice(0, Math.max(1, max - 1)) + '…';
  if (!name) return clip(who);
  const suffix = `（${who}）`;
  if ((name + suffix).length <= max) return name + suffix;
  const room = max - suffix.length - 1;
  if (room < 1) return clip(suffix);
  return name.slice(0, room) + '…' + suffix;
}

// Picker rows add ⚠️ in front of a target the bot cannot post to. Shorten that
// label again so checkbox + warning + name still fit Telegram's 64-character button.
const WARN_MARK = '⚠️ ';
export function broadcastPickerLabel(label, warned) {
  const text = String(label || '');
  if (!warned) return text;
  const max = BROADCAST_BUTTON_LIMIT - BUTTON_PREFIX.length - WARN_MARK.length;
  if (text.length <= max) return text;
  const suffix = /（[^）]*）$/.exec(text)?.[0] || '';
  const room = max - suffix.length - 1;
  if (suffix && room >= 1) return text.slice(0, room) + '…' + suffix;
  return text.slice(0, Math.max(1, max - 1)) + '…';
}

function copiedIds(op) {
  if (!op) return [];
  if (op.method === 'copyMessages' && Array.isArray(op.result)) return op.result.map(item => item?.message_id).filter(id => Number.isSafeInteger(id) && id > 0);
  return Number.isSafeInteger(op.result?.message_id) && op.result.message_id > 0 ? [op.result.message_id] : [];
}

function contentKind(message, count) {
  if (count > 1) return `这组 ${count} 条相册`;
  if (message?.photo) return '这张图片';
  if (message?.video) return '这段视频';
  if (message?.document) return '这个文件';
  return '这条消息';
}

export class BroadcastMethods {
  // Text (including links), photos, videos and documents. Commands and the
  // mini-app / member-recovery phrases stay with the handlers in index.js.
  broadcastContent(message) {
    if (message?.chat?.type !== 'private') return false;
    if (!Number.isSafeInteger(message.from?.id) || !this.owners().includes(String(message.from.id))) return false;
    if (!Number.isSafeInteger(message.message_id) || message.message_id <= 0) return false;
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    if (/^\/\w+/.test(text) || /^(?:后台|管理后台)$/.test(text)) return false;
    if (message.photo?.length || message.video || message.document) return true;
    return text.length > 0;
  }

  async broadcastOffer(message) {
    if (!this.broadcastContent(message)) return false;
    if (message.media_group_id) return this.rememberBroadcastAlbum(message);
    await this.presentBroadcast(message, [message.message_id]);
    return true;
  }

  async rememberBroadcastAlbum(message) {
    const group = String(message.media_group_id).replace(/[^\w.-]/g, '').slice(0, 64);
    if (!group) {
      await this.presentBroadcast(message, [message.message_id]);
      return true;
    }
    const key = `broadcast:album:${message.chat.id}:${group}`;
    const album = this.read(key, { ownerId: message.from.id, chatId: message.chat.id, messages: [], updated: 0 });
    if (String(album.ownerId) !== String(message.from.id)) return false;
    if (!album.messages.some(item => item.message_id === message.message_id)) album.messages.push({ message_id: message.message_id });
    album.messages = album.messages.sort((a, b) => a.message_id - b.message_id).slice(-10);
    album.updated = Date.now();
    this.write(key, album, 10 * 60 * 1000);
    await this.schedule(album.updated + ALBUM_QUIET_MS);
    return true;
  }

  nextBroadcastAlbumDue() {
    const rows = this.sql.exec("SELECT value FROM records WHERE key LIKE 'broadcast:album:%' AND expires>?", Date.now()).toArray();
    const times = rows.map(row => Number(JSON.parse(row.value).updated) + ALBUM_QUIET_MS).filter(Number.isFinite);
    return times.length ? Math.min(...times) : undefined;
  }

  async flushBroadcastAlbums() {
    const rows = this.sql.exec("SELECT key, value FROM records WHERE key LIKE 'broadcast:album:%' AND expires>?", Date.now()).toArray();
    for (const row of rows) {
      const album = JSON.parse(row.value);
      if (Date.now() < Number(album.updated) + ALBUM_QUIET_MS) continue;
      this.remove(row.key);
      const message = { chat: { id: album.chatId, type: 'private' }, from: { id: Number(album.ownerId) }, photo: [{ file_id: 'album' }] };
      try { await this.presentBroadcast(message, album.messages.map(item => item.message_id)); }
      catch (error) {
        if (error.retryable) this.write(row.key, album, 10 * 60 * 1000);
        else await telegram(this.env.BOT_TOKEN)('sendMessage', { chat_id: album.chatId, text: '相册广播未准备好：' + String(error.message || '').slice(0, 300) }).catch(() => {});
        this.log({ action: 'broadcast-album', outcome: error.retryable ? 'retrying' : 'failed', error: String(error.message || '').slice(0, 200) });
      }
    }
  }

  // Title plus chat type and the default send permission. A fresh snapshot skips
  // getChat; membership is still checked live. One getChat serves both the title
  // and the permission check, so a failed lookup is not reported twice.
  freshBroadcastChat(id) {
    const cached = this.read(`broadcast:chat-title:${id}`);
    if (!cached || typeof cached.title !== 'string' || !cached.title || typeof cached.type !== 'string' || !Number.isFinite(cached.at) || Date.now() - cached.at >= DAY) return null;
    return cached;
  }

  broadcastPostingProblem(chat, member) {
    const admin = ['creator', 'administrator'].includes(member.status);
    if (chat.type === 'channel') {
      if (member.status === 'creator' || (admin && member.can_post_messages === true)) return '';
      return admin ? '机器人没有「发布消息」权限' : '机器人不是这个频道的管理员';
    }
    if (admin) return '';
    if (['member', 'restricted'].includes(member.status) && member.can_send_messages !== false && chat.permissions?.can_send_messages !== false) return '';
    return '机器人在这里不能发言';
  }

  problemFromError(error) {
    if (error.retryable) return '暂时检查不了，发送时再看结果';
    return /not found/i.test(error.message) ? '找不到，或机器人不在里面' : '机器人不在里面或没有权限';
  }

  // Labels use 「群标题（@用户名）」. Problems say whether the bot can post.
  // A check that cannot run says so and never blocks sending. Test mode checks
  // the real targets too.
  async broadcastTargetView(entries) {
    const tg = telegram(this.env.BOT_TOKEN);
    let me;
    try { me = await this.me(tg); } catch { me = null; }
    return Promise.all(entries.map(async entry => {
      const cached = this.freshBroadcastChat(entry.id);
      let chat = cached ? { type: cached.type, title: cached.title, permissions: { can_send_messages: cached.canSendMessages !== false } } : null;
      let chatError = null;
      if (!cached) {
        try {
          const loaded = await tg('getChat', { chat_id: chatIdOf(entry.id) });
          const title = String(loaded?.title || '').replace(/\s+/g, ' ').trim();
          if (title) this.write(`broadcast:chat-title:${entry.id}`, {
            title,
            type: String(loaded?.type || ''),
            canSendMessages: loaded?.permissions?.can_send_messages !== false,
            at: Date.now(),
          }, 2 * DAY);
          chat = loaded;
        } catch (error) {
          chatError = error;
        }
      }
      const title = String((cached ? cached.title : chat?.title) || '').replace(/\s+/g, ' ').trim();
      const label = broadcastDisplayLabel(title, entry.label);
      if (!me) return { label, problem: '暂时检查不了，发送时再看结果' };
      if (chatError) return { label, problem: this.problemFromError(chatError) };
      try {
        const member = await tg('getChatMember', { chat_id: chatIdOf(entry.id), user_id: me.id });
        return { label, problem: this.broadcastPostingProblem(chat, member) };
      } catch (error) {
        return { label, problem: this.problemFromError(error) };
      }
    }));
  }

  async presentBroadcast(message, messageIds) {
    const ids = [...new Set(messageIds.filter(id => Number.isSafeInteger(Number(id)) && Number(id) > 0).map(Number))].sort((a, b) => a - b).slice(0, 10);
    if (!ids.length || !this.owners().includes(String(message.from?.id))) return false;
    const entries = broadcastTargetEntries(this.env);
    const view = await this.broadcastTargetView(entries);
    const labels = view.map(item => item.label);
    const problems = view.map(item => item.problem);
    const warned = problems.flatMap((problem, index) => problem ? [index] : []);
    const token = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
    const testing = this.env.BROADCAST_TEST_MODE === 'true';
    const text = [
      `要把${contentKind(message, ids.length)}发到哪里？`,
      '',
      '目标：',
      ...labels.map((label, index) => problems[index] ? `⚠️ ${label}：${problems[index]}` : `✅ ${label}`),
      ...(warned.length ? ['', '带 ⚠️ 的目标现在多半发不出去。可以先去补权限，或用「选择目标」跳过它们。'] : []),
      '',
      testing ? '当前是测试模式。确认后只会复制一份给所有者 ' + BROADCAST_TEST_CHAT + '，不会发到这些目标。' : '确认后才会发送。',
    ].join('\n').slice(0, 3500);
    const sent = await telegram(this.env.BOT_TOKEN)('sendMessage', {
      chat_id: message.chat.id,
      text,
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: this.broadcastKeyboard(token, null, labels) },
    });
    if (!Number.isSafeInteger(sent?.message_id)) throw new Error('确认消息没有发出去');
    this.write(`broadcast:draft:${token}`, {
      token, ownerId: String(message.from.id), chatId: message.chat.id, messageIds: ids,
      targets: entries.map(item => item.id), labels, warned, selected: [], testing,
      status: 'open', promptMessageId: sent.message_id, created: Date.now(),
    }, DRAFT_TTL);
    return true;
  }

  broadcastKeyboard(token, selected, targets, warned = []) {
    if (!selected) return [
      [{ text: '发送到全部目标', callback_data: `bc:a:${token}` }],
      [{ text: '选择目标', callback_data: `bc:p:${token}` }],
      [{ text: '取消', callback_data: `bc:c:${token}` }],
    ];
    const chosen = new Set(selected);
    return [
      ...targets.map((target, index) => {
        const warn = warned.includes(index);
        return [{ text: `${chosen.has(index) ? '☑' : '☐'} ${warn ? WARN_MARK : ''}${broadcastPickerLabel(target, warn)}`, callback_data: `bc:t:${token}:${index}` }];
      }),
      [{ text: '确认发送', callback_data: `bc:g:${token}` }, { text: '取消', callback_data: `bc:c:${token}` }],
    ];
  }

  async broadcastAction(callback) {
    const tg = telegram(this.env.BOT_TOKEN);
    let answered = false;
    const answer = (text, alert = false) => { if (answered) return Promise.resolve(); answered = true; return tg('answerCallbackQuery', { callback_query_id: callback.id, text: String(text || '').slice(0, 190), show_alert: alert }).catch(() => {}); };
    if (!this.owners().includes(String(callback.from?.id))) return answer('只有机器人所有者可以操作。', true);
    const data = String(callback.data || '');
    const undo = /^bc:u:([0-9a-f]{16})$/.exec(data);
    if (undo) return this.broadcastUndo(callback, undo[1], answer);
    const toggle = /^bc:t:([0-9a-f]{16}):(\d{1,2})$/.exec(data);
    const action = /^bc:(a|p|c|g):([0-9a-f]{16})$/.exec(data);
    if (!toggle && !action) return answer('无效操作。', true);
    const token = toggle ? toggle[1] : action[2];
    const draft = this.read(`broadcast:draft:${token}`);
    const messageId = callback.message?.message_id;
    if (!draft || draft.status !== 'open' || String(draft.ownerId) !== String(callback.from.id) || !Number.isSafeInteger(messageId) || messageId !== draft.promptMessageId) return answer('这个按钮已失效。', true);
    if (toggle) {
      const index = Number(toggle[2]);
      if (!Number.isSafeInteger(index) || index < 0 || index >= draft.targets.length) return answer('无效操作。', true);
      const selected = new Set(draft.selected || []);
      if (selected.has(index)) selected.delete(index); else selected.add(index);
      draft.selected = [...selected].sort((a, b) => a - b);
      this.write(`broadcast:draft:${token}`, draft, DRAFT_TTL);
      await tg('editMessageReplyMarkup', { chat_id: draft.chatId, message_id: draft.promptMessageId, reply_markup: { inline_keyboard: this.broadcastKeyboard(token, draft.selected, draft.labels || draft.targets, draft.warned) } }).catch(() => {});
      return answer(draft.selected.length ? `已选 ${draft.selected.length} 个` : '未选择目标');
    }
    const kind = action[1];
    if (kind === 'c') {
      draft.status = 'cancelled';
      this.write(`broadcast:draft:${token}`, draft, DRAFT_TTL);
      await tg('editMessageText', { chat_id: draft.chatId, message_id: draft.promptMessageId, text: '已取消，没有发送。' }).catch(() => {});
      return answer('已取消');
    }
    if (kind === 'p') {
      await tg('editMessageText', {
        chat_id: draft.chatId, message_id: draft.promptMessageId,
        text: `选择要发送的目标（${(draft.labels || draft.targets).length} 个），然后点确认发送。`,
        reply_markup: { inline_keyboard: this.broadcastKeyboard(token, draft.selected, draft.labels || draft.targets, draft.warned) },
      }).catch(() => {});
      return answer('请选择目标');
    }
    const indexes = kind === 'a' ? draft.targets.map((_, index) => index) : draft.selected;
    const sendIds = indexes.map(index => draft.targets[index]).filter(Boolean);
    const selectedLabels = indexes.map(index => (draft.labels || draft.targets)[index]).filter(Boolean);
    if (!sendIds.length) return answer('请至少选择一个目标。', true);
    draft.status = 'sending';
    draft.sendIds = sendIds;
    draft.selectedLabels = selectedLabels;
    this.write(`broadcast:draft:${token}`, draft, DRAFT_TTL);
    this.queueBroadcastSends(draft);
    await this.schedule(Date.now() + 200);
    const progress = draft.testing ? '测试模式：正在复制一份给你自己…' : `正在发送到 ${sendIds.length} 个目标…`;
    await tg('editMessageText', { chat_id: draft.chatId, message_id: draft.promptMessageId, text: progress }).catch(() => {});
    return answer('开始发送');
  }

  queueBroadcastSends(draft) {
    // Test mode records the chosen names, but delivers a single copy to the owner.
    const targets = draft.testing ? [BROADCAST_TEST_CHAT] : draft.sendIds;
    const delivery = {
      id: draft.token, ownerId: draft.ownerId, ownerChatId: draft.chatId, messageIds: draft.messageIds,
      targets, selectedLabels: draft.selectedLabels || [], testing: draft.testing === true,
      labelById: Object.fromEntries((draft.sendIds || []).map((id, index) => [id, (draft.selectedLabels || [])[index] || id])),
      results: {}, undoState: 'idle',
    };
    this.write(`broadcast:delivery:${draft.token}`, delivery, DELIVERY_TTL);
    for (const target of targets) {
      const chatId = chatIdOf(target);
      const copy = draft.messageIds.length > 1
        ? { method: 'copyMessages', params: { chat_id: chatId, from_chat_id: draft.chatId, message_ids: draft.messageIds } }
        : { method: 'copyMessage', params: { chat_id: chatId, from_chat_id: draft.chatId, message_id: draft.messageIds[0] } };
      const plan = { ops: [copy, { local: 'broadcast-copied', broadcastId: draft.token, target }], entry: { action: 'broadcast-copy', chatId: String(chatId), reasons: ['所有者广播'] } };
      this.sql.exec('INSERT OR IGNORE INTO jobs(id,payload,plan,due,created) VALUES (?,?,?,?,?)', `broadcast:send:${draft.token}:${target}`, '{}', JSON.stringify(plan), Date.now(), Date.now());
    }
  }

  broadcastCopied(op, plan) {
    const messageIds = copiedIds(plan.ops.find(item => item.method === 'copyMessage' || item.method === 'copyMessages'));
    if (!messageIds.length) this.broadcastSettle(op.broadcastId, op.target, { ok: false, error: '没有返回消息 ID', messageIds: [] });
    else this.broadcastSettle(op.broadcastId, op.target, { ok: true, messageIds });
  }

  // Called only after the queue gives up. A retry leaves the target unsettled
  // so the same job can finish the copy without creating a second one.
  async broadcastJobFailed(job, plan, error) {
    if (job.id.startsWith('broadcast:undo:')) return this.broadcastUndoFailed(plan, error);
    if (!job.id.startsWith('broadcast:send:')) return;
    const op = plan?.ops?.find(item => item.local === 'broadcast-copied');
    if (!op) return;
    this.broadcastSettle(op.broadcastId, op.target, { ok: false, error: String(error.message || '发送失败').slice(0, 200), messageIds: [] });
  }

  broadcastSettle(id, target, result) {
    const key = `broadcast:delivery:${id}`;
    const delivery = this.read(key);
    if (!delivery || delivery.results[target]) return;
    delivery.results[target] = result;
    this.write(key, delivery, DELIVERY_TTL);
    if (delivery.targets.every(item => delivery.results[item])) this.queueBroadcastReport(delivery);
  }

  queueBroadcastReport(delivery) {
    const lines = ['广播结果', ''];
    if (delivery.testing) {
      lines.push('选择的目标：' + (delivery.selectedLabels || []).join('、'));
      const copy = delivery.results[BROADCAST_TEST_CHAT];
      lines.push(copy?.ok
        ? `测试模式：已复制一份给所有者 ${BROADCAST_TEST_CHAT}，没有发给上面这些目标。`
        : `测试模式：复制给所有者 ${BROADCAST_TEST_CHAT} 失败：${copy?.error || '发送失败'}。没有发给上面这些目标。`);
    } else {
      for (const target of delivery.targets) {
        const result = delivery.results[target];
        const label = delivery.labelById?.[target] || target;
        lines.push(result?.ok ? `✅ ${label}` : `❌ ${label}：${result?.error || '发送失败'}`);
      }
    }
    const canUndo = delivery.targets.some(target => delivery.results[target]?.messageIds?.length);
    if (canUndo) lines.push('', '点「撤回」可从已发送的目标删除这条消息。Telegram 只允许删除 48 小时内发出的消息。');
    else lines.push('', '没有发送成功的目标。');
    const params = { chat_id: delivery.ownerChatId, text: lines.join('\n').slice(0, 4000), disable_web_page_preview: true };
    if (canUndo) params.reply_markup = { inline_keyboard: [[{ text: '撤回', callback_data: `bc:u:${delivery.id}` }]] };
    const plan = { ops: [{ method: 'sendMessage', params }, { local: 'broadcast-reported', broadcastId: delivery.id }], entry: { action: 'broadcast-report', chatId: String(delivery.ownerChatId), reasons: ['所有者广播结果'] } };
    this.sql.exec('INSERT OR IGNORE INTO jobs(id,payload,plan,due,created) VALUES (?,?,?,?,?)', `broadcast:report:${delivery.id}`, '{}', JSON.stringify(plan), Date.now(), Date.now());
  }

  async broadcastUndo(callback, id, answer) {
    const delivery = this.read(`broadcast:delivery:${id}`);
    const messageId = callback.message?.message_id;
    if (!delivery || String(delivery.ownerId) !== String(callback.from?.id) || !Number.isSafeInteger(messageId) || messageId !== delivery.reportMessageId) return answer('这个按钮已失效。', true);
    if (delivery.undoState === 'done') return answer('已经撤回过了。', true);
    if (delivery.undoState === 'running') return answer('正在撤回。', true);
    const copies = delivery.targets.flatMap(target => (delivery.results[target]?.messageIds || []).map(message_id => ({ target, message_id })));
    if (!copies.length) return answer('没有可以撤回的消息。', true);
    delivery.undoState = 'running';
    delivery.undoMessageId = messageId;
    delivery.undoAttempts = (delivery.undoAttempts || 0) + 1;
    this.write(`broadcast:delivery:${id}`, delivery, DELIVERY_TTL);
    const ops = copies.map(item => ({ method: 'deleteMessage', params: { chat_id: chatIdOf(item.target), message_id: item.message_id }, broadcastTarget: item.target, broadcastContinue: true }));
    ops.push({ local: 'broadcast-undo-report', broadcastId: id });
    this.sql.exec('INSERT OR IGNORE INTO jobs(id,payload,plan,due,created) VALUES (?,?,?,?,?)', `broadcast:undo:${id}:${delivery.undoAttempts}`, '{}', JSON.stringify({ ops, entry: { action: 'broadcast-undo', chatId: String(delivery.ownerChatId), reasons: ['撤回所有者广播'] } }), Date.now(), Date.now());
    await this.schedule(Date.now() + 200);
    return answer('正在撤回');
  }

  // The queue gave up on an undo (e.g. Telegram unreachable for a long time).
  // Reopen the button instead of leaving it stuck on 正在撤回.
  async broadcastUndoFailed(plan, error) {
    const op = plan?.ops?.find(item => item.local === 'broadcast-undo-report');
    const key = `broadcast:delivery:${op?.broadcastId}`;
    const delivery = op && this.read(key);
    if (!delivery || delivery.undoState !== 'running') return;
    delivery.undoState = 'idle';
    this.write(key, delivery, DELIVERY_TTL);
    await telegram(this.env.BOT_TOKEN)('sendMessage', { chat_id: delivery.ownerChatId, text: '撤回没有完成：' + String(error.message || '发送失败').slice(0, 200) + '\n可以稍后再点一次「撤回」。' }).catch(() => {});
  }

  broadcastReported(op, plan) {
    const sent = plan.ops.find(item => item.method === 'sendMessage');
    const key = `broadcast:delivery:${op.broadcastId}`;
    const delivery = this.read(key);
    if (!delivery || !Number.isSafeInteger(sent?.result?.message_id)) return;
    delivery.reportMessageId = sent.result.message_id;
    this.write(key, delivery, DELIVERY_TTL);
  }

  async broadcastUndoReport(op, plan) {
    const key = `broadcast:delivery:${op.broadcastId}`;
    const delivery = this.read(key);
    if (!delivery || delivery.undoReported) return;
    const byTarget = new Map();
    for (const item of plan.ops.filter(entry => entry.method === 'deleteMessage')) {
      const current = byTarget.get(item.broadcastTarget) || { ok: 0, failed: [] };
      if (item.skipped) current.failed.push(item.skipped);
      else current.ok += 1;
      byTarget.set(item.broadcastTarget, current);
    }
    const lines = ['撤回结果', ''];
    for (const [target, item] of byTarget) {
      const label = delivery.labelById?.[target] || target;
      if (!item.failed.length) lines.push(`✅ 已从 ${label} 删除`);
      else lines.push(`❌ ${label}：${/can.t be deleted/i.test(item.failed[0]) ? '删不掉：可能已超过 48 小时，或机器人没有删除权限，请手动删' : item.failed[0]}`);
    }
    if (!byTarget.size) lines.push('没有已发送的消息需要删除。');
    const tg = telegram(this.env.BOT_TOKEN);
    await tg('sendMessage', { chat_id: delivery.ownerChatId, text: lines.join('\n').slice(0, 4000), disable_web_page_preview: true });
    // The 撤回 button has done its job; take it off the result message.
    if (Number.isSafeInteger(delivery.reportMessageId)) await tg('editMessageReplyMarkup', { chat_id: delivery.ownerChatId, message_id: delivery.reportMessageId, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    delivery.undoReported = true;
    delivery.undoState = 'done';
    this.write(key, delivery, DELIVERY_TTL);
  }
}
