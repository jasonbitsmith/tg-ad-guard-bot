import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

test('队列诊断只返回安全摘要，不泄露消息或用户编号',async t=>{
 const wrapper=`import worker,{GuardState as Base} from './index.js';
 export class GuardState extends Base {
  async seed(){this.sql.exec("INSERT INTO jobs(id,payload,plan,due,created) VALUES (?,?,?,?,?)",'u:123456789',JSON.stringify({message:{text:'secret message'}}),JSON.stringify({entry:{action:'test'},ops:[]}),Date.now()-1000,Date.now()-2000);}
 }
 export default worker;`;
 const mf=new Miniflare(convertV4MiniflareOptions({compatibilityDate:'2026-09-22',compatibilityFlags:['nodejs_compat'],modules:[{type:'ESModule',path:'wrapper.js',contents:wrapper},{type:'ESModule',path:'index.js',contents:await readFile(new URL('../dist/index.js',import.meta.url),'utf8')}],durableObjects:{GUARD_STATE:{className:'GuardState',useSQLite:true}},kvNamespaces:['BOT_KV'],bindings:{BOT_TOKEN:'fake',ADMIN_IDS:'99'}}));
 t.after(()=>mf.dispose());const state=(await mf.getDurableObjectNamespace('GUARD_STATE')).getByName('chat:-123');await state.seed();const d=await state.queueDiagnostics();
 assert.equal(d.oldest[0].type,'u');assert.equal(d.oldest[0].action,'test');assert.ok(!JSON.stringify(d).includes('secret message'));assert.ok(!JSON.stringify(d).includes('123456789'));
});
