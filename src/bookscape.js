import { digest, telegram, telegramUpload } from './telegram.js';

export const CHANNEL = '@Book_Scape';
const BOT = 'jasonworksai_bot';
const DAY = 86400000;

export function validatePost(body) {
  if (!body || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 4096) throw new Error('正文需为 1–4096 字符；长文请先精简');
  if (!['HTML', 'plain'].includes(body.format || 'HTML')) throw new Error('仅支持 HTML 或 plain');
  if (!['separate', 'photo_caption'].includes(body.layout || 'separate')) throw new Error('不支持此发布布局');
  if (Object.keys(body).some(k => !['text', 'format', 'image', 'layout'].includes(k))) throw new Error('不接受自定义频道、接收人或 Telegram 参数');
  let image;
  if (body.image !== undefined) {
    if (!body.image || typeof body.image !== 'object' || Object.keys(body.image).some(k => !['data', 'mime', 'name', 'caption'].includes(k))) throw new Error('图片参数无效');
    if (!['image/jpeg', 'image/png'].includes(body.image.mime)) throw new Error('配图仅支持 JPEG 或 PNG');
    if (typeof body.image.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.image.data) || body.image.data.length > 7000000) throw new Error('图片内容无效或过大');
    if (typeof body.image.name !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(body.image.name)) throw new Error('图片文件名无效');
    if (typeof body.image.caption !== 'string' || !body.image.caption.trim() || body.image.caption.length > 200) throw new Error('图片标题需为 1–200 字符');
    image = { data: body.image.data, mime: body.image.mime, name: body.image.name, caption: body.image.caption };
  }
  const layout = body.layout || 'separate';
  if (layout === 'photo_caption') {
    if (!image) throw new Error('单图单文布局必须包含配图');
    const visible = body.format === 'plain' ? body.text : body.text.replace(/<[^>]+>/g, '').replace(/&(?:lt|gt|amp|quot);/g, 'x');
    if (visible.length > 1024) throw new Error('图片说明文字超过 Telegram 的 1024 字符上限');
  }
  return { text: body.text, format: body.format || 'HTML', layout, ...(image ? { image } : {}) };
}

export async function channelStatus(env) {
  const tg = telegram(env.BOT_TOKEN);
  const me = await tg('getMe');
  if (me.username?.toLowerCase() !== BOT) throw new Error('机器人身份不匹配，已阻止发布');
  const chat = await tg('getChat', { chat_id: CHANNEL });
  if (chat.type !== 'channel' || chat.username?.toLowerCase() !== CHANNEL.slice(1).toLowerCase() || !Number.isSafeInteger(chat.id)) throw new Error('目标频道身份不匹配');
  const member = await tg('getChatMember', { chat_id: chat.id, user_id: me.id });
  return { bot: me.username, channel: CHANNEL, chatId: chat.id, title: chat.title, memberStatus: member.status, canPost: member.status === 'administrator' && member.can_post_messages === true };
}

export async function editPostCaption(env, body) {
  if (!body || Object.keys(body).some(k => !['messageId', 'text', 'format'].includes(k))) throw new Error('编辑参数无效');
  if (!Number.isSafeInteger(body.messageId) || body.messageId <= 0) throw new Error('消息编号无效');
  const format = body.format || 'HTML';
  if (!['HTML', 'plain'].includes(format) || typeof body.text !== 'string' || !body.text.trim()) throw new Error('图片说明无效');
  const visible = format === 'plain' ? body.text : body.text.replace(/<[^>]+>/g, '').replace(/&(?:lt|gt|amp|quot);/g, 'x');
  if (visible.length > 1024) throw new Error('图片说明文字超过 Telegram 的 1024 字符上限');
  const status = await channelStatus(env);
  if (!status.canPost) throw new Error('机器人缺少频道发布权限');
  const message = await telegram(env.BOT_TOKEN)('editMessageCaption', {
    chat_id: CHANNEL,
    message_id: body.messageId,
    caption: body.text,
    ...(format === 'HTML' ? { parse_mode: 'HTML' } : {}),
  });
  if (message?.message_id !== body.messageId) throw new Error('Telegram 返回的消息编号不匹配');
  return { ok: true, channel: CHANNEL, messageId: body.messageId, url: `https://t.me/Book_Scape/${body.messageId}` };
}

