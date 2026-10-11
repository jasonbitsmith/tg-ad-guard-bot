import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { ADMIN_JS } from '../src/admin.js';

function harness(failures={},responses={},globals={}) {
  const nodes=new Map(), calls=[];
  function node(id='',tag='DIV') {
    return {id,tagName:tag,value:'',textContent:'',checked:false,dataset:{},children:[],isConnected:true,
      classList:{add(){},remove(){}},querySelector(){return null;},querySelectorAll(){return [];},
      closest(){return null;},append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;},scrollIntoView(){}};
  }
  const document={getElementById(id){if(!nodes.has(id))nodes.set(id,node(id,id.endsWith('Form')?'FORM':'DIV'));return nodes.get(id);},body:node(),querySelector(){return null;},querySelectorAll(){return [];},createElement:tag=>node('',tag.toUpperCase())};
  let loggedIn=false;
  const context=vm.createContext({document,localStorage:{removeItem(){},getItem(){return null;},setItem(){}},Option:function(text,value){return {text,value};},fetch:async(url,options)=>{
    calls.push(url);if(url.endsWith('/login')||url.endsWith('/telegram-login'))loggedIn=true;
    const failure=loggedIn&&failures[url.split('/').at(-1)];if(failure)return {ok:false,status:failure,json:async()=>({error:'模拟读取失败'})};
    const ok=loggedIn, data=url.endsWith('/chats')?{chats:[{id:'-100123',title:'测试群'}]}:url.endsWith('/samples')?{samples:[]}:url.endsWith('/federation')?{chats:[]}:{ok:true};
    return {ok,status:ok?200:401,json:async()=>ok?(responses[url.split('/').at(-1)]||data):{error:'请重新登录'}};
  },...globals});
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


test('AI 设置保存反馈明确；每周备份仅填入恢复来源，不直接恢复',async()=>{
  const backup={schema:1,groups:[],samples:[],federation:[]};
  const h=harness({}, {'ai-review':{config:{aiReviewEnabled:false}},status:{enabled:true,schedule:'每周一 03:00',retention:8,last:{outcome:'success',at:'2026-10-07T00:00:00Z'},backups:[{id:'2026-10-05',created:'2026-10-07T00:00:00Z',groups:6,samples:2}]},'automatic?id=2026-10-05':backup});await flush();
  await h.document.getElementById('loginForm').onsubmit({preventDefault(){},currentTarget:h.document.getElementById('loginForm')});await flush();
  h.document.getElementById('chatId').value='-100123';h.document.getElementById('aiReviewEnabled').checked=false;
  await h.document.getElementById('aiReviewForm').onsubmit({preventDefault(){},currentTarget:h.document.getElementById('aiReviewForm')});
  assert.equal(h.document.getElementById('aiReviewEnabled').checked,false);assert.match(h.document.getElementById('notice').textContent,/AI 设置已保存/);
  assert.match(h.document.getElementById('automaticBackupStatus').textContent,/已保存/);
  const row=h.document.getElementById('automaticBackups').children[0];await row.children[2].onclick({preventDefault(){},currentTarget:row.children[2]});
  assert.deepEqual(JSON.parse(h.document.getElementById('backupText').value),backup);assert.ok(!h.calls.some(x=>x.endsWith('/backup/restore')));
});

test('全群状态异常卡片与处罚分步结果正常显示',async()=>{
 const h=harness({}, {overview:{groups:[{id:'-100123',title:'缺权限测试',attention:true,permissions:{deleteMessages:false,restrictMembers:true,inviteUsers:false},verification:'button',health:{pending:2,failed:1},raid:{active:false}}]},'jobs?chatId=-100123':{jobs:[{id:'u:9',action:'delete-and-permanent-ban',status:'failed',userId:7,steps:[{method:'deleteMessage',status:'failed',error:'权限不足'},{method:'banChatMember',status:'success'}]}]}});await flush();
 await h.document.getElementById('loginForm').onsubmit({preventDefault(){},currentTarget:h.document.getElementById('loginForm')});await flush();
 assert.match(h.document.getElementById('operationsOverview').children[0].children[0].textContent,/缺权限测试/);
 h.document.getElementById('chatId').value='-100123';await h.document.getElementById('refreshOperations').onclick({preventDefault(){},currentTarget:h.document.getElementById('refreshOperations')});
 const row=h.document.getElementById('operationJobs').children[0];assert.ok(row.children.some(x=>x.textContent.includes('删除广告：失败')));assert.ok(row.children.some(x=>x.textContent.includes('封禁成员：成功')));assert.ok(row.children.some(x=>x.textContent==='重试未完成步骤'));
});
test('应急操作明确反馈，规则回放展示正常误命中而不发布',async()=>{
 const h=harness({}, {emergency:{until:Date.now()+300000},replay:{total:2,normalHits:1,adHits:1,cases:[{text:'正常讨论',verdict:'normal',matched:true}]}});await flush();await h.document.getElementById('loginForm').onsubmit({preventDefault(){},currentTarget:h.document.getElementById('loginForm')});
 h.document.getElementById('chatId').value='-100123';h.document.getElementById('emergencyMinutes').value='5';await h.document.getElementById('emergencyForm').onsubmit({preventDefault(){},currentTarget:h.document.getElementById('emergencyForm')});assert.match(h.document.getElementById('emergencyStatus').textContent,/已开启/);
 h.document.getElementById('replayValue').value='香港';h.document.getElementById('replayKind').value='keyword';await h.document.getElementById('replayForm').onsubmit({preventDefault(){},currentTarget:h.document.getElementById('replayForm')});assert.match(h.document.getElementById('replayResult').children[0].textContent,/正常.*1/);assert.ok(!h.calls.some(x=>x.includes('keywords/add')));
});

test('开启入群欢迎但欢迎语留空时，保存会填入默认欢迎语，和预览一致',async()=>{
  const h=harness();await flush();
  await h.document.getElementById('loginForm').onsubmit({preventDefault(){},currentTarget:h.document.getElementById('loginForm')});
  h.document.getElementById('chatId').value='-100123';h.document.getElementById('welcomeEnabled').checked=true;
  await h.document.getElementById('welcomeForm').onsubmit({preventDefault(){},currentTarget:h.document.getElementById('welcomeForm')});
  assert.equal(h.document.getElementById('welcomeMessage').value,'👋 欢迎 {name} 加入 **{group}**！');
});

test('从机器人私聊打开时先用 Telegram 身份登录，再加载后台，并清掉地址栏里的登录数据',async()=>{
  let replaced=null;
  const h=harness({},{},{location:{hash:'#tgWebAppData=user%3D%257B%2522id%2522%253A99%257D%26hash%3Dabc&tgWebAppVersion=8.0',pathname:'/admin',search:''},history:{replaceState(a,b,url){replaced=url;}},window:{},URLSearchParams});
  await flush();await flush();
  assert.ok(h.calls[0].endsWith('/telegram-login'));
  assert.equal(replaced,'/admin');
  assert.equal(h.document.getElementById('chats').children.length,2);
});
