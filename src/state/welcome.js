// Welcome card and group rules: the message new members see, the 📜 rules
// button (popup or private chat), /rules, and the admin preview.
// Methods are copied onto GuardState.prototype in ../state.js.
import { telegram } from '../telegram.js';
import { linkBase } from './links.js';
import { BANNER_ID, BANNERS } from '../assets/welcome-banner.js';

const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export const DEFAULT_WELCOME = '👋 欢迎 {name} 加入 **{group}**！';
// Telegram popups hold 200 characters; longer rules open in the bot's private chat.
const POPUP_LIMIT = 190;
const MAX_BUTTONS = 8;

// Admin text is escaped first, then **bold** and the placeholders are filled in.
const format = text => esc(text).replace(/\*\*([^*\n][^\n]*?)\*\*/g, '<b>$1</b>');
const plain = text => String(text || '').replace(/\*\*([^*\n][^\n]*?)\*\*/g, '$1');
const mention = member => `<a href="tg://user?id=${Number(member.id)}">${esc(member.name || '新成员')}</a>`;

// Telegram button colours; buttons without one use the app's default look.
const STYLES = { 蓝: 'primary', 蓝色: 'primary', blue: 'primary', 绿: 'success', 绿色: 'success', green: 'success', 红: 'danger', 红色: 'danger', red: 'danger' };
const STYLE_NAMES = { primary: '蓝', success: '绿', danger: '红' };
// Merge newcomers who join within this window into one card.
const MERGE_MS = 5 * 60000;
// A link in a button line: a web or tg:// address, t.me/… or an @username.
const LINK = /(?:https?:\/\/|tg:\/\/)[^\s|｜]+|t\.me\/[^\s|｜]+|@[A-Za-z][A-Za-z0-9_]{3,31}(?![A-Za-z0-9_])/i;
const toUrl = link => link.startsWith('@') ? `https://t.me/${link.slice(1)}` : /^t\.me\//i.test(link) ? `https://${link}` : link;
// One button per line: "按钮文字 | 链接 | 颜色". The separator can also be a
// colon or a space ("DMIT选购：https://…"), and @频道 becomes a t.me link.
export function parseWelcomeButtons(value) {
  if (Array.isArray(value)) return value;
  const buttons = [];
  for (const [index, raw] of String(value || '').split('\n').entries()) {
    const line = raw.trim();
    if (!line) continue;
    const match = LINK.exec(line);
    if (!match) throw new Error(`按钮第 ${index + 1} 行没有找到链接，格式：按钮文字 | 链接（链接以 https:// 开头，或写 @频道名）`);
    const text = line.slice(0, match.index).replace(/[\s|｜:：\-—]+$/, '').trim();
    const color = line.slice(match.index + match[0].length).replace(/^[\s|｜:：,，]+/, '').trim();
    const style = color ? STYLES[color.toLowerCase()] : undefined;
    if (color && !style) throw new Error(`按钮第 ${index + 1} 行的颜色只能填 蓝、绿 或 红`);
    buttons.push({ text, url: toUrl(match[0]), ...(style ? { style } : {}) });
  }
  return buttons;
}
export function normalizeWelcomeButtons(items) {
  if (!Array.isArray(items) || items.length > MAX_BUTTONS) throw new Error(`按钮最多 ${MAX_BUTTONS} 个`);
  return items.map((item, index) => {
    const text = String(item?.text || '').trim(), url = String(item?.url || '').trim();
    if (!text || text.length > 32) throw new Error(`第 ${index + 1} 个按钮的文字需为 1–32 个字`);
    if (!/^(https?:\/\/[^\s]+|tg:\/\/[^\s]+)$/i.test(url) || url.length > 512) throw new Error(`第 ${index + 1} 个按钮的链接无效，需以 https:// 开头`);
    if (item?.style !== undefined && !Object.hasOwn(STYLE_NAMES, item.style)) throw new Error(`第 ${index + 1} 个按钮的颜色无效`);
    return { text, url, ...(item?.style ? { style: item.style } : {}) };
  });
}
export const welcomeButtonsText = buttons => (buttons || []).map(item => `${item.text} | ${item.url}${item.style ? ` | ${STYLE_NAMES[item.style]}` : ''}`).join('\n');

// Banner above the card: a built-in colour ('default' = blue, or purple/gold/green), 'off', or an https image link.
export function normalizeWelcomeBanner(value) {
  const banner = String(value ?? 'default').trim();
  if (!banner || banner === 'default' || banner === 'blue') return 'default';
  if (banner === 'off' || Object.hasOwn(BANNERS, banner)) return banner;
  if (!/^https:\/\/[^\s]+$/i.test(banner) || banner.length > 512) throw new Error('横幅图片链接无效，需以 https:// 开头');
  return banner;
}
export const bannerUrl = (config, env) => {
  const banner = config.welcomeBanner || 'default';
  if (banner === 'off') return '';
  if (/^https:/i.test(banner)) return banner;
  return `${linkBase(env)}/welcome-banner-${banner === 'default' ? 'blue' : banner}.jpg?v=${BANNER_ID}`;
};
// Photo captions hold 1024 characters of visible text.
const visibleLength = html => html.replace(/<[^>]+>/g, '').replace(/&(amp|lt|gt);/g, '_').length;