function init(state) {
  state.sql.exec(`CREATE TABLE IF NOT EXISTS bookscape_posts (id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, preview_state TEXT NOT NULL DEFAULT 'none', result TEXT, created INTEGER NOT NULL)`);
  // Keep only the deduplication receipt after expiry, never the old manuscript.
  state.sql.exec("UPDATE bookscape_posts SET payload='{}',state='expired' WHERE created<? AND state='draft'", Date.now() - DAY);
}
function row(state, id) {
  init(state);
  if (typeof id !== 'string' || id.length > 64) throw new Error('无效草稿编号');
  const post = state.sql.exec('SELECT * FROM bookscape_posts WHERE id=?', id).toArray()[0];
  if (!post) throw new Error('草稿不存在');
  return post;
}
function receipt(post) {
  const payload = JSON.parse(post.payload || '{}');
  const result = post.result ? JSON.parse(post.result) : {};
  return { id: post.id, hash: post.hash, state: post.state, previewState: post.preview_state, channel: CHANNEL, hasImage: !!(payload.image || payload.imageFileId || result.photoMessageId), ...result };
}
export async function draftPost(state, body) {
  const payload = validatePost(body);
  const hash = await digest(JSON.stringify(payload));
  init(state);
  // Synchronous insert after digest; concurrent identical drafts share one ID.
  state.sql.exec("INSERT OR IGNORE INTO bookscape_posts(id,hash,payload,state,created) VALUES (?,?,?,'draft',?)", crypto.randomUUID(), hash, JSON.stringify(payload), Date.now());
  return receipt(state.sql.exec('SELECT * FROM bookscape_posts WHERE hash=?', hash).one());
}
export function inspectPost(state, id) { return receipt(row(state, id)); }
function parameters(payload, chatId) {
  return { chat_id: chatId, text: payload.text, ...(payload.format === 'HTML' ? { parse_mode: 'HTML' } : {}), disable_notification: true, link_preview_options: { is_disabled: true } };
}
function photoParameters(payload, chatId) {
  const oneMessage = payload.layout === 'photo_caption';
  return { chat_id: chatId, photo: payload.imageFileId, caption: oneMessage ? payload.text : payload.imageCaption, ...(oneMessage && payload.format === 'plain' ? {} : { parse_mode: 'HTML' }), disable_notification: true };
}
function decodeImage(data) {
  const raw = atob(data);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
async function sendDraft(tg, token, payload, chatId) {
  let photo;
  const oneMessage = payload.layout === 'photo_caption';
  if (payload.image) {
    photo = await telegramUpload(token, 'sendPhoto', {
      chat_id: chatId, caption: oneMessage ? payload.text : payload.image.caption,
      ...(oneMessage && payload.format === 'plain' ? {} : { parse_mode: 'HTML' }), disable_notification: true,
    }, { field: 'photo', bytes: decodeImage(payload.image.data), name: payload.image.name, mime: payload.image.mime });
  } else if (payload.imageFileId) {
    photo = await tg('sendPhoto', photoParameters(payload, chatId));
  }
  const message = oneMessage ? photo : await tg('sendMessage', parameters(payload, chatId));
  if (!Number.isSafeInteger(message?.message_id)) throw new Error('正文返回异常');
  if (payload.image && !photo?.photo?.length) throw new Error('配图返回异常');
  return { message, photo };
}
export async function previewPost(state, id) {
  let post = row(state, id);
  if (post.preview_state === 'sent') return receipt(post);
  if (post.state !== 'draft' || post.preview_state !== 'none') throw new Error('此草稿不能重发预览；如状态不确定，请先检查机器人私聊');
  const owner = (state.env.ADMIN_IDS || '').split(',').map(x => x.trim()).find(x => /^[1-9]\d{0,15}$/.test(x));
  if (!owner || !Number.isSafeInteger(Number(owner))) throw new Error('未配置有效的机器人所有者 ID');
  const tg = telegram(state.env.BOT_TOKEN);
  const me = await tg('getMe');
  if (me.username?.toLowerCase() !== BOT) throw new Error('机器人身份不匹配');
  const chat = await tg('getChat', { chat_id: Number(owner) });
  if (chat.type !== 'private' || chat.id !== Number(owner)) throw new Error('预览仅允许发送到现有所有者私聊');
  post = row(state, id); // Re-read after I/O: another request may have acquired it.
  if (post.preview_state !== 'none' || post.state !== 'draft') return receipt(post);
  state.sql.exec("UPDATE bookscape_posts SET preview_state='sending' WHERE id=?", id);
  try {
    const payload = JSON.parse(post.payload);
    const sent = await sendDraft(tg, state.env.BOT_TOKEN, payload, chat.id);
    if (payload.image) {
      const imageFileId = sent.photo.photo.at(-1)?.file_id;
      if (!imageFileId) throw new Error('配图文件编号缺失');
      delete payload.image;
      payload.imageFileId = imageFileId;
      payload.imageCaption = sent.photo.caption || '📘 BookScape · 书境';
      state.sql.exec('UPDATE bookscape_posts SET payload=? WHERE id=?', JSON.stringify(payload), id);
    }
    state.sql.exec("UPDATE bookscape_posts SET preview_state='sent' WHERE id=?", id);
  } catch (error) {
    state.sql.exec("UPDATE bookscape_posts SET preview_state=? WHERE id=?", [400,403,429].includes(error.code) ? 'none' : 'unknown', id);
    throw new Error('私聊预览未确认成功；请确认已向机器人发送 /start，或检查私聊后再处理');
  }
  return receipt(row(state, id));
}
export async function publishPost(state, body) {
  let post = row(state, body?.id);
  if (body.confirmHash !== post.hash) throw new Error('确认摘要不匹配');
  if (post.state === 'sent') return receipt(post);
  if (post.state !== 'draft' || post.preview_state !== 'sent') throw new Error('请先完成私聊预览；发送中或结果不确定的草稿禁止重发');
  const status = await channelStatus(state.env);
  if (!status.canPost) throw new Error('机器人缺少频道发布权限');
  const pinned = state.read('bookscape:channel-id');
  if (pinned && pinned !== status.chatId) throw new Error('频道 ID 已变化，已阻止发布');
  state.write('bookscape:channel-id', status.chatId);
  post = row(state, body.id);
  if (post.state !== 'draft') return receipt(post);
  // Durable marker before send: ambiguous outcomes never auto-retry.
  state.sql.exec("UPDATE bookscape_posts SET state='sending' WHERE id=?", post.id);
  try {
    const sent = await sendDraft(telegram(state.env.BOT_TOKEN), state.env.BOT_TOKEN, JSON.parse(post.payload), status.chatId);
    const result = { messageId: sent.message.message_id, url: `https://t.me/Book_Scape/${sent.message.message_id}`, ...(sent.photo ? { photoMessageId: sent.photo.message_id } : {}) };
    state.sql.exec("UPDATE bookscape_posts SET state='sent',payload='{}',result=? WHERE id=?", JSON.stringify(result), post.id);
  } catch (error) {
    const certainFailure = [400,403,429].includes(error.code);
    state.sql.exec('UPDATE bookscape_posts SET state=? WHERE id=?', certainFailure ? 'draft' : 'unknown', post.id);
    throw new Error(certainFailure ? 'Telegram 拒绝发布，请检查格式、权限或限流后重试原草稿' : '发布结果不确定，已锁定防止重复；请人工核对频道');
  }
  return receipt(row(state, post.id));
}
