import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions, Response as MFResponse } from 'miniflare';

test('Cloudflare 本地运行：去重、重试、处罚、权限、多群和后台', async t => {
  const calls = [], failures = new Map();
  const wrapper = `import worker, { GuardState as Base } from './index.js';
    export class GuardState extends Base {
      async inspectTest(force=false) {
        if(force) this.sql.exec("UPDATE jobs SET due=0 WHERE status='pending'");
        await this.alarm();
        return { data:await this.adminData(), jobs:this.sql.exec('SELECT id,status,due,attempts FROM jobs').toArray() };
      }
    }
    export default { async fetch(r,env) {
      if(new URL(r.url).pathname==='/__test') { const b=await r.json(); return Response.json(await env.GUARD_STATE.getByName('chat:'+b.chatId).inspectTest(b.force)); }
      return worker.fetch(r,env);
    }};`;
  const mf = new Miniflare(convertV4MiniflareOptions({
    compatibilityDate: '2026-09-22', compatibilityFlags: ['nodejs_compat'],
    modules: [{ type: 'ESModule', path: 'test-wrapper.js', contents: wrapper }, { type: 'ESModule', path: 'index.js', contents: await readFile(new URL('../dist/index.js', import.meta.url), 'utf8') }],
    durableObjects: { GUARD_STATE: { className: 'GuardState', useSQLite: true } },
    kvNamespaces: ['BOT_KV'], bindings: { BOT_TOKEN: 'fake', WEBHOOK_SECRET: 'path', WEBHOOK_VERIFY_TOKEN: 'verify', ADMIN_PASSWORD: 'password-for-test', ADMIN_IDS: '99' },
    outboundService: async request => {
      const url = new URL(request.url);
      assert.equal(url.hostname, 'api.telegram.org');
      const method = url.pathname.split('/').at(-1), params = await request.json();
      calls.push({ method, params });
      const key = `${method}:${params.chat_id}`;
      const failure = failures.get(key);
      if (failure) { failures.delete(key); return MFResponse.json({ ok: false, ...failure }, { status: failure.error_code }); }
      let result = true;
      if (method === 'getMe') result = { id: 555, username: 'GuardBot', is_bot: true };
      if (method === 'getWebhookInfo') result = { url: 'https://bot.test/webhook/path', pending_update_count: 0 };
      if (method === 'getChatMember') result = { status: params.user_id === 11 ? 'administrator' : params.user_id === 12 ? 'restricted' : 'member', can_restrict_members: false };
      if (method === 'getChat') result = { permissions: { can_send_messages: true, can_send_photos: false } };
      if (method === 'sendMessage') result = { message_id: 444 };
      return MFResponse.json({ ok: true, result });
    },
  }));
  t.after(() => mf.dispose());
  const kv = await mf.getKVNamespace('BOT_KV');
  await kv.put('keywords', JSON.stringify(['兼职','招聘','USDT','刷单','稳赚','私聊我']));
  await t.test('旧版已知群在没有新消息时也会出现在后台列表', async () => {
    const state = await mf.getDurableObjectNamespace('GUARD_STATE');
    const chats = await state.getByName('admin').listChats();
    assert.equal(chats.length, 6);
    assert.ok(chats.some(chat => chat.id === '-1003590410271' && chat.title === 'Jason - VPS 交流互助交流'));
  });
  let seq = 0;
  function update(chatId, text, extra = {}) { const n = ++seq; return { update_id: n, message: { message_id: n, date: Math.floor(Date.now()/1000), chat: { id: chatId, type: 'supergroup', title: '测试群' }, from: { id: 7, first_name: '测试用户' }, text, ...extra } }; }
  const send = u => mf.dispatchFetch('https://bot.test/webhook/path', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'verify' }, body: JSON.stringify(u) });
  async function tick(chatId, force = false) { const r=await mf.dispatchFetch('https://bot.test/__test', { method:'POST',body:JSON.stringify({chatId,force}) }); assert.equal(r.status,200,await r.clone().text());return r.json(); }
  const actions = chatId => calls.filter(c => c.params.chat_id === chatId && ['deleteMessage','restrictChatMember','banChatMember','unbanChatMember'].includes(c.method));

  await t.test('验证头缺失拒绝，风险讨论不处罚', async () => {
    const r=await mf.dispatchFetch('https://bot.test/webhook/path',{method:'POST',body:'{}'}); assert.equal(r.status,403);
    await send(update(-101,'请警惕刷单骗局，不要转账')); await tick(-101); assert.equal(actions(-101).length,0);
  });
  await t.test('同一 update 并发投递不会重复删除或计警告', async () => {
    const u=update(-102,'兼职招聘 私聊我');
    const responses=await Promise.all(Array.from({length:5},()=>send(u))); responses.forEach(r=>assert.equal(r.status,200));
    const {data}=await tick(-102);
    assert.equal(actions(-102).length,1); assert.equal(data.logs[0].warnings,1);
    const edited={update_id:++seq,edited_message:{...u.message,text:'兼职招聘 私聊我 改字'}};
    await send(edited);await tick(-102);assert.equal(actions(-102).length,1);
  });
  await t.test('三条独立违规后临时禁言，不自动封禁', async () => {
    for(let i=0;i<3;i++){await send(update(-103,'兼职招聘 私聊我 '+i));await tick(-103);}
    const a=actions(-103);assert.equal(a.filter(x=>x.method==='deleteMessage').length,3);assert.equal(a.filter(x=>x.method==='restrictChatMember').length,1);assert.ok(!a.some(x=>x.method==='banChatMember'));
    const until=a.find(x=>x.method==='restrictChatMember').params.until_date;
    assert.ok(until>Date.now()/1000+500 && until<Date.now()/1000+650);
  });
  await t.test('429 按重试时间保留任务，成功后才写成功记录', async () => {
    failures.set('deleteMessage:-104',{error_code:429,description:'rate limit',parameters:{retry_after:90}});
    await send(update(-104,'兼职招聘 私聊我'));let a=await tick(-104);
    assert.equal(a.data.pending,1);assert.equal(a.data.logs[0].outcome,'retrying');assert.ok(a.jobs[0].due>Date.now()+85000);
    a=await tick(-104,true);assert.equal(a.data.pending,0);assert.equal(a.data.logs[0].outcome,'success');assert.equal(a.data.logs[0].warnings,1);
  });
  await t.test('禁言失败重试不重复删消息和警告', async () => {
    failures.set('restrictChatMember:-105',{error_code:500,description:'temporary failure'});
    await send(update(-105,'兼职招聘 私聊我 稳赚 https://ad.example'));await tick(-105);const a=await tick(-105,true);
    assert.equal(actions(-105).filter(x=>x.method==='deleteMessage').length,1);assert.equal(a.data.logs[0].warnings,1);assert.equal(a.data.logs[0].outcome,'success');
  });
  await t.test('失败重试期间后续消息不乱序或覆盖警告计数', async () => {
    failures.set('deleteMessage:-115',{error_code:429,description:'rate limit',parameters:{retry_after:90}});
    await send(update(-115,'兼职招聘 私聊我 A'));await tick(-115);
    await send(update(-115,'兼职招聘 私聊我 B'));const before=await tick(-115);
    assert.equal(before.data.pending,2);assert.equal(actions(-115).length,1);
    const after=await tick(-115,true);assert.equal(after.data.pending,0);
    assert.deepEqual(after.data.logs.filter(x=>x.outcome==='success').map(x=>x.warnings),[2,1]);
  });
  await t.test('403 删消息失败不继续禁言、不虚报成功', async () => {
    failures.set('deleteMessage:-106',{error_code:403,description:'not enough rights'});
    await send(update(-106,'兼职招聘 私聊我 稳赚 https://ad.example'));const a=await tick(-106);
    assert.equal(a.data.failed,1);assert.equal(a.data.logs[0].outcome,'failed');assert.equal(actions(-106).length,1);
  });
  await t.test('管理员身份查询失败不会按普通用户处罚', async () => {
    failures.set('getChatMember:-107',{error_code:503,description:'unavailable'});
    await send(update(-107,'兼职招聘 私聊我'));await tick(-107);assert.equal(actions(-107).length,0);
  });
  await t.test('A/B 交替刷屏能被识别', async () => {
    for(const text of ['AAAA','BBBB','AAAA','BBBB','AAAA']) {await send(update(-108,text));await tick(-108);}
    assert.equal(actions(-108).filter(x=>x.method==='deleteMessage').length,1);
  });
  await t.test('频道身份广告删消息，不封禁伪造 from 用户', async () => {
    await send(update(-109,'兼职招聘 私聊我',{sender_chat:{id:-999,title:'外部频道'},from:{id:88,is_bot:true}}));await tick(-109);
    assert.deepEqual(actions(-109).map(x=>x.method),['deleteMessage']);
    await send(update(-109,'兼职招聘 私聊我',{sender_chat:{id:-109},from:{id:88,is_bot:true}}));await tick(-109);assert.equal(actions(-109).length,1);
  });
  await t.test('无封禁权限的群管理员不能借机器人封人', async () => {
    await send(update(-110,'/ban 7',{from:{id:11,first_name:'受限管理员'}}));await tick(-110);assert.equal(actions(-110).length,0);
  });
  await t.test('自动处罚不覆盖已有禁言限制', async () => {
    await send(update(-112,'兼职招聘 私聊我 稳赚 https://ad.example',{from:{id:12,first_name:'已受限制用户'}}));await tick(-112);
    assert.deepEqual(actions(-112).map(x=>x.method),['deleteMessage']);
  });
  await t.test('清除警告和白名单生效，私聊命令不会跨群生效', async () => {
    await send(update(-113,'兼职招聘 私聊我'));await tick(-113);
    await send(update(-113,'/allow 7',{from:{id:99,first_name:'owner'}}));await tick(-113);
    await send(update(-113,'兼职招聘 私聊我 稳赚 https://ad.example'));await tick(-113);
    assert.equal(actions(-113).length,1);
    const u=update(-114,'/ban 7',{from:{id:99},chat:{id:99,type:'private'}});await send(u);assert.equal(actions(99).length,0);
  });
  await t.test('解除封禁使用 only_if_banned，不踢出已在群的用户', async () => {
    await send(update(-111,'/unban 7',{from:{id:99,first_name:'owner'}}));await tick(-111);assert.equal(actions(-111)[0].params.only_if_banned,true);
  });
  await t.test('后台会话、CSRF、多群词库隔离和退出', async () => {
    const login=await mf.dispatchFetch('https://bot.test/admin/api/login',{method:'POST',headers:{Origin:'https://bot.test','Content-Type':'application/json'},body:JSON.stringify({password:'password-for-test'})});
    assert.equal(login.status,200);const raw=login.headers.get('set-cookie');assert.ok(raw.includes('HttpOnly'));assert.ok(raw.includes('SameSite=Strict'));const cookie=raw.split(';')[0];
    const request=(path,body,origin='https://bot.test')=>mf.dispatchFetch('https://bot.test/admin/api/'+path,{method:body?'POST':'GET',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    assert.equal((await request('keywords/add',{chatId:-120,word:'本群测试词'},'https://evil.test')).status,403);
    assert.equal((await request('keywords/add',{chatId:-120,word:'本群测试词'})).status,200);
    assert.equal((await request('domains/deny/add',{chatId:-120,domain:'bad.example'})).status,200);
    assert.equal((await request('domains/allow/add',{chatId:-120,domain:'trusted.example'})).status,200);
    assert.equal((await request('welcome-rules',{chatId:-120,welcomeMessage:'欢迎 {name} 加入 {group}',rulesMessage:'禁止广告'})).status,200);
    const a=await (await request('logs?chatId=-120')).json(),b=await (await request('logs?chatId=-121')).json();
    assert.ok(a.config.keywords.includes('本群测试词'));assert.ok(a.config.domainDenylist.includes('bad.example'));assert.ok(a.config.domainAllowlist.includes('trusted.example'));assert.equal(a.config.welcomeMessage,'欢迎 {name} 加入 {group}');assert.ok(!b.config.keywords.includes('本群测试词'));
    await request('logout',{});assert.equal((await request('chats')).status,401);
  });
  await t.test('欢迎语、群规、域名黑名单和关键词统计按群生效', async () => {
    const login=await mf.dispatchFetch('https://bot.test/admin/api/login',{method:'POST',headers:{Origin:'https://bot.test','Content-Type':'application/json'},body:JSON.stringify({password:'password-for-test'})});
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const request=(path,body)=>mf.dispatchFetch('https://bot.test/admin/api/'+path,{method:body?'POST':'GET',headers:{Cookie:cookie,Origin:'https://bot.test','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    await request('welcome-rules',{chatId:-130,welcomeMessage:'欢迎 {name} 加入 {group}',rulesMessage:'禁止广告'});
    await request('keywords/add',{chatId:-130,word:'本群测试词'});
    await request('domains/deny/add',{chatId:-130,domain:'spam.example'});
    const join=update(-130,'',{new_chat_members:[{id:33,first_name:'小明'}]});await send(join);await tick(-130);
    assert.ok(calls.some(c=>c.method==='sendMessage'&&c.params.chat_id===-130&&c.params.text.includes('欢迎 小明 加入 测试群')&&c.params.text.includes('群规：禁止广告')));
    await send(update(-130,'本群测试词 https://sub.spam.example/ad'));const result=await tick(-130);
    assert.ok(actions(-130).some(x=>x.method==='deleteMessage'));
    const stats=await (await request('keyword-stats?chatId=-130')).json();assert.ok(stats.keywords.some(x=>x.word==='本群测试词'&&x.count===1));
    assert.ok(result.data.logs.some(x=>x.domains?.includes('sub.spam.example')));
  });
});
