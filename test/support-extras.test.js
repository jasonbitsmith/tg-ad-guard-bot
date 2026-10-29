import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions,Response as MFResponse} from 'miniflare';
import {supportOffHours,supportNextOpen} from '../src/state/support.js';

const at=(hh,mm=0)=>Date.UTC(2026,9,29,hh-8,mm);// Beijing wall clock on 2026-10-29
test('客服工作时间：跨午夜、同一天和关闭',()=>{
 const day={hoursEnabled:true,start:'09:00',end:'23:00'};
 assert.equal(supportOffHours(day,at(10)),false);assert.equal(supportOffHours(day,at(23,30)),true);assert.equal(supportOffHours(day,at(8,59)),true);
 assert.equal(supportNextOpen(day,at(23,30)),at(33));assert.equal(supportNextOpen(day,at(10)),at(10));
 const night={hoursEnabled:true,start:'20:00',end:'02:00'};
 assert.equal(supportOffHours(night,at(21)),false);assert.equal(supportOffHours(night,at(25)),false);assert.equal(supportOffHours(night,at(12)),true);
 assert.equal(supportOffHours({...day,hoursEnabled:false},at(3)),false);
});

test('客服增强：少刷屏、常见问题、休息时间、提醒、待回复、快捷回复、主动发、挡广告、相册',async t=>{
 const calls=[];let seq=1000;
 const wrapper=`import worker,{GuardState as Base} from './index.js';
 export class GuardState extends Base {
  async alarm(){}
  async drainTest(){for(const job of this.sql.exec("SELECT * FROM jobs WHERE status='pending' AND id NOT LIKE 'support:later:remind:%' ORDER BY rowid").toArray())await this.runJob(job);}
  async remindTest(){const jobs=this.sql.exec("SELECT * FROM jobs WHERE status='pending' AND id LIKE 'support:later:remind:%' ORDER BY rowid").toArray();for(const job of jobs)await this.runJob(job);return jobs.map(x=>x.due);}
  mapTest(id){return this.read('support:map:99:'+id);}
  blockedTest(id){return this.read('support:block:'+id);}
  async saveTest(body){try{return await this.saveSupportSettings(body);}catch(error){return {error:error.message};}}
 }
 export default worker;`;
 const mf=new Miniflare(convertV4MiniflareOptions({
  compatibilityDate:'2026-09-22',compatibilityFlags:['nodejs_compat'],
  modules:[{type:'ESModule',path:'wrapper.js',contents:wrapper},{type:'ESModule',path:'index.js',contents:await readFile(new URL('../dist/index.js',import.meta.url),'utf8')}],
  durableObjects:{GUARD_STATE:{className:'GuardState',useSQLite:true}},kvNamespaces:['BOT_KV'],
  bindings:{BOT_TOKEN:'guardfake',SUPPORT_BOT_TOKEN:'supportfake',SUPPORT_WEBHOOK_SECRET:'support-secret',SUPPORT_OWNER_ID:'99',ADMIN_IDS:'99'},
  outboundService:async req=>{
   const method=new URL(req.url).pathname.split('/').at(-1),params=await req.json();
   calls.push({method,params});
   if(method==='copyMessages')return MFResponse.json({ok:true,result:params.message_ids.map(()=>({message_id:++seq}))});
   return MFResponse.json({ok:true,result:{message_id:++seq}});
  },
 }));t.after(()=>mf.dispose());
 const state=(await mf.getDurableObjectNamespace('GUARD_STATE')).getByName('support:inbox');
 const send=update=>mf.dispatchFetch('https://bot.test/support/webhook',{method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':'support-secret'},body:JSON.stringify(update)});
 let id=0;
 const msg=(user,text,extra={})=>({update_id:++id,message:{message_id:id,chat:{id:user,type:'private'},from:{id:user,first_name:'Customer '+user},text,...extra}});
 const run=async(...updates)=>{const start=calls.length;for(const u of updates)await send(u);await state.drainTest();return calls.slice(start);};
 const headers=list=>list.filter(x=>x.params.text?.startsWith('📩 客服咨询'));
 const findMap=async user=>{for(let m=seq;m>1000;m--)if((await state.mapTest(m))?.userId===String(user))return m;};
 // Settings: invalid input is refused, valid input is stored.
 assert.match((await state.saveTest({faqText:'只有问题没有回答',templatesText:'',hoursEnabled:false,start:'09:00',end:'23:00',offMessage:'休息',remindHours:2,adFilter:true})).error,/下面要写内容/);
 assert.match((await state.saveTest({faqText:'',templatesText:'有 空格\n内容',hoursEnabled:false,start:'09:00',end:'23:00',offMessage:'休息',remindHours:2,adFilter:true})).error,/不能有空格/);
 const saved=await state.saveTest({faqText:'多久发货\n下单后 1–2 天寄出。\n\n怎么保号\n每 90 天充值一次。',templatesText:'付款\n支持支付宝和 USDT。',hoursEnabled:false,start:'09:00',end:'23:00',offMessage:'现在休息',remindHours:2,adFilter:true});
 assert.deepEqual(saved.settings.faq.map(x=>x.q),['多久发货','怎么保号']);

 // /start shows the FAQ keyboard; a FAQ button is answered and never relayed.
 let out=await run(msg(201,'/start'));
 assert.deepEqual(out[0].params.reply_markup.keyboard,[[{text:'多久发货'},{text:'怎么保号'}]]);
 out=await run(msg(201,'多久发货'));
 assert.equal(out.length,1);assert.equal(out[0].params.chat_id,201);assert.match(out[0].params.text,/1–2 天/);

 // Consecutive messages from one customer: one header; another customer in between gets a new one.
 out=await run(msg(201,'第一条'),msg(201,'第二条'),msg(201,'第三条'));
 assert.equal(headers(out).length,1);assert.equal(out.filter(x=>x.method==='copyMessage'&&x.params.chat_id===99).length,3);
 out=await run(msg(202,'另一位'),msg(201,'又是我'));
 assert.equal(headers(out).length,2);
 // Every relayed copy can be replied to, header or not.
 const lastCopy=out.filter(x=>x.method==='copyMessage').at(-1);assert.equal(lastCopy.params.from_chat_id,201);

 // /pending lists both waiting customers with replyable notes.
 out=await run(msg(99,'/pending'));
 assert.match(out[0].params.text,/共有 2 位客户/);
 const pendingFor202=await findMap(202);assert.ok(pendingFor202);
 // Quick reply via /t to the pending note; the customer gets the template text.
 out=await run(msg(99,'/t 付款',{reply_to_message:{message_id:pendingFor202}}));
 assert.ok(out.some(x=>x.params.chat_id===202&&x.params.text==='支持支付宝和 USDT。'));
 out=await run(msg(99,'/t'));assert.match(out[0].params.text,/付款/);
 out=await run(msg(99,'/pending'));assert.match(out[0].params.text,/共有 1 位客户/);

 // Reminder: fires for 201 (still waiting) but not after the customer is answered.
 out=calls.length;await state.remindTest();
 const reminders=calls.slice(out).filter(x=>x.params.text?.startsWith('⏰'));
 assert.equal(reminders.length,1);assert.match(reminders[0].params.text,/用户 ID：201/);
 const remindMap=await findMap(201);
 await run(msg(99,'/done',{reply_to_message:{message_id:remindMap}}));
 out=await run(msg(99,'/pending'));assert.match(out[0].params.text,/没有等你回复/);
 // A new message after being answered starts a new wait with a new reminder; replying cancels it.
 await run(msg(202,'还有问题'));
 const map202=await findMap(202);await run(msg(99,'好的',{reply_to_message:{message_id:map202}}));
 out=calls.length;await state.remindTest();assert.equal(calls.slice(out).filter(x=>x.params.text?.startsWith('⏰')).length,0);

 // /msg sends to a user directly by ID.
 out=await run(msg(99,'/msg 202 卡已寄出'));
 assert.ok(out.some(x=>x.params.chat_id===202&&x.params.text==='卡已寄出'));
 out=await run(msg(99,'/msg abc'));assert.match(out[0].params.text,/用法/);

 // Working hours that start two hours from now, so it is off hours right now.
 const clock=h=>new Date(Date.now()+(8+h)*3600000).toISOString().slice(11,16);
 // Off hours: the customer is told when Jason will be back, once.
 await state.saveTest({faqText:'',templatesText:'',hoursEnabled:true,start:clock(2),end:clock(3),offMessage:'现在休息',remindHours:0,adFilter:true});
 out=await run(msg(203,'晚上好'),msg(203,'在吗'));
 assert.equal(out.filter(x=>x.params.chat_id===203&&x.params.text?.startsWith('现在休息')).length,1);
 assert.ok(!out.some(x=>x.params.chat_id===203&&x.params.text?.includes('已转交')));
 assert.deepEqual(out.find(x=>x.params.chat_id===203).params.reply_markup,undefined);
 out=await run(msg(203,'/start'));assert.deepEqual(out[0].params.reply_markup,{remove_keyboard:true});

 // Ads from strangers are blocked with a one-line notice; ordinary questions with links are not.
 out=await run(msg(204,'有码来吃肉 一天8K'));
 assert.ok(!out.some(x=>x.method==='copyMessage'));assert.match(out[0].params.text,/疑似广告/);
 assert.ok(await state.blockedTest(204));
 out=await run(msg(204,'再发一条'));assert.equal(out.length,0);
 out=await run(msg(205,'你好，RedPocket 卡怎么充值保号？多少钱一个月 https://www.jasonselect.com'));
 assert.ok(out.some(x=>x.method==='copyMessage'&&x.params.from_chat_id===205));

 // An album is relayed as one group, in order.
 const photo={photo:[{file_id:'p',width:1,height:1}],media_group_id:'g1'};
 const a=msg(206,undefined,photo),b=msg(206,undefined,photo),c=msg(206,undefined,photo);
 out=await run(c,a,b);
 const album=out.filter(x=>x.method==='copyMessages');
 assert.equal(album.length,1);assert.deepEqual(album[0].params.message_ids,[a.message.message_id,b.message.message_id,c.message.message_id]);
 assert.ok(!out.some(x=>x.method==='copyMessage'&&x.params.from_chat_id===206));
 assert.equal((await findMap(206))>0,true);
 assert.ok(calls.every(x=>!x.params.chat_id||x.params.chat_id>0));
});
