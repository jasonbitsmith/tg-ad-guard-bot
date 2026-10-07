import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions, Response as MFResponse } from 'miniflare';

test('BookScape: protected draft, private preview, permissions, durable send-once', async t => {
  const calls = [];
  let canPost = true, username = 'JasonworksAI_bot', failure = null;
  const key = 'test-only-key-'.repeat(4);
  const mf = new Miniflare(convertV4MiniflareOptions({
    compatibilityDate: '2026-09-22', compatibilityFlags: ['nodejs_compat'],
    modules: [{ type: 'ESModule', path: 'test-wrapper.js', contents: "export { default, GuardState } from './index.js';" }, { type: 'ESModule', path: 'index.js', contents: await readFile(new URL('../dist/index.js', import.meta.url), 'utf8') }],
    durableObjects: { GUARD_STATE: { className: 'GuardState', useSQLite: true } },
    kvNamespaces: ['BOT_KV'], bindings: { BOT_TOKEN: 'fake', BOOKSCAPE_PUBLISH_KEY: key, ADMIN_IDS: '99' },
    outboundService: async request => {
      const url = new URL(request.url);
      assert.equal(url.hostname, 'api.telegram.org');
      const method = url.pathname.split('/').at(-1);
      let params;
      if (request.headers.get('Content-Type')?.startsWith('multipart/form-data')) {
        const form = await request.formData();
        params = Object.fromEntries(form.entries());
      } else params = await request.json();
      calls.push({ method, params });
      if (method === 'getMe') return MFResponse.json({ ok: true, result: { id: 555, username } });
      if (method === 'getChat') return MFResponse.json({ ok: true, result: params.chat_id === 99 ? { id: 99, type: 'private' } : { id: -100123, type: 'channel', username: 'Book_Scape', title: 'BookScape' } });
      if (method === 'getChatMember') return MFResponse.json({ ok: true, result: { status: 'administrator', can_post_messages: canPost } });
      if (method === 'sendMessage' && params.chat_id === -100123 && failure) { const code=failure; failure=null; return MFResponse.json({ ok: false, error_code: code, description: 'test failure' }, { status: code }); }
      if (method === 'sendPhoto') return MFResponse.json({ ok: true, result: { message_id: calls.length, caption: params.caption, photo: [{ file_id: 'small' }, { file_id: 'largest-file-id' }] } });
      if (method === 'editMessageCaption') return MFResponse.json({ ok: true, result: { message_id: params.message_id } });
      return MFResponse.json({ ok: true, result: { message_id: calls.length } });
    },
  }));
  t.after(() => mf.dispose());
  async function api(path, body, auth=key) {
    const r=await mf.dispatchFetch('https://bot.test/bookscape/api/'+path,{ method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+auth,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}) });
    return {status:r.status,...await r.json()};
  }
  const drafts = text => api('draft',{text,format:'HTML'});
  const publish = d => api('publish',{id:d.id,confirmHash:d.hash});
  const channelSends = () => calls.filter(c=>c.method==='sendMessage'&&c.params.chat_id===-100123);
  await t.test('unauthorized and oversized/redirected payloads rejected without Telegram calls',async()=>{
    assert.equal((await api('status',undefined,'wrong')).status,401);
    assert.equal((await drafts('x'.repeat(4097))).status,400);
    assert.equal((await api('draft',{text:'test',chat_id:'@elsewhere'})).status,400);
    assert.equal(calls.length,0);
  });
  await t.test('same content deduplicated; preview does not touch channel; explicit hash required',async()=>{
    const [a,b]=await Promise.all([drafts('<b>BookScape test</b>'),drafts('<b>BookScape test</b>')]);
    assert.equal(a.id,b.id);
    assert.equal((await publish(a)).status,400);
    const previews=await Promise.all([api('preview',{id:a.id}),api('preview',{id:a.id})]);
    assert.ok(previews.some(p=>p.previewState==='sent'));
    assert.equal(calls.filter(c=>c.method==='sendMessage').length,1);
    assert.equal(channelSends().length,0);
    assert.equal((await api('publish',{id:a.id,confirmHash:'wrong'})).status,400);
    canPost=false;assert.equal((await publish(a)).status,400);assert.equal(channelSends().length,0);canPost=true;
    username='OtherBot';assert.equal((await publish(a)).status,400);username='JasonworksAI_bot';
    const results=await Promise.all([publish(a),publish(a),publish(a)]);
    assert.ok(results.some(r=>r.state==='sent'));assert.equal(channelSends().length,1);
    assert.equal((await publish(a)).state,'sent');assert.equal(channelSends().length,1);
    const params=channelSends()[0].params;assert.equal(params.disable_notification,true);assert.equal(params.parse_mode,'HTML');
    assert.deepEqual(params.link_preview_options,{is_disabled:true});
  });
  await t.test('ambiguous failure locks draft and never automatically retries',async()=>{
    const d=await drafts('Ambiguous test');await api('preview',{id:d.id});failure=503;
    assert.equal((await publish(d)).status,400);const count=channelSends().length;
    assert.equal((await api('receipt?id='+d.id)).state,'unknown');
    assert.equal((await publish(d)).status,400);assert.equal(channelSends().length,count);
  });
  await t.test('definite Telegram rejection permits explicit retry of same draft',async()=>{
    const d=await drafts('Rate limit test');await api('preview',{id:d.id});failure=429;
    assert.equal((await publish(d)).status,400);
    assert.equal((await api('receipt?id='+d.id)).state,'draft');
    assert.equal((await publish(d)).state,'sent');
  });
  await t.test('image uploads once in preview, then reuses Telegram file_id for channel',async()=>{
    const d=await api('draft',{text:'<b>Image post</b>',format:'HTML',image:{data:'aGVsbG8=',mime:'image/jpeg',name:'cover.jpg',caption:'📘 《配图测试》'}});
    assert.equal(d.hasImage,true);
    const preview=await api('preview',{id:d.id});assert.equal(preview.previewState,'sent');
    const previewPhoto=calls.find(c=>c.method==='sendPhoto'&&String(c.params.chat_id)==='99');
    assert.ok(previewPhoto.params.photo instanceof File);
    const sent=await publish(d);assert.equal(sent.hasImage,true);assert.ok(sent.photoMessageId);
    const channelPhoto=calls.find(c=>c.method==='sendPhoto'&&c.params.chat_id===-100123&&c.params.photo==='largest-file-id');
    assert.ok(channelPhoto);assert.equal(channelPhoto.params.caption,'📘 《配图测试》');
  });
  await t.test('single layout sends exactly one photo with the complete caption',async()=>{
    const d=await api('draft',{text:'📘 <b>《单条测试》</b>\n\n正文',format:'HTML',layout:'photo_caption',image:{data:'aGVsbG8=',mime:'image/jpeg',name:'single.jpg',caption:'unused'}});
    const before=calls.filter(c=>['sendPhoto','sendMessage'].includes(c.method)).length;
    await api('preview',{id:d.id});
    assert.equal(calls.filter(c=>['sendPhoto','sendMessage'].includes(c.method)).length,before+1);
    const preview=calls.at(-1);assert.equal(preview.method,'sendPhoto');assert.equal(preview.params.caption,'📘 <b>《单条测试》</b>\n\n正文');
    const sent=await publish(d);assert.equal(sent.state,'sent');
    const channel=calls.at(-1);assert.equal(channel.method,'sendPhoto');assert.equal(channel.params.chat_id,-100123);assert.equal(channel.params.photo,'largest-file-id');
  });
  await t.test('single layout enforces Telegram caption limit',async()=>{
    const d=await api('draft',{text:'字'.repeat(1025),format:'HTML',layout:'photo_caption',image:{data:'aGVsbG8=',mime:'image/jpeg',name:'long.jpg',caption:'unused'}});
    assert.equal(d.status,400);assert.match(d.error,/1024/);
  });
  await t.test('caption editing stays on the fixed BookScape channel',async()=>{
    const edited=await api('edit',{messageId:106,text:'<b>更新后的落款</b>',format:'HTML'});
    assert.equal(edited.status,200,JSON.stringify(edited));assert.equal(edited.ok,true);assert.equal(edited.messageId,106);
    const call=calls.at(-1);assert.equal(call.method,'editMessageCaption');assert.equal(call.params.chat_id,'@Book_Scape');assert.equal(call.params.message_id,106);
    assert.equal((await api('edit',{messageId:106,text:'x'.repeat(1025),format:'HTML'})).status,400);
    assert.equal((await api('edit',{messageId:106,text:'test',chat_id:'@elsewhere'})).status,400);
  });
});
