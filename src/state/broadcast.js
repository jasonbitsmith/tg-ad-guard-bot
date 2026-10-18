// Owner broadcast: the owner sends 「群发」 (or starts a message with 「群发 」),
// the next content becomes a confirmation, then copyMessage jobs (one per
// target) reuse the durable queue. Successful targets are stored so a later
// 撤回 / 修改 touches only those messages, and a retry never copies them again.
import { telegram } from '../telegram.js';
import { DAY } from './shared.js';

export const BROADCAST_TEST_CHAT = '5615131413';
const ALBUM_QUIET_MS = 1000;
const DRAFT_TTL = DAY;
const DELIVERY_TTL = 30 * DAY;
// How long 「群发」, 「修改文字」 and 「自己输入时间」 wait for the owner's next message.
const WAIT_TTL = 10 * 60 * 1000;
const MAX_SCHEDULE = 7 * DAY;
const BEIJING = 8 * 3600000;
// Inline button labels are at most 64 characters, including the checkbox prefix.
export const BROADCAST_BUTTON_LIMIT = 64;
const BUTTON_PREFIX = '☐ ';

// id is the canonical send address. label keeps the configured spelling so the
// confirmation and picker can show @JasonSIMLab rather than a numeric chat id.
export function broadcastTargetEntries(env) {
  const values = String(env.BROADCAST_TARGETS || '').split(/[,\s，]+/).filter(Boolean);
  const result = [];
  const seen = new Set();
  for (const raw of values) {
    if (!/^@[a-zA-Z0-9_]{5,32}$|^-\d{5,16}$/.test(raw)) throw new Error('广播目标必须是 @用户名或负数群 ID：' + raw.slice(0, 40));
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

// 「群发 内容」: returns the content after the prefix with its entities moved
// left, or null when the text does not start with the prefix. Offsets are
// UTF-16 units, the same as JavaScript string indexes.
export function stripBroadcastPrefix(text, entities = []) {
  const match = /^群发(?:[\s:：,，]+)/.exec(String(text || ''));
  if (!match) return null;
  const cut = match[0].length, rest = String(text).slice(cut);
  if (!rest.trim()) return null;
  const moved = (Array.isArray(entities) ? entities : []).flatMap(entity => {
    const start = Math.max(entity.offset, cut), end = entity.offset + entity.length;
    if (end <= cut) return [];
    return [{ ...entity, offset: start - cut, length: end - start }];
  });
  return { text: rest, entities: moved };
}

const parts = time => { const d = new Date(time + BEIJING); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), min: d.getUTCMinutes() }; };
const beijing = (y, m, d, h, min) => Date.UTC(y, m - 1, d, h, min) - BEIJING;
const pad = value => String(value).padStart(2, '0');

export function formatBeijing(time, now = Date.now()) {
  const p = parts(time), today = parts(now), tomorrow = parts(now + DAY);
  const day = p.y === today.y && p.m === today.m && p.d === today.d ? '今天' : p.y === tomorrow.y && p.m === tomorrow.m && p.d === tomorrow.d ? '明天' : `${p.m}月${p.d}日`;
  return `${day} ${pad(p.h)}:${pad(p.min)}`;
}

// Beijing time typed by the owner: 21:30, 明天 9:00, 10-20 21:30, 10月20日 21:30.
// A bare time already past today means tomorrow. Returns null when unreadable.
export function parseBroadcastTime(text, now = Date.now()) {
  const value = String(text || '').trim().replace(/：/g, ':').replace(/\s+/g, ' ');
  const today = parts(now);
  const valid = (t, y, m, d, h, min) => { const p = parts(t); return p.y === y && p.m === m && p.d === d && p.h === h && p.min === min; };
  let match = /^(今天|今晚|明天|明早|明晚|后天)?\s*(\d{1,2})[:点](\d{2})?分?$/.exec(value);
  if (match) {
    const offset = { 今天: 0, 今晚: 0, 明天: 1, 明早: 1, 明晚: 1, 后天: 2 }[match[1]] ?? 0;
    let hour = Number(match[2]);
    const minute = Number(match[3] || 0);
    if (/晚/.test(match[1] || '') && hour < 12) hour += 12;
    if (hour > 23 || minute > 59) return null;
    let time = beijing(today.y, today.m, today.d + offset, hour, minute);
    if (!match[1] && time <= now) time += DAY;
    return time;
  }
  match = /^(\d{1,2})(?:[-/.]|月)(\d{1,2})日?\s*(\d{1,2}):(\d{2})$/.exec(value);
  if (match) {
    const [month, day, hour, minute] = match.slice(1).map(Number);
    if (hour > 23 || minute > 59) return null;
    let year = today.y, time = beijing(year, month, day, hour, minute);
    if (time < now - DAY) { year += 1; time = beijing(year, month, day, hour, minute); }
    return valid(time, year, month, day, hour, minute) ? time : null;
  }
  return null;
}

