import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MonitorsMethods} from '../src/state/monitors.js';

class Monitor extends MonitorsMethods {
  constructor(records=new Map()){super();this.env={BOT_TOKEN:'test'};this.records=records;this.logs=[];}
  read(key,fallback=null){const x=this.records.get(key);return x&&x.expires>Date.now()?structuredClone(x.value):fallback;}
  write(key,value,ttl){this.records.set(key,{value:structuredClone(value),expires:Date.now()+ttl});}
  owners(){return ['99','99','100'];}
  log(x){this.logs.push(x);}
}

test('告警在发送前持久占位，并发及对象重建不重复，部分收件人失败只补发失败者',async t=>{
 const previous=globalThis.fetch;let release;let calls=[];
 const gate=new Promise(r=>release=r);
 globalThis.fetch=async(url,init)=>{const p=JSON.parse(init.body);calls.push(p);await gate;return p.chat_id===100?Response.json({ok:false,error_code:503,description:'temporary'},{status:503}):Response.json({ok:true,result:{message_id:1}});};
 t.after(()=>{globalThis.fetch=previous;});
 const a=new Monitor(),first=a.alertOwner('parallel','同类测试');
 await Promise.resolve();
 const b=new Monitor(a.records);
 assert.equal(await b.alertOwner('parallel','同类测试'),false);
 release();assert.equal(await first,true);
 assert.equal(calls.length,2);assert.equal(calls.filter(x=>x.chat_id===99).length,1);
 for(const [key,x] of a.records)if(key.endsWith(':100'))x.expires=Date.now()-1;
 globalThis.fetch=async(url,init)=>{calls.push(JSON.parse(init.body));return Response.json({ok:true,result:{message_id:2}});};
 await b.alertOwner('parallel','同类测试');
 assert.equal(calls.length,3);assert.equal(calls.at(-1).chat_id,100);
});

test('并发异常恢复顺序不覆盖；网络波动连续两轮且至少五分钟才提醒，未通知不发恢复',async t=>{
 const previous=globalThis.fetch,clock=Date.now;let now=clock(),calls=[];
 Date.now=()=>now;
 globalThis.fetch=async(url,init)=>{calls.push(JSON.parse(init.body));return Response.json({ok:true,result:{message_id:1}});};
 t.after(()=>{globalThis.fetch=previous;Date.now=clock;});
 const m=new Monitor();
 await Promise.all(Array.from({length:12},()=>m.checkIncident('one',true,'并发异常')));
 assert.equal(calls.length,2,'两位不同接收人各收一条');
 await Promise.all([m.checkIncident('one',true,'仍异常'),m.checkIncident('one',false,'恢复')]);
 assert.equal(calls.length,4);assert.equal(m.read('incident:one').active,false);
 const options={delayMs:300000,minChecks:2};
 await m.checkIncident('blip',true,'网络波动',options);await m.checkIncident('blip',false,'正常');assert.equal(calls.length,4);
 await m.checkIncident('network',true,'网络超时',options);
 for(let i=0;i<10;i++)await m.checkIncident('network',true,'网络超时',options);
 assert.equal(m.read('incident:network').checks,1);assert.equal(calls.length,4);
 now+=300001;await m.checkIncident('network',true,'网络超时',options);
 assert.equal(calls.length,6);assert.equal(m.read('incident:network').notified,true);
 await m.checkIncident('network',false,'API 正常');assert.equal(calls.length,8);
 assert.equal(m.read('incident:network').details,'API 正常');
});