export function welcomeText(config, members, chatTitle, memberCount) {
  const names = members.slice(0, 10).map(mention).join('、') + (members.length > 10 ? ` 等 ${members.length} 人` : '');
  const greeting = format(config.welcomeMessage || DEFAULT_WELCOME).replaceAll('{group}', esc(chatTitle || '本群')).replaceAll('{name}', names);
  const keep = config.welcomeDeleteMinutes;
  // Bold headline, then the owner's own extra lines, then a quote block of tips, then a small footer.
  const [title, ...rest] = greeting.split('\n');
  const intro = rest.filter(line => line.trim());
  const tips = [
    ...(config.welcomeShowCount !== false && memberCount > 0 ? [members.length === 1 ? `🎉 你是本群第 <b>${memberCount.toLocaleString('en-US')}</b> 位成员` : `🎉 群里现在共有 <b>${memberCount.toLocaleString('en-US')}</b> 位成员`] : []),
    ...(config.rulesMessage ? ['📜 发言前请先点下方「群规」看一眼'] : []),
    '🛡 广告和骗子会被机器人自动清理',
  ];
  const footer = [
    ...(keep > 0 ? [`⏳ ${keep >= 60 && keep % 60 === 0 ? `${keep / 60} 小时` : `${keep} 分钟`}后自动消失`] : []),
    ...(config.welcomeButtons?.length ? ['👇 常用入口'] : []),
  ];
  return [
    [`<b>${title.replace(/<\/?b>/g, '')}</b>`, ...intro].join('\n'),
    `<blockquote>${tips.join('\n')}</blockquote>`,
    ...(footer.length ? [`<i>${footer.join(' · ')}</i>`] : []),
  ].join('\n\n');
}
// The Bot API call that posts a card: a photo with caption when a banner is set and the text fits.
export function welcomeSend(config, env, chatId, text, keyboard, extra = {}) {
  const banner = bannerUrl(config, env);
  const markup = keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {};
  if (banner && visibleLength(text) <= 1024) return { method: 'sendPhoto', params: { chat_id: chatId, photo: banner, caption: text, parse_mode: 'HTML', ...markup, ...extra } };
  return { method: 'sendMessage', params: { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...markup, ...extra } };
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
    buttons.push({ text: '📜 群规', style: 'primary', ...(short || !botUsername ? { callback_data: `wr:${chatId}` } : { url: `https://t.me/${botUsername}?start=rules${String(chatId).replace('-', '')}` }) });
  }
  for (const item of config.welcomeButtons || []) buttons.push({ text: item.text, url: item.url, ...(item.style ? { style: item.style } : {}) });
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
    const keepLatest = config.welcomeKeepLatest !== false;
    const previous = keepLatest && this.read('welcome:last');
    if (Number.isSafeInteger(previous)) ops.push({ method: 'deleteMessage', params: { chat_id: chat.id, message_id: previous }, optional: true });
    // The card being replaced keeps its people: newcomers within a few minutes share one card.
    const recent = keepLatest && this.read('welcome:recent');
    const fresh = new Set(members.map(member => String(member.id)));
    if (recent && recent.at > Date.now() - MERGE_MS) members = [...recent.members.filter(member => !fresh.has(String(member.id))), ...members];
    this.write('welcome:recent', { at: Date.now(), members: members.slice(-20) }, MERGE_MS);
    const count = config.welcomeShowCount !== false ? await tg('getChatMemberCount', { chat_id: chat.id }).catch(() => 0) : 0;
    ops.push({
      ...welcomeSend(config, this.env, chat.id, welcomeText(config, members, chat.title, Number(count) || 0), keyboard, { disable_notification: true }),
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
    if (typeof options.showCount === 'boolean') config.welcomeShowCount = options.showCount;
    if (options.banner !== undefined) config.welcomeBanner = normalizeWelcomeBanner(options.banner);
    config.welcomeMessage = welcomeMessage.trim(); config.rulesMessage = rulesMessage.trim();
    this.saveConfig(config, '欢迎语与群规');
    this.log({ action: 'welcome-rules-update', actorId: 'web-admin', outcome: 'success' });
    return { welcomeMessage: config.welcomeMessage, rulesMessage: config.rulesMessage, welcomeEnabled: config.welcomeEnabled, welcomeButtons: config.welcomeButtons, welcomeDeleteMinutes: config.welcomeDeleteMinutes, welcomeKeepLatest: config.welcomeKeepLatest, welcomeShowCount: config.welcomeShowCount, welcomeBanner: config.welcomeBanner };
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
    const count = Number(await tg('getChatMemberCount', { chat_id: Number(chatId) }).catch(() => 0)) || 0;
    const results = await Promise.allSettled(recipients.map(id => { const card = welcomeSend(config, this.env, Number(id), welcomeText(config, [{ id, name: '新成员' }], title, count), keyboard); return tg(card.method, card.params); }));
    if (!results.some(item => item.status === 'fulfilled')) throw new Error('预览发送失败，请先私聊机器人发送一次 /start');
    return { sent: results.filter(item => item.status === 'fulfilled').length };
  }
}
