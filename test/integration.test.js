import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions, Response as MFResponse } from 'miniflare';

test('Cloudflare 本地运行：去重、重试、处罚、权限、多群和后台', async t => {
  const calls = [], failures = new Map();let officialPostId=9876,botPermissionsHealthy=false,webhookState={url:'https://bot.test/webhook/path',pending_update_count:0};
  const wrapper = `import worker, { GuardState as Base } from './index.js';
    export class GuardState extends Base {
      constructor(ctx,env) { super(ctx,env); }
      owners(){return this.read('test:owners') || super.owners();}
      async isolateOperationsTest(){this.sql.exec('DELETE FROM samples');await this.broadcastSamplesChanged();}
      seedRecordTest(key,value,ttl=86400000){this.write(key,value,ttl);}
      seedLogTest(data){this.log(data);}
      readRecordTest(key){return this.read(key);}
      async exportBackup(){if(this.read('test:backup-fail'))throw Error('模拟存储错误');return super.exportBackup();}
      async reviewWithAi(msg,text){const mock=this.read('test:ai');if(mock)this.env.AI={run:async(model,input)=>{this.write('test:ai-input',input);this.write('test:ai-calls',this.read('test:ai-calls',0)+1);if(mock.fail)throw Error('模拟 AI 失败');return {response:JSON.stringify(mock)};}};return super.reviewWithAi(msg,text);}
      async realOcrTest(msg){this.env.AI={run:async()=>({answer:'广告图片测试'})};return super.ocr(msg,async()=>({file_path:'ocr.jpg'}));}
      async ocr(msg){ return Array.isArray(msg.photo) ? '水果机 渠道正品 日搞1w 当日下单 秒发' : ''; }
      forceNoticesTest(){const notices=this.quietNotices().map(x=>({...x,retryAt:0}));this.write('quiet:notices',notices);return notices;}
      seedNoticesTest(notices){this.write('quiet:notices',notices);}
      expireNoticesTest(){const notices=this.quietNotices().map(x=>x.deleteAt?{...x,deleteAt:Date.now()-1}:x);this.write('quiet:notices',notices);return notices;}
      // Quiet-hours tests drive quietTick() with a fake Beijing time. A real
      // alarm would call quietTick() with the actual clock and undo that state,
      // so groups under a fake clock skip real alarms.
      fakeQuietClockTest(){this.write('test:fake-quiet-clock',true);}
      async alarm(){if(this.read('test:fake-quiet-clock'))return;return super.alarm();}
      async automaticBackupTest(id){try{return {backup:await this.automaticBackup(id)};}catch(error){return {error:error.message};}}
      async backupTest(){try{return {backup:await this.exportBackup()};}catch(error){return {error:error.message};}}
      async replaceBackupConfig(chat,expected){if(this.read('test:restore-fail')){this.remove('test:restore-fail');throw Error('模拟恢复失败');}return super.replaceBackupConfig(chat,expected);}
      seedFutureJobTest(){this.sql.exec("INSERT INTO jobs(id,payload,status,due,created) VALUES ('future','{}','pending',?,?)",Date.now()+3600000,Date.now()-3600000);}
      expireVerificationTest(userId){this.sql.exec('UPDATE verifications SET expires=? WHERE user_id=?',Date.now()-1000,String(userId));return this.verification(userId);}
      async inspectTest(force=false) {
        if(force) this.sql.exec("UPDATE jobs SET due=0 WHERE status='pending'");
        // A real alarm may already be running (alarm() then returns early);
        // wait for it so the tick below actually processes pending jobs.
        for(let i=0;i<100 && this.running;i++)await new Promise(r=>setTimeout(r,20));
        await this.alarm();
        return { data:await this.adminData(), jobs:this.sql.exec('SELECT id,status,due,attempts FROM jobs').toArray() };
      }
    }
    export default { async fetch(r,env) {
      if(new URL(r.url).pathname==='/__test') { const b=await r.json(); return Response.json(await env.GUARD_STATE.getByName('chat:'+b.chatId).inspectTest(b.force)); }
      if(new URL(r.url).pathname==='/__daily') return Response.json({sent:await env.GUARD_STATE.getByName('admin').sendDailyReport(Date.parse('2026-09-27T01:00:00Z'))});
      return worker.fetch(r,env);
    }};`;
  const mf = new Miniflare(convertV4MiniflareOptions({
    compatibilityDate: '2026-09-22', compatibilityFlags: ['nodejs_compat'],
    modules: [{ type: 'ESModule', path: 'test-wrapper.js', contents: wrapper }, { type: 'ESModule', path: 'index.js', contents: await readFile(new URL('../dist/index.js', import.meta.url), 'utf8') }],
    durableObjects: { GUARD_STATE: { className: 'GuardState', useSQLite: true } },
    kvNamespaces: ['BOT_KV'], bindings: { BOT_TOKEN: 'fake', WEBHOOK_SECRET: 'path', WEBHOOK_VERIFY_TOKEN: 'verify', ADMIN_PASSWORD: 'password-for-test', ADMIN_IDS: '99', DMIT_MONITOR_ENABLED:'true',DMIT_AFFILIATE_ID:'16962',DMIT_NOTIFY_CHAT:'@jason_vps_deal', OCR_ENABLED: 'true', OCR_MAX_PER_CHAT_HOUR: '30' },
    outboundService: async request => {
      const url = new URL(request.url);
      if(url.hostname==='www.dmit.io')return new MFResponse('Forbidden',{status:403});
      if(url.hostname==='t.me')return new MFResponse('<div data-post="DMIT_INC/'+officialPostId+'"><div class="tgme_widget_message_text">HKG restocked and back in stock</div></div>');
      if(url.hostname==='api.cas.chat')return MFResponse.json(url.searchParams.get('user_id')==='666'?{ok:true,result:{offenses:3}}:{ok:false,description:'Record not found.'});
      assert.equal(url.hostname, 'api.telegram.org');
      if (url.pathname.includes('/file/botfake/')) return new MFResponse(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { 'Content-Type': 'image/jpeg' } });
      const method = url.pathname.split('/').at(-1), multipart = String(request.headers.get('content-type')).includes('multipart');
      const params = multipart ? Object.fromEntries([...(await request.formData())].map(([k, v]) => [k, typeof v === 'string' ? v : { name: v.name, size: v.size, type: v.type }])) : await request.json();
      calls.push({ method, params });
      const key = `${method}:${params.chat_id}`;
      if(method==='sendMessage'&&JSON.stringify(params.reply_markup||{}).includes('tg://user?id=670'))return MFResponse.json({ok:false,error_code:400,description:'Bad Request: BUTTON_USER_PRIVACY_RESTRICTED'},{status:400});
      // `onlyText` limits a failure to messages containing that text, so background alerts to the same chat cannot use it up.
      const pending=failures.get(key),matches=!pending?.onlyText||String(params.text||'').includes(pending.onlyText);
      const configured=matches?pending:undefined,failure=Array.isArray(configured)?configured.shift():configured;
      if (failure) { if(!Array.isArray(configured)||!configured.length)failures.delete(key); return MFResponse.json({ ok: false, ...failure }, { status: failure.error_code }); }
      let result = true;
      if (method === 'getMe') result = { id: 555, username: 'GuardBot', is_bot: true };
      if (method === 'getWebhookInfo') result = webhookState;
      if (method === 'getChatMember') result = { status: params.user_id === 11 ? 'administrator' : params.user_id === 12 ? 'restricted' : params.user_id===88?'kicked':'member', can_restrict_members: false };
      if (method === 'getChatMember' && params.user_id===555 && botPermissionsHealthy)result={status:'administrator',can_delete_messages:true,can_restrict_members:true};
      if (method === 'getChat') result = params.chat_id===667 ? { id: 667, type: 'private', bio: '兼职日结 私聊我 @abc12345' } : { permissions: { can_send_messages: true, can_send_photos: false } };
      if (method === 'getFile') result = { file_path: 'ocr.jpg' };
      if (method === 'getMyDescription') result = { description: 'Jason 的群管家' };
      if (method === 'getMyShortDescription') result = { short_description: '' };
      if (method === 'getMyName') result = { name: 'JASON_BOT' };
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
    assert.equal(chats.length, 5);
    assert.ok(!chats.some(chat => chat.id === '-100999888777'), '模拟群占位记录应被清除');
    assert.ok(chats.some(chat => chat.id === '-1003590410271' && chat.title === 'Jason - VPS 交流互助交流'));
  });
  await t.test('每日群防日报在北京时间九点向所有者发送', async () => {
    const report=await mf.dispatchFetch('https://bot.test/__daily');const body=await report.json();assert.equal(body.sent,true);
    assert.ok(calls.some(call=>call.method==='sendMessage'&&call.params.chat_id===99&&call.params.text.includes('群防日报')));
  });
  await t.test('机器人加入新群时立即登记，无需等待普通消息', async () => {
    const added={update_id:1,my_chat_member:{chat:{id:-1001234567890,type:'supergroup',title:'新加入测试群'},new_chat_member:{status:'administrator',user:{id:555,is_bot:true}}}};
    const response=await mf.dispatchFetch('https://bot.test/webhook/path',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':'verify'},body:JSON.stringify(added)});
    assert.equal(response.status,200);
    const state=await mf.getDurableObjectNamespace('GUARD_STATE');
    assert.ok((await state.getByName('admin').listChats()).some(chat=>chat.id==='-1001234567890'&&chat.title==='新加入测试群'));
  });
  await t.test('机器人被移出或退出群时自动从后台列表除名', async () => {
    const state=await mf.getDurableObjectNamespace('GUARD_STATE');
    const send=status=>mf.dispatchFetch('https://bot.test/webhook/path',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':'verify'},body:JSON.stringify({update_id:1,my_chat_member:{chat:{id:-1001234567891,type:'supergroup',title:'将被移出群'},new_chat_member:{status,user:{id:555,is_bot:true}}}})});
    assert.equal((await send('member')).status,200);
    assert.ok((await state.getByName('admin').listChats()).some(chat=>chat.id==='-1001234567891'));
    assert.equal((await send('left')).status,200);
    assert.ok(!(await state.getByName('admin').listChats()).some(chat=>chat.id==='-1001234567891'));
  });
  await t.test('后台「退出并移除」让机器人退群并从列表移除', async () => {
    const state=await mf.getDurableObjectNamespace('GUARD_STATE');
    await state.getByName('admin').register({id:-1001234567892,title:'要移除的群'});
    const login=await mf.dispatchFetch('https://bot.test/admin/api/login',{method:'POST',headers:{Origin:'https://bot.test','Content-Type':'application/json'},body:JSON.stringify({password:'password-for-test'})});
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const remove=chatId=>mf.dispatchFetch('https://bot.test/admin/api/groups/remove',{method:'POST',headers:{Cookie:cookie,Origin:'https://bot.test','Content-Type':'application/json'},body:JSON.stringify({chatId})});
    const before=(await state.getByName('admin').listChats()).length;
    const response=await remove('-1001234567892');assert.equal(response.status,200);
    assert.ok(calls.some(call=>call.method==='leaveChat'&&call.params.chat_id===-1001234567892));
    const chats=(await response.json()).chats;
    assert.equal(chats.length,before-1);assert.ok(!chats.some(chat=>chat.id==='-1001234567892'));
    assert.equal((await remove('-1001234567892')).status,400);
  });
  await t.test('所有者私聊转发已有群消息时登记该群', async () => {
    const forwarded = { update_id: 2, message: { message_id: 2, date: Math.floor(Date.now() / 1000), chat: { id: 99, type: 'private' }, from: { id: 99 }, forward_origin: { type: 'chat', chat: { id: -1009999999999, type: 'supergroup', title: '转发登记群' } } } };
    const response = await mf.dispatchFetch('https://bot.test/webhook/path', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'verify' }, body: JSON.stringify(forwarded) });
    assert.equal(response.status, 200);
    const state = await mf.getDurableObjectNamespace('GUARD_STATE');
    assert.ok((await state.getByName('admin').listChats()).some(chat => chat.id === '-1009999999999' && chat.title === '转发登记群'));
    assert.ok(calls.some(call => call.method === 'sendMessage' && call.params.chat_id === 99));
  });
  let seq = 0;
  function update(chatId, text, extra = {}) { const n = ++seq; return { update_id: n, message: { message_id: n, date: Math.floor(Date.now()/1000), chat: { id: chatId, type: 'supergroup', title: '测试群' }, from: { id: 7, first_name: '测试用户' }, text, ...extra } }; }
  const send = u => mf.dispatchFetch('https://bot.test/webhook/path', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'verify' }, body: JSON.stringify(u) });
  async function tick(chatId, force = false) { const r=await mf.dispatchFetch('https://bot.test/__test', { method:'POST',body:JSON.stringify({chatId,force}) }); assert.equal(r.status,200,await r.clone().text());return r.json(); }
  const actions = chatId => calls.filter(c => c.params.chat_id === chatId && ['deleteMessage','restrictChatMember','banChatMember','unbanChatMember'].includes(c.method));

  await t.test('验证头缺失拒绝，黑名单词首次命中即删除', async () => {
    const r=await mf.dispatchFetch('https://bot.test/webhook/path',{method:'POST',body:'{}'}); assert.equal(r.status,403);
    await send(update(-101,'请警惕刷单骗局，不要转账')); await tick(-101); assert.equal(actions(-101).filter(x=>x.method==='deleteMessage').length,1);
  });
  await t.test('同一 update 并发投递不会重复删除或计警告', async () => {
    const u=update(-102,'兼职招聘 私聊我');
    const responses=await Promise.all(Array.from({length:5},()=>send(u))); responses.forEach(r=>assert.equal(r.status,200));
    const {data}=await tick(-102);
    assert.equal(actions(-102).length,2); assert.equal(data.logs[0].warnings,undefined); assert.equal(data.logs[0].action,'delete-and-permanent-ban');
    const edited={update_id:++seq,edited_message:{...u.message,text:'兼职招聘 私聊我 改字'}};
    await send(edited);await tick(-102);assert.equal(actions(-102).length,2);
  });
  await t.test('广告直接删除并永久封禁，不累计警告或自动禁言', async () => {
    for(let i=0;i<3;i++){await send(update(-103,'兼职招聘 私聊我 '+i));await tick(-103);}
    const a=actions(-103);assert.equal(a.filter(x=>x.method==='deleteMessage').length,3);assert.equal(a.filter(x=>x.method==='restrictChatMember').length,0);assert.equal(a.filter(x=>x.method==='banChatMember').length,3);
  });
  await t.test('429 按重试时间保留任务，成功后才写成功记录', async () => {
    failures.set('deleteMessage:-104',{error_code:429,description:'rate limit',parameters:{retry_after:90}});
    await send(update(-104,'兼职招聘 私聊我'));let a=await tick(-104);
    assert.equal(a.data.pending,1);assert.equal(a.data.logs[0].outcome,'retrying');assert.ok(a.jobs[0].due>Date.now()+85000);
    a=await tick(-104,true);assert.equal(a.data.pending,0);assert.equal(a.data.logs[0].outcome,'success');assert.equal(a.data.logs[0].warnings,undefined);
  });
  await t.test('删消息暂时失败会重试，不产生警告状态', async () => {
    failures.set('deleteMessage:-105',{error_code:500,description:'temporary failure'});
    await send(update(-105,'兼职招聘 私聊我 稳赚 https://ad.example'));await tick(-105);const a=await tick(-105,true);
    assert.equal(actions(-105).filter(x=>x.method==='deleteMessage').length,2);assert.equal(a.data.logs[0].warnings,undefined);assert.equal(a.data.logs[0].outcome,'success');
  });
  await t.test('失败重试期间后续消息按顺序删除，不累计警告', async () => {
    failures.set('deleteMessage:-115',{error_code:429,description:'rate limit',parameters:{retry_after:90}});
    await send(update(-115,'兼职招聘 私聊我 A'));await tick(-115);
    await send(update(-115,'兼职招聘 私聊我 B'));const before=await tick(-115);
    assert.equal(before.data.pending,2);assert.equal(actions(-115).length,2);
    const after=await tick(-115,true);assert.equal(after.data.pending,0);
    assert.ok(after.data.logs.filter(x=>x.outcome==='success').every(x=>x.action==='delete-and-permanent-ban' && x.warnings===undefined));
  });
  await t.test('403 删消息失败仍封禁明确广告，逐步报告失败', async () => {
    failures.set('deleteMessage:-106',{error_code:403,description:'not enough rights'});
    await send(update(-106,'兼职招聘 私聊我 稳赚 https://ad.example'));const a=await tick(-106);
    assert.equal(a.data.failed,1);assert.equal(a.data.logs[0].outcome,'failed');assert.equal(actions(-106).length,2);assert.ok(a.data.logs[0].operationSteps.some(x=>x.method==='deleteMessage'&&x.status==='failed'));assert.ok(a.data.logs[0].operationSteps.some(x=>x.method==='banChatMember'&&x.status==='success'));
  });
  await t.test('管理员身份查询失败不会按普通用户处罚', async () => {
    failures.set('getChatMember:-107',{error_code:503,description:'unavailable'});
    await send(update(-107,'兼职招聘 私聊我'));await tick(-107);assert.equal(actions(-107).length,0);
  });
  await t.test('A/B 交替刷屏能被识别', async () => {
    for(const text of ['AAAA','BBBB','AAAA','BBBB','AAAA']) {await send(update(-108,text));await tick(-108);}
    assert.equal(actions(-108).filter(x=>x.method==='deleteMessage').length,1);
  });
  await t.test('多个账号重复同一文本会触发群级刷屏处理', async () => {
    await send(update(-116,'帮我收米 一天赚8K',{from:{id:71,first_name:'甲'}}));await tick(-116);
    await send(update(-116,'帮我收米 一天赚8K',{from:{id:72,first_name:'乙'}}));const data=await tick(-116);
    assert.equal(actions(-116).filter(x=>x.method==='deleteMessage').length,2);
    assert.equal(actions(-116).filter(x=>x.method==='banChatMember').length,2);
    assert.ok(actions(-116).filter(x=>x.method==='banChatMember').every(x=>x.params.until_date===0));
    assert.ok(data.data.logs.some(x=>x.reasons?.includes('10 分钟内多个账号重复相同内容')));
  });
  await t.test('频道身份广告删消息，不封禁伪造 from 用户', async () => {
    await send(update(-109,'兼职招聘 私聊我',{sender_chat:{id:-999,title:'外部频道'},from:{id:88,is_bot:true}}));await tick(-109);
    assert.deepEqual(actions(-109).map(x=>x.method),['deleteMessage']);
    await send(update(-109,'兼职招聘 私聊我',{sender_chat:{id:-109},from:{id:88,is_bot:true}}));await tick(-109);assert.equal(actions(-109).length,1);
  });
  await t.test('无封禁权限的群管理员不能借机器人封人', async () => {
    await send(update(-110,'/ban 7',{from:{id:11,first_name:'受限管理员'}}));await tick(-110);assert.equal(actions(-110).length,0);
  });
  await t.test('广告账号即使已有禁言限制也会永久封禁', async () => {
    await send(update(-112,'兼职招聘 私聊我 稳赚 https://ad.example',{from:{id:12,first_name:'已受限制用户'}}));await tick(-112);
    assert.deepEqual(actions(-112).map(x=>x.method),['deleteMessage','banChatMember']);
  });
  await t.test('OCR 识别纯图片广告后删除并永久封禁', async () => {
    await send(update(-117, '', { photo: [{ file_id: 'ocr-file', file_unique_id: 'ocr-unique', file_size: 12000 }] })); const result=await tick(-117);
    assert.deepEqual(actions(-117).map(x => x.method), ['deleteMessage', 'banChatMember'], JSON.stringify(result.data.logs));
  });
  await t.test('白名单会阻止自动封禁，私聊命令不会跨群生效', async () => {
    await send(update(-113,'兼职招聘 私聊我'));await tick(-113);
    await send(update(-113,'/allow 7',{from:{id:99,first_name:'owner'}}));await tick(-113);
    await send(update(-113,'兼职招聘 私聊我 稳赚 https://ad.example'));await tick(-113);
    assert.equal(actions(-113).length,2);
    const u=update(-114,'/ban 7',{from:{id:99},chat:{id:99,type:'private'}});await send(u);assert.equal(actions(99).length,0);
  });
  await t.test('解除封禁使用 only_if_banned，不踢出已在群的用户', async () => {
    await send(update(-111,'/unban 7',{from:{id:99,first_name:'owner'}}));await tick(-111);assert.equal(actions(-111)[0].params.only_if_banned,true);
  });
  await t.test('后台会话、CSRF、多群词库隔离和退出', async () => {
    for (const path of ['/admin','/admin/app.js','/admin/api/chats']) {
      const response=await mf.dispatchFetch('https://bot.test'+path);
      assert.equal(response.headers.get('X-Robots-Tag'),'noindex, nofollow, noarchive');
      assert.equal(response.headers.get('Cache-Control'),'no-store');
      assert.equal(response.status,path==='/admin/api/chats'?401:200);
    }
    const login=await mf.dispatchFetch('https://bot.test/admin/api/login',{method:'POST',headers:{Origin:'https://bot.test','Content-Type':'application/json'},body:JSON.stringify({password:'password-for-test'})});
    assert.equal(login.status,200);const raw=login.headers.get('set-cookie');assert.ok(raw.includes('HttpOnly'));assert.ok(raw.includes('SameSite=Strict'));const cookie=raw.split(';')[0];
    const request=(path,body,origin='https://bot.test')=>mf.dispatchFetch('https://bot.test/admin/api/'+path,{method:body?'POST':'GET',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    assert.equal((await request('keywords/add',{chatId:-120,word:'本群测试词'},'https://evil.test')).status,403);
    assert.equal((await request('keywords/add',{chatId:-120,word:'本群测试词'})).status,200);
    assert.equal((await request('domains/deny/add',{chatId:-120,domain:'bad.example'})).status,200);
    assert.equal((await request('domains/allow/add',{chatId:-120,domain:'trusted.example'})).status,200);
    const added=await request('samples/add',{kind:'text',value:'后台接口样本',label:'接口测试'});assert.equal(added.status,200);
    const addedSamples=(await added.json()).samples;assert.ok(Array.isArray(addedSamples));
    const item=addedSamples.find(x=>x.label==='接口测试');assert.ok(item);
    assert.ok(Array.isArray((await (await request('samples')).json()).samples));
    assert.equal((await (await request('samples/disable',{id:item.id})).json()).samples.find(x=>x.id===item.id).status,'disabled');
    assert.equal((await (await request('samples/test',{kind:'text',value:'后台接口样本',text:'后.台.接.口.样.本'})).json()).matched,true);
    assert.ok(Array.isArray((await (await request('federation')).json()).chats));
    const review=await request('review/resolve',{chatId:-120,userId:66,messageId:123});assert.equal(review.status,200);assert.equal((await review.json()).queued,true);await tick(-120);
    assert.ok(calls.some(c=>c.method==='banChatMember'&&c.params.chat_id===-120&&c.params.user_id===66));
    const health=await (await request('status?all=1')).json();
    assert.ok(Array.isArray(health.groups) && health.groups.length >= 6);
    assert.equal((await request('welcome-rules',{chatId:-120,welcomeMessage:'欢迎 {name} 加入 {group}',rulesMessage:'禁止广告'})).status,200);
    const a=await (await request('logs?chatId=-120')).json(),b=await (await request('logs?chatId=-121')).json();
    assert.ok(a.config.keywords.includes('本群测试词'));assert.ok(a.config.domainDenylist.includes('bad.example'));assert.ok(a.config.domainAllowlist.includes('trusted.example'));assert.equal(a.config.welcomeMessage,'欢迎 {name} 加入 {group}');assert.ok(!b.config.keywords.includes('本群测试词'));
    assert.ok(a.versions.length >= 1);const restored=await (await request('config/restore',{chatId:-120,versionId:a.versions[0].id})).json();assert.ok(Array.isArray(restored.versions));
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
  await t.test('联防同步广告封禁，算术验证通过后解除限制', async () => {
    const login=await mf.dispatchFetch('https://bot.test/admin/api/login',{method:'POST',headers:{Origin:'https://bot.test','Content-Type':'application/json'},body:JSON.stringify({password:'password-for-test'})});
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const request=(path,body)=>mf.dispatchFetch('https://bot.test/admin/api/'+path,{method:body?'POST':'GET',headers:{Cookie:cookie,Origin:'https://bot.test','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    await request('federation',{chatId:-140,enabled:true});await request('federation',{chatId:-141,enabled:true});
    const quiet=await (await request('quiet',{scope:'all',enabled:true,start:'00:00',end:'08:00',notify:true})).json();
    assert.ok(quiet.updated >= 6);
    const quietState = (await mf.getDurableObjectNamespace('GUARD_STATE')).getByName('-149');
    await quietState.fakeQuietClockTest();
    await quietState.editQuiet({ id: -149, title: '静默测试群' }, true, '00:00', '08:00', true);
    await quietState.quietTick('00:00');
    failures.set('deleteMessage:-149', { error_code: 500, description: 'temporary failure' });
    await quietState.quietTick('08:00');
    await quietState.forceNoticesTest();
    await quietState.quietTick('08:01');
    assert.equal(calls.filter(c => c.method === 'deleteMessage' && c.params.chat_id === -149 && c.params.message_id === 444).length, 2);
    await send(update(-140,'兼职招聘 私聊我',{from:{id:77,first_name:'广告号'}}));await tick(-140);await tick(-141);
    assert.ok(calls.some(c=>c.method==='banChatMember'&&c.params.chat_id===-141&&c.params.user_id===77));
    await request('verification',{chatId:-142,mode:'math',minutes:10,channel:''});
    await send(update(-142,'',{new_chat_members:[{id:44,first_name:'新人'}]}));await tick(-142);
    const verification=calls.find(c=>c.method==='sendMessage'&&c.params.chat_id===-142&&c.params.text.includes('新成员验证'));
    assert.ok(verification);const answer=/= \?/.test(verification.params.text)?verification.params.text.match(/(\d+) \+ (\d+)/):null;
    assert.ok(answer);await send(update(-142,String(Number(answer[1])+Number(answer[2])),{from:{id:44,first_name:'新人'}}));await tick(-142);
    assert.ok(calls.some(c=>c.method==='restrictChatMember'&&c.params.chat_id===-142&&c.params.user_id===44&&c.params.permissions.can_send_photos===false));
    assert.ok(calls.some(c=>c.method==='restrictChatMember'&&c.params.chat_id===-142&&c.params.user_id===44&&c.params.permissions.can_send_photos===false&&c.params.permissions.can_send_messages===true));
    const channelConfig=await (await request('verification',{chatId:-143,mode:'channel',minutes:10,channel:'jason_vps_deal'})).json();
    assert.equal(channelConfig.verificationChannel,'@jason_vps_deal');
    await send(update(-143,'',{new_chat_members:[{id:45,first_name:'订阅者'}]}));await tick(-143);
    const callback={update_id:++seq,callback_query:{id:'verify-45',from:{id:45,first_name:'订阅者'},data:'verify:channel:45',message:{message_id:999,chat:{id:-143,type:'supergroup',title:'测试群'}}}};
    await send(callback);await tick(-143);
    assert.ok(calls.some(c=>c.method==='answerCallbackQuery'&&c.params.callback_query_id==='verify-45'));
    await request('raid',{chatId:-144,enabled:true,limit:2,minutes:30});
    await send(update(-144,'',{new_chat_members:[{id:51,first_name:'新一'}]}));await tick(-144);
    await send(update(-144,'',{new_chat_members:[{id:52,first_name:'新二'}]}));await tick(-144);
    assert.ok(calls.some(c=>c.method==='sendMessage'&&c.params.chat_id===-144&&c.params.text.includes('新成员验证')));
    await request('new-member-link-guard',{chatId:-145,enabled:true,minutes:30});
    await send(update(-145,'',{new_chat_members:[{id:61,first_name:'引流号'}]}));await tick(-145);
    await send(update(-145,'看看 https://example.org',{from:{id:61,first_name:'引流号'}}));await tick(-145);
    assert.ok(calls.some(c=>c.method==='banChatMember'&&c.params.chat_id===-145&&c.params.user_id===61));
    await request('new-member-media-guard',{chatId:-146,enabled:true,minutes:30});
    await send(update(-146,'',{new_chat_members:[{id:62,first_name:'发图号'}]}));await tick(-146);
    await send(update(-146,'',{from:{id:62,first_name:'发图号'},animation:{file_unique_id:'plain-animation'}}));await tick(-146);
    assert.ok(calls.some(c=>c.method==='deleteMessage'&&c.params.chat_id===-146));
    assert.ok(!calls.some(c=>c.method==='banChatMember'&&c.params.chat_id===-146&&c.params.user_id===62));
    const knowledge=await (await request('knowledge/upsert',{chatId:-148,item:{title:'VPS 购买',command:'vps',triggers:'怎么购买,有没有官网吗',response:'购买说明：https://example.com/buy',enabled:true}})).json();
    assert.equal(knowledge.knowledgeBase.length,1);
    await send(update(-148,'/vps',{from:{id:67,first_name:'提问者'}}));await tick(-148);
    await send(update(-148,'请问怎么购买？',{from:{id:68,first_name:'提问者二'}}));await tick(-148);
    assert.ok(calls.filter(c=>c.method==='sendMessage'&&c.params.chat_id===-148&&c.params.text.includes('购买说明')).length>=2);
    await request('content-locks',{chatId:-147,locks:{forward:{enabled:true,action:'delete'},invite:{enabled:true,action:'ban'},sticker:{enabled:true,action:'delete'}}});
    await send(update(-147,'转发内容',{from:{id:63,first_name:'转发号'},forward_origin:{type:'user'}}));await tick(-147);
    await send(update(-147,'加入 https://t.me/+abcdef',{from:{id:64,first_name:'引流号'}}));await tick(-147);
    await send(update(-147,'',{from:{id:65,first_name:'贴纸号'},sticker:{file_unique_id:'sticker-1'}}));await tick(-147);
    assert.equal(actions(-147).filter(x=>x.method==='deleteMessage').length,3);
    assert.ok(calls.some(c=>c.method==='banChatMember'&&c.params.chat_id===-147&&c.params.user_id===64));
    assert.ok(!calls.some(c=>c.method==='banChatMember'&&c.params.chat_id===-147&&c.params.user_id===63));
  });
  await t.test('/spam 保护管理员、删除封禁且样本待审；停用和启用可纠错', async()=>{
    const ns=await mf.getDurableObjectNamespace('GUARD_STATE'), global=ns.getByName('admin');
    const target={message_id:9991,from:{id:77,first_name:'广告号'},text:'独立样本测试文案abcd'};
    await send(update(-160,'/spam',{from:{id:99},reply_to_message:target}));await tick(-160);
    assert.ok(actions(-160).some(x=>x.method==='banChatMember'&&x.params.user_id===77));
    assert.ok(actions(-160).some(x=>x.method==='deleteMessage'&&x.params.message_id===9991));
    const sample=(await global.listSamples()).find(x=>x.label.includes('/spam'));assert.equal(sample.status,'pending');
    await send(update(-161,target.text));await tick(-161);assert.equal(actions(-161).length,0);
    await global.editSample('activate',{id:sample.id,previewToken:(await global.previewSample(sample.id)).previewToken});await send(update(-162,target.text));await tick(-162);assert.ok(actions(-162).some(x=>x.method==='banChatMember'));
    await global.editSample('disable',{id:sample.id});await send(update(-163,target.text));await tick(-163);assert.equal(actions(-163).length,0);
    assert.equal((await global.testSample({kind:'text',value:'独立样本测试',text:'独.立.样.本.测.试'})).matched,true);
    await send(update(-164,'/spam',{from:{id:99},reply_to_message:{...target,from:{id:11}}}));await tick(-164);assert.ok(!actions(-164).some(x=>x.method==='banChatMember'));
  });
  await t.test('同用户分段广告可识别，跨用户内容不拼接',async()=>{
    await send(update(-165,'又赚钱了!!!'));await tick(-165);
    await send(update(-165,'都说了跟对他很重要 @advertiser'));await tick(-165);
    assert.ok(actions(-165).some(x=>x.method==='banChatMember'));
    await send(update(-166,'又赚钱了!!!'));await tick(-166);
    await send(update(-166,'都说了跟对他很重要 @advertiser',{from:{id:78}}));await tick(-166);
    assert.ok(!actions(-166).some(x=>x.method==='banChatMember'));
  });
  await t.test('失败任务可显式重试，成功之前日报不计处罚',async()=>{
    failures.set('deleteMessage:-167',{error_code:403,description:'Forbidden'});
    await send(update(-167,'兼职'));const before=await tick(-167);
    const ns=await mf.getDurableObjectNamespace('GUARD_STATE'),group=ns.getByName('chat:-167');
    assert.equal((await group.dailySummary(Date.now()-60000,Date.now()+1000)).intercepted,0);
    assert.equal((await group.healthSummary()).failed,1);
    await group.retryJob(before.jobs[0].id);await tick(-167,true);
    assert.equal((await group.dailySummary(Date.now()-60000,Date.now()+1000)).intercepted,1);
    assert.equal((await group.healthSummary()).failed,0);
  });

  await t.test('静默期间关闭功能立即恢复原权限；删除失败通知不覆盖且退避',async()=>{
    const ns=await mf.getDurableObjectNamespace('GUARD_STATE'),group=ns.getByName('chat:-170');
    await group.fakeQuietClockTest();
    await group.editQuiet({id:-170,title:'关闭静默测试'},true,'00:00','08:00',true);
    await group.quietTick('00:00');
    failures.set('deleteMessage:-170',{error_code:500,description:'temporary failure'});
    await group.editQuiet({id:-170,title:'关闭静默测试'},false,'00:00','08:00',false);
    assert.ok(calls.some(x=>x.method==='setChatPermissions'&&x.params.chat_id===-170&&x.params.permissions.can_send_messages===true));
    const count=calls.filter(x=>x.method==='deleteMessage'&&x.params.chat_id===-170).length;
    await group.quietTick('08:00');assert.equal(calls.filter(x=>x.method==='deleteMessage'&&x.params.chat_id===-170).length,count);
    assert.equal((await group.quietNotices()).length,1);
    await group.forceNoticesTest();await group.quietTick('08:00');assert.equal((await group.quietNotices()).length,0);
    await group.seedNoticesTest([{id:1234,retryAt:0,attempts:0}]);
    await group.editQuiet({id:-170,title:'关闭静默测试'},true,'00:00','08:00',true);await group.quietTick('00:00');
    assert.deepEqual((await group.quietNotices()).map(x=>x.id),[1234,444]);
    failures.set('setChatPermissions:-170',{error_code:500,description:'restore temporarily fails'});
    const result=await group.editQuiet({id:-170,title:'关闭静默测试'},false,'00:00','08:00',false);assert.equal(result.quietRestorePending,true);
    await group.quietTick('08:00');assert.equal((await group.quietNotices()).length,0);
  });
  await t.test('静默恢复提醒按设置的分钟数自动删除，0 表示不删除',async()=>{
    const ns=await mf.getDurableObjectNamespace('GUARD_STATE'),group=ns.getByName('chat:-172');
    const deletes=()=>calls.filter(x=>x.method==='deleteMessage'&&x.params.chat_id===-172).length;
    await group.fakeQuietClockTest();
    const saved=await group.editQuiet({id:-172,title:'自动删除测试'},true,'00:00','08:00',true,5);assert.equal(saved.quietEndNoticeMinutes,5);
        await group.quietTick('00:00');
    const start=calls.filter(x=>x.method==='sendMessage'&&x.params.chat_id===-172).at(-1);
    assert.equal(start.params.parse_mode,'HTML');assert.ok(start.params.text.includes('夜间静默已开启')&&start.params.text.includes('00:00 – 08:00'));
    await group.quietTick('08:00');assert.equal(deletes(),1);
    const end=calls.filter(x=>x.method==='sendMessage'&&x.params.chat_id===-172).at(-1);
    assert.ok(end.params.text.includes('群聊已恢复发言')&&end.params.text.includes('5 分钟后自动删除'));
    const pending=await group.quietNotices();assert.equal(pending.length,1);assert.ok(pending[0].deleteAt>Date.now());
    await group.quietTick('08:01');assert.equal(deletes(),1);
    await group.expireNoticesTest();await group.quietTick('08:06');assert.equal(deletes(),2);assert.equal((await group.quietNotices()).length,0);
    await group.editQuiet({id:-172,title:'自动删除测试'},true,'00:00','08:00',true,0);
    await group.quietTick('00:00');await group.quietTick('08:00');
    const kept=calls.filter(x=>x.method==='sendMessage'&&x.params.chat_id===-172).at(-1);
    assert.ok(!kept.params.text.includes('自动删除'));assert.equal((await group.quietNotices()).length,0);
  });
  await t.test('验证超时封禁失败保留记录并重试，成功后才清理',async()=>{
    const ns=await mf.getDurableObjectNamespace('GUARD_STATE'),group=ns.getByName('chat:-171');
    await group.editVerification('math',5,'');
    await send(update(-171,'',{new_chat_members:[{id:81,first_name:'超时新人'}]}));await tick(-171);
    await group.expireVerificationTest(81);
    failures.set('banChatMember:-171',{error_code:500,description:'temporary failure'});
    const first=await tick(-171);assert.ok(await group.verification(81));assert.ok(first.jobs.some(x=>x.id.startsWith('verification-timeout:')&&x.status==='pending'));
    await send(update(-171,'兼职 私聊我',{from:{id:82,first_name:'其他广告号'}}));await tick(-171);
    assert.ok(actions(-171).some(x=>x.method==='banChatMember'&&x.params.user_id===82));
    await tick(-171,true);assert.equal(await group.verification(81),undefined);
    assert.equal(calls.filter(x=>x.method==='banChatMember'&&x.params.chat_id===-171&&x.params.user_id===81).length,2);
  });
  await t.test('频道验证期间不能发言；按钮答题限 3 次；超时可选择移出', async () => {
    const ns=await mf.getDurableObjectNamespace('GUARD_STATE'),channelGroup=ns.getByName('chat:-501');
    await channelGroup.editVerification('channel',10,'@jason_vps_deal','ban');
    await send(update(-501,'',{new_chat_members:[{id:91,first_name:'未验证'}]}));await tick(-501);
    assert.ok(calls.some(c=>c.method==='restrictChatMember'&&c.params.chat_id===-501&&c.params.user_id===91&&c.params.permissions.can_send_messages===false));
    const prompt=calls.find(c=>c.method==='sendMessage'&&c.params.chat_id===-501&&c.params.text.includes('新成员验证'));
    assert.equal(prompt.params.parse_mode,'HTML');assert.ok(prompt.params.text.includes('tg://user?id=91'));
    const sneaky=update(-501,'加我领福利',{from:{id:91,first_name:'未验证'}});await send(sneaky);await tick(-501);
    assert.ok(calls.some(c=>c.method==='deleteMessage'&&c.params.chat_id===-501&&c.params.message_id===sneaky.message.message_id));

    const buttonGroup=ns.getByName('chat:-502');await buttonGroup.editVerification('button',10,'','kick');
    await send(update(-502,'',{new_chat_members:[{id:92,first_name:'按钮新人'}]}));await tick(-502);
    const ask=calls.find(c=>c.method==='sendMessage'&&c.params.chat_id===-502&&c.params.text.includes('新成员验证'));
    const buttons=ask.params.reply_markup.inline_keyboard.flat();assert.equal(buttons.length,6);assert.equal(ask.params.reply_markup.inline_keyboard.length,2);assert.ok(ask.params.text.includes('最多可选 2 次'));
    const answer=(await buttonGroup.verification(92)).answer,wrong=buttons.find(b=>!b.callback_data.endsWith(':'+answer)).callback_data;
    const click=(id,data,from=92)=>send({update_id:++seq,callback_query:{id,from:{id:from,first_name:'按钮新人'},data,message:{message_id:ask.params.chat_id===-502?777:0,chat:{id:-502,type:'supergroup',title:'测试群'}}}});
    await click('other-1',wrong,93);await tick(-502);
    assert.ok(calls.some(c=>c.method==='answerCallbackQuery'&&c.params.callback_query_id==='other-1'&&c.params.text.includes('其他新成员')));
    await click('wrong-1',wrong);await tick(-502);
    assert.ok(calls.some(c=>c.method==='answerCallbackQuery'&&c.params.callback_query_id==='wrong-1'&&c.params.text.includes('还可以再试 1 次')));
    await click('wrong-2',wrong);await tick(-502);await tick(-502);
    assert.equal(await buttonGroup.verification(92),undefined);
    assert.ok(calls.some(c=>c.method==='banChatMember'&&c.params.chat_id===-502&&c.params.user_id===92));
    assert.ok(calls.some(c=>c.method==='unbanChatMember'&&c.params.chat_id===-502&&c.params.user_id===92&&c.params.only_if_banned===true));

    await send(update(-502,'',{new_chat_members:[{id:94,first_name:'答对的人'}]}));await tick(-502);
    const right=(await buttonGroup.verification(94)).answer;
    await click('right',`verify:pick:94:${right}`,94);await tick(-502);
    assert.equal(await buttonGroup.verification(94),undefined);
    assert.ok(calls.some(c=>c.method==='answerCallbackQuery'&&c.params.callback_query_id==='right'&&c.params.text.includes('验证通过')));
  });
  await t.test('算术验证通过的提示稍后自动删除', async () => {
    const ns=await mf.getDurableObjectNamespace('GUARD_STATE'),g=ns.getByName('chat:-503');await g.editVerification('math',10,'');
    await send(update(-503,'',{new_chat_members:[{id:95,first_name:'算术'}]}));await tick(-503);
    await send(update(-503,'99',{from:{id:95,first_name:'算术'}}));await tick(-503);
    assert.ok(calls.some(c=>c.method==='sendMessage'&&c.params.chat_id===-503&&c.params.text.includes('还可以再试 <b>2</b> 次')));
    await send(update(-503,(await g.verification(95)).answer,{from:{id:95,first_name:'算术'}}));
    const {jobs}=await tick(-503);
    assert.ok(jobs.some(x=>x.id==='cleanup:-503:444'&&x.status==='pending'));
    await tick(-503,true);
    assert.ok(calls.some(c=>c.method==='deleteMessage'&&c.params.chat_id===-503&&c.params.message_id===444));
  });
  await t.test('二选一验证：关注频道或答题都能通过，答题仍限次数', async () => {
    const ns=await mf.getDurableObjectNamespace('GUARD_STATE'),g=ns.getByName('chat:-506');await g.editVerification('choice',10,'jason_vps_deal','ban');
    await send(update(-506,'',{new_chat_members:[{id:81,first_name:'选频道'},{id:82,first_name:'选答题'}]}));await tick(-506);
    const prompt=calls.find(c=>c.method==='sendMessage'&&c.params.chat_id===-506&&c.params.text.includes('任选一种'));
    assert.ok(prompt);const rows=prompt.params.reply_markup.inline_keyboard;assert.equal(rows.length,4);assert.ok(rows[0][0].url.endsWith('/jason_vps_deal'));assert.equal(rows.slice(2).flat().length,6);
    assert.ok(calls.some(c=>c.method==='restrictChatMember'&&c.params.chat_id===-506&&c.params.user_id===81&&c.params.permissions.can_send_messages===false));
    const click=(id,from,data)=>send({update_id:++seq,callback_query:{id,from:{id:from,first_name:'x'},data,message:{message_id:700+from,chat:{id:-506,type:'supergroup',title:'测试群'}}}});
    await click('c81',81,'verify:channel:81');await tick(-506);
    assert.equal(await g.verification(81),undefined);
    const answer=(await g.verification(82)).answer;
    await click('p82',82,`verify:pick:82:${answer}`);await tick(-506);
    assert.equal(await g.verification(82),undefined);
    assert.ok(calls.some(c=>c.method==='answerCallbackQuery'&&c.params.callback_query_id==='p82'&&c.params.text.includes('验证通过')));
    await assert.rejects(g.editVerification('choice',10,'','ban'));
  });
  await t.test('验证前自行退群：撤销验证、删除提示，不会超时封禁', async () => {
    const ns=await mf.getDurableObjectNamespace('GUARD_STATE'),g=ns.getByName('chat:-505');await g.editVerification('button',10,'','ban');
    await send(update(-505,'',{new_chat_members:[{id:98,first_name:'走了'}]}));await tick(-505);
    const prompt=(await g.verification(98)).prompt_message_id;assert.ok(prompt);
    await send(update(-505,'',{from:{id:98,first_name:'走了'},left_chat_member:{id:98,first_name:'走了'}}));await tick(-505);
    assert.equal(await g.verification(98),undefined);
    assert.ok(calls.some(c=>c.method==='deleteMessage'&&c.params.chat_id===-505&&c.params.message_id===prompt));
    assert.ok(!calls.some(c=>c.method==='banChatMember'&&c.params.chat_id===-505&&c.params.user_id===98));
  });
  await t.test('活跃统计、进出群系统提示自动删除，可在后台关闭', async () => {
    const ns=await mf.getDurableObjectNamespace('GUARD_STATE'),g=ns.getByName('chat:-512'),today=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
    for(const [n,id] of [7401,7401,7401,7402].entries())await send(update(-512,['早上好','今天天气不错','有人吗','我在'][n],{from:{id,first_name:'活跃'+id}}));
    const joined=update(-512,'',{from:{id:7403,first_name:'新人'},new_chat_members:[{id:7403,first_name:'新人'}]});await send(joined);await tick(-512);
    assert.ok(calls.some(c=>c.method==='deleteMessage'&&c.params.chat_id===-512&&c.params.message_id===joined.message.message_id));
    const left=update(-512,'',{from:{id:7403,first_name:'新人'},left_chat_member:{id:7403,first_name:'新人'}});await send(left);await tick(-512);
    assert.ok(calls.some(c=>c.method==='deleteMessage'&&c.params.chat_id===-512&&c.params.message_id===left.message.message_id));
    const stats=await g.activityStats(today,today);
    assert.equal(stats.messages,4);assert.equal(stats.speakers,2);assert.equal(stats.joins,1);assert.equal(stats.leaves,1);assert.equal(stats.top[0].userId,'7401');assert.equal(stats.top[0].messages,3);
    const {data}=await tick(-512);assert.ok(!data.logs.some(l=>(l.steps||[]).some(x=>x.method==='deleteMessage')),'service deletes are not counted as intercepted ads');
    assert.deepEqual(JSON.parse(JSON.stringify(await g.editScreening(true,false,false))),{casEnabled:true,profileCheckEnabled:false,deleteServiceMessages:false});
    const again=update(-512,'',{from:{id:7404,first_name:'又一个'},new_chat_members:[{id:7404,first_name:'又一个'}]});await send(again);await tick(-512);
    assert.ok(!calls.some(c=>c.method==='deleteMessage'&&c.params.chat_id===-512&&c.params.message_id===again.message.message_id));
    await assert.rejects(g.editScreening('yes',true,true));
    const admin=ns.getByName('admin');
    assert.equal(await admin.sendWeeklyReport(Date.parse('2026-10-13T01:30:00Z')),false);
    assert.equal(await admin.sendWeeklyReport(Date.parse('2026-10-12T01:30:00Z')),true);
    assert.ok(calls.some(c=>c.method==='sendMessage'&&c.params.chat_id===99&&c.params.text.includes('群活跃周报')));
    assert.equal(await admin.sendWeeklyReport(Date.parse('2026-10-12T02:30:00Z')),false);
  });
  await t.test('定时公告每天按时发送一次，可替换上一条', async () => {
    const ns=await mf.getDurableObjectNamespace('GUARD_STATE'),g=ns.getByName('chat:-511');await g.fakeQuietClockTest();
    await g.seedRecordTest('chat',{id:-511,type:'supergroup',title:'公告群'});
    await assert.rejects(g.editAnnouncement('upsert',{time:'25:00',text:'x'}));
    const {announcements}=await g.editAnnouncement('upsert',{time:'09:00',text:'⚠️ 防骗提醒',pin:true});assert.equal(announcements.length,1);
    assert.equal(await g.announceTick(Date.parse('2026-10-09T00:59:00Z')),0);
    assert.equal(await g.announceTick(Date.parse('2026-10-09T01:05:00Z')),1);
    assert.ok(calls.some(c=>c.method==='sendMessage'&&c.params.chat_id===-511&&c.params.text==='⚠️ 防骗提醒'));
    assert.ok(calls.some(c=>c.method==='pinChatMessage'&&c.params.chat_id===-511));
    assert.equal(await g.announceTick(Date.parse('2026-10-09T01:06:00Z')),0);
    assert.equal(await g.announceTick(Date.parse('2026-10-09T01:30:00Z')),0);
    const before=calls.length;
    assert.equal(await g.announceTick(Date.parse('2026-10-10T01:00:00Z')),1);
    assert.ok(calls.slice(before).some(c=>c.method==='deleteMessage'&&c.params.chat_id===-511&&c.params.message_id===444));
    assert.equal((await g.editAnnouncement('remove',{id:announcements[0].id})).announcements.length,0);
    await assert.rejects(g.editAnnouncement('upsert',{time:'10:00',text:'周会',days:[]}));
    const weekly=(await g.editAnnouncement('upsert',{time:'10:00',text:'周一例会提醒',days:[1]})).announcements[0];assert.deepEqual([...weekly.days],[1]);
    assert.equal(await g.announceTick(Date.parse('2026-10-13T02:01:00Z')),0);
    assert.equal(await g.announceTick(Date.parse('2026-10-12T02:01:00Z')),1);
  });
  await t.test('机器人简介追加申诉提示，保留原有内容且只做一次', async () => {
    const admin=(await mf.getDurableObjectNamespace('GUARD_STATE')).getByName('admin'),before=calls.length;
    assert.equal(await admin.ensureAppealHint(),true);
    const set=calls.slice(before).find(c=>c.method==='setMyDescription');assert.ok(set.params.description.startsWith('Jason 的群管家'));assert.ok(set.params.description.includes('/start'));
    assert.ok(calls.slice(before).some(c=>c.method==='setMyShortDescription'&&c.params.short_description.length<=120));
    assert.equal(await admin.ensureAppealHint(),false);
  });
  await t.test('机器人自己改名为 Jason Guard Bot、换头像和简介，只做一次', async () => {
    const admin=(await mf.getDurableObjectNamespace('GUARD_STATE')).getByName('admin'),before=calls.length;
    assert.equal(await admin.ensureBotProfile(),true);
    const made=calls.slice(before);
    assert.ok(made.some(c=>c.method==='setMyName'&&c.params.name==='Jason Guard Bot'));
    const photo=made.find(c=>c.method==='setMyProfilePhoto');assert.ok(photo);
    assert.deepEqual(JSON.parse(photo.params.photo),{type:'static',photo:'attach://avatar'});
    assert.equal(photo.params.avatar.type,'image/jpeg');assert.ok(photo.params.avatar.size>10000);
    assert.ok(made.some(c=>c.method==='setMyShortDescription'&&c.params.short_description.startsWith('自动群管理机器人')&&c.params.short_description.length<=120));
    const desc=made.find(c=>c.method==='setMyDescription');assert.ok(desc.params.description.startsWith('自动群管理机器人'));assert.ok(desc.params.description.includes('/start'));
    assert.equal(await admin.ensureBotProfile(),false);
  });
  await t.test('误封申诉：私聊机器人提交，所有者一键解封并通知本人', async () => {
    const ns=await mf.getDurableObjectNamespace('GUARD_STATE');
    await send(update(-510,'兼职招聘 私聊我',{from:{id:7301,first_name:'误封者'}}));await tick(-510);
    assert.ok(calls.some(c=>c.method==='banChatMember'&&c.params.chat_id===-510&&c.params.user_id===7301));
    const dm=(id,text)=>send({update_id:++seq,message:{message_id:++seq,date:Math.floor(Date.now()/1000),chat:{id,type:'private'},from:{id,first_name:'误封者'},text}});
    await dm(7302,'/start');
    assert.ok(calls.some(c=>c.method==='sendMessage'&&c.params.chat_id===7302&&c.params.text.includes('没有被本机器人封禁')));
    await dm(7301,'/start');
    const intro=calls.findLast(c=>c.method==='sendMessage'&&c.params.chat_id===7301);
    assert.ok(intro.params.text.includes('被封禁'));assert.equal(intro.params.reply_markup.inline_keyboard[0][0].callback_data,'ap:go');
    await send({update_id:++seq,callback_query:{id:'ap-1',from:{id:7301,first_name:'误封者'},data:'ap:go',message:{message_id:50,chat:{id:7301,type:'private'}}}});
    const notice=calls.findLast(c=>c.method==='sendMessage'&&c.params.chat_id===99&&c.params.text.includes('解封申诉'));
    assert.ok(notice);
    await send({update_id:++seq,callback_query:{id:'ap-2',from:{id:7301,first_name:'误封者'},data:'ap:go',message:{message_id:50,chat:{id:7301,type:'private'}}}});
    assert.ok(calls.some(c=>c.method==='answerCallbackQuery'&&c.params.callback_query_id==='ap-2'&&c.params.text.includes('已提交')));
    const accept=notice.params.reply_markup.inline_keyboard.flat().find(b=>String(b.callback_data).endsWith(':accept')).callback_data;
    await send({update_id:++seq,callback_query:{id:'ap-own',from:{id:99,first_name:'Jason'},data:accept,message:{message_id:444,chat:{id:99,type:'private'}}}});
    await tick(-510);
    assert.ok(calls.some(c=>c.method==='unbanChatMember'&&c.params.chat_id===-510&&c.params.user_id===7301));
    assert.ok(calls.some(c=>c.method==='sendMessage'&&c.params.chat_id===7301&&c.params.text.includes('申诉通过')));
    assert.equal(await ns.getByName('chat:-510').appealBanInfo(7301),null);
  });
  await t.test('入群申请：未开启验证的群筛查后直接批准', async () => {
    const ns=await mf.getDurableObjectNamespace('GUARD_STATE'),g=ns.getByName('chat:-507');await g.editVerification('off',10,'');
    await send({update_id:++seq,chat_join_request:{chat:{id:-507,type:'supergroup',title:'无验证群'},from:{id:83,first_name:'普通人'},user_chat_id:83,date:Math.floor(Date.now()/1000)}});await tick(-507);
    assert.ok(calls.some(c=>c.method==='approveChatJoinRequest'&&c.params.chat_id===-507&&c.params.user_id===83));
    assert.equal(await g.verification(83),undefined);
  });
  await t.test('入群申请：私聊验证，通过自动批准，超时自动拒绝', async () => {
    const ns=await mf.getDurableObjectNamespace('GUARD_STATE'),g=ns.getByName('chat:-504');await g.editVerification('button',10,'');
    const joinRequest=id=>({update_id:++seq,chat_join_request:{chat:{id:-504,type:'supergroup',title:'申请群'},from:{id,first_name:'申请人'},user_chat_id:id,date:Math.floor(Date.now()/1000)}});
    assert.equal((await send(joinRequest(96))).status,200);await tick(-504);
    const dm=calls.find(c=>c.method==='sendMessage'&&c.params.chat_id===96);
    assert.ok(dm.params.text.includes('入群验证：申请群'));
    assert.equal((await g.verification(96)).via,'request');
    const answer=(await g.verification(96)).answer;
    await send({update_id:++seq,callback_query:{id:'dm-ok',from:{id:96,first_name:'申请人'},data:`vj:-504:p:${answer}`,message:{message_id:444,chat:{id:96,type:'private',first_name:'申请人'}}}});await tick(-504);
    assert.ok(calls.some(c=>c.method==='approveChatJoinRequest'&&c.params.chat_id===-504&&c.params.user_id===96));
    // Approved members are not asked again when they actually join.
    await send(update(-504,'',{new_chat_members:[{id:96,first_name:'申请人'}]}));await tick(-504);
    assert.equal(await g.verification(96),undefined);
    assert.ok(!(await ns.getByName('admin').listChats()).some(chat=>chat.id==='96'));

    await send(joinRequest(97));await tick(-504);
    await g.expireVerificationTest(97);await tick(-504);
    assert.ok(calls.some(c=>c.method==='declineChatJoinRequest'&&c.params.chat_id===-504&&c.params.user_id===97));
    assert.ok(!calls.some(c=>c.method==='banChatMember'&&c.params.chat_id===-504&&c.params.user_id===97));
    assert.equal(await g.verification(97),undefined);
  });
  await t.test('跨群用户名定位验证超时：手动解封、免验证一次且继续拦截广告',async()=>{
    const ns=await mf.getDurableObjectNamespace('GUARD_STATE'),g=ns.getByName('chat:-181');
    await g.editVerification('math',5,'');
    await send(update(-181,'',{new_chat_members:[{id:88,username:'Recover_User',first_name:'待救成员'}]}));await tick(-181);await g.expireVerificationTest(88);await tick(-181);
    const found=await ns.getByName('admin').findVerificationMembers('@RECOVER_USER');
    assert.ok(found.members.some(x=>x.chatId==='-181'&&x.userId==='88'&&x.state==='timeout'));
    assert.equal((await ns.getByName('admin').findVerificationMembers('@Unknown_User')).members.length,0);
    const result=await g.releaseVerification('-181','88');assert.equal(result.queued,true);await tick(-181);
    assert.ok(actions(-181).some(x=>x.method==='unbanChatMember'&&x.params.user_id===88&&x.params.only_if_banned));
    assert.equal((await g.verificationMembers('88'))[0].state,'released');
    await send(update(-181,'',{new_chat_members:[{id:88,username:'Recover_User'}]}));await tick(-181);assert.equal(await g.verification(88),undefined);
    await send(update(-181,'兼职',{from:{id:88,username:'Recover_User'}}));await tick(-181);assert.ok(actions(-181).filter(x=>x.method==='banChatMember'&&x.params.user_id===88).length>=2);
  });
  await t.test('管理员手动通过取消旧超时任务，恢复群默认权限，不影响其他群',async()=>{
    const ns=await mf.getDurableObjectNamespace('GUARD_STATE'),g=ns.getByName('chat:-182'),other=ns.getByName('chat:-183');
    for(const [chat,groupState] of [[-182,g],[-183,other]]){await groupState.editVerification('math',5,'');await send(update(chat,'',{new_chat_members:[{id:12,username:'Pending_User'}]}));await tick(chat);}
    await g.expireVerificationTest(12);failures.set('banChatMember:-182',{error_code:500,description:'temporary failure'});await tick(-182);
    const bans=actions(-182).filter(x=>x.method==='banChatMember').length;await g.releaseVerification('-182','12');await tick(-182,true);
    assert.equal(actions(-182).filter(x=>x.method==='banChatMember').length,bans);assert.equal(await g.verification(12),undefined);assert.ok(await other.verification(12));
    assert.ok(actions(-182).some(x=>x.method==='restrictChatMember'&&x.params.permissions.can_send_messages&&x.params.permissions.can_send_photos===false));
  });
  await t.test('解封失败保留处理中；出现新广告封禁后停止旧解封任务',async()=>{
    const ns=await mf.getDurableObjectNamespace('GUARD_STATE'),g=ns.getByName('chat:-184');await g.editVerification('math',5,'');
    await send(update(-184,'',{new_chat_members:[{id:88,username:'Retry_User'}]}));await tick(-184);await g.expireVerificationTest(88);await tick(-184);
    failures.set('unbanChatMember:-184',{error_code:500,description:'temporary failure'});await g.releaseVerification('-184','88');await tick(-184);assert.equal((await g.verificationMembers('88'))[0].state,'processing');
    await g.seedRecordTest('member-ban:88',{action:'advertisement-permanent-ban',jobId:'new-ad'});const unbans=actions(-184).filter(x=>x.method==='unbanChatMember').length;await tick(-184,true);
    assert.equal(actions(-184).filter(x=>x.method==='unbanChatMember').length,unbans);assert.equal((await g.verificationMembers('88'))[0].canRelease,false);
  });
  await t.test('验证限制恢复失败可手动重试，历史超时日志也能按 ID 找到',async()=>{
    const ns=await mf.getDurableObjectNamespace('GUARD_STATE'),g=ns.getByName('chat:-185');await g.editVerification('math',5,'');
    await send(update(-185,'',{new_chat_members:[{id:12,username:'Failed_User'}]}));await tick(-185);
    failures.set('restrictChatMember:-185',{error_code:400,description:'permission error'});await g.releaseVerification('-185','12');await tick(-185);
    const row=(await g.verificationMembers('12'))[0];assert.equal(row.state,'failed');assert.equal(row.canRelease,true);
    const retried=await g.releaseVerification('-185','12');assert.equal(retried.id,row.jobId);await tick(-185);assert.equal((await g.verificationMembers('12'))[0].state,'released');assert.ok((await g.verificationMembers()).some(x=>x.userId==='12'&&x.state==='released'));
    await g.seedLogTest({chatId:-185,userId:'100888',action:'verification-timeout-ban',outcome:'success',steps:[{method:'banChatMember',done:true}]});assert.equal((await g.verificationMembers('100888'))[0].state,'timeout');
  });
  await t.test('后台解封鉴权与私聊指令仅所有者可用，成员可查询自己的 ID',async()=>{
    const denied=await mf.dispatchFetch('https://bot.test/admin/api/verification/members?query=88');assert.equal(denied.status,401);
    const before=calls.filter(x=>x.method==='sendMessage'&&x.params.chat_id===7).length;
    await send(update(7,'/release 88 -181',{chat:{id:7,type:'private'},from:{id:7}}));assert.equal(calls.filter(x=>x.method==='sendMessage'&&x.params.chat_id===7).length,before);
    await send(update(7,'/myid',{chat:{id:7,type:'private'},from:{id:7}}));assert.ok(calls.some(x=>x.method==='sendMessage'&&x.params.chat_id===7&&x.params.text.includes('ID：7')));
    await send(update(99,'/findmember @Pending_User',{chat:{id:99,type:'private'},from:{id:99}}));assert.ok(calls.some(x=>x.method==='sendMessage'&&x.params.chat_id===99&&x.params.text.includes('/release 12 -183')));
    const login=await mf.dispatchFetch('https://bot.test/admin/api/login',{method:'POST',headers:{Origin:'https://bot.test','Content-Type':'application/json'},body:JSON.stringify({password:'password-for-test'})});const cookie=login.headers.get('set-cookie').split(';')[0];
    const search=await mf.dispatchFetch('https://bot.test/admin/api/verification/members?query=12',{headers:{Cookie:cookie}});assert.equal(search.status,200);assert.ok((await search.json()).members.some(x=>x.chatId==='-183'));
    const release=await mf.dispatchFetch('https://bot.test/admin/api/verification/release',{method:'POST',headers:{Cookie:cookie,Origin:'https://bot.test','Content-Type':'application/json'},body:JSON.stringify({chatId:'-183',userId:'12'})});assert.equal(release.status,200);assert.equal((await release.json()).queued,true);
  });
  await t.test('DMIT 备用公告同时提供推广购买链接和官方公告链接',async()=>{
    const global=(await mf.getDurableObjectNamespace('GUARD_STATE')).getByName('admin');await global.monitorDmit();assert.ok(!calls.some(x=>x.method==='sendMessage'&&x.params.chat_id==='@jason_vps_deal'));
    officialPostId=9877;await global.monitorDmit();
    const pushed=calls.find(x=>x.method==='sendMessage'&&x.params.chat_id==='@jason_vps_deal');assert.ok(pushed);
    const buttons=pushed.params.reply_markup.inline_keyboard.flat();
    assert.equal(buttons[0].url,'https://bot.jasonselect.com/go/dmit');assert.equal(buttons[1].url,'https://t.me/DMIT_INC/9877');
    const buy=await mf.dispatchFetch('https://bot.test/go/dmit',{redirect:'manual',headers:{'User-Agent':'Mozilla/5.0 (iPhone)'}});assert.equal(buy.status,302);assert.equal(new URL(buy.headers.get('location')).searchParams.get('aff'),'16962');
    const count=calls.filter(x=>x.method==='sendMessage'&&x.params.chat_id==='@jason_vps_deal').length;await global.monitorDmit();officialPostId=9875;await global.monitorDmit();assert.equal(calls.filter(x=>x.method==='sendMessage'&&x.params.chat_id==='@jason_vps_deal').length,count);assert.equal((await global.dmitStatus()).sourceType,'official-announcement');
  });

  await t.test('推广短链接：跳转、计数、排除预览程序、周报排行和后台管理',async()=>{
    const login=await mf.dispatchFetch('https://bot.test/admin/api/login',{method:'POST',headers:{Origin:'https://bot.test','Content-Type':'application/json'},body:JSON.stringify({password:'password-for-test'})});
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const request=(path,body)=>mf.dispatchFetch('https://bot.test/admin/api/'+path,{method:body?'POST':'GET',headers:{Cookie:cookie,Origin:'https://bot.test','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    for(const item of [{slug:'坏名字',target:'https://example.com'},{slug:'ok',target:'javascript:alert(1)'},{slug:'ok',target:'http://example.com'}])assert.equal((await request('links/upsert',{item})).status,400);
    const saved=await request('links/upsert',{item:{slug:'BWG',target:'https://bandwagonhost.com/aff.php?aff=1',note:'搬瓦工 <CN2>'}});assert.equal(saved.status,200);
    const data=await saved.json();const bwg=data.links.find(x=>x.slug==='bwg');assert.equal(bwg.url,'https://bot.jasonselect.com/go/bwg');assert.equal(bwg.week,0);
    await request('links/upsert',{item:{slug:'rn',target:'https://racknerd.com/aff.php?aff=2',note:'RackNerd'}});
    const open=(slug,agent,ip)=>mf.dispatchFetch('https://bot.test/go/'+slug,{redirect:'manual',headers:{'User-Agent':agent,'CF-Connecting-IP':ip}});
    const first=await open('bwg','Mozilla/5.0 (iPhone)','1.1.1.1');assert.equal(first.status,302);assert.equal(first.headers.get('location'),'https://bandwagonhost.com/aff.php?aff=1');
    await open('bwg','Mozilla/5.0 (iPhone)','1.1.1.1');await open('BWG','Mozilla/5.0 (Android)','2.2.2.2');await open('rn','Mozilla/5.0 (Mac)','3.3.3.3');
    const preview=await open('bwg','TelegramBot (like TwitterBot)','4.4.4.4');assert.equal(preview.status,302);
    assert.equal((await open('nothing','Mozilla/5.0','1.1.1.1')).status,404);
    const listed=(await (await request('links')).json()).links;const counted=listed.find(x=>x.slug==='bwg');
    assert.equal(counted.today,3);assert.equal(counted.week,3);assert.equal(counted.weekVisitors,2);assert.equal(listed[0].slug,'bwg');assert.equal(listed.find(x=>x.slug==='rn').week,1);
    const admin=(await mf.getDurableObjectNamespace('GUARD_STATE')).getByName('admin');
    const today=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
    const lines=await admin.linkReportLines(today,today);assert.ok(lines[1].includes('推广链接点击'));assert.equal(lines[2],'🥇 搬瓦工 &lt;CN2&gt;：3 次 · 2 人');
    // A link the owner edited by hand is not overwritten by the DMIT monitor.
    await request('links/upsert',{item:{slug:'dmit',target:'https://www.dmit.io/aff.php?aff=777',note:'我的 DMIT'}});
    assert.equal(await admin.autoLink('dmit','https://www.dmit.io/aff.php?aff=16962','DMIT 官网'),'https://bot.jasonselect.com/go/dmit');
    assert.equal((await open('dmit','Mozilla/5.0','5.5.5.5')).headers.get('location'),'https://www.dmit.io/aff.php?aff=777');
    const removed=await request('links/remove',{item:{slug:'rn'}});assert.equal(removed.status,200);assert.ok(!(await removed.json()).links.some(x=>x.slug==='rn'));
    assert.equal((await open('rn','Mozilla/5.0','1.1.1.1')).status,404);
  });
  await t.test('样本默认待审核，启用须预览；短样本和错误票据不能启用',async()=>{
    const global=(await mf.getDurableObjectNamespace('GUARD_STATE')).getByName('admin');
    const login=await mf.dispatchFetch('https://bot.test/admin/api/login',{method:'POST',headers:{Origin:'https://bot.test','Content-Type':'application/json'},body:JSON.stringify({password:'password-for-test'})});const cookie=login.headers.get('set-cookie').split(';')[0];
    const activate=body=>mf.dispatchFetch('https://bot.test/admin/api/samples/activate',{method:'POST',headers:{Cookie:cookie,Origin:'https://bot.test','Content-Type':'application/json'},body:JSON.stringify(body)});
    const sample=(await global.editSample('add',{kind:'text',value:'这个服务器怎么买',label:'预览测试'})).find(x=>x.label==='预览测试');assert.equal(sample.status,'pending');
    const noPreview=await activate({id:sample.id});assert.equal(noPreview.status,400);assert.match((await noPreview.json()).error,/预览/);
    const preview=await global.previewSample(sample.id);assert.ok(preview.matches.length>0);
    const wrong=await activate({id:sample.id,previewToken:'wrong'});assert.equal(wrong.status,400);assert.match((await wrong.json()).error,/预览/);
    const short=(await global.editSample('add',{kind:'text',value:'赚',pending:true})).find(x=>x.value==='赚');assert.equal(short.status,'disabled');
    assert.equal((await global.previewSample(short.id)).eligible,false);
    const shortResult=await activate({id:short.id,previewToken:(await global.previewSample(short.id)).previewToken});assert.equal(shortResult.status,400);assert.match((await shortResult.json()).error,/至少/);
  });
  await t.test('群内样本缓存：启用样本后下一条消息立即生效，群改名后重新登记',async()=>{
    const global=(await mf.getDurableObjectNamespace('GUARD_STATE')).getByName('admin');
    await send(update(-183,'先发一条普通消息填充缓存',{from:{id:91,first_name:'普通成员'}}));await tick(-183);
    assert.ok(!actions(-183).some(x=>x.method==='banChatMember'));
    const sample=(await global.editSample('add',{kind:'text',value:'缓存失效样本文案',label:'缓存测试'})).find(x=>x.label==='缓存测试');
    await global.editSample('activate',{id:sample.id,previewToken:(await global.previewSample(sample.id)).previewToken});
    await send(update(-183,'缓存失效样本文案',{from:{id:92,first_name:'样本发送者'}}));await tick(-183);
    assert.ok(actions(-183).some(x=>x.method==='banChatMember'&&x.params.user_id===92));
    await send(update(-183,'改名后的消息',{chat:{id:-183,type:'supergroup',title:'改名后的测试群'},from:{id:91,first_name:'普通成员'}}));await tick(-183);
    assert.equal((await global.listChats()).find(x=>x.id==='-183').title,'改名后的测试群');
  });
  await t.test('明确黑名单词命中直接封号，带联系方式仍直接封号',async()=>{
    const plain=update(-185,'我周末兼职做家教',{from:{id:93,first_name:'普通成员'}});await send(plain);await tick(-185);
    assert.ok(actions(-185).some(x=>x.method==='deleteMessage'&&x.params.message_id===plain.message.message_id));
    assert.ok(actions(-185).some(x=>x.method==='banChatMember'&&x.params.user_id===93));
    await send(update(-185,'兼职日结 私聊我',{from:{id:94,first_name:'广告号'}}));await tick(-185);
    assert.ok(actions(-185).some(x=>x.method==='banChatMember'&&x.params.user_id===94));
  });
  await t.test('联防各群独立执行，失败不挡其他群；撤销停用命中样本并取消未执行封禁',async()=>{
    const ns=await mf.getDurableObjectNamespace('GUARD_STATE'),global=ns.getByName('admin');
    for(const id of [-180,-181,-182])await global.setFederation(id,true);
    const sample=(await global.editSample('add',{kind:'text',value:'联防纠错样本文案',label:'纠错测试'})).find(x=>x.label==='纠错测试');
    await global.editSample('activate',{id:sample.id,previewToken:(await global.previewSample(sample.id)).previewToken});
    failures.set('banChatMember:-181',{error_code:500,description:'target fails'});
    await send(update(-180,'联防纠错样本文案',{from:{id:87,first_name:'样本发送者'}}));await tick(-180);await tick(-181);await tick(-182);
    const record=(await global.listCases()).find(x=>x.sourceChatId==='-180');assert.ok(record);
    assert.equal(record.groups.find(x=>x.chatId==='-181').status,'retrying');assert.equal(record.groups.find(x=>x.chatId==='-182').status,'success');
    assert.equal(record.groups.find(x=>x.chatId==='-180').status,'success');
    await global.reverseCase(record.id);await tick(-180,true);await tick(-181,true);await tick(-182,true);
    assert.equal((await global.listSamples()).find(x=>x.id===sample.id).status,'disabled');
    assert.ok(actions(-180).some(x=>x.method==='unbanChatMember'&&x.params.user_id===87));assert.ok(actions(-182).some(x=>x.method==='unbanChatMember'&&x.params.user_id===87));
    assert.equal(actions(-181).filter(x=>x.method==='banChatMember'&&x.params.user_id===87).length,1);
    await global.reverseCase(record.id);await tick(-180,true);assert.equal(actions(-180).filter(x=>x.method==='unbanChatMember'&&x.params.user_id===87).length,1);
  });
  await t.test('已有独立封禁不能被联防纠错解封',async()=>{
    const ns=await mf.getDurableObjectNamespace('GUARD_STATE'),global=ns.getByName('admin');
    await global.setFederation(-183,true);
    await send(update(-183,'兼职 私聊我',{from:{id:88,first_name:'原已封禁用户'}}));await tick(-183);
    const record=(await global.listCases()).find(x=>x.sourceChatId==='-183');assert.ok(record);
    await global.reverseCase(record.id);await tick(-183,true);
    assert.ok(!actions(-183).some(x=>x.method==='unbanChatMember'&&x.params.user_id===88));
  });

  await t.test('只重试失败联防群；后续手动封禁不被旧记录撤销',async()=>{
    const ns=await mf.getDurableObjectNamespace('GUARD_STATE'),global=ns.getByName('admin');await global.setFederation(-184,true);
    failures.set('banChatMember:-181',{error_code:403,description:'permission missing'});
    await send(update(-184,'兼职 私聊我',{from:{id:89,first_name:'待处理用户'}}));await tick(-184);await tick(-181);await tick(-182);
    const record=(await global.listCases()).find(x=>x.sourceChatId==='-184');assert.equal(record.groups.find(x=>x.chatId==='-181').status,'failed');
    await global.retryCase(record.id,'-181');await tick(-181,true);
    assert.equal((await global.listCases()).find(x=>x.id===record.id).groups.find(x=>x.chatId==='-181').status,'success');
    assert.equal(actions(-184).filter(x=>x.method==='banChatMember'&&x.params.user_id===89).length,1);
    await send(update(-184,'/ban 89',{from:{id:99}}));await tick(-184);
    await global.reverseCase(record.id);await tick(-184,true);assert.ok(!actions(-184).some(x=>x.method==='unbanChatMember'&&x.params.user_id===89));
    assert.deepEqual(await global.federationTargets('-199'),[]);
  });

  await t.test('日报按实际步骤去重统计联防封禁、广告账号和成功撤销',async()=>{
    const ns=await mf.getDurableObjectNamespace('GUARD_STATE'),group=ns.getByName('chat:-190');
    await group.seedLogTest({updateId:'job1',userId:77,action:'federation-ban',outcome:'retrying',steps:[{method:'banChatMember',done:true}]});
    await group.seedLogTest({updateId:'job1',userId:77,action:'federation-ban',outcome:'success',steps:[{method:'banChatMember',done:true}]});
    await group.seedLogTest({updateId:'job2',userId:77,action:'delete-and-permanent-ban',outcome:'success',steps:[{method:'deleteMessage',done:true},{method:'banChatMember',done:true}]});
    await group.seedLogTest({updateId:'job3',userId:78,action:'federation-ban',outcome:'partial',steps:[{method:'banChatMember',done:true,skipped:'管理员'}]});
    await group.seedLogTest({updateId:'job4',action:'federation-undo',outcome:'success',steps:[{method:'case-unban',done:true,undoOutcome:'skipped'}]});
    await group.seedLogTest({updateId:'job5',action:'federation-undo',outcome:'success',steps:[{method:'case-unban',done:true,undoOutcome:'success'}]});
    await group.seedLogTest({updateId:'yesterday',userId:79,action:'federation-ban',outcome:'success',steps:[{method:'banChatMember',done:true,doneAt:Date.now()-86400000}]});
    const stats=await group.dailySummary(Date.now()-60000,Date.now()+1000);assert.equal(stats.banned,2);assert.deepEqual(stats.adUsers,['77']);assert.equal(stats.reversals,1);assert.equal(stats.intercepted,1);assert.equal(stats.retries,1);
  });
  await t.test('日报部分接收人失败，仅重试未送达者，成功后停止重发',async()=>{
    const ns=await mf.getDurableObjectNamespace('GUARD_STATE'),global=ns.getByName('admin');await global.seedRecordTest('test:owners',['99','100']);
    const now=Date.parse('2026-09-28T01:00:00Z'),start=calls.length;
    failures.set('sendMessage:100',{error_code:500,description:'recipient temporarily unavailable',onlyText:'群防日报'});
    assert.deepEqual(await Promise.all([global.sendDailyReport(now),global.sendDailyReport(now)]),[false,false]);assert.equal(await global.sendDailyReport(now+3600000),true);assert.equal(await global.sendDailyReport(now+3600000),false);
    const sent=calls.slice(start).filter(x=>x.method==='sendMessage'&&x.params.text.includes('群防日报'));
    assert.equal(sent.filter(x=>x.params.chat_id===99).length,1);assert.equal(sent.filter(x=>x.params.chat_id===100).length,2);
    assert.equal(sent.find(x=>x.params.chat_id===99).params.text,sent.filter(x=>x.params.chat_id===100).at(-1).params.text);
    await global.seedRecordTest('test:owners',['99']);
  });
  await t.test('OCR 固定窗口、超额提醒去重、缓存不占额度，过期可恢复',async()=>{
    const ns=await mf.getDurableObjectNamespace('GUARD_STATE'),group=ns.getByName('chat:-191');const resetAt=Date.now()+3600000;
    await group.seedRecordTest('ocr:quota:-191',{used:29,resetAt},3600000);
    const msg={chat:{id:-191,title:'OCR测试群'},message_id:1,photo:[{file_id:'test',file_unique_id:'quota-test',file_size:12000}]};
    assert.equal(await group.realOcrTest(msg),'广告图片测试');const quota=await group.ocrQuota(-191);assert.equal(quota.used,30);assert.equal(quota.resetAt,resetAt);assert.equal(quota.remaining,0);
    assert.equal(await group.realOcrTest(msg),'广告图片测试');assert.equal((await group.ocrQuota(-191)).used,30);
    const before=calls.length;const other={...msg,photo:[{...msg.photo[0],file_unique_id:'quota-other'}]};assert.equal(await group.realOcrTest(other),'');assert.equal(await group.realOcrTest(other),'');
    assert.equal(calls.slice(before).filter(x=>x.method==='sendMessage'&&x.params.text.includes('OCR 图片识别额度已用完')).length,1);
    assert.equal((await group.dailySummary(Date.now()-60000,Date.now()+1000)).ocrSkipped,2);
    await group.seedRecordTest('ocr:quota:-191',{used:30,resetAt:Date.now()-1000});assert.equal((await group.ocrQuota(-191)).remaining,30);
    assert.equal(await group.realOcrTest(other),'广告图片测试');assert.equal((await group.ocrQuota(-191)).used,1);
  });
  await t.test('联防搜索可分页，群和状态必须匹配同一目标，更新不破坏游标',async()=>{
    const ns=await mf.getDurableObjectNamespace('GUARD_STATE'),global=ns.getByName('admin');
    for(let i=0;i<55;i++)await global.ensureCase({id:'page-'+i,userId:200,chatId:'-192',federationTargets:['-193']});
    await global.caseStatus('page-0','-193',{status:'failed'});
    const page=await global.searchCases({userId:'200'});assert.equal(page.cases.length,50);assert.ok(page.next);
    await global.caseStatus('page-0','-192',{status:'success'});
    const last=await global.searchCases({userId:'200',before:page.next});assert.equal(last.cases.length,5);assert.equal(last.next,null);assert.equal(new Set([...page.cases,...last.cases].map(x=>x.id)).size,55);
    assert.equal((await global.searchCases({userId:'200',chatId:'-192',status:'failed'})).cases.length,0);
    assert.equal((await global.searchCases({userId:'200',chatId:'-193',status:'failed'})).cases[0].id,'page-0');
  });
  await t.test('人工确认案例脱敏后参与预览，删除案例后结果同步变化',async()=>{
    const ns=await mf.getDurableObjectNamespace('GUARD_STATE'),global=ns.getByName('admin');
    const sample=(await global.editSample('add',{kind:'text',value:'测试案例重复短语'})).find(x=>x.value==='测试案例重复短语');
    const examples=await global.editReviewExample('add',{confirmed:true,verdict:'normal',text:'正常讨论测试案例重复短语 @testuser 13812345678 abc@example.com https://example.com/private?token=secret'});
    const normal=examples[0];assert.ok(!normal.text.includes('testuser'));assert.ok(!normal.text.includes('13812345678'));assert.ok(!normal.text.includes('abc@'));assert.ok(!normal.text.includes('secret'));
    await global.editReviewExample('add',{confirmed:true,verdict:'advertisement',text:'测试案例重复短语这是广告'});
    const preview=await global.previewSample(sample.id);assert.equal(preview.cases.length,2);assert.ok(preview.cases.every(x=>x.matched));
    await global.editReviewExample('remove',{id:normal.id});assert.equal((await global.previewSample(sample.id)).cases.length,1);
  });

  await t.test('案例与搜索后台接口验证输入和登录权限',async()=>{
    const login=await mf.dispatchFetch('https://bot.test/admin/api/login',{method:'POST',headers:{'Origin':'https://bot.test','Content-Type':'application/json'},body:JSON.stringify({password:'password-for-test'})});
    const cookie=login.headers.get('Set-Cookie').split(';')[0];
    const add=body=>mf.dispatchFetch('https://bot.test/admin/api/review-examples/add',{method:'POST',headers:{Origin:'https://bot.test',Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(body)});
    assert.equal((await add({verdict:'normal',text:'这是正常测试消息',confirmed:false})).status,400);
    const created=await add({verdict:'normal',text:'测试正常消息 '.repeat(300),confirmed:true});assert.equal(created.status,200);
    const unauthorized=await mf.dispatchFetch('https://bot.test/admin/api/review-examples');assert.equal(unauthorized.status,401);
    const invalid=await mf.dispatchFetch('https://bot.test/admin/api/federation/cases?status=unknown',{headers:{Cookie:cookie}});assert.equal(invalid.status,400);
    const page=await mf.dispatchFetch('https://bot.test/admin/api/federation/cases?userId=200',{headers:{Cookie:cookie}});assert.equal(page.status,200);assert.equal((await page.json()).cases.length,50);
  });

  await t.test('试运行仅观察；去重命中、域名试运行、正式启用不影响现有拦截',async()=>{
    const ns=await mf.getDurableObjectNamespace('GUARD_STATE'),group=ns.getByName('chat:-196');
    const trial=(await group.editTrial('add',{kind:'keyword',value:'观察词'})).trials[0];
    const msg=update(-196,'技术讨论观察词');await send(msg);await send(msg);await tick(-196);
    assert.equal(actions(-196).filter(x=>['deleteMessage','banChatMember'].includes(x.method)).length,0);
    assert.equal((await group.listTrials())[0].hits,1);
    await group.editTrial('add',{kind:'domain',value:'trial-only.example'});await send(update(-196,'官网 https://trial-only.example 怎么用'));await tick(-196);
    assert.equal((await group.listTrials()).find(x=>x.kind==='domain').hits,1);
    assert.equal(actions(-196).filter(x=>x.method==='deleteMessage').length,0);
    await send(update(-196,'官网入口',{entities:[{type:'text_link',offset:0,length:4,url:'https://trial-only.example/private'}]}));await tick(-196);assert.equal((await group.listTrials()).find(x=>x.kind==='domain').hits,2);
    await send(update(-196,'兼职 私聊我'));await tick(-196);assert.equal(actions(-196).filter(x=>x.method==='banChatMember').length,1);
    await group.editTrial('promote',{id:trial.id});const promoted=update(-196,'再聊观察词');await send(promoted);await tick(-196);
    // Promoted blacklist words delete and ban immediately.
    assert.ok(actions(-196).some(x=>x.method==='deleteMessage'&&x.params.message_id===promoted.message.message_id));assert.equal(actions(-196).filter(x=>x.method==='banChatMember').length,2);
    assert.ok((await group.config()).keywords.includes('观察词'));
    await group.editTrial('add',{kind:'keyword',value:'渠道正品'});await send(update(-196,'',{photo:[{file_id:'trial-ocr',file_unique_id:'trial-ocr-unique',file_size:12000}]}));await tick(-196);assert.equal((await group.listTrials()).find(x=>x.value==='渠道正品').hits,1);
  });
  await t.test('完整备份可预览恢复、保留回退包和稳定样本 ID；部分失败可续作',async()=>{
    const ns=await mf.getDurableObjectNamespace('GUARD_STATE'),global=ns.getByName('admin');const exported=await global.backupTest();assert.ok(exported.backup,exported.error);const backup=exported.backup;
    assert.ok(backup.groups.length>0);assert.ok(!JSON.stringify(backup).includes('fake'));assert.ok(!Object.hasOwn(backup,'session'));
    const target=backup.groups[0];target.config.keywords.push('备份恢复测试词');
    const original=await ns.getByName('chat:'+target.id).config();const preview=await global.previewBackup(backup);assert.ok(preview.groups.some(x=>x.id===target.id));
    assert.ok(!(await ns.getByName('chat:'+target.id).config()).keywords.includes('备份恢复测试词'));
    const sampleBefore=(await global.listSamples()).map(x=>[x.kind,x.value,x.id]);
    await ns.getByName('chat:'+backup.groups[1].id).seedRecordTest('test:restore-fail',true);
    const login=await mf.dispatchFetch('https://bot.test/admin/api/login',{method:'POST',headers:{Origin:'https://bot.test','Content-Type':'application/json'},body:JSON.stringify({password:'password-for-test'})});const cookie=login.headers.get('set-cookie').split(';')[0];
    const restore=()=>mf.dispatchFetch('https://bot.test/admin/api/backup/restore',{method:'POST',headers:{Origin:'https://bot.test',Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({token:preview.token})});
    assert.equal((await restore()).status,400);assert.ok(await global.lastRollback());
    const completed=await restore();assert.equal(completed.status,200);assert.equal((await completed.json()).complete,true);
    assert.ok((await ns.getByName('chat:'+target.id).config()).keywords.includes('备份恢复测试词'));
    assert.deepEqual((await global.listSamples()).map(x=>[x.kind,x.value,x.id]),sampleBefore);
    assert.deepEqual(JSON.parse(JSON.stringify((await global.lastRollback()).groups.find(x=>x.id===target.id).config)),JSON.parse(JSON.stringify(original)));
    assert.equal((await restore()).status,200);
    const audit=await global.listAudit();assert.ok(audit.entries.some(x=>x.action==='backup/restore'&&x.status==='failed'));assert.ok(audit.entries.some(x=>x.action==='backup/restore'&&x.status==='success'));
  });
  await t.test('恢复预览后配置发生变化会拒绝覆盖，审计可查看具体字段差异',async()=>{
    const ns=await mf.getDurableObjectNamespace('GUARD_STATE'),global=ns.getByName('admin');const exported=await global.backupTest();assert.ok(exported.backup,exported.error);const backup=exported.backup;const preview=await global.previewBackup(backup);
    const login=await mf.dispatchFetch('https://bot.test/admin/api/login',{method:'POST',headers:{Origin:'https://bot.test','Content-Type':'application/json'},body:JSON.stringify({password:'password-for-test'})});const cookie=login.headers.get('set-cookie').split(';')[0];
    const request=(path,body)=>mf.dispatchFetch('https://bot.test/admin/api/'+path,{method:body?'POST':'GET',headers:{Origin:'https://bot.test',Cookie:cookie,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    const chatId=backup.groups[0].id;assert.equal((await request('keywords/add',{chatId,word:'预览后新修改词'})).status,200);
    const stale=await request('backup/restore',{token:preview.token});assert.equal(stale.status,400);assert.match((await stale.json()).error,/配置已变化/);
    const audits=(await (await request('audit')).json()).entries;const entry=audits.find(x=>x.action==='keywords/add'&&x.status==='success');assert.ok(entry.changes.some(x=>x.field==='keywords'&&x.after.includes('预览后新修改词')));
    assert.match(entry.actor,/^session:[a-f0-9]{12}$/);assert.ok(!JSON.stringify(audits).includes('password-for-test'));
    assert.equal((await mf.dispatchFetch('https://bot.test/admin/api/backup/export')).status,401);
  });
  await t.test('异常与恢复只提醒一次，未来到期任务不误报积压，Webhook 异常可自动检查',async()=>{
    const ns=await mf.getDurableObjectNamespace('GUARD_STATE'),global=ns.getByName('admin'),start=calls.length;
    await global.checkIncident('test-transition',true,'测试权限异常');await global.checkIncident('test-transition',true,'测试权限异常');await global.checkIncident('test-transition',false,'测试权限恢复');await global.checkIncident('test-transition',false,'测试权限恢复');
    const reminders=calls.slice(start).filter(x=>x.method==='sendMessage'&&x.params.text.includes('测试权限'));assert.equal(reminders.length,2);assert.equal((await global.incidentList()).find(x=>x.id==='test-transition').active,false);
    await global.register({id:'-197',title:'未来到期测试群'});await ns.getByName('chat:-197').seedFutureJobTest();assert.equal((await ns.getByName('chat:-197').healthSummary()).overdueSeconds,0);
    botPermissionsHealthy=true;webhookState={url:'https://bot.test/webhook/path',pending_update_count:5,last_error_date:Math.floor(Date.now()/1000)};
    await global.monitorOperations(true);assert.ok((await global.incidentList()).find(x=>x.id==='webhook').active);assert.ok(!(await global.incidentList()).some(x=>x.id==='queue--197'&&x.active));
    webhookState={url:'https://bot.test/webhook/path',pending_update_count:0};await global.monitorOperations(true);assert.equal((await global.incidentList()).find(x=>x.id==='webhook').active,false);
  });

  await t.test('Telegram 自检偶发服务错误复查后不报警，持续失败保留具体接口和错误码',async()=>{
    const global=(await mf.getDurableObjectNamespace('GUARD_STATE')).getByName('admin');
    failures.set('getWebhookInfo:undefined',{error_code:503,description:'temporary connection failure'});
    let start=calls.length;await global.monitorOperations(true);
    assert.equal(calls.slice(start).filter(x=>x.method==='getWebhookInfo').length,2);
    assert.ok(!(await global.incidentList()).some(x=>x.id==='telegram-api'&&x.active));
    failures.set('getWebhookInfo:undefined',[{error_code:503,description:'connection timed out'},{error_code:503,description:'connection timed out'}]);
    await global.monitorOperations(true);let incident=(await global.incidentList()).find(x=>x.id==='telegram-api');assert.equal(incident.active,true);assert.match(incident.details,/503/);assert.match(incident.details,/getWebhookInfo/);assert.match(incident.details,/connection timed out/);
    await global.monitorOperations(true);assert.equal((await global.incidentList()).find(x=>x.id==='telegram-api').active,false);
    failures.set('getMe:undefined',{error_code:401,description:'Unauthorized'});start=calls.length;await global.monitorOperations(true);
    assert.equal(calls.slice(start).filter(x=>x.method==='getMe').length,1);assert.match((await global.incidentList()).find(x=>x.id==='telegram-api').details,/401/);
    await global.monitorOperations(true);
  });
  await t.test('部分恢复后的新修改阻止旧任务续作；批量静默审计只记录相关字段',async()=>{
    const ns=await mf.getDurableObjectNamespace('GUARD_STATE'),global=ns.getByName('admin'),exported=await global.backupTest();assert.ok(exported.backup,exported.error);const backup=exported.backup;
    backup.groups[0].config.keywords.push('续作冲突测试词');const preview=await global.previewBackup(backup),target=backup.groups[1];await ns.getByName('chat:'+target.id).seedRecordTest('test:restore-fail',true);
    const login=await mf.dispatchFetch('https://bot.test/admin/api/login',{method:'POST',headers:{Origin:'https://bot.test','Content-Type':'application/json'},body:JSON.stringify({password:'password-for-test'})});const cookie=login.headers.get('set-cookie').split(';')[0];
    const restore=()=>mf.dispatchFetch('https://bot.test/admin/api/backup/restore',{method:'POST',headers:{Origin:'https://bot.test',Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({token:preview.token})});
    assert.equal((await restore()).status,400);await ns.getByName('chat:'+target.id).editWord('add','部分恢复后新词');assert.equal((await restore()).status,400);assert.ok((await ns.getByName('chat:'+target.id).config()).keywords.includes('部分恢复后新词'));
    const quiet=await global.auditSnapshot('quiet',{scope:'all'});assert.ok(quiet['quiet:'+target.id]);assert.deepEqual(Object.keys(quiet['quiet:'+target.id]).sort(),['quietEnabled','quietEnd','quietEndNoticeMinutes','quietNotify','quietStart']);
  });

  await t.test('AI 确认广告永久封禁，正常内容放行，服务失败待审，黑名单不等待 AI',async()=>{
    const ns=await mf.getDurableObjectNamespace('GUARD_STATE');
    for(const [chatId,mock,expected] of [
      [-301,{decision:'ad',confidence:0.99,reason:'明确招揽',evidence:['招募代理']},'banChatMember'],
      [-302,{decision:'normal',confidence:0.99,reason:'正常讨论',evidence:[]},null],
      [-303,{fail:true},null],
      [-304,{decision:'ad',confidence:0.8,reason:'不确定',evidence:['招募代理']},null],
    ]){
      const group=ns.getByName('chat:'+chatId);await group.seedRecordTest('test:ai',mock);
      await send(update(chatId,'最近有招募代理的消息，大家怎么看？'));const {data}=await tick(chatId);
      assert.equal(actions(chatId).some(x=>x.method==='banChatMember'),expected==='banChatMember');
      if(mock.fail||mock.confidence===0.8)assert.ok(data.logs.some(x=>x.action==='review'&&x.aiReview));
      const input=await group.readRecordTest('test:ai-input');assert.deepEqual(Object.keys(JSON.parse(input.messages[1].content)),['message']);
      assert.ok(!input.messages[1].content.includes('测试用户'));
    }
    const group=ns.getByName('chat:-305');await group.seedRecordTest('test:ai',{fail:true});
    await send(update(-305,'USDT'));await tick(-305);assert.ok(actions(-305).some(x=>x.method==='banChatMember'));assert.equal(await group.readRecordTest('test:ai-calls'),null);
  });
  await t.test('AI 缓存按正文区分，修改后的消息重新判断，群与全局额度均生效',async()=>{
    const ns=await mf.getDurableObjectNamespace('GUARD_STATE'),group=ns.getByName('chat:-306'),global=ns.getByName('admin');
    const mock={decision:'normal',confidence:0.99,reason:'正常',evidence:[]};await group.seedRecordTest('test:ai',mock);
    const msg={chat:{id:-306},message_id:1};await group.reviewWithAi(msg,'如何讨论优惠？');await group.reviewWithAi(msg,'如何讨论优惠？');assert.equal(await group.readRecordTest('test:ai-calls'),1);
    await group.reviewWithAi(msg,'代理技术交流内容');assert.equal(await group.readRecordTest('test:ai-calls'),2);
    const hour=Math.floor(Date.now()/3600000);await group.seedRecordTest('ai:quota:'+hour,20);assert.equal((await group.reviewWithAi({...msg,message_id:2},'新的优惠讨论内容')).decision,'quota');
    await group.seedRecordTest('ai:quota:'+hour,0);await global.seedRecordTest('ai:global-quota:'+hour,100);
    assert.equal((await group.reviewWithAi({...msg,message_id:3},'又一条优惠内容')).decision,'quota');assert.equal(await group.readRecordTest('test:ai-calls'),2);
    await global.seedRecordTest('ai:global-quota:'+hour,0);
  });
  await t.test('每周备份首次立即生成、周一三点轮换、失败重试且校验损坏文件',async()=>{
    const ns=await mf.getDurableObjectNamespace('GUARD_STATE'),global=ns.getByName('admin');
    const now=Date.parse('2026-10-11T12:00:00Z');await global.runAutomaticBackup(now);
    let status=await global.automaticBackupStatus();assert.equal(status.last.outcome,'success');assert.equal(status.backups[0].id,'2026-10-05');
    const id=status.backups[0].id,backup=await global.automaticBackup(id);assert.ok(backup.groups.length);assert.ok(!JSON.stringify(backup).includes('password-for-test'));
    await global.runAutomaticBackup(now+1000);assert.equal((await global.automaticBackupStatus()).backups.length,1);
    await global.runAutomaticBackup(Date.parse('2026-10-11T18:59:59Z'));assert.equal((await global.automaticBackupStatus()).backups.length,1);
    await global.seedRecordTest('test:backup-fail',true);const next=Date.parse('2026-10-11T19:00:00Z');await global.runAutomaticBackup(next);assert.equal((await global.automaticBackupStatus()).last.outcome,'failed');
    await global.seedRecordTest('test:backup-fail',false);await global.runAutomaticBackup(next+1000);assert.equal((await global.automaticBackupStatus()).backups.length,1);
    await global.runAutomaticBackup(next+15*60000);assert.equal((await global.automaticBackupStatus()).backups[0].id,'2026-10-12');
    for(let i=1;i<=8;i++)await global.runAutomaticBackup(next+i*7*86400000);
    status=await global.automaticBackupStatus();assert.equal(status.backups.length,8);assert.equal(status.backups[0].id,'2026-12-07');
    const latest=status.backups[0].id;await kv.put('automatic-backup:'+latest,JSON.stringify({...backup,created:'tampered'}));assert.match((await global.automaticBackupTest(latest)).error,/校验失败/);
    for(const path of ['backup/status','backup/automatic?id='+latest])assert.equal((await mf.dispatchFetch('https://bot.test/admin/api/'+path)).status,401);
    const login=await mf.dispatchFetch('https://bot.test/admin/api/login',{method:'POST',headers:{Origin:'https://bot.test','Content-Type':'application/json'},body:JSON.stringify({password:'password-for-test'})});const cookie=login.headers.get('set-cookie').split(';')[0];
    const save=await mf.dispatchFetch('https://bot.test/admin/api/ai-review',{method:'POST',headers:{Origin:'https://bot.test',Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({chatId:-306,enabled:false})});assert.equal(save.status,200);assert.equal((await save.json()).config.aiReviewEnabled,false);
  });

  await t.test('全网黑名单账号入群即封禁，所有者收到带撤销按钮的通知，撤销后解封并加白', async () => {
    const join={update_id:++seq,message:{message_id:7001,date:Math.floor(Date.now()/1000),chat:{id:-401,type:'supergroup',title:'CAS群'},from:{id:666,first_name:'广告号'},new_chat_members:[{id:666,first_name:'广告<号>',username:'Spam_Acc'}]}};
    await send(join);const {data}=await tick(-401);
    assert.ok(actions(-401).some(x=>x.method==='banChatMember'&&x.params.user_id===666));
    assert.ok(actions(-401).some(x=>x.method==='deleteMessage'&&x.params.message_id===7001));
    assert.equal(data.logs[0].action,'cas-permanent-ban');
    const notice=calls.findLast(c=>c.method==='sendMessage'&&c.params.chat_id===99&&c.params.text.includes('已封禁'));
    assert.ok(notice);assert.match(notice.params.text,/全网广告号黑名单/);
    assert.equal(notice.params.parse_mode,'HTML');
    assert.ok(notice.params.text.includes('<a href="tg://user?id=666">广告&lt;号&gt;</a> <a href="https://t.me/spam_acc">@spam_acc</a>'));
    assert.deepEqual(notice.params.reply_markup.inline_keyboard[0],[{text:'👤 查看用户资料',url:'https://t.me/spam_acc'}]);
    const data2=notice.params.reply_markup.inline_keyboard[1][0].callback_data;assert.match(data2,/^n:[a-f0-9]{16}:undo$/);
    const info={callback_data:data2.replace(/:undo$/,':info')};
    await send({update_id:++seq,callback_query:{id:'cb-info',from:{id:99},data:info.callback_data,message:{message_id:1,chat:{id:99,type:'private'},text:notice.params.text}}});
    const card=calls.findLast(c=>['sendMessage','sendPhoto'].includes(c.method)&&c.params.chat_id===99&&(c.params.text||c.params.caption||'').startsWith('👤'));
    assert.ok(card);const body=card.params.text||card.params.caption;assert.ok(body.includes('https://t.me/spam_acc'));assert.match(body,/全网广告号黑名单/);assert.match(body,/因广告被封/);
    assert.ok(calls.some(c=>c.method==='answerCallbackQuery'&&c.params.callback_query_id==='cb-info'&&c.params.text==='资料已发送'));
    const before=calls.length;
    await send({update_id:++seq,message:{message_id:++seq,date:Math.floor(Date.now()/1000),chat:{id:99,type:'private'},from:{id:99},text:'看看',reply_to_message:{message_id:1,from:{id:555,is_bot:true},chat:{id:99,type:'private'},text:'🚫 已封禁：广告<号> @spam_acc（666）\n群：CAS群\n原因：全网广告号黑名单'}}});
    const viaReply=calls.slice(before).find(c=>['sendMessage','sendPhoto'].includes(c.method)&&c.params.chat_id===99&&(c.params.text||c.params.caption||'').startsWith('👤'));
    assert.ok(viaReply&&(viaReply.params.text||viaReply.params.caption).includes('因广告被封'));
    const before2=calls.length;
    await send({update_id:++seq,message:{message_id:++seq,date:Math.floor(Date.now()/1000),chat:{id:99,type:'private'},from:{id:99},text:'/who 666'}});
    assert.ok(calls.slice(before2).some(c=>['sendMessage','sendPhoto'].includes(c.method)&&c.params.chat_id===99&&(c.params.text||c.params.caption||'').includes('全网广告号黑名单')));
    const stranger=await send({update_id:++seq,callback_query:{id:'cb-x',from:{id:5,first_name:'路人'},data:data2,message:{message_id:1,chat:{id:5,type:'private'},text:notice.params.text}}});assert.equal(stranger.status,200);
    assert.ok(calls.some(c=>c.method==='answerCallbackQuery'&&c.params.callback_query_id==='cb-x'&&/所有者/.test(c.params.text)));
    assert.ok(!actions(-401).some(x=>x.method==='unbanChatMember'));
    await send({update_id:++seq,callback_query:{id:'cb-undo',from:{id:99,first_name:'主人'},data:data2,message:{message_id:2,chat:{id:99,type:'private'},text:notice.params.text}}});
    await tick(-401);
    assert.ok(actions(-401).some(x=>x.method==='unbanChatMember'&&x.params.user_id===666));
    assert.ok(calls.some(c=>c.method==='answerCallbackQuery'&&c.params.callback_query_id==='cb-undo'&&c.params.text.includes('正在处理')));
    const edits=calls.filter(c=>c.method==='editMessageText'&&c.params.chat_id===99&&c.params.message_id===444);
    assert.ok(edits.some(c=>c.params.text.includes('已撤销封禁并信任此人（主人')&&c.params.text.includes('正在解封')&&!JSON.stringify(c.params.reply_markup).includes(':undo')));
    assert.ok(edits.at(-1).params.text.includes('解封成功')&&!edits.at(-1).params.text.includes('正在解封'));
    assert.equal(await (await mf.getDurableObjectNamespace('GUARD_STATE')).getByName('chat:-401').readRecordTest('verification-pass:666'),true);
    const state=await mf.getDurableObjectNamespace('GUARD_STATE');assert.equal(await state.getByName('chat:-401').readRecordTest('allow:666'),true);
    await send({update_id:++seq,callback_query:{id:'cb-again',from:{id:99},data:data2,message:{message_id:2,chat:{id:99,type:'private'}}}});
    assert.ok(calls.some(c=>c.method==='answerCallbackQuery'&&c.params.callback_query_id==='cb-again'&&/已经处理过/.test(c.params.text)));
  });
  await t.test('Webhook 漏收按钮点击时自动补上，并通知所有者', async () => {
    const global=(await mf.getDurableObjectNamespace('GUARD_STATE')).getByName('admin');
    webhookState={...webhookState,allowed_updates:['message','edited_message','my_chat_member']};
    const result=await global.ensureWebhookUpdates();
    assert.deepEqual(result.fixed,['callback_query','chat_join_request','chat_member']);
    const set=calls.findLast(c=>c.method==='setWebhook');
    assert.equal(set.params.url,'https://bot.test/webhook/path');assert.equal(set.params.secret_token,'verify');
    assert.ok(set.params.allowed_updates.includes('callback_query')&&set.params.allowed_updates.includes('message'));
    assert.ok(calls.some(c=>c.method==='sendMessage'&&c.params.chat_id===99&&c.params.text.includes('callback_query')));
    const count=calls.filter(c=>c.method==='setWebhook').length;assert.equal(await global.ensureWebhookUpdates(),null);assert.equal(calls.filter(c=>c.method==='setWebhook').length,count);
    webhookState={url:'https://bot.test/webhook/path',pending_update_count:0};
  });
  await t.test('解封失败时通知上写明失败原因', async () => {
    const join={update_id:++seq,message:{message_id:7101,date:Math.floor(Date.now()/1000),chat:{id:-405,type:'supergroup',title:'失败群'},from:{id:666,first_name:'广告号'},new_chat_members:[{id:666,first_name:'广告号'}]}};
    await send(join);await tick(-405);
    const notice=calls.findLast(c=>c.method==='sendMessage'&&c.params.chat_id===99&&c.params.text.includes('失败群'));
    failures.set('unbanChatMember:-405',{error_code:400,description:'Bad Request: not enough rights'});
    await send({update_id:++seq,callback_query:{id:'cb-fail',from:{id:99,first_name:'主人'},data:notice.params.reply_markup.inline_keyboard[1][0].callback_data,message:{message_id:444,chat:{id:99,type:'private'},text:notice.params.text}}});
    await tick(-405);
    assert.ok(calls.findLast(c=>c.method==='editMessageText'&&c.params.chat_id===99).params.text.includes('❌ 解封失败'));
  });
  await t.test('简介含广告的成员发言即删除并封禁；普通成员不受影响', async () => {
    await send(update(-402,'大家好',{from:{id:667,first_name:'小王'}}));await tick(-402);
    assert.ok(actions(-402).some(x=>x.method==='banChatMember'&&x.params.user_id===667));
    const {data}=await tick(-402);assert.equal(data.logs[0].action,'profile-permanent-ban');
    await send(update(-402,'大家好，今天天气不错',{from:{id:668,first_name:'小李'}}));await tick(-402);
    assert.ok(!actions(-402).some(x=>x.params.user_id===668));
  });
  await t.test('群友 /report 私信所有者，点击按钮即删除并封禁；同一消息只通知一次', async () => {
    const target=update(-403,'这条消息有问题',{from:{id:670,first_name:'可疑人'}});await send(target);await tick(-403);
    const report=update(-403,'/report 发广告',{from:{id:671,first_name:'热心群友'},reply_to_message:target.message});await send(report);await tick(-403);
    const notice=calls.findLast(c=>c.method==='sendMessage'&&c.params.chat_id===99&&c.params.text.includes('群友举报'));
    assert.ok(notice);assert.match(notice.params.text,/发广告/);
    assert.ok(notice.params.text.includes('<a href="tg://user?id=670">可疑人</a>')&&notice.params.text.includes('<a href="tg://user?id=671">热心群友</a>'));
    // 670 hides direct profile links, so the notice falls back to the profile-card button.
    assert.match(notice.params.reply_markup.inline_keyboard[0][0].callback_data,/:info$/);
    assert.ok(calls.some(c=>c.method==='sendMessage'&&JSON.stringify(c.params.reply_markup||{}).includes('tg://user?id=670')));
    const [ban,ignore]=notice.params.reply_markup.inline_keyboard[1];assert.match(ban.callback_data,/:ban$/);assert.match(ignore.callback_data,/:ignore$/);
    await send(update(-403,'/report',{from:{id:672,first_name:'另一位'},reply_to_message:target.message}));await tick(-403);
    assert.equal(calls.filter(c=>c.method==='sendMessage'&&c.params.chat_id===99&&c.params.text.includes('群友举报')&&c.params.text.includes('可疑人')&&!JSON.stringify(c.params.reply_markup).includes('tg://user')).length,1);
    await send({update_id:++seq,callback_query:{id:'cb-ban',from:{id:99},data:ban.callback_data,message:{message_id:3,chat:{id:99,type:'private'},text:notice.params.text}}});
    await tick(-403);
    assert.ok(actions(-403).some(x=>x.method==='banChatMember'&&x.params.user_id===670));
    assert.ok(actions(-403).some(x=>x.method==='deleteMessage'&&x.params.message_id===target.message.message_id));
  });
  await t.test('所有者可以用 /log 切换处理记录的接收位置', async () => {
    const dm=text=>send({update_id:++seq,message:{message_id:++seq,date:Math.floor(Date.now()/1000),chat:{id:99,type:'private'},from:{id:99},text}});
    await dm('/log off');assert.match(calls.findLast(c=>c.method==='sendMessage'&&c.params.chat_id===99).params.text,/已关闭/);
    const before=calls.filter(c=>c.method==='sendMessage'&&c.params.chat_id===99).length;
    await send(update(-404,'兼职招聘 私聊我'));await tick(-404);assert.ok(actions(-404).some(x=>x.method==='banChatMember'));
    assert.equal(calls.filter(c=>c.method==='sendMessage'&&c.params.chat_id===99).length,before);
    await dm('/log @guard_log_channel');assert.ok(calls.some(c=>c.method==='sendMessage'&&c.params.chat_id==='@guard_log_channel'));
    await send(update(-404,'兼职招聘 私聊我 再来'));await tick(-404);
    assert.ok(calls.some(c=>c.method==='sendMessage'&&c.params.chat_id==='@guard_log_channel'&&c.params.text.includes('已封禁')));
    await dm('/log me');assert.match(calls.findLast(c=>c.method==='sendMessage'&&c.params.chat_id===99).params.text,/私信/);
  });

  await t.test('访客代发与富文本广告使用实际发送账号，首次删除封禁，不处罚调用者', async () => {
    const group=(await mf.getDurableObjectNamespace('GUARD_STATE')).getByName('chat:-410');
    await group.seedRecordTest('config',{keywords:[],aiReviewEnabled:true,casEnabled:false,profileCheckEnabled:false});
    await group.seedRecordTest('test:ai',{decision:'normal',confidence:1,reason:'不应调用',evidence:[]});
    const body='有一台手机能拍照就可做，拍商家收款码照片80/张，日入3500，小白可做，具体了解 @example_user';
    const guest=update(-410,'',{from:{id:7001,is_bot:true,first_name:'GuestAdBot'},guest_bot_caller_user:{id:99,is_bot:false,first_name:'无辜调用者'},rich_message:{blocks:[{type:'heading',size:1,text:body}]}});
    await send(guest);await tick(-410);
    assert.ok(actions(-410).some(x=>x.method==='deleteMessage'&&x.params.message_id===guest.message.message_id));
    assert.ok(actions(-410).some(x=>x.method==='banChatMember'&&x.params.user_id===7001&&x.params.until_date===0));
    assert.ok(!actions(-410).some(x=>x.params.user_id===99));
    assert.equal(await group.readRecordTest('test:ai-calls'),null);
    for(const extra of [
      {from:{id:7002,is_bot:true,first_name:'GuestBot'},guest_bot_caller_user:{id:7010},rich_message:{blocks:[{type:'paragraph',text:'今天讨论服务器配置'}]}},
      {from:{id:7003,is_bot:true},rich_message:{blocks:[{type:'heading',text:body}]}},
      {from:{id:7004,is_bot:true},guest_bot_caller_user:{id:99},text:'/ban 7011'},
    ]) {const before=actions(-410).length;await send(update(-410,'',extra));await tick(-410);assert.equal(actions(-410).length,before);}
    const manual=update(-410,'',{from:{id:7020,is_bot:true},guest_bot_caller_user:{id:99},rich_message:{blocks:[{type:'heading',text:'管理员确认的广告样本'}]}});
    await send(update(-410,'/spam',{from:{id:99},reply_to_message:manual.message}));await tick(-410);
    assert.ok(actions(-410).some(x=>x.method==='deleteMessage'&&x.params.message_id===manual.message.message_id));
    assert.ok(actions(-410).some(x=>x.method==='banChatMember'&&x.params.user_id===7020));
    assert.ok(!actions(-410).some(x=>x.params.user_id===99));
    const reportTarget=update(-410,'',{from:{id:7021,is_bot:true},guest_bot_caller_chat:{id:-999},rich_message:{blocks:[{type:'paragraph',text:'待举报的富文本样本'}]}});
    await send(update(-410,'/report',{from:{id:7022},reply_to_message:reportTarget.message}));await tick(-410);
    assert.ok(calls.some(x=>x.method==='sendMessage'&&x.params.chat_id===99&&x.params.text.includes('待举报的富文本样本')));
    const inline=update(-410,'替我收钱 一天7k',{from:{id:7012,is_bot:false,first_name:'普通发送者'},via_bot:{id:7005,is_bot:true}});
    await send(inline);await tick(-410);assert.ok(actions(-410).some(x=>x.method==='banChatMember'&&x.params.user_id===7012));
    assert.ok(!actions(-410).some(x=>x.method==='banChatMember'&&x.params.user_id===7005));
    const rich=update(-410,'',{from:{id:7013},rich_message:{blocks:[{type:'heading',text:'免.税集.团7.折出水.果..机 🔥17·p·m.ax入手只4k'},{type:'paragraph',text:'日搞1w 当.日.下.单 现.货.秒.发 具体 @example_user'}]}});
    await send(rich);await tick(-410);assert.ok(actions(-410).some(x=>x.method==='banChatMember'&&x.params.user_id===7013));
  });

  await t.test('话题中的账号供应广告首次删除封禁；正常 GV 求助通过', async () => {
    const group=(await mf.getDurableObjectNamespace('GUARD_STATE')).getByName('chat:-411');
    await group.seedRecordTest('config',{keywords:[],aiReviewEnabled:true,casEnabled:false,profileCheckEnabled:false});
    await group.seedRecordTest('test:ai',{decision:'normal',confidence:1,reason:'明确规则不应调用',evidence:[]});
    const ad=update(-411,'新 批 次 纯 手 工：GV / 墨工 / Nextdoor / ChatSMS 🌟 纯海外独享环境，无封号风险，登录包保，支持一手测试！',{from:{id:7101,first_name:'供应商 SMS-GV-TN-TF-SL-ID'},message_thread_id:123});
    await send(ad);const {data}=await tick(-411);
    assert.ok(actions(-411).some(x=>x.method==='deleteMessage'&&x.params.message_id===ad.message.message_id));
    assert.ok(actions(-411).some(x=>x.method==='banChatMember'&&x.params.user_id===7101&&x.params.until_date===0));
    assert.ok(data.logs.some(x=>x.action==='delete-and-permanent-ban'&&x.outcome==='success'));
    assert.equal(await group.readRecordTest('test:ai-calls'),null);
    const before=actions(-411).length;
    await send(update(-411,'GV 被停用了有解决办法吗？',{from:{id:7102},message_thread_id:123}));await tick(-411);
    assert.equal(actions(-411).length,before);
  });

  await t.test('管理员中文漏拦指令保存正文图片与话题、处罚并准备联防，成员不能滥用', async()=>{
    const ns=await mf.getDurableObjectNamespace('GUARD_STATE'),g=ns.getByName('chat:-9001'),global=ns.getByName('admin');
    await g.editScreening(false,false,true);await global.setFederation('-9001',true);await global.setFederation('-9002',true);
    await global.isolateOperationsTest();
    const target={message_id:987,from:{id:7501,first_name:'广告者'},photo:[{file_unique_id:'missed-photo',file_id:'photo'}],caption:'全新手工账号 登录包保 支持一手测试',message_thread_id:77};
    const u=update(-9001,'/漏拦',{from:{id:99},reply_to_message:target,message_thread_id:77});
    await send(u);await send(u);await tick(-9001);
    assert.equal(actions(-9001).filter(x=>x.method==='banChatMember').length,1);
    const records=await g.missedRecords();assert.equal(records.length,1);assert.equal(records[0].photoId,'missed-photo');assert.equal(records[0].topicId,77);assert.equal(records[0].text,target.caption);
    const samples=await global.listSamples();assert.ok(samples.some(x=>x.kind==='photo'&&x.value==='missed-photo'&&x.status==='pending'));
    assert.ok(samples.some(x=>x.kind==='text'&&x.label==='漏拦广告正文（待审核）'));
    assert.ok((await global.searchCases({userId:'7501'})).cases.length);
    await send(update(-9001,'/missed',{from:{id:7502},reply_to_message:target}));await tick(-9001);assert.equal(actions(-9001).filter(x=>x.method==='banChatMember').length,1);
    assert.ok((await g.operationList()).some(x=>x.action==='missed-ad-confirmed'&&x.steps.some(y=>y.method==='banChatMember'&&y.status==='success')));
  });
  await t.test('不同成员正常重复讨论不会因群级指纹被封禁',async()=>{
    const g=(await mf.getDurableObjectNamespace('GUARD_STATE')).getByName('chat:-9003');await g.seedRecordTest('config',{keywords:[],aiReviewEnabled:false,casEnabled:false,profileCheckEnabled:false});
    for(const id of [7511,7512,7513]){await send(update(-9003,'香港节点今天的网络速度怎么样？',{from:{id}}));await tick(-9003);}
    assert.equal(actions(-9003).length,0);
  });
  await t.test('应急模式临时限制新人媒体，到期/手动关闭恢复，私聊申请加强验证',async()=>{
    const g=(await mf.getDurableObjectNamespace('GUARD_STATE')).getByName('chat:-9004');await g.seedRecordTest('config',{keywords:[],aiReviewEnabled:false,casEnabled:false,profileCheckEnabled:false});await g.editNewMemberMediaGuard(false,30);
    await g.seedRecordTest('join:7521',Date.now());await g.setEmergency(true,5);
    const photo={from:{id:7521},sticker:{file_unique_id:'normal-sticker'}};
    await send(update(-9004,'',photo));const initialEmergency=await tick(-9004);assert.equal(actions(-9004).filter(x=>x.method==='deleteMessage').length,1,JSON.stringify(initialEmergency.data.logs));assert.equal(actions(-9004).filter(x=>x.method==='banChatMember').length,0);
    const request={chat:{id:-9004,type:'supergroup'},from:{id:7522},user_chat_id:7522};await send({update_id:++seq,chat_join_request:request});await tick(-9004);assert.equal((await g.verification('7522')).mode,'button');
    await g.setEmergency(false,5);await send(update(-9004,'',photo));await tick(-9004);assert.equal(actions(-9004).filter(x=>x.method==='deleteMessage').length,1);
    assert.equal((await g.config()).newMemberMediaGuard,false);await g.seedRecordTest('raid:until',Date.now()-1);assert.equal((await g.raidState()).active,false);
  });
  await t.test('应急模式下新人发的明确广告链接仍然封禁，普通链接只删除',async()=>{
    const g=(await mf.getDurableObjectNamespace('GUARD_STATE')).getByName('chat:-9010');await g.seedRecordTest('config',{keywords:[],aiReviewEnabled:false,casEnabled:false,profileCheckEnabled:false});await g.editNewMemberLinkGuard(false,30);
    await g.seedRecordTest('join:7561',Date.now());await g.seedRecordTest('join:7562',Date.now());await g.setEmergency(true,5);
    await send(update(-9010,'兼职招聘 私聊我 稳赚 https://ad.example',{from:{id:7561}}));await tick(-9010);
    assert.ok(actions(-9010).some(x=>x.method==='banChatMember'&&x.params.user_id===7561));
    await send(update(-9010,'教程在这里 https://docs.example/guide',{from:{id:7562}}));const {data}=await tick(-9010);
    assert.equal(actions(-9010).filter(x=>x.method==='banChatMember'&&x.params.user_id===7562).length,0);
    assert.ok(data.logs.some(x=>x.action==='emergency-link-quarantine'&&x.userId==='7562'));
    assert.equal(actions(-9010).filter(x=>x.method==='deleteMessage').length,2);
  });
  await t.test('删消息失败但已封禁时，所有者仍收到带撤销按钮的通知且不重复',async()=>{
    failures.set('deleteMessage:-9011',{error_code:400,description:"Bad Request: message can't be deleted"});
    const before=calls.length;
    await send(update(-9011,'兼职招聘 私聊我 稳赚 https://ad.example',{from:{id:7571,first_name:'广告号'}}));await tick(-9011);await tick(-9011,true);
    assert.ok(actions(-9011).some(x=>x.method==='banChatMember'&&x.params.user_id===7571));
    const notices=calls.slice(before).filter(c=>c.method==='sendMessage'&&c.params.chat_id===99&&c.params.text.includes('已封禁')&&c.params.text.includes('7571'));
    assert.equal(notices.length,1);assert.ok(JSON.stringify(notices[0].params.reply_markup).includes(':undo'));
    failures.delete('deleteMessage:-9011');
  });
  await t.test('明确广告爆发自动开启防护、停止后抑制自动重开',async()=>{
    const g=(await mf.getDurableObjectNamespace('GUARD_STATE')).getByName('chat:-9005');await g.editScreening(false,false,true);await g.editRaid(true,2,5);
    for(const id of [7531,7532]){await send(update(-9005,'替我收钱 一天7k',{from:{id}}));await tick(-9005);}
    assert.equal((await g.raidState()).active,true);await g.setEmergency(false,5);
    for(const id of [7533,7534]){await send(update(-9005,'替我收钱 一天7k',{from:{id}}));await tick(-9005);}
    assert.equal((await g.raidState()).active,false);
  });
  await t.test('邀请来源只保存哈希、来源名称，去重入群并关联广告账号',async()=>{
    const g=(await mf.getDurableObjectNamespace('GUARD_STATE')).getByName('chat:-9006');await g.editScreening(false,false,true);
    const link={invite_link:'https://t.me/+private-invite-token',name:'网站入口'},chat={id:-9006,type:'supergroup',title:'来源测试'};
    const u={update_id:++seq,chat_member:{chat,old_chat_member:{status:'left'},new_chat_member:{status:'member',user:{id:7541}},invite_link:link}};
    await send(u);await send(u);await tick(-9006);let stats=await g.inviteStats();assert.equal(stats.sources.length,1);assert.equal(stats.sources[0].joins,1);assert.ok(!JSON.stringify(stats).includes('private-invite-token'));
    await send(update(-9006,'替我收钱 一天7k',{from:{id:7541}}));await tick(-9006);stats=await g.inviteStats();assert.equal(stats.sources[0].advertisements,1);
    await send({update_id:++seq,chat_member:{...u.chat_member,old_chat_member:{status:'member'},new_chat_member:{status:'administrator',user:{id:7541}}}});await tick(-9006);assert.equal((await g.inviteStats()).sources[0].joins,1);
  });
  await t.test('规则回放使用人工确认的正常和广告案例，无处罚与规则写入',async()=>{
    const ns=await mf.getDurableObjectNamespace('GUARD_STATE'),global=ns.getByName('admin'),g=ns.getByName('chat:-9007');
    await global.editReviewExample('add',{text:'香港服务器网络讨论是正常消息',verdict:'normal',confirmed:true});await global.editReviewExample('add',{text:'兼职招聘 一天赚八千 联系我',verdict:'advertisement',confirmed:true});
    const before=(await g.adminData()).config;const preview=await g.ruleReplay({kind:'keyword',value:'兼职'});assert.ok(preview.adHits>=1);assert.equal(preview.normalHits,0);assert.deepEqual((await g.adminData()).config,before);assert.equal(actions(-9007).length,0);
    assert.ok((await g.ruleReplay({kind:'keyword',value:'香港'})).normalHits>=1);
  });
  await t.test('成员恢复取消联防，保留后续封禁，单群信任后联防不再封回',async()=>{
    const ns=await mf.getDurableObjectNamespace('GUARD_STATE'),global=ns.getByName('admin'),g=ns.getByName('chat:-9008');
    await g.seedRecordTest('chat',{id:-9008,type:'supergroup',title:'恢复测试'});await global.register({id:-9008,title:'恢复测试'});await global.setFederation('-9008',true);
    await g.seedRecordTest('member-ban:7551',{action:'delete-and-permanent-ban',jobId:'older'});await g.seedRecordTest('ban-owner:7551','older-case');
    await global.ensureCase({id:'older-case',userId:7551,chatId:-9008,federationTargets:[]});
    assert.equal((await global.memberRecovery('7551')).groups.some(x=>x.id==='-9008'),true);
    await global.recoverMember({userId:'7551',scope:'federation'});await tick(-9008);assert.equal(await g.memberBan('7551'),null);assert.equal(await global.caseReversed('older-case'),true);
    await g.seedRecordTest('member-ban:7552',{action:'newer-ban',jobId:'newer'});await g.seedRecordTest('ban-owner:7552','newer-case');await global.ensureCase({id:'older-case-2',userId:7552,chatId:-9008,federationTargets:[]});await global.recoverMember({userId:'7552',scope:'federation'});await tick(-9008);assert.equal((await g.memberBan('7552')).action,'newer-ban');
    await global.ensureCase({id:'new-case-3',userId:7551,chatId:-9009,federationTargets:['-9008']});const before=actions(-9008).length;await g.queueFederation('new-case-3','-9008',7551,'-9009');await tick(-9008);assert.equal(actions(-9008).length,before);
  });
  await t.test('全群状态总览显示权限、队列、接收时间和应急状态',async()=>{
    const global=(await mf.getDurableObjectNamespace('GUARD_STATE')).getByName('admin');const result=await global.operationsOverview();const group=result.groups.find(x=>x.id==='-9005');assert.ok(group);assert.ok(group.health);assert.ok(group.lastReceived);assert.equal(typeof group.permissions.deleteMessages,'boolean');assert.equal(typeof group.attention,'boolean');
  });

});