// Preset buttons on the 定时发送 screen.
const PRESETS = ['m30', 'h1', 'h3', 'e20', 'm09'];
function presetTime(code, now = Date.now()) {
  const today = parts(now);
  const atOrNext = (h) => { const time = beijing(today.y, today.m, today.d, h, 0); return time > now + 60000 ? time : time + DAY; };
  return { m30: now + 30 * 60000, h1: now + 3600000, h3: now + 3 * 3600000, e20: atOrNext(20), m09: atOrNext(9) }[code];
}
function presetLabel(code, now = Date.now()) {
  if (code === 'm30') return '30 分钟后';
  if (code === 'h1') return '1 小时后';
  if (code === 'h3') return '3 小时后';
  const time = presetTime(code, now), today = formatBeijing(time, now).startsWith('今天');
  return code === 'e20' ? (today ? '今晚 20:00' : '明晚 20:00') : (today ? '今早 9:00' : '明早 9:00');
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
  // Targets set in the admin panel replace BROADCAST_TARGETS from wrangler.jsonc.
  broadcastEntries() {
    const custom = this.read('broadcast:targets-config');
    return broadcastTargetEntries({ BROADCAST_TARGETS: custom || this.env.BROADCAST_TARGETS });
  }

  async broadcastSettings() {
    const custom = this.read('broadcast:targets-config');
    let entries = [], error = null;
    try { entries = this.broadcastEntries(); } catch (problem) { error = problem.message; }
    const view = entries.length ? await this.broadcastTargetView(entries) : [];
    return {
      custom: !!custom, testMode: this.env.BROADCAST_TEST_MODE === 'true', error,
      defaultTargets: String(this.env.BROADCAST_TARGETS || ''),
      targets: entries.map((entry, index) => ({ id: entry.id, handle: entry.label, label: view[index]?.label || entry.label, problem: view[index]?.problem || '' })),
    };
  }

  // Empty or reset goes back to the wrangler.jsonc list. Invalid input throws
  // before anything is saved.
  async saveBroadcastTargets(raw, reset = false) {
    const text = String(raw || '').slice(0, 2000);
    if (reset || !text.trim()) this.remove('broadcast:targets-config');
    else this.write('broadcast:targets-config', broadcastTargetEntries({ BROADCAST_TARGETS: text }).map(entry => entry.label).join(','));
    return this.broadcastSettings();
  }

  // Text (including links), photos, videos, documents and other media.
  // Commands and the mini-app / member-recovery phrases stay with the
  // handlers in index.js.
  broadcastContent(message) {
    if (message?.chat?.type !== 'private') return false;
    if (!Number.isSafeInteger(message.from?.id) || !this.owners().includes(String(message.from.id))) return false;
    if (!Number.isSafeInteger(message.message_id) || message.message_id <= 0) return false;
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    if (/^\/\w+/.test(text) || /^(?:后台|管理后台)$/.test(text)) return false;
    if (message.photo?.length || message.video || message.document || message.animation || message.audio || message.voice || message.video_note || message.sticker) return true;
    return text.length > 0;
  }

  // Owner messages only become a broadcast after 「群发」 or with a 「群发 」
  // prefix; everything else is left alone. A pending 修改 or custom time
  // takes the next message first.
  async broadcastOffer(message) {
    if (message?.chat?.type !== 'private' || !Number.isSafeInteger(message.from?.id) || !this.owners().includes(String(message.from.id))) return false;
    const owner = String(message.from.id), tg = telegram(this.env.BOT_TOKEN);
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    const say = value => tg('sendMessage', { chat_id: message.chat.id, text: value }).catch(() => {});
    const waits = ['armed', 'editing', 'timing'].map(name => `broadcast:${name}:${owner}`);
    if (/^(?:取消|退出)$/.test(text) && waits.some(key => this.read(key))) {
      waits.forEach(key => this.remove(key));
      await say('已退出群发，没有发送任何内容。');
      return true;
    }
    if (/^\/?群发$/.test(text)) {
      waits.forEach(key => this.remove(key));
      this.write(`broadcast:armed:${owner}`, true, WAIT_TTL);
      await say('好的，请发送要群发的内容：文字、图片、视频、文件或相册都可以（10 分钟内有效）。\n发「取消」退出。');
      return true;
    }
    const editing = this.read(`broadcast:editing:${owner}`);
    if (editing && !message.media_group_id) return this.applyBroadcastEdit(message, editing, say);
    const timing = this.read(`broadcast:timing:${owner}`);
    if (timing && text) return this.applyBroadcastTime(message, timing, say);
    if (message.media_group_id && this.read(this.broadcastAlbumKey(message))) return this.rememberBroadcastAlbum(message);
    if (!this.broadcastContent(message)) return false;
    if (this.read(`broadcast:armed:${owner}`)) {
      this.remove(`broadcast:armed:${owner}`);
      if (message.media_group_id) return this.rememberBroadcastAlbum(message);
      await this.presentBroadcast(message, [message.message_id]);
      return true;
    }
    if (message.media_group_id) return false;
    const prefixed = typeof message.text === 'string' ? stripBroadcastPrefix(message.text, message.entities)
      : typeof message.caption === 'string' ? stripBroadcastPrefix(message.caption, message.caption_entities) : null;
    if (!prefixed) return false;
    const override = typeof message.text === 'string' ? { text: prefixed.text, entities: prefixed.entities } : { caption: prefixed.text, caption_entities: prefixed.entities };
    await this.presentBroadcast(message, [message.message_id], override);
    return true;
  }

  broadcastAlbumKey(message) {
    const group = String(message.media_group_id || '').replace(/[^\w.-]/g, '').slice(0, 64);
    return group ? `broadcast:album:${message.chat.id}:${group}` : null;
  }

  async rememberBroadcastAlbum(message) {
    const key = this.broadcastAlbumKey(message);
    if (!key) {
      await this.presentBroadcast(message, [message.message_id]);
      return true;
    }
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

  async presentBroadcast(message, messageIds, override = null) {
    const ids = [...new Set(messageIds.filter(id => Number.isSafeInteger(Number(id)) && Number(id) > 0).map(Number))].sort((a, b) => a - b).slice(0, 10);
    if (!ids.length || !this.owners().includes(String(message.from?.id))) return false;
    const entries = this.broadcastEntries();
    const view = await this.broadcastTargetView(entries);
    const draft = {
      token: crypto.randomUUID().replaceAll('-', '').slice(0, 16), ownerId: String(message.from.id), chatId: message.chat.id, messageIds: ids,
      kind: contentKind(message, ids.length), isText: ids.length === 1 && (typeof message.text === 'string' || typeof override?.text === 'string'), override,
      targets: entries.map(item => item.id), labels: view.map(item => item.label), problems: view.map(item => item.problem),
      selected: [], silent: false, pin: false, screen: 'main', testing: this.env.BROADCAST_TEST_MODE === 'true',
      status: 'open', created: Date.now(),
    };
    draft.warned = draft.problems.flatMap((problem, index) => problem ? [index] : []);
    const sent = await telegram(this.env.BOT_TOKEN)('sendMessage', {
      chat_id: message.chat.id,
      text: this.broadcastScreenText(draft),
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: this.broadcastKeyboard(draft) },
    });
    if (!Number.isSafeInteger(sent?.message_id)) throw new Error('确认消息没有发出去');
    draft.promptMessageId = sent.message_id;
    this.write(`broadcast:draft:${draft.token}`, draft, DRAFT_TTL);
    return true;
  }

  broadcastScreenText(draft) {
    const labels = draft.labels || draft.targets;
    if (draft.screen === 'pick') return `选择要发送的目标（${labels.length} 个），然后点确认发送。`;
    if (draft.screen === 'time') return [
      '什么时候发？（北京时间）',
      `发到：${draft.scope === 'selected' ? `所选的 ${draft.selected.length} 个目标` : `全部 ${labels.length} 个目标`}`,
      '',
      '到时间前请不要删除你发给我的原消息。',
    ].join('\n');
    return [
      `要把${draft.kind || '这条消息'}发到哪里？`,
      '',
      '目标：',
      ...labels.map((label, index) => draft.problems?.[index] ? `⚠️ ${label}：${draft.problems[index]}` : `✅ ${label}`),
      ...(draft.warned?.length ? ['', '带 ⚠️ 的目标现在多半发不出去。可以先去补权限，或用「选择目标」跳过它们。'] : []),
      '',
      draft.testing ? '当前是测试模式。确认后只会复制一份给所有者 ' + BROADCAST_TEST_CHAT + '，不会发到这些目标。' : '确认后才会发送。',
    ].join('\n').slice(0, 3500);
  }

  broadcastKeyboard(draft) {
    const token = draft.token;
    const options = [
      { text: draft.silent ? '🔕 静音发送：开' : '🔔 静音发送：关', callback_data: `bc:s:${token}` },
      { text: draft.pin ? '📌 发完置顶：开' : '📌 发完置顶：关', callback_data: `bc:n:${token}` },
    ];
    if (draft.screen === 'time') {
      const now = Date.now();
      return [
        PRESETS.slice(0, 3).map(code => ({ text: presetLabel(code, now), callback_data: `bc:h:${token}:${code}` })),
        PRESETS.slice(3).map(code => ({ text: presetLabel(code, now), callback_data: `bc:h:${token}:${code}` })),
        [{ text: '自己输入时间', callback_data: `bc:h:${token}:cu` }],
        [{ text: '返回', callback_data: `bc:b:${token}` }],
      ];
    }
    if (draft.screen === 'pick') {
      const chosen = new Set(draft.selected || []), warned = draft.warned || [];
      return [
        ...(draft.labels || draft.targets).map((target, index) => {
          const warn = warned.includes(index);
          return [{ text: `${chosen.has(index) ? '☑' : '☐'} ${warn ? WARN_MARK : ''}${broadcastPickerLabel(target, warn)}`, callback_data: `bc:t:${token}:${index}` }];
        }),
        options,
        [{ text: '确认发送', callback_data: `bc:g:${token}` }, { text: '⏰ 定时发送所选', callback_data: `bc:w:${token}` }],
        [{ text: '取消', callback_data: `bc:c:${token}` }],
      ];
    }
    return [
      [{ text: '发送到全部目标', callback_data: `bc:a:${token}` }],
      [{ text: '选择目标', callback_data: `bc:p:${token}` }],
      options,
      [{ text: '⏰ 定时发送', callback_data: `bc:w:${token}` }],
      [{ text: '取消', callback_data: `bc:c:${token}` }],
    ];
  }

  async broadcastAction(callback) {
    const tg = telegram(this.env.BOT_TOKEN);
    let answered = false;
    const answer = (text, alert = false) => { if (answered) return Promise.resolve(); answered = true; return tg('answerCallbackQuery', { callback_query_id: callback.id, text: String(text || '').slice(0, 190), show_alert: alert }).catch(() => {}); };
    if (!this.owners().includes(String(callback.from?.id))) return answer('只有机器人所有者可以操作。', true);
    const data = String(callback.data || '');
    const delivered = /^bc:([ue]):([0-9a-f]{16})$/.exec(data);
    if (delivered?.[1] === 'u') return this.broadcastUndo(callback, delivered[2], answer);
    if (delivered?.[1] === 'e') return this.broadcastEditStart(callback, delivered[2], answer);
    const toggle = /^bc:t:([0-9a-f]{16}):(\d{1,2})$/.exec(data);
    const hour = /^bc:h:([0-9a-f]{16}):(m30|h1|h3|e20|m09|cu)$/.exec(data);
    const action = /^bc:([apcgsnwbz]):([0-9a-f]{16})$/.exec(data);
    if (!toggle && !hour && !action) return answer('无效操作。', true);
    const kind = toggle ? 't' : hour ? 'h' : action[1];
    const token = (toggle || hour || action)[1 + (action ? 1 : 0)];
    const key = `broadcast:draft:${token}`;
    const draft = this.read(key);
    const messageId = callback.message?.message_id;
    const allowed = kind === 'z' ? draft?.status === 'scheduled' : draft?.status === 'open';
    if (!draft || !allowed || String(draft.ownerId) !== String(callback.from.id) || !Number.isSafeInteger(messageId) || messageId !== draft.promptMessageId) return answer('这个按钮已失效。', true);
    const redraw = async (textToo = false) => {
      this.write(key, draft, DRAFT_TTL);
      const params = { chat_id: draft.chatId, message_id: draft.promptMessageId, reply_markup: { inline_keyboard: this.broadcastKeyboard(draft) } };
      if (textToo) await tg('editMessageText', { ...params, text: this.broadcastScreenText(draft), disable_web_page_preview: true }).catch(() => {});
      else await tg('editMessageReplyMarkup', params).catch(() => {});
    };
    if (kind === 't') {
      const index = Number(toggle[2]);
      if (!Number.isSafeInteger(index) || index < 0 || index >= draft.targets.length) return answer('无效操作。', true);
      const selected = new Set(draft.selected || []);
      if (selected.has(index)) selected.delete(index); else selected.add(index);
      draft.selected = [...selected].sort((a, b) => a - b);
      await redraw();
      return answer(draft.selected.length ? `已选 ${draft.selected.length} 个` : '未选择目标');
    }
    if (kind === 's') { draft.silent = !draft.silent; await redraw(); return answer(draft.silent ? '静音发送：订阅者不会收到提醒' : '正常发送，会有提醒'); }
    if (kind === 'n') { draft.pin = !draft.pin; await redraw(); return answer(draft.pin ? '发完会自动置顶' : '发完不置顶'); }
    if (kind === 'c') {
      draft.status = 'cancelled';
      this.remove(`broadcast:timing:${draft.ownerId}`);
      this.write(key, draft, DRAFT_TTL);
      await tg('editMessageText', { chat_id: draft.chatId, message_id: draft.promptMessageId, text: '已取消，没有发送。' }).catch(() => {});
      return answer('已取消');
    }
    if (kind === 'p') { draft.screen = 'pick'; await redraw(true); return answer('请选择目标'); }
    if (kind === 'b') { draft.screen = 'main'; await redraw(true); return answer('已返回'); }
    if (kind === 'w') {
      draft.scope = draft.screen === 'pick' ? 'selected' : 'all';
      if (draft.scope === 'selected' && !draft.selected?.length) return answer('请先勾选至少一个目标。', true);
      draft.screen = 'time';
      await redraw(true);
      return answer('请选择发送时间');
    }
    if (kind === 'h') {
      if (draft.screen !== 'time') return answer('这个按钮已失效。', true);
      if (hour[2] === 'cu') {
        this.write(`broadcast:timing:${draft.ownerId}`, { token }, WAIT_TTL);
        await tg('sendMessage', { chat_id: draft.chatId, text: '请发送发送时间（北京时间），例如：21:30、明天 9:00、10-20 21:30。最多 7 天以内。\n发「取消」退出。' }).catch(() => {});
        return answer('请发送时间');
      }
      const result = await this.startBroadcast(draft, this.broadcastScopeIndexes(draft), presetTime(hour[2]));
      return answer(result.error || '已定好时间', !!result.error);
    }
    if (kind === 'z') return this.cancelScheduledBroadcast(draft, answer);
    const result = await this.startBroadcast(draft, kind === 'a' ? draft.targets.map((_, index) => index) : draft.selected || [], null);
    return answer(result.error || '开始发送', !!result.error);
  }

  broadcastScopeIndexes(draft) {
    return draft.scope === 'selected' ? draft.selected || [] : draft.targets.map((_, index) => index);
  }

  // Sends now (due null) or queues the copies for a Beijing time picked on
  // the 定时发送 screen. Each copy is still one job per target.
  async startBroadcast(draft, indexes, due) {
    const tg = telegram(this.env.BOT_TOKEN);
    const sendIds = indexes.map(index => draft.targets[index]).filter(Boolean);
    const selectedLabels = indexes.map(index => (draft.labels || draft.targets)[index]).filter(Boolean);
    if (!sendIds.length) return { error: '请至少选择一个目标。' };
    if (due && (due < Date.now() + 60000 || due > Date.now() + MAX_SCHEDULE)) return { error: '时间要在 1 分钟以后、7 天以内。' };
    draft.status = due ? 'scheduled' : 'sending';
    this.remove(`broadcast:timing:${draft.ownerId}`);
    draft.sendIds = sendIds;
    draft.selectedLabels = selectedLabels;
    draft.scheduledAt = due || null;
    this.write(`broadcast:draft:${draft.token}`, draft, due ? Math.max(DRAFT_TTL, due - Date.now() + DAY) : DRAFT_TTL);
    this.queueBroadcastSends(draft, due || Date.now());
    await this.schedule(due || Date.now() + 200);
    const extras = [draft.silent ? '静音发送' : '', draft.pin ? '发完置顶' : ''].filter(Boolean).join('、');
    if (!due) {
      const progress = draft.testing ? '测试模式：正在复制一份给你自己…' : `正在发送到 ${sendIds.length} 个目标…`;
      await tg('editMessageText', { chat_id: draft.chatId, message_id: draft.promptMessageId, text: progress + (extras ? `（${extras}）` : '') }).catch(() => {});
      return {};
    }
    const text = [
      `⏰ 已定好：${formatBeijing(due)}（北京时间）发送到 ${sendIds.length} 个目标${extras ? `（${extras}）` : ''}。`,
      draft.testing ? '测试模式：到时只会复制一份给你自己。' : '',
      '到时间前请不要删除原消息。想改主意就点「取消定时」。',
    ].filter(Boolean).join('\n');
    await tg('editMessageText', { chat_id: draft.chatId, message_id: draft.promptMessageId, text, reply_markup: { inline_keyboard: [[{ text: '取消定时', callback_data: `bc:z:${draft.token}` }]] } }).catch(() => {});
    return { text };
  }

  async applyBroadcastTime(message, timing, say) {
    const owner = String(message.from.id);
    const draft = this.read(`broadcast:draft:${timing.token}`);
    if (!draft || draft.status !== 'open' || String(draft.ownerId) !== owner) {
      this.remove(`broadcast:timing:${owner}`);
      await say('这条群发已经不在等待中了，请重新发「群发」。');
      return true;
    }
    const due = parseBroadcastTime(message.text);
    if (!due) { await say('没看懂这个时间。可以这样写：21:30、明天 9:00、10-20 21:30。\n发「取消」退出。'); return true; }
    const result = await this.startBroadcast(draft, this.broadcastScopeIndexes(draft), due);
    if (result.error) { await say(result.error + '\n请重新发送时间，或发「取消」退出。'); return true; }
    this.remove(`broadcast:timing:${owner}`);
    await say(result.text);
    return true;
  }

  async cancelScheduledBroadcast(draft, answer) {
    const tg = telegram(this.env.BOT_TOKEN);
    const pattern = `broadcast:send:${draft.token}:%`;
    const waiting = this.sql.exec("SELECT COUNT(*) AS n FROM jobs WHERE id LIKE ? AND status='pending' AND attempts=0 AND due>?", pattern, Date.now() + 1000).toArray()[0]?.n || 0;
    const delivery = this.read(`broadcast:delivery:${draft.token}`);
    if (!delivery || waiting < delivery.targets.length) return answer('已经开始发送，取消不了。发完后可以点「撤回」。', true);
    this.sql.exec("DELETE FROM jobs WHERE id LIKE ? AND status='pending' AND attempts=0", pattern);
    this.remove(`broadcast:delivery:${draft.token}`);
    draft.status = 'cancelled';
    this.write(`broadcast:draft:${draft.token}`, draft, DRAFT_TTL);
    await tg('editMessageText', { chat_id: draft.chatId, message_id: draft.promptMessageId, text: '已取消定时，没有发送。' }).catch(() => {});
    return answer('已取消定时');
  }

  queueBroadcastSends(draft, due = Date.now()) {
    // Test mode records the chosen names, but delivers a single copy to the owner.
    const targets = draft.testing ? [BROADCAST_TEST_CHAT] : draft.sendIds;
    const delivery = {
      id: draft.token, ownerId: draft.ownerId, ownerChatId: draft.chatId, messageIds: draft.messageIds,
      targets, selectedLabels: draft.selectedLabels || [], testing: draft.testing === true,
      labelById: Object.fromEntries((draft.sendIds || []).map((id, index) => [id, (draft.selectedLabels || [])[index] || id])),
      isText: draft.isText === true, silent: draft.silent === true, pin: draft.pin === true, scheduledAt: draft.scheduledAt || null,
      results: {}, undoState: 'idle',
    };
    this.write(`broadcast:delivery:${draft.token}`, delivery, Math.max(DELIVERY_TTL, due - Date.now() + DELIVERY_TTL));
    const override = draft.override;
    for (const target of targets) {
      const chatId = chatIdOf(target);
      const base = { chat_id: chatId, ...(draft.silent ? { disable_notification: true } : {}) };
      let copy;
      if (draft.messageIds.length > 1) copy = { method: 'copyMessages', params: { ...base, from_chat_id: draft.chatId, message_ids: draft.messageIds } };
      else if (typeof override?.text === 'string') copy = { method: 'sendMessage', params: { ...base, text: override.text, ...(override.entities?.length ? { entities: override.entities } : {}) } };
      else copy = { method: 'copyMessage', params: { ...base, from_chat_id: draft.chatId, message_id: draft.messageIds[0], ...(typeof override?.caption === 'string' ? { caption: override.caption, ...(override.caption_entities?.length ? { caption_entities: override.caption_entities } : {}) } : {}) } };
      const plan = { ops: [copy, { local: 'broadcast-copied', broadcastId: draft.token, target }], entry: { action: 'broadcast-copy', chatId: String(chatId), reasons: ['所有者广播'] } };
      this.sql.exec('INSERT OR IGNORE INTO jobs(id,payload,plan,due,created) VALUES (?,?,?,?,?)', `broadcast:send:${draft.token}:${target}`, '{}', JSON.stringify(plan), due, Date.now());
    }
  }

  // After a successful copy: pin it when asked. A pin failure is reported on
  // that target's line, never retried, and never resends the copy.
  async broadcastCopied(op, plan) {
    const messageIds = copiedIds(plan.ops.find(item => ['copyMessage', 'copyMessages', 'sendMessage'].includes(item.method)));
    if (!messageIds.length) return this.broadcastSettle(op.broadcastId, op.target, { ok: false, error: '没有返回消息 ID', messageIds: [] });
    const result = { ok: true, messageIds };
    const delivery = this.read(`broadcast:delivery:${op.broadcastId}`);
    if (delivery?.pin) {
      try {
        await telegram(this.env.BOT_TOKEN)('pinChatMessage', { chat_id: chatIdOf(op.target), message_id: messageIds[0], disable_notification: delivery.silent === true });
        result.pinned = true;
      } catch (error) { result.pinError = String(error.message || '置顶失败').slice(0, 120); }
    }
    this.broadcastSettle(op.broadcastId, op.target, result);
  }

  // Called only after the queue gives up. A retry leaves the target unsettled
  // so the same job can finish the copy without creating a second one.
  async broadcastJobFailed(job, plan, error) {
    if (job.id.startsWith('broadcast:undo:')) return this.broadcastUndoFailed(plan, error);
    if (job.id.startsWith('broadcast:edit:')) {
      const op = plan?.ops?.find(item => item.local === 'broadcast-edit-report');
      const delivery = op && this.read(`broadcast:delivery:${op.broadcastId}`);
      if (delivery) await telegram(this.env.BOT_TOKEN)('sendMessage', { chat_id: delivery.ownerChatId, text: '修改没有完成：' + String(error.message || '发送失败').slice(0, 200) + '\n可以稍后再点一次「修改文字」。' }).catch(() => {});
      return;
    }
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
    const pinNote = result => result?.pinned ? '（已置顶）' : result?.pinError ? `（置顶失败：${result.pinError}）` : '';
    const lines = ['广播结果', ''];
    if (delivery.testing) {
      lines.push('选择的目标：' + (delivery.selectedLabels || []).join('、'));
      const copy = delivery.results[BROADCAST_TEST_CHAT];
      lines.push(copy?.ok
        ? `测试模式：已复制一份给所有者 ${BROADCAST_TEST_CHAT}${pinNote(copy)}，没有发给上面这些目标。`
        : `测试模式：复制给所有者 ${BROADCAST_TEST_CHAT} 失败：${copy?.error || '发送失败'}。没有发给上面这些目标。`);
    } else {
      for (const target of delivery.targets) {
        const result = delivery.results[target];
        const label = delivery.labelById?.[target] || target;
        lines.push(result?.ok ? `✅ ${label}${pinNote(result)}` : `❌ ${label}：${result?.error || '发送失败'}`);
      }
    }
    const canUndo = delivery.targets.some(target => delivery.results[target]?.messageIds?.length);
    if (canUndo) lines.push('', '发错了可以点「修改文字」直接改；点「撤回」从已发送的目标删除。Telegram 只允许删除 48 小时内发出的消息。');
    else lines.push('', '没有发送成功的目标。');
    const params = { chat_id: delivery.ownerChatId, text: lines.join('\n').slice(0, 4000), disable_web_page_preview: true };
    if (canUndo) params.reply_markup = { inline_keyboard: [[{ text: '✏️ 修改文字', callback_data: `bc:e:${delivery.id}` }, { text: '撤回', callback_data: `bc:u:${delivery.id}` }]] };
    const plan = { ops: [{ method: 'sendMessage', params }, { local: 'broadcast-reported', broadcastId: delivery.id }], entry: { action: 'broadcast-report', chatId: String(delivery.ownerChatId), reasons: ['所有者广播结果'] } };
    this.sql.exec('INSERT OR IGNORE INTO jobs(id,payload,plan,due,created) VALUES (?,?,?,?,?)', `broadcast:report:${delivery.id}`, '{}', JSON.stringify(plan), Date.now(), Date.now());
  }

  broadcastDeliveryFor(callback, id) {
    const delivery = this.read(`broadcast:delivery:${id}`);
    const messageId = callback.message?.message_id;
    if (!delivery || String(delivery.ownerId) !== String(callback.from?.id) || !Number.isSafeInteger(messageId) || messageId !== delivery.reportMessageId) return null;
    return delivery;
  }

  async broadcastEditStart(callback, id, answer) {
    const delivery = this.broadcastDeliveryFor(callback, id);
    if (!delivery) return answer('这个按钮已失效。', true);
    if (delivery.undoState !== 'idle') return answer('已经撤回，不能再修改。', true);
    if (!delivery.targets.some(target => delivery.results[target]?.messageIds?.length)) return answer('没有可以修改的消息。', true);
    this.write(`broadcast:editing:${delivery.ownerId}`, { id }, WAIT_TTL);
    this.remove(`broadcast:armed:${delivery.ownerId}`);
    this.remove(`broadcast:timing:${delivery.ownerId}`);
    await telegram(this.env.BOT_TOKEN)('sendMessage', {
      chat_id: delivery.ownerChatId,
      text: (delivery.isText ? '请发送改好的完整文字，我会把已经发出去的那条一起改掉。' : '请发送新的说明文字，会替换已经发出去的图片、视频或文件下面的文字。') + '（10 分钟内有效）\n发「取消」退出。',
    }).catch(() => {});
    return answer('请发送改好的文字');
  }

  async applyBroadcastEdit(message, editing, say) {
    const owner = String(message.from.id);
    if (typeof message.text !== 'string' || !message.text.trim()) { await say('修改只能发文字。\n发「取消」退出。'); return true; }
    const key = `broadcast:delivery:${editing.id}`;
    const delivery = this.read(key);
    this.remove(`broadcast:editing:${owner}`);
    if (!delivery || delivery.undoState !== 'idle') { await say('这条群发已经不能修改了。'); return true; }
    const limit = delivery.isText ? 4096 : 1024;
    if (message.text.length > limit) {
      this.write(`broadcast:editing:${owner}`, editing, WAIT_TTL);
      await say(`太长了：${delivery.isText ? '文字' : '说明文字'}最多 ${limit} 个字，请删短后重新发送。`);
      return true;
    }
    const entities = Array.isArray(message.entities) && message.entities.length ? message.entities : null;
    const ops = delivery.targets.flatMap(target => {
      const messageId = delivery.results[target]?.messageIds?.[0];
      if (!messageId) return [];
      const params = delivery.isText
        ? { chat_id: chatIdOf(target), message_id: messageId, text: message.text, ...(entities ? { entities } : {}) }
        : { chat_id: chatIdOf(target), message_id: messageId, caption: message.text, ...(entities ? { caption_entities: entities } : {}) };
      return [{ method: delivery.isText ? 'editMessageText' : 'editMessageCaption', params, broadcastTarget: target, broadcastContinue: true }];
    });
    if (!ops.length) { await say('没有可以修改的消息。'); return true; }
    delivery.editAttempts = (delivery.editAttempts || 0) + 1;
    this.write(key, delivery, DELIVERY_TTL);
    ops.push({ local: 'broadcast-edit-report', broadcastId: editing.id });
    this.sql.exec('INSERT OR IGNORE INTO jobs(id,payload,plan,due,created) VALUES (?,?,?,?,?)', `broadcast:edit:${editing.id}:${delivery.editAttempts}`, '{}', JSON.stringify({ ops, entry: { action: 'broadcast-edit', chatId: String(delivery.ownerChatId), reasons: ['修改所有者广播'] } }), Date.now(), Date.now());
    await this.schedule(Date.now() + 200);
    await say('正在修改已经发出去的消息…');
    return true;
  }

  async broadcastEditReport(op, plan) {
    const delivery = this.read(`broadcast:delivery:${op.broadcastId}`);
    if (!delivery) return;
    const lines = ['修改结果', ''];
    for (const item of plan.ops.filter(entry => entry.broadcastTarget)) {
      const label = delivery.testing ? `所有者 ${BROADCAST_TEST_CHAT}（测试模式）` : delivery.labelById?.[item.broadcastTarget] || item.broadcastTarget;
      if (!item.skipped) lines.push(`✅ ${label}：已改好`);
      else if (/not modified/i.test(item.skipped)) lines.push(`✅ ${label}：内容和原来一样，没有变化`);
      else lines.push(`❌ ${label}：${/can.t be edited/i.test(item.skipped) ? '改不了：机器人没有编辑权限，或消息已被删除' : item.skipped}`);
    }
    await telegram(this.env.BOT_TOKEN)('sendMessage', { chat_id: delivery.ownerChatId, text: lines.join('\n').slice(0, 4000), disable_web_page_preview: true });
  }

  async broadcastUndo(callback, id, answer) {
    const delivery = this.broadcastDeliveryFor(callback, id);
    if (!delivery) return answer('这个按钮已失效。', true);
    if (delivery.undoState === 'done') return answer('已经撤回过了。', true);
    if (delivery.undoState === 'running') return answer('正在撤回。', true);
    const copies = delivery.targets.flatMap(target => (delivery.results[target]?.messageIds || []).map(message_id => ({ target, message_id })));
    if (!copies.length) return answer('没有可以撤回的消息。', true);
    delivery.undoState = 'running';
    delivery.undoMessageId = callback.message.message_id;
    delivery.undoAttempts = (delivery.undoAttempts || 0) + 1;
    this.write(`broadcast:delivery:${id}`, delivery, DELIVERY_TTL);
    this.remove(`broadcast:editing:${delivery.ownerId}`);
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
    // The 撤回 / 修改 buttons have done their job; take them off the result message.
    if (Number.isSafeInteger(delivery.reportMessageId)) await tg('editMessageReplyMarkup', { chat_id: delivery.ownerChatId, message_id: delivery.reportMessageId, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    delivery.undoReported = true;
    delivery.undoState = 'done';
    this.write(key, delivery, DELIVERY_TTL);
  }
}
