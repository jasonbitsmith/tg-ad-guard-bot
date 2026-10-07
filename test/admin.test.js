import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { ADMIN_JS } from '../src/admin.js';

function harness(failures={},responses={}) {
  const nodes=new Map(), calls=[];
  function node(id='',tag='DIV') {
    return {id,tagName:tag,value:'',textContent:'',checked:false,dataset:{},children:[],isConnected:true,
      classList:{add(){},remove(){}},querySelector(){return null;},querySelectorAll(){return [];},
      closest(){return null;},append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;},scrollIntoView(){}};
  }
  const document={getElementById(id){if(!nodes.has(id))nodes.set(id,node(id,id.endsWith('Form')?'FORM':'DIV'));return nodes.get(id);},body:node(),querySelector(){return null;},querySelectorAll(){return [];},createElement:tag=>node('',tag.toUpperCase())};
  let loggedIn=false;
  const context=vm.createContext({document,localStorage:{removeItem(){},getItem(){return null;},setItem(){}},Option:function(text,value){return {text,value};},fetch:async(url,options)=>{
    calls.push(url);if(url.endsWith('/login'))loggedIn=true;
    const failure=loggedIn&&failures[url.split('/').at(-1)];if(failure)return {ok:false,status:failure,json:async()=>({error:'模拟读取失败'})};
    const ok=loggedIn, data=url.endsWith('/chats')?{chats:[{id:'-100123',title:'测试群'}]}:url.endsWith('/samples')?{samples:[]}:url.endsWith('/federation')?{chats:[]}:{ok:true};
    return {ok,status:ok?200:401,json:async()=>ok?(responses[url.split('/').at(-1)]||data):{error:'请重新登录'}};
  }});
  vm.runInContext(ADMIN_JS,context);
  return {nodes,calls,context,document};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('首次未登录后正常登录必须加载群列表；真正过期重登保留表单',async()=>{
  const h=harness();await flush();
  h.document.getElementById('password').value='test';
  const event={preventDefault(){},currentTarget:h.document.getElementById('loginForm')};
  await h.document.getElementById('loginForm').onsubmit(event);
  assert.equal(h.document.getElementById('chats').children.length,2);
  assert.equal(h.document.getElementById('chats').children[1].value,'-100123');
  assert.equal(vm.runInContext('initialized',h.context),true);
  h.document.getElementById('welcomeMessage').value='未保存欢迎语';
  vm.runInContext('reauth=true',h.context);
  const before=h.calls.filter(x=>x.endsWith('/chats')).length;
  await h.document.getElementById('loginForm').onsubmit(event);
  assert.equal(h.calls.filter(x=>x.endsWith('/chats')).length,before);
  assert.equal(h.document.getElementById('welcomeMessage').value,'未保存欢迎语');
});


test('样本和联防读取失败不影响群列表，群列表可以独立刷新',async()=>{
  const h=harness({samples:503,federation:503});await flush();
  await h.document.getElementById('loginForm').onsubmit({preventDefault(){},currentTarget:h.document.getElementById('loginForm')});
  assert.equal(h.document.getElementById('chats').children.length,2);
  assert.match(h.document.getElementById('samples').textContent,/暂时无法读取/);
  await h.document.getElementById('refreshChats').onclick({preventDefault(){},currentTarget:h.document.getElementById('refreshChats')});
  assert.equal(h.document.getElementById('chats').children[1].value,'-100123');
});
test('设置提交成功但回读失败时明确显示已保存，不误报保存失败',async()=>{
  const h=harness({logs:503});await flush();
  await h.document.getElementById('loginForm').onsubmit({preventDefault(){},currentTarget:h.document.getElementById('loginForm')});
  h.document.getElementById('chatId').value='-100123';h.document.getElementById('welcomeMessage').value='欢迎';
  await h.document.getElementById('welcomeForm').onsubmit({preventDefault(){},currentTarget:h.document.getElementById('welcomeForm')});
  assert.match(h.document.getElementById('error').textContent,/设置已保存，但刷新显示失败/);
});

test('待审样本先展示预览，查看命中结果后才出现启用按钮',async()=>{
  const h=harness({}, {samples:{samples:[{id:1,kind:'text',value:'这个服务器怎么买',status:'pending'}]},preview:{eligible:true,matches:['这个服务器怎么买，有没有官网吗？'],examples:[],previewToken:'preview-test'}});await flush();
  await h.document.getElementById('loginForm').onsubmit({preventDefault(){},currentTarget:h.document.getElementById('loginForm')});
  const row=h.document.getElementById('samples').children[0], preview=row.children.find(x=>x.textContent==='预览命中并审核'), results=row.children[2];
  assert.equal(results.children.length,0);
  await preview.onclick({preventDefault(){},currentTarget:preview});
  assert.match(results.children[0].textContent,/这个服务器怎么买/);
  assert.ok(results.children.some(x=>x.textContent==='已核对这些命中，启用样本'));
});


