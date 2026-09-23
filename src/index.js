import { ADMIN_PAGE, ADMIN_JS } from './admin.js';
import { secureEqual, digest, telegram } from './telegram.js';
export { GuardState } from './state.js';

export const VERSION = '2.1.1';
const COOKIE = '__Host-guard_session';
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" };
const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', ...extra } });
const globalState = env => env.GUARD_STATE.getByName('admin');
function group(env, id) {
  if (!/^-[0-9]{1,16}$/.test(String(id)) || !Number.isSafeInteger(Number(id))) throw new Error('无效群 ID');
  return env.GUARD_STATE.getByName('chat:' + id);
}
async function readJson(request, limit = 262144) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('缺少请求内容');
  let length = 0;
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > limit) { await reader.cancel(); throw new Error('请求内容过大'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
async function admin(request, env, url) {
  if (request.method === 'GET' && ['/admin','/admin/'].includes(url.pathname)) return new Response(ADMIN_PAGE, { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
  if (request.method === 'GET' && url.pathname === '/admin/app.js') return new Response(ADMIN_JS, { headers: { ...headers, 'Content-Type': 'text/javascript; charset=utf-8' } });
  if (!url.pathname.startsWith('/admin/api/')) return json({ error: 'Not found' }, 404);
  if (!env.ADMIN_PASSWORD || !env.GUARD_STATE) return json({ error: '服务配置缺失' }, 503);
  if (!['GET','POST'].includes(request.method)) return json({ error: 'Method not allowed' }, 405);
  if (request.method === 'POST' && (request.headers.get('Origin') !== url.origin || !request.headers.get('Content-Type')?.startsWith('application/json'))) return json({ error: '请求来源不匹配' }, 403);
  const state = globalState(env);
  const path = url.pathname.slice('/admin/api/'.length);
  if (path === 'login' && request.method === 'POST') {
    const ip = await digest(request.headers.get('CF-Connecting-IP') || 'unknown');
    if (!await state.loginAttempt(ip)) return json({ error: '尝试过于频繁，请 15 分钟后再试' }, 429);
    let body;
    try { body = await readJson(request, 4096); } catch { return json({ error: '无效请求' }, 400); }
    if (!await secureEqual(body.password, env.ADMIN_PASSWORD)) return json({ error: '密码错误' }, 401);
    const session = crypto.randomUUID() + crypto.randomUUID();
    await state.createSession(await digest(session), await digest(env.ADMIN_PASSWORD));
    return json({ ok: true }, 200, { 'Set-Cookie': `${COOKIE}=${session}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800` });
  }
  const session = request.headers.get('Cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
  if (!session || !await state.hasSession(await digest(session), await digest(env.ADMIN_PASSWORD))) return json({ error: '请重新登录' }, 401);
  if (path === 'logout' && request.method === 'POST') {
    await state.deleteSession(await digest(session));
    return json({ ok: true }, 200, { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
  }
  if (request.method === 'GET') {
    if (path === 'chats') return json({ chats: await state.listChats() });
    if (path === 'logs') return json(await group(env, url.searchParams.get('chatId')).adminData(Number(url.searchParams.get('before')) || 0));
    if (path === 'keyword-stats') return json(await group(env, url.searchParams.get('chatId')).keywordStats());
    if (path === 'legacy') {
      const page = await env.BOT_KV.list({ prefix: 'log:', limit: 50, ...(url.searchParams.get('cursor') ? { cursor: url.searchParams.get('cursor') } : {}) });
      const values = await Promise.all(page.keys.map(k => env.BOT_KV.get(k.name, 'json')));
      return json({ logs: values.filter(Boolean), next: page.list_complete ? null : page.cursor });
    }
    if (path === 'status') {
      const tg = telegram(env.BOT_TOKEN);
      const me = await tg('getMe');
      const webhook = await tg('getWebhookInfo');
      let permissions;
      if (url.searchParams.has('chatId')) {
        const chatId = url.searchParams.get('chatId'); group(env, chatId);
        const member = await tg('getChatMember', { chat_id: Number(chatId), user_id: me.id });
        permissions = { deleteMessages: !!member.can_delete_messages, restrictMembers: !!member.can_restrict_members, status: member.status };
      }
      return json({ version: VERSION, bot: me.username, automaticPermanentBan: '收米日薪、拍照日结批量广告', pendingUpdates: webhook.pending_update_count, lastWebhookErrorAt: webhook.last_error_date || null, webhookConfigured: !!webhook.url, permissions });
    }
  }
  if (request.method === 'POST' && ['keywords/add','keywords/remove'].includes(path)) {
    const body = await readJson(request, 4096);
    return json(await group(env, body.chatId).editWord(path.split('/')[1], body.word));
  }
  if (request.method === 'POST' && ['domains/allow/add','domains/allow/remove','domains/deny/add','domains/deny/remove'].includes(path)) {
    const body = await readJson(request, 4096); const [, list, action] = path.split('/');
    return json(await group(env, body.chatId).editDomain(action, body.domain, list));
  }
  if (request.method === 'POST' && path === 'welcome-rules') {
    const body = await readJson(request, 8192);
    return json(await group(env, body.chatId).editWelcome(body.welcomeMessage, body.rulesMessage));
  }
  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') return json({ ok: true, version: VERSION });
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
      try { return await admin(request, env, url); }
      catch (error) { return json({ error: error.retryable ? '上游暂时不可用，请稍后重试' : String(error.message).slice(0, 300) }, error.retryable ? 503 : 400); }
    }
    if (request.method !== 'POST' || !env.WEBHOOK_SECRET || url.pathname !== '/webhook/' + env.WEBHOOK_SECRET) return new Response('Not found', { status: 404 });
    if (!env.WEBHOOK_VERIFY_TOKEN || !env.BOT_TOKEN || !env.GUARD_STATE) return new Response('Service unavailable', { status: 503 });
    if (!await secureEqual(request.headers.get('X-Telegram-Bot-Api-Secret-Token'), env.WEBHOOK_VERIFY_TOKEN)) return new Response('Forbidden', { status: 403 });
    let update;
    try { update = await readJson(request); } catch { return new Response('Bad Request', { status: 400 }); }
    if (!Number.isSafeInteger(update?.update_id)) return new Response('Bad Request', { status: 400 });
    const msg = update.message || update.edited_message;
    if (!msg || !['group','supergroup'].includes(msg.chat?.type)) return new Response('OK');
    if (!Number.isSafeInteger(msg.message_id) || !Number.isSafeInteger(msg.chat.id) || msg.chat.id >= 0) return new Response('Bad Request', { status: 400 });
    try {
      await globalState(env).register(msg.chat);
      await group(env, msg.chat.id).enqueue(update);
      return new Response('OK');
    } catch {
      console.error(JSON.stringify({ event: 'enqueue_failed', updateId: update.update_id }));
      return new Response('Retry later', { status: 503 });
    }
  },
};
