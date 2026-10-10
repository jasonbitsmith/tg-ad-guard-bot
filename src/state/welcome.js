// Welcome card and group rules: the message new members see, the 📜 rules
// button (popup or private chat), /rules, and the admin preview.
// Methods are copied onto GuardState.prototype in ../state.js.
import { telegram } from '../telegram.js';

const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export const DEFAULT_WELCOME = '👋 欢迎 {name} 加入 **{group}**！';
// Telegram popups hold 200 characters; longer rules open in the bot's private chat.
const POPUP_LIMIT = 190;
const MAX_BUTTONS = 8;

// Admin text is escaped first, then **bold** and the placeholders are filled in.
const format = text => esc(text).replace(/\*\*([^*\n][^\n]*?)\*\*/g, '<b>$1</b>');
const plain = text => String(text || '').replace(/\*\*([^*\n][^\n]*?)\*\*/g, '$1');
const mention = member => `<a href="tg://user?id=${Number(member.id)}">${esc(member.name || '新成员')}</a>`;

// One button per line: "按钮文字 | https://链接".
export function parseWelcomeButtons(value) {
  if (Array.isArray(value)) return value;
  const buttons = [];
  for (const [index, raw] of String(value || '').split('\n').entries()) {
    const line = raw.trim();
    if (!line) continue;
    const at = line.search(/[|｜]/);
    if (at < 0) throw new Error(`按钮第 ${index + 1} 行缺少「|」，格式：按钮文字 | 链接`);
    buttons.push({ text: line.slice(0, at).trim(), url: line.slice(at + 1).trim() });
  }
  return buttons;
}
export function normalizeWelcomeButtons(items) {
  if (!Array.isArray(items) || items.length > MAX_BUTTONS) throw new Error(`按钮最多 ${MAX_BUTTONS} 个`);
  return items.map((item, index) => {
    const text = String(item?.text || '').trim(), url = String(item?.url || '').trim();
    if (!text || text.length > 32) throw new Error(`第 ${index + 1} 个按钮的文字需为 1–32 个字`);
    if (!/^(https?:\/\/[^\s]+|tg:\/\/[^\s]+)$/i.test(url) || url.length > 512) throw new Error(`第 ${index + 1} 个按钮的链接无效，需以 https:// 开头`);
    return { text, url };
  });
}
export const welcomeButtonsText = buttons => (buttons || []).map(item => `${item.text} | ${item.url}`).join('\n');

export function welcomeText(config, members, chatTitle) {
  const names = members.slice(0, 10).map(mention).join('、') + (members.length > 10 ? ` 等 ${members.length} 人` : '');
  const greeting = format(config.welcomeMessage || DEFAULT_WELCOME).replaceAll('{group}', esc(chatTitle || '本群')).replaceAll('{name}', names);
  const keep = config.welcomeDeleteMinutes;
  return [
    greeting,
    ...(config.rulesMessage ? ['📌 发言前请先点下面的「📜 群规」看一眼'] : []),
    ...(keep > 0 ? [`<i>本消息 ${keep >= 60 && keep % 60 === 0 ? `${keep / 60} 小时` : `${keep} 分钟`}后自动删除</i>`] : []),
  ].join('\n\n');
}
export function rulesText(config, chatTitle) {
  return [
    `📜 <b>${esc(chatTitle || '本群')} · 群规</b>`,
    format(config.rulesMessage),
    '⚠️ 违规内容会被自动删除，发广告会被封禁。\n被误封？私聊我发 /start 可以申诉。',
  ].join('\n\n');
}
export function welcomeKeyboard(config, chatId, botUsername) {
  const buttons = [];
  if (config.rulesMessage) {
    const short = plain(config.rulesMessage).length <= POPUP_LIMIT - 8;
    buttons.push(short || !botUsername ? { text: '📜 群规', callback_data: `wr:${chatId}` } : { text: '📜 群规', url: `https://t.me/${botUsername}?start=rules${String(chatId).replace('-', '')}` });
  }
  for (const item of config.welcomeButtons || []) buttons.push({ text: item.text, url: item.url });
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return rows;
}

