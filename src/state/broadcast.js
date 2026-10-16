// Owner broadcast: a private message becomes a confirmation, then copyMessage
// jobs (one per target) reuse the durable queue. Successful targets are stored
// so a later 撤回 deletes only those messages, and a retry never copies them again.
import { telegram } from '../telegram.js';
import { DAY } from './shared.js';

export const BROADCAST_TEST_CHAT = '5615131413';
const ALBUM_QUIET_MS = 1000;
const DRAFT_TTL = DAY;
const DELIVERY_TTL = 30 * DAY;

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

  async presentBroadcast(message, messageIds) {
    const ids = [...new Set(messageIds.filter(id => Number.isSafeInteger(Number(id)) && Number(id) > 0).map(Number))].sort((a, b) => a - b).slice(0, 10);
    if (!ids.length || !this.owners().includes(String(message.from?.id))) return false;
    const entries = broadcastTargetEntries(this.env);
    const labels = entries.map(item => item.label);
    const token = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
    const testing = this.env.BROADCAST_TEST_MODE === 'true';
    const text = [
      `要把${contentKind(message, ids.length)}发到哪里？`,
      '',
      '目标：' + labels.join('、'),
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
      targets: entries.map(item => item.id), labels, selected: [], testing,
      status: 'open', promptMessageId: sent.message_id, created: Date.now(),
    }, DRAFT_TTL);
    return true;
  }

  broadcastKeyboard(token, selected, targets) {
    if (!selected) return [
      [{ text: '发送到全部目标', callback_data: `bc:a:${token}` }],
      [{ text: '选择目标', callback_data: `bc:p:${token}` }],
      [{ text: '取消', callback_data: `bc:c:${token}` }],
    ];
    const chosen = new Set(selected);
    return [
      ...targets.map((target, index) => [{ text: `${chosen.has(index) ? '☑' : '☐'} ${target}`, callback_data: `bc:t:${token}:${index}` }]),
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
      await tg('editMessageReplyMarkup', { chat_id: draft.chatId, message_id: draft.promptMessageId, reply_markup: { inline_keyboard: this.broadcastKeyboard(token, draft.selected, draft.labels || draft.targets) } }).catch(() => {});
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
        reply_markup: { inline_keyboard: this.broadcastKeyboard(token, draft.selected, draft.labels || draft.targets) },
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
  broadcastJobFailed(job, plan, error) {
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
    if (canUndo) lines.push('', '点「撤回」可从已发送的目标删除这条消息。');
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
    this.write(`broadcast:delivery:${id}`, delivery, DELIVERY_TTL);
    const ops = copies.map(item => ({ method: 'deleteMessage', params: { chat_id: chatIdOf(item.target), message_id: item.message_id }, broadcastTarget: item.target, broadcastContinue: true }));
    ops.push({ local: 'broadcast-undo-report', broadcastId: id });
    this.sql.exec('INSERT OR IGNORE INTO jobs(id,payload,plan,due,created) VALUES (?,?,?,?,?)', `broadcast:undo:${id}`, '{}', JSON.stringify({ ops, entry: { action: 'broadcast-undo', chatId: String(delivery.ownerChatId), reasons: ['撤回所有者广播'] } }), Date.now(), Date.now());
    await this.schedule(Date.now() + 200);
    return answer('正在撤回');
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
      if (!item.failed.length) lines.push(`✅ 已从 ${target} 删除`);
      else lines.push(`❌ ${target}：${item.failed[0]}`);
    }
    if (!byTarget.size) lines.push('没有已发送的消息需要删除。');
    await telegram(this.env.BOT_TOKEN)('sendMessage', { chat_id: delivery.ownerChatId, text: lines.join('\n').slice(0, 4000), disable_web_page_preview: true });
    delivery.undoReported = true;
    delivery.undoState = 'done';
    this.write(key, delivery, DELIVERY_TTL);
  }
}
