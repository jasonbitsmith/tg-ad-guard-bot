import { diffValues } from './operations.js';
import { ADMIN_PAGE, ADMIN_JS } from './admin.js';
import { secureEqual, digest, telegram } from './telegram.js';
import { channelStatus, editPostCaption } from './bookscape.js';
export { GuardState } from './state.js';

export const VERSION = '2.10.7';
const COOKIE = '__Host-guard_session';
const headers = { 'X-Robots-Tag': 'noindex, nofollow, noarchive', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" };
const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', ...extra } });
const globalState = env => env.GUARD_STATE.getByName('admin');
async function bookscapeState(state, path, body) {
  const response = await state.fetch(new Request('https://bookscape.internal/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '发布状态服务不可用');
  return result;
}
const owners = env => new Set((env.ADMIN_IDS || '').split(',').map(id => id.trim()).filter(Boolean));
async function loginRateAllowed(request, env) {
  if (!env.ADMIN_LOGIN_LIMITER) return true;
  try {
    const key = await digest(request.headers.get('CF-Connecting-IP') || 'unknown');
    const { success } = await env.ADMIN_LOGIN_LIMITER.limit({ key });
    if (success) return true;
    try { env.ANALYTICS?.writeDataPoint({ indexes: ['global'], blobs: ['admin-login-rate-limited', 'blocked'], doubles: [1] }); } catch { /* Non-critical metric. */ }
    return false;
  } catch { return true; }
}
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
    if (!await loginRateAllowed(request, env)) return json({ error: '请求过于频繁，请稍后再试' }, 429);
    const ip = await digest(request.headers.get('CF-Connecting-IP') || 'unknown');
    if (!await state.loginAllowed(ip)) return json({ error: '错误密码次数过多，请 15 分钟后再试' }, 429);
    let body;
    try { body = await readJson(request, 4096); } catch { return json({ error: '无效请求' }, 400); }
    if (!await secureEqual(body.password, env.ADMIN_PASSWORD)) { await state.recordLoginFailure(ip); return json({ error: '密码错误' }, 401); }
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
    if(path==='verification/members')return json(await state.findVerificationMembers(url.searchParams.get('query')||''));
    if (path === 'chats') return json({ chats: await state.listChats() });
    if (path === 'samples') return json({ samples: await state.listSamples() });
    if (path === 'federation') return json({ chats: await state.federation() });
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
      let groups;
      if (url.searchParams.get('all') === '1') {
        const chats = await state.listChats();
        groups = await Promise.all(chats.map(async chat => {
          try {
            const member = await tg('getChatMember', { chat_id: Number(chat.id), user_id: me.id });
            return { id: chat.id, title: chat.title, status: member.status, deleteMessages: !!member.can_delete_messages, restrictMembers: !!member.can_restrict_members, ok: !!member.can_delete_messages && !!member.can_restrict_members };
          } catch (error) { return { id: chat.id, title: chat.title, ok: false, error: '无法读取机器人权限' }; }
        }));
      } else if (url.searchParams.has('chatId')) {
        const chatId = url.searchParams.get('chatId'); group(env, chatId);
        const member = await tg('getChatMember', { chat_id: Number(chatId), user_id: me.id });
        permissions = { deleteMessages: !!member.can_delete_messages, restrictMembers: !!member.can_restrict_members, status: member.status };
      }
      return json({ version: VERSION, bot: me.username, automaticPermanentBan: '所有广告命中', pendingUpdates: webhook.pending_update_count, lastWebhookErrorAt: webhook.last_error_date || null, webhookConfigured: !!webhook.url, permissions, groups, dmitMonitor: await state.dmitStatus(), ocr: { enabled: env.OCR_ENABLED === 'true', maxPerChatHour: Number(env.OCR_MAX_PER_CHAT_HOUR || 30) } });
    }
  }
  if(request.method==='GET' && path==='review-examples')return json({examples:await state.listReviewExamples()});
  if(request.method==='GET' && path==='federation/cases')return json(await state.searchCases(Object.fromEntries(url.searchParams)));
  if(request.method==='GET' && path==='backup/automatic')return json(await state.automaticBackup(url.searchParams.get('id')));
  if(request.method==='GET' && path==='backup/status')return json(await state.automaticBackupStatus());
  if(request.method==='GET' && path==='backup/export')return json(await state.exportBackup());
  if(request.method==='GET' && path==='backup/rollback')return json({backup:await state.lastRollback()});
  if(request.method==='GET' && path==='audit')return json(await state.listAudit(Number(url.searchParams.get('before'))||0));
  if(request.method==='GET' && path==='incidents')return json({incidents:await state.incidentList()});
  if(request.method==='GET' && path==='trials')return json({trials:await group(env,url.searchParams.get('chatId')).listTrials()});
  if(request.method!=='POST')return json({error:'Not found'},404);
  const body=await readJson(request.clone(),600000);
  const excluded=['samples/preview','samples/test','backup/preview'];
  if(excluded.includes(path))return mutateAdmin(request,env,url,state,path);
  let before={};try{before=await state.auditSnapshot(path,body);}catch{}
  const actor='session:'+String(await digest(session)).slice(0,12), operation=crypto.randomUUID();
  await state.recordAudit({operation,actor,action:path,chatId:body.chatId||null,status:'started',changes:[]});
  try{
    const response=await mutateAdmin(request,env,url,state,path);let after={};try{after=await state.auditSnapshot(path,body);}catch{}
    await state.recordAudit({operation,actor,action:path,chatId:body.chatId||null,status:response.ok?'success':'failed',target:body.id||body.word||body.domain||null,changes:diffValues(before,after)});
    return response;
  }catch(error){let after={};try{after=await state.auditSnapshot(path,body);}catch{}await state.recordAudit({operation,actor,action:path,chatId:body.chatId||null,status:'failed',error:String(error.message).slice(0,200),changes:diffValues(before,after)});throw error;}
}
async function mutateAdmin(request,env,url,state,path){
  if(path==='ai-review'){const body=await readJson(request,4096);return json(await group(env,body.chatId).editAiReview(body.enabled));}
  if(path==='verification/release'){const body=await readJson(request,4096);return json(await group(env,body.chatId).releaseVerification(body.chatId,body.userId));}
  if(path==='backup/preview'){const body=await readJson(request,600000);return json(await state.previewBackup(body.backup));}
  if(path==='backup/restore'){const body=await readJson(request,4096);return json(await state.restoreBackup(body.token));}
  if(['trials/add','trials/remove','trials/promote'].includes(path)){const body=await readJson(request,4096);return json(await group(env,body.chatId).editTrial(path.split('/')[1],body));}
  if (request.method === 'POST' && ['keywords/add','keywords/remove'].includes(path)) {
    const body = await readJson(request, 4096);
    return json(await group(env, body.chatId).editWord(path.split('/')[1], body.word));
  }
  if (request.method === 'POST' && ['samples/add','samples/remove','samples/activate','samples/disable'].includes(path)) {
    return json({ samples: await state.editSample(path.split('/')[1], await readJson(request, 4096)) });
  }
  if(request.method==='POST' && ['review-examples/add','review-examples/remove'].includes(path))return json({examples:await state.editReviewExample(path.split('/')[1],await readJson(request,20000))});
  if(request.method==='POST' && path==='samples/preview'){const body=await readJson(request,4096);return json(await state.previewSample(body.id));}
  if(request.method==='POST' && path==='federation/retry'){const body=await readJson(request,4096);group(env,body.chatId);return json(await state.retryCase(String(body.id),String(body.chatId)));}
  if(request.method==='POST' && path==='federation/reverse'){const body=await readJson(request,4096);return json(await state.reverseCase(String(body.id)));}
  if(request.method==='POST' && path==='samples/test') return json(await state.testSample(await readJson(request,8192)));
  if(request.method==='POST' && path==='jobs/retry') { const body=await readJson(request,4096);return json(await group(env,body.chatId).retryJob(body.id)); }
  if (request.method === 'POST' && path === 'review/resolve') {
    const body = await readJson(request, 4096);
    const chatId = String(body.chatId), userId = Number(body.userId), messageId = Number(body.messageId);
    group(env, chatId);
    if (!Number.isSafeInteger(userId) || userId <= 0 || !Number.isSafeInteger(messageId) || messageId <= 0) throw new Error('无效的审查记录');
    return json(await group(env,chatId).queueReview(chatId,userId,messageId));
  }
  if (request.method === 'POST' && path === 'federation') {
    const body = await readJson(request, 4096);
    return json({ chats: await state.setFederation(body.chatId, body.enabled === true) });
  }
  if (request.method === 'POST' && ['domains/allow/add','domains/allow/remove','domains/deny/add','domains/deny/remove'].includes(path)) {
    const body = await readJson(request, 4096); const [, list, action] = path.split('/');
    return json(await group(env, body.chatId).editDomain(action, body.domain, list));
  }
  if (request.method === 'POST' && path === 'welcome-rules') {
    const body = await readJson(request, 8192);
    return json(await group(env, body.chatId).editWelcome(body.welcomeMessage, body.rulesMessage));
  }
  if (request.method === 'POST' && path === 'verification') {
    const body = await readJson(request, 4096);
    return json(await group(env, body.chatId).editVerification(body.mode, body.minutes, body.channel, body.timeoutAction));
  }
  if (request.method === 'POST' && path === 'raid') {
    const body = await readJson(request, 4096);
    return json(await group(env, body.chatId).editRaid(body.enabled, body.limit, body.minutes));
  }
  if (request.method === 'POST' && path === 'new-member-link-guard') {
    const body = await readJson(request, 4096);
    return json(await group(env, body.chatId).editNewMemberLinkGuard(body.enabled, body.minutes));
  }
  if (request.method === 'POST' && path === 'new-member-media-guard') {
    const body = await readJson(request, 4096);
    return json(await group(env, body.chatId).editNewMemberMediaGuard(body.enabled, body.minutes));
  }
  if (request.method === 'POST' && path === 'content-locks') {
    const body = await readJson(request, 8192);
    return json(await group(env, body.chatId).editContentLocks(body.locks));
  }
  if (request.method === 'POST' && ['knowledge/upsert', 'knowledge/remove'].includes(path)) {
    const body = await readJson(request, 16384);
    return json(await group(env, body.chatId).editKnowledge(path.split('/')[1], body.item));
  }
  if (request.method === 'POST' && path === 'config/restore') {
    const body = await readJson(request, 4096);
    return json(await group(env, body.chatId).restoreConfig(body.versionId));
  }
  if (request.method === 'POST' && path === 'quiet') {
    const body = await readJson(request, 4096);
    const registered = await state.listChats();
    const targets = body.scope === 'all' ? registered : registered.filter(item => item.id === String(body.chatId));
    if (!targets.length && body.scope !== 'all') targets.push({ id: body.chatId, title: body.chatId });
    if (!targets.length) throw new Error('暂无可设置的群');
    const results = await Promise.allSettled(targets.map(chat => group(env, chat.id).editQuiet(chat, body.enabled, body.start, body.end, body.notify)));
    const failed = results.filter(result => result.status === 'rejected').length;
    if (failed) throw new Error(`${failed} 个群保存失败，请稍后重试`);
    return json({ updated: targets.length, restorePending:results.filter(x=>x.status==='fulfilled' && x.value.quietRestorePending).length, config: results[0].value });
  }
  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/bookscape/api/')) {
      if (!env.BOOKSCAPE_PUBLISH_KEY || env.BOOKSCAPE_PUBLISH_KEY.length < 32) return json({ error: '发布入口未启用' }, 503);
      if (!await secureEqual(request.headers.get('Authorization'), 'Bearer ' + env.BOOKSCAPE_PUBLISH_KEY)) return json({ error: '发布凭据无效' }, 401);
      const state = env.GUARD_STATE.getByName('bookscape:Book_Scape');
      const path = url.pathname.slice('/bookscape/api/'.length);
      try {
        if (request.method === 'GET' && path === 'status') return json(await channelStatus(env));
        if (request.method === 'GET' && path === 'receipt') return json(await bookscapeState(state, 'receipt?id=' + encodeURIComponent(url.searchParams.get('id') || '')));
        if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
        if (!request.headers.get('Content-Type')?.startsWith('application/json')) return json({ error: '需要 JSON 请求' }, 415);
        const body = await readJson(request, path === 'draft' ? 8000000 : 32768);
        if (path === 'draft') return json(await bookscapeState(state, 'draft', body));
        if (path === 'preview') return json(await bookscapeState(state, 'preview', { id: body.id }));
        if (path === 'publish') return json(await bookscapeState(state, 'publish', body));
        if (path === 'edit') return json(await editPostCaption(env, body));
        return json({ error: 'Not found' }, 404);
      } catch (error) { return json({ error: String(error.message).slice(0, 300) }, 400); }
    }
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
    const membership = update.my_chat_member;
    if (membership?.chat && ['group','supergroup'].includes(membership.chat.type) && membership.new_chat_member?.status !== 'kicked') {
      try { await globalState(env).register(membership.chat); return new Response('OK'); }
      catch { return new Response('Retry later', { status: 503 }); }
    }
    // Telegram does not expose an API to enumerate a bot's existing groups.
    // An owner can forward any message from an already-added group to the bot
    // privately; Telegram supplies the original chat metadata server-side.
    // Buttons on owner notices (report / ban log) can live in a private chat
    // or a log channel, so they are handled before the group-only routing.
    if (/^n:/.test(String(update.callback_query?.data || ''))) {
      try { await globalState(env).noticeAction(update.callback_query); } catch { console.error(JSON.stringify({ event: 'notice_action_failed', updateId: update.update_id })); }
      return new Response('OK');
    }
    // Join requests and the buttons of private join-request challenges belong
    // to the group being joined.
    const joinRequest = update.chat_join_request;
    const requestCallback = /^vj:(-\d{1,16}):/.exec(String(update.callback_query?.data || ''));
    if ((joinRequest?.chat && ['group','supergroup'].includes(joinRequest.chat.type)) || requestCallback) {
      try { await group(env, joinRequest ? joinRequest.chat.id : requestCallback[1]).enqueue(update); return new Response('OK'); }
      catch { console.error(JSON.stringify({ event: 'enqueue_failed', updateId: update.update_id })); return new Response('Retry later', { status: 503 }); }
    }
    const privateMessage = update.message;
    if(privateMessage?.chat?.type==='private'&&privateMessage.text?.trim()==='/myid'){await telegram(env.BOT_TOKEN)('sendMessage',{chat_id:privateMessage.chat.id,text:'你的 Telegram 用户 ID：'+privateMessage.from.id+'。请把这个数字发给群管理员，以便查找验证记录。'});return new Response('OK');}
    if (privateMessage?.chat?.type === 'private' && owners(env).has(String(privateMessage.from?.id))) {
      const text=String(privateMessage.text||'').trim(),tg=telegram(env.BOT_TOKEN);
      const release=/^\/release\s+(\d{1,16})\s+(-\d+)$/i.exec(text);
      const find=/^\/findmember(?:\s+(.+))?$/i.exec(text);
      const logTarget=/^\/log(?:channel)?(?:\s+(\S+))?$/i.exec(text);
      if(logTarget){
        let reply;
        try{reply=logTarget[1]?'✅ 处理记录：'+(await globalState(env).describeLogTarget(await globalState(env).setLogTarget(logTarget[1]))):'处理记录当前：'+(await globalState(env).describeLogTarget())+'\n\n/log me 发给我\n/log @频道用户名 发到频道（先把机器人加为频道管理员）\n/log off 关闭';}
        catch(error){reply='设置未完成：'+String(error.message).slice(0,300);}
        await tg('sendMessage',{chat_id:privateMessage.chat.id,text:reply});return new Response('OK');
      }
      if(release||find||/^@[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(text)){
        try{
          let reply;
          if(release){await group(env,release[2]).releaseVerification(release[2],release[1],'telegram:'+privateMessage.from.id);reply='已提交手动通过验证，请稍后在后台查看执行结果。成功后，请成员在 24 小时内重新加入；首次重新加入免验证。';}
          else {const result=await globalState(env).findVerificationMembers(find?find[1]||'':text);reply=result.members.length?result.members.slice(0,15).map(x=>`${x.name||x.username||x.userId} · ${x.chatTitle}\n用户 ID：${x.userId}；状态：${({pending:'等待验证',timeout:'验证超时封禁',processing:'解封处理中',failed:'解封失败',released:'已手动通过'})[x.state]||x.state}\n${x.canRelease?'/release '+x.userId+' '+x.chatId:'请在后台查看执行结果'}`).join('\n\n'):'未找到验证记录。用户名仅能匹配机器人已记录过的成员，请改用数字用户 ID，或让成员私聊机器人发送 /myid。';if(result.errors.length)reply+='\n部分群查询失败，请在后台重试。';}
          await tg('sendMessage',{chat_id:privateMessage.chat.id,text:reply.slice(0,4000)});return new Response('OK');
        }catch(error){await tg('sendMessage',{chat_id:privateMessage.chat.id,text:'操作未完成：'+String(error.message).slice(0,300)});return new Response('OK');}
      }
      const replied=privateMessage.reply_to_message?.from?.is_bot?String(privateMessage.reply_to_message.text||privateMessage.reply_to_message.caption||''):'';
      if(/^\/who(?:@\w+)?(?:\s|$)/i.test(text)||/^(?:🚫 已封禁|📣 群友举报|👤)/.test(replied)){
        try{await globalState(env).profileLookup(text,replied,privateMessage.chat.id);}
        catch(error){await tg('sendMessage',{chat_id:privateMessage.chat.id,text:'读取资料失败：'+String(error.message).slice(0,300)});}
        return new Response('OK');
      }
      const forwardedChat = privateMessage.forward_origin?.chat || privateMessage.forward_from_chat;
      if (forwardedChat && ['group', 'supergroup'].includes(forwardedChat.type) && Number.isSafeInteger(forwardedChat.id) && forwardedChat.id < 0) {
        try {
          await globalState(env).register(forwardedChat);
          await telegram(env.BOT_TOKEN)('sendMessage', { chat_id: privateMessage.chat.id, text: `✅ 已登记群：${forwardedChat.title || forwardedChat.id}。现在可在管理后台选择它。` });
          return new Response('OK');
        } catch { return new Response('Retry later', { status: 503 }); }
      }
    }
    const msg = update.message || update.edited_message || update.callback_query?.message;
    if (!msg || !['group','supergroup'].includes(msg.chat?.type)) return new Response('OK');
    if (!Number.isSafeInteger(msg.message_id) || !Number.isSafeInteger(msg.chat.id) || msg.chat.id >= 0) return new Response('Bad Request', { status: 400 });
    try {
      await group(env, msg.chat.id).enqueue(update);
      return new Response('OK');
    } catch {
      console.error(JSON.stringify({ event: 'enqueue_failed', updateId: update.update_id }));
      return new Response('Retry later', { status: 503 });
    }
  },
  async scheduled(controller, env, ctx) {
    if (env.GUARD_STATE) {
      ctx.waitUntil(globalState(env).runAutomaticBackup());
      if (env.DMIT_MONITOR_ENABLED === 'true') ctx.waitUntil(globalState(env).monitorDmit());
      // Each group's own alarm already runs quiet-hours switching every minute
      // while quiet mode is on; this sweep is only a safety net, so it wakes
      // every group every 15 minutes instead of every minute.
      if (new Date(controller.scheduledTime || Date.now()).getUTCMinutes() % 15 === 0) ctx.waitUntil(globalState(env).runQuietMaintenance());
      ctx.waitUntil(globalState(env).sendDailyReport());
      ctx.waitUntil(globalState(env).monitorOperations());
      ctx.waitUntil(globalState(env).ensureWebhookUpdates().catch(() => null));
    }
  },
};