export class WelcomeMethods {
  welcomeActive(config) {
    return config.welcomeEnabled !== false && !!(config.welcomeMessage || config.rulesMessage || config.welcomeButtons?.length);
  }
  // Ops that post the welcome card (and remove the previous one) for real members who just joined.
  async welcomeOps(config, chat, members, tg) {
    if (!members.length || !this.welcomeActive(config)) return [];
    const me = config.rulesMessage ? await this.me(tg).catch(() => ({})) : {};
    const keyboard = welcomeKeyboard(config, chat.id, me.username);
    const ops = [];
    const previous = config.welcomeKeepLatest !== false && this.read('welcome:last');
    if (Number.isSafeInteger(previous)) ops.push({ method: 'deleteMessage', params: { chat_id: chat.id, message_id: previous }, optional: true });
    ops.push({
      method: 'sendMessage',
      params: { chat_id: chat.id, text: welcomeText(config, members, chat.title), parse_mode: 'HTML', disable_web_page_preview: true, disable_notification: true, ...(keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {}) },
      remember: 'welcome:last',
      ...(config.welcomeDeleteMinutes > 0 ? { cleanupAfter: config.welcomeDeleteMinutes * 60000 } : {}),
    });
    return ops;
  }
  // The 📜 button when the rules fit in a popup.
  async rulesCallbackPlan(callback) {
    const config = await this.config();
    const text = config.rulesMessage ? `📜 群规\n\n${plain(config.rulesMessage)}` : '本群暂未设置群规。';
    return { ops: [{ method: 'answerCallbackQuery', params: { callback_query_id: callback.id, text: text.length > 200 ? text.slice(0, 197) + '…' : text, show_alert: true } }] };
  }
  // /rules in the group: post the rules briefly, then tidy up.
  async rulesCommandPlan(msg) {
    const config = await this.config();
    if (!config.rulesMessage) return null;
    return { ops: [
      { method: 'deleteMessage', params: { chat_id: msg.chat.id, message_id: msg.message_id }, optional: true },
      { method: 'sendMessage', params: { chat_id: msg.chat.id, text: rulesText(config, msg.chat.title), parse_mode: 'HTML', disable_web_page_preview: true, disable_notification: true }, cleanupAfter: 2 * 60000 },
    ] };
  }
  // The rules shown in the bot's private chat after tapping 📜 (deep link /start rules…).
  async rulesForPrivate() {
    // Never set up storage for a group id someone typed by hand.
    if (!this.read('config')) return '这个群还没有设置群规。';
    const config = await this.config();
    const chat = this.read('chat') || {};
    return config.rulesMessage ? rulesText(config, chat.title) : '这个群还没有设置群规。';
  }
  async editWelcome(welcomeMessage, rulesMessage, options = {}) {
    if (typeof welcomeMessage !== 'string' || typeof rulesMessage !== 'string' || welcomeMessage.length > 2500 || rulesMessage.length > 2500) throw new Error('欢迎语和群规均不能超过 2500 个字符');
    const config = await this.config();
    if (options.buttons !== undefined) config.welcomeButtons = normalizeWelcomeButtons(parseWelcomeButtons(options.buttons));
    if (options.deleteMinutes !== undefined) {
      const minutes = Number(options.deleteMinutes);
      if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) throw new Error('自动删除时间需为 0 到 1440 分钟');
      config.welcomeDeleteMinutes = minutes;
    }
    if (typeof options.enabled === 'boolean') config.welcomeEnabled = options.enabled;
    if (typeof options.keepLatest === 'boolean') config.welcomeKeepLatest = options.keepLatest;
    config.welcomeMessage = welcomeMessage.trim(); config.rulesMessage = rulesMessage.trim();
    this.saveConfig(config, '欢迎语与群规');
    this.log({ action: 'welcome-rules-update', actorId: 'web-admin', outcome: 'success' });
    return { welcomeMessage: config.welcomeMessage, rulesMessage: config.rulesMessage, welcomeEnabled: config.welcomeEnabled, welcomeButtons: config.welcomeButtons, welcomeDeleteMinutes: config.welcomeDeleteMinutes, welcomeKeepLatest: config.welcomeKeepLatest };
  }
  // Sends the saved welcome card to the owners' private chats, as if they had just joined.
  async welcomePreview(chatId) {
    const config = await this.config();
    if (!this.welcomeActive(config)) throw new Error('请先开启入群欢迎并填写内容后再预览');
    const tg = telegram(this.env.BOT_TOKEN);
    const me = await this.me(tg).catch(() => ({}));
    const title = this.read('chat')?.title || String(chatId);
    const recipients = this.owners().filter(id => /^\d{1,16}$/.test(id));
    if (!recipients.length) throw new Error('未设置机器人所有者，无法发送预览');
    const keyboard = welcomeKeyboard(config, chatId, me.username);
    const results = await Promise.allSettled(recipients.map(id => tg('sendMessage', { chat_id: Number(id), text: `👀 <i>预览：新成员进群后群里会看到下面这样</i>\n\n${welcomeText(config, [{ id, name: '新成员' }], title)}`, parse_mode: 'HTML', disable_web_page_preview: true, ...(keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {}) })));
    if (!results.some(item => item.status === 'fulfilled')) throw new Error('预览发送失败，请先私聊机器人发送一次 /start');
    return { sent: results.filter(item => item.status === 'fulfilled').length };
  }
}
