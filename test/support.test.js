import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions,Response as MFResponse} from 'miniflare';
import {supportOwner} from '../src/support.js';

test('客服接收者只允许指定所有者私聊',()=>{
 assert.equal(supportOwner({ADMIN_IDS:'99',SUPPORT_OWNER_ID:'99'}),'99');
 for(const id of ['88','-1001','@owner',''])assert.equal(supportOwner({ADMIN_IDS:'99',SUPPORT_OWNER_ID:id}),null);
});

test('双向客服：鉴权、多用户对应、去重、媒体、重试、屏蔽和限流',async t=>{
 const calls=[];let seq=1000,copyFail=false;
 const wrapper=`import worker,{GuardState as Base} from './index.js';
 export class GuardState extends Base {
  async alarm(){}
  async drainSupportTest(){for(const job of this.sql.exec("SELECT * FROM jobs WHERE status='pending' AND id NOT LIKE 'support:later:remind:%' ORDER BY rowid").toArray())await this.runJob(job);return this.sql.exec('SELECT id,status,attempts,plan FROM jobs ORDER BY rowid').toArray();}
  supportJobsTest(){return this.sql.exec('SELECT id,status,plan FROM jobs ORDER BY rowid').toArray();}
  mapTest(id){return this.read('support:map:99:'+id);}
 }
 export default worker;`;
 const mf=new Miniflare(convertV4MiniflareOptions({
  compatibilityDate:'2026-09-22',compatibilityFlags:['nodejs_compat'],
  modules:[{type:'ESModule',path:'wrapper.js',contents:wrapper},{type:'ESModule',path:'index.js',contents:await readFile(new URL('../dist/index.js',import.meta.url),'utf8')}],
  durableObjects:{GUARD_STATE:{className:'GuardState',useSQLite:true}},kvNamespaces:['BOT_KV'],
  bindings:{BOT_TOKEN:'guardfake',SUPPORT_BOT_TOKEN:'supportfake',SUPPORT_WEBHOOK_SECRET:'support-secret',SUPPORT_OWNER_ID:'99',ADMIN_IDS:'99'},
  outboundService:async req=>{
   const method=new URL(req.url).pathname.split('/').at(-1),params=await req.json();
   calls.push({method,params,path:new URL(req.url).pathname});
   if(method==='sendMessage'&&params.reply_markup?.inline_keyboard?.[0]?.[0]?.url==='tg://user?id=105')return MFResponse.json({ok:false,error_code:400,description:'Bad Request: BUTTON_USER_PRIVACY_RESTRICTED'},{status:400});
   if(method==='copyMessage'&&copyFail){copyFail=false;return MFResponse.json({ok:false,error_code:429,description:'limited',parameters:{retry_after:1}},{status:429});}
   return MFResponse.json({ok:true,result:{message_id:++seq}});
  },
 }));t.after(()=>mf.dispose());
 const state=(await mf.getDurableObjectNamespace('GUARD_STATE')).getByName('support:inbox');
 const send=(update,secret='support-secret')=>mf.dispatchFetch('https://bot.test/support/webhook',{method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':secret},body:JSON.stringify(update)});
 let id=0;
 const msg=(user,text,extra={})=>({update_id:++id,message:{message_id:id,chat:{id:user,type:'private'},from:{id:user,first_name:'Customer '+user},text,...extra}});
 assert.equal((await send(msg(1,'spoof'),'wrong')).status,403);
 assert.equal((await send({...msg(1,'spoof'),message:{...msg(1,'spoof').message,from:{id:2}}})).status,400);
 await send({update_id:++id,message:{chat:{id:-100,type:'supergroup'},from:{id:1},text:'group'}});
 assert.equal((await state.supportJobsTest()).length,0);
 await send(msg(99,'/start'));await state.drainSupportTest();
 assert.ok(calls.some(x=>x.params.chat_id===99&&x.params.text?.includes('客服入口')));
 const a=msg(101,'问题一');await Promise.all([send(a),send(a)]);
 await send(msg(102,undefined,{from:{id:102,first_name:'第二位',username:'CustomerTwo'},photo:[{file_id:'image',width:1,height:1}]}));
 await state.drainSupportTest();
 assert.equal(calls.filter(x=>x.method==='copyMessage'&&x.params.from_chat_id===101).length,1);
 const copyA=calls.find(x=>x.method==='copyMessage'&&x.params.from_chat_id===101);
 assert.ok(copyA);
 assert.equal(calls.find(x=>x.params.text?.includes('用户 ID：101')).params.reply_markup.inline_keyboard[0][0].url,'tg://user?id=101');
 assert.equal(calls.find(x=>x.params.text?.includes('用户 ID：102')).params.reply_markup.inline_keyboard[0][0].url,'https://t.me/CustomerTwo');
 const jobs=await state.supportJobsTest();
 // Done plans are pruned; obtain saved durable owner message maps by returned IDs.
 let mapA,mapB;
 for(let mid=1001;mid<=seq;mid++){const m=await state.mapTest(mid);if(m?.userId==='101')mapA=mid;if(m?.userId==='102')mapB=mid;}
 assert.ok(mapA&&mapB&&mapA!==mapB);
 let start=calls.length;
 await send(msg(99,'给第二位的答复',{reply_to_message:{message_id:mapB}}));await state.drainSupportTest();
 const outbound=calls.slice(start).find(x=>x.method==='copyMessage');assert.equal(outbound.params.chat_id,102);
 assert.equal(outbound.params.from_chat_id,99,'copyMessage 不转发管理员个人资料');
 await send(msg(99,'无对应消息',{reply_to_message:{message_id:999999}}));start=calls.length;await state.drainSupportTest();
 assert.ok(!calls.slice(start).some(x=>x.method==='copyMessage'));
 // A header succeeds, media gets 429: retry does not repeat the header.
 copyFail=true;await send(msg(103,'限流后重试'));start=calls.length;
 let pending=await state.drainSupportTest();assert.ok(pending.some(x=>x.status==='pending'));
 await state.drainSupportTest();assert.equal(calls.slice(start).filter(x=>x.params.text?.includes('用户 ID：103')).length,1);
 // Privacy rejects only the button; the plain header and content still arrive.
 await send(msg(105,'隐私设置测试'));start=calls.length;await state.drainSupportTest();
 const privacy=calls.slice(start).filter(x=>x.params.text?.includes('用户 ID：105'));
 assert.equal(privacy.length,2);assert.ok(privacy[0].params.reply_markup);assert.equal(privacy[1].params.reply_markup,undefined);
 assert.ok(calls.slice(start).some(x=>x.method==='copyMessage'&&x.params.from_chat_id===105));
 let privacyMap;for(let mid=1001;mid<=seq;mid++){if((await state.mapTest(mid))?.userId==='105')privacyMap=mid;}assert.ok(privacyMap);
 await send(msg(99,'隐私用户的回复',{reply_to_message:{message_id:privacyMap}}));start=calls.length;await state.drainSupportTest();assert.ok(calls.slice(start).some(x=>x.method==='copyMessage'&&x.params.chat_id===105));
 // Block a user after their message is queued; content is cancelled before send.
 await send(msg(101,'稍后处理'));await send(msg(99,'/block',{reply_to_message:{message_id:mapA}}));start=calls.length;await state.drainSupportTest();
 assert.ok(!calls.slice(start).some(x=>x.method==='copyMessage'&&x.params.from_chat_id===101));
 await send(msg(101,'骚扰'));start=calls.length;await state.drainSupportTest();assert.equal(calls.length,start);
 await send(msg(99,'/unblock 101'));await send(msg(101,'恢复咨询'));start=calls.length;await state.drainSupportTest();
 assert.ok(calls.slice(start).some(x=>x.method==='copyMessage'&&x.params.from_chat_id===101));
 for(let i=0;i<20;i++)await send(msg(104,'大量消息'));
 start=calls.length;await state.drainSupportTest();assert.equal(calls.slice(start).filter(x=>x.method==='copyMessage'&&x.params.from_chat_id===104).length,12);
 assert.equal(calls.slice(start).filter(x=>x.params.chat_id===104&&x.params.text?.includes('消息较多')).length,1);
 assert.ok(calls.every(x=>x.path.startsWith('/botsupportfake/')),'客服不能调用群管或订单机器人');
 assert.ok(jobs.every(x=>!x.plan||!x.plan.includes('support-secret')));
});
