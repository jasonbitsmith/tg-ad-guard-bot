import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions,Response as MFResponse} from 'miniflare';

test('长时间积压的队列被唤醒，旧任务隔离，新任务仍可处理',async t=>{
 const sent=[];
 const wrapper=`import worker,{GuardState as Base} from './index.js';
 export class GuardState extends Base {
  async alarm(){}
  seed(){const now=Date.now(),insert=(id,created,text)=>this.sql.exec("INSERT INTO jobs(id,payload,plan,due,created) VALUES (?,?,?,?,?)",id,'{}',JSON.stringify({entry:{action:'test'},ops:[{method:'sendMessage',params:{chat_id:99,text}}]}),created,created);
   insert('u:old',now-90000000,'old');insert('federation:old',now-90000000,'old-ban');insert('u:new',now,'new');}
  async run(id){const job=this.sql.exec('SELECT * FROM jobs WHERE id=?',id).toArray()[0];await this.runJob(job);return this.sql.exec('SELECT status FROM jobs WHERE id=?',id).toArray()[0].status;}
 }
 export default worker;`;
 const mf=new Miniflare(convertV4MiniflareOptions({compatibilityDate:'2026-09-22',compatibilityFlags:['nodejs_compat'],modules:[{type:'ESModule',path:'wrapper.js',contents:wrapper},{type:'ESModule',path:'index.js',contents:await readFile(new URL('../dist/index.js',import.meta.url),'utf8')}],durableObjects:{GUARD_STATE:{className:'GuardState',useSQLite:true}},kvNamespaces:['BOT_KV'],bindings:{BOT_TOKEN:'fake',ADMIN_IDS:'99'},outboundService:async req=>{sent.push(await req.json());return MFResponse.json({ok:true,result:{message_id:10}});}}));
 t.after(()=>mf.dispose());const state=(await mf.getDurableObjectNamespace('GUARD_STATE')).getByName('chat:-1001');await state.seed();
 // Simulate an alarm lost while jobs have been overdue for more than five minutes.
 // All jobs are at least six minutes overdue in this test's durable storage.
 const before=await state.queueDiagnostics();assert.equal(before.types.reduce((n,x)=>n+x.count,0),3);
 assert.equal((await state.ensureQueueWake()).rearmed,true);
 assert.equal(await state.run('u:old'),'quarantined');assert.equal(await state.run('federation:old'),'quarantined');
 assert.equal(await state.run('u:new'),'done');assert.deepEqual(sent.map(x=>x.text),['new']);
 assert.equal((await state.queueDiagnostics()).quarantined,2);
});

test('入群验证未送达时超时不拒绝申请',async t=>{
 const sent=[];
 const wrapper=`import worker,{GuardState as Base} from './index.js';
 export class GuardState extends Base {
  async seed(){this.write('chat',{id:-1001,title:'test'});this.sql.exec("INSERT INTO verifications(user_id,expires,mode,via,prompt_message_id,prompt_chat_id) VALUES (?,?,?,?,?,?)",'123',Date.now()-1000,'channel','request',null,123);}
  async tick(){await super.alarm();return this.verification('123');}
 }
 export default worker;`;
 const mf=new Miniflare(convertV4MiniflareOptions({compatibilityDate:'2026-09-22',compatibilityFlags:['nodejs_compat'],modules:[{type:'ESModule',path:'wrapper.js',contents:wrapper},{type:'ESModule',path:'index.js',contents:await readFile(new URL('../dist/index.js',import.meta.url),'utf8')}],durableObjects:{GUARD_STATE:{className:'GuardState',useSQLite:true}},kvNamespaces:['BOT_KV'],bindings:{BOT_TOKEN:'fake',ADMIN_IDS:'99'},outboundService:async req=>{sent.push(new URL(req.url).pathname);return MFResponse.json({ok:true,result:{message_id:10}});}}));
 t.after(()=>mf.dispose());const state=(await mf.getDurableObjectNamespace('GUARD_STATE')).getByName('chat:-1001');await state.seed();await state.tick();assert.ok(!sent.some(x=>x.endsWith('/declineChatJoinRequest')));
});