test('联防筛选传递群用户状态和分页游标，追加页面保留已有记录',async()=>{
  const h=harness({}, {cases:{cases:[{id:'case1',userId:7,created:'today',groups:[]}],next:42},'cases?chatId=-123&userId=7&status=failed':{cases:[{id:'case1',userId:7,created:'today',groups:[]}],next:42},'cases?chatId=-123&userId=7&status=failed&before=42':{cases:[{id:'case2',userId:7,created:'today',groups:[]}],next:null}});await flush();
  await h.document.getElementById('loginForm').onsubmit({preventDefault(){},currentTarget:h.document.getElementById('loginForm')});await flush();
  h.document.getElementById('caseChat').value='-123';h.document.getElementById('caseUser').value='7';h.document.getElementById('caseStatus').value='failed';
  await h.document.getElementById('caseFilterForm').onsubmit({preventDefault(){},currentTarget:h.document.getElementById('caseFilterForm')});
  await h.document.getElementById('moreCases').onclick({preventDefault(){},currentTarget:h.document.getElementById('moreCases')});
  assert.ok(h.calls.includes('/admin/api/federation/cases?chatId=-123&userId=7&status=failed&before=42'));
  assert.equal(h.document.getElementById('federationCases').children.length,2);assert.equal(h.document.getElementById('moreCases').disabled,true);
});

test('人工确认案例的正常消息命中和广告遗漏展示在样本预览',async()=>{
  const h=harness({}, {samples:{samples:[{id:1,kind:'text',value:'测试完整广告样本',status:'pending'}]},preview:{eligible:true,matches:[],cases:[{verdict:'normal',matched:true,text:'正常讨论样本'},{verdict:'advertisement',matched:false,text:'另一个广告'}],previewToken:'ticket'}});await flush();
  await h.document.getElementById('loginForm').onsubmit({preventDefault(){},currentTarget:h.document.getElementById('loginForm')});
  const row=h.document.getElementById('samples').children[0],preview=row.children.find(x=>x.textContent==='预览命中并审核'),results=row.children[2];await preview.onclick({preventDefault(){},currentTarget:preview});
  assert.ok(results.children.some(x=>x.textContent.includes('正常消息误命中 1 条')));
  assert.ok(results.children.some(x=>x.textContent.includes('广告 · 未命中 · 另一个广告')));
  assert.ok(results.children.some(x=>x.textContent==='已核对这些命中，启用样本'));
});


test('备份必须先预览，点击确认前不执行恢复',async()=>{
 const h=harness({}, {preview:{token:'restore-test',groups:[{id:'-1',changes:[]}],samples:{restore:1,disable:0},federation:{before:[],after:[]},notes:'仅预览'},restore:{restored:2,complete:true}});await flush();
 await h.document.getElementById('loginForm').onsubmit({preventDefault(){},currentTarget:h.document.getElementById('loginForm')});
 h.document.getElementById('backupText').value=JSON.stringify({schema:1,groups:[],samples:[],federation:[]});await h.document.getElementById('backupForm').onsubmit({preventDefault(){},currentTarget:h.document.getElementById('backupForm')});
 assert.ok(!h.calls.some(x=>x.endsWith('/backup/restore')));const confirm=h.document.getElementById('backupPreview').children[1];assert.equal(confirm.textContent,'已核对差异，执行恢复');
 await confirm.onclick({preventDefault(){},currentTarget:confirm});assert.ok(h.calls.some(x=>x.endsWith('/backup/restore')));assert.equal(h.document.getElementById('backupPreview').textContent,'✓ 恢复已完成。');
});

test('试运行列表展示命中例子和正式启用按钮，审计展示变更字段',async()=>{
 const h=harness({}, {'trials?chatId=-100123':{trials:[{id:'trial1',kind:'keyword',value:'观察规则',hits:2,examples:[{text:'命中例子'}]}]},audit:{entries:[{at:'today',actor:'session:abc',action:'keywords/add',status:'success',changes:[{field:'keywords',before:[],after:['新增规则']}]}]}});await flush();
 await h.document.getElementById('loginForm').onsubmit({preventDefault(){},currentTarget:h.document.getElementById('loginForm')});h.document.getElementById('chatId').value='-100123';await h.document.getElementById('refreshTrials').onclick({preventDefault(){},currentTarget:h.document.getElementById('refreshTrials')});
 const trial=h.document.getElementById('trials').children[0];assert.match(trial.children[0].textContent,/命中 2 次/);assert.match(trial.children[1].textContent,/命中例子/);assert.equal(trial.children[2].textContent,'核对完成，正式启用');
 await h.document.getElementById('refreshAudit').onclick({preventDefault(){},currentTarget:h.document.getElementById('refreshAudit')});assert.match(h.document.getElementById('auditEntries').children[0].children[1].textContent,/新增规则/);
});
