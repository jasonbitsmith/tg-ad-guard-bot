export const ADMIN_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>群管理后台</title>
<style>body{font:15px/1.6 system-ui;background:#10151e;color:#e7edf5;max-width:1050px;margin:auto;padding:28px}h1{font-size:24px}input,select,button{font:inherit;padding:8px 12px;margin:5px;border-radius:8px;border:1px solid #46536b;background:#1b2638;color:inherit}button{cursor:pointer}article{background:#1b2638;border-radius:12px;padding:16px;margin:12px 0;overflow-wrap:anywhere}small,.muted{color:#abb8cd}#error{color:#ffb19e;white-space:pre-wrap}pre{white-space:pre-wrap}.chip{display:inline-block;border:1px solid #46536b;padding:4px;margin:3px;border-radius:8px}.hidden{display:none}label{display:inline-block}button:disabled{opacity:.4}a{color:#9cbeff}</style></head>
<body><h1>群管理后台</h1><p class="muted">低风险记录 · 中风险删消息并计警告 · 累计违规临时禁言 · 自动永久封禁已关闭</p>
<section id="login"><form id="loginForm"><label>管理密码 <input id="password" type="password" autocomplete="current-password" required></label><button>登录</button></form><small>会话 8 小时后过期，密码不会保存在浏览器。</small></section>
<p id="error" role="alert"></p><section id="app" class="hidden"><button id="logout">退出登录</button><button id="health">运行自检</button><pre id="healthResult"></pre>
<p><label>选择群 <select id="chats"><option value="">请选择</option></select></label><label>或输入群 ID <input id="chatId" placeholder="-100…"></label><button id="load">查看</button></p>
<p class="muted">已从旧版拦截记录导入已知群。新群会在机器人收到消息或管理员发送 <code>/status</code> 后自动出现；Telegram 不提供机器人直接列出全部所在群的接口，也可直接填写群 ID。规则仅影响选中的群。</p>
<h2>本群关键词</h2><p class="muted">关键词仅作为评分信号，不会单词命中即封禁。</p><form id="wordForm"><input id="word" maxlength="80" placeholder="新关键词" required><button>添加</button></form><div id="keywords"></div>
<h2>处理记录</h2><p id="summary"></p><button id="legacy">查看旧版记录</button><button id="refresh">刷新新版记录</button><div id="logs"></div><button id="more" disabled>加载更多</button>
<h2>纠错指令</h2><p>在群内回复用户消息，或填写用户 ID：<code>/warnings</code> 查看警告；<code>/clearwarn</code> 清除警告；<code>/allow</code> 加白名单；<code>/unallow</code> 移出白名单；<code>/unmute</code> 解除禁言；<code>/unban</code> 解除封禁。白名单不会自动解除已有处罚，解除封禁也不能恢复已删除的消息。</p></section><script src="/admin/app.js"></script></body></html>`;

export const ADMIN_JS = `
localStorage.removeItem('tg_ad_guard_admin_pw');
const $ = id => document.getElementById(id);
let cursor = null, legacy = false;
async function api(path, body) {
  const r = await fetch('/admin/api/' + path, body === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data = await r.json();
  if (!r.ok) { if(r.status===401) { $('app').classList.add('hidden'); $('login').classList.remove('hidden'); } throw Error(data.error || '请求失败'); }
  return data;
}
function safe(fn) { return async e => { e?.preventDefault(); $('error').textContent=''; try{await fn(e);}catch(err){$('error').textContent=err.message;} }; }
function chat() { const id=$('chatId').value.trim(); if(!/^-[0-9]+$/.test(id))throw Error('请选择群或输入有效的负数群 ID'); return id; }
async function enter() {
  const data=await api('chats');
  $('chats').replaceChildren(new Option('请选择',''),...data.chats.map(c=>new Option(c.title+' ('+c.id+')',c.id)));
  $('login').classList.add('hidden');$('app').classList.remove('hidden');
}
function renderWords(words) {
  $('keywords').replaceChildren(...words.map(word=>{const s=document.createElement('span');s.className='chip';const label=document.createElement('span');label.textContent=word;const b=document.createElement('button');b.textContent='×';b.title='移除关键词';b.onclick=safe(async()=>{await api('keywords/remove',{chatId:chat(),word});await load();});s.append(label,b);return s;}));
}
function renderLogs(logs,append) {
  if(!append)$('logs').replaceChildren();
  for(const l of logs){const a=document.createElement('article');const title=document.createElement('strong');title.textContent=(l.ts||'')+' · '+(l.action||'')+' · '+(l.outcome||'旧版记录，未校验实际执行结果');const p=document.createElement('p');p.textContent=(l.userName||l.userId||'')+' '+(l.text||'');const pre=document.createElement('pre');pre.textContent=JSON.stringify({原因:l.reasons,错误:l.error,执行步骤:l.steps,警告数:l.warnings,操作人:l.actorId},null,2);a.append(title,p,pre);$('logs').append(a);}
  if(!logs.length&&!append)$('logs').textContent='暂无记录';
}
async function load(append=false) {
  let data;
  if(legacy){data=await api('legacy'+(append&&cursor?'?cursor='+encodeURIComponent(cursor):''));$('summary').textContent='旧版归档：按旧键顺序分页读取；新记录请点击刷新新版记录。';}
  else{data=await api('logs?chatId='+encodeURIComponent(chat())+(append&&cursor?'&before='+cursor:''));renderWords(data.config.keywords);$('summary').textContent='待处理 '+data.pending+' · 失败 '+data.failed+' · 记录保留 30 天';}
  renderLogs(data.logs,append);cursor=data.next;$('more').disabled=!cursor;
}
$('loginForm').onsubmit=safe(async()=>{await api('login',{password:$('password').value});$('password').value='';await enter();});
$('logout').onclick=safe(async()=>{await api('logout',{});location.reload();});
$('chats').onchange=()=>{$('chatId').value=$('chats').value;};
$('load').onclick=$('refresh').onclick=safe(async()=>{legacy=false;await load();});
$('legacy').onclick=safe(async()=>{legacy=true;await load();});
$('more').onclick=safe(async()=>{await load(true);});
$('wordForm').onsubmit=safe(async()=>{await api('keywords/add',{chatId:chat(),word:$('word').value});$('word').value='';legacy=false;await load();});
$('health').onclick=safe(async()=>{$('healthResult').textContent=JSON.stringify(await api('status'+($('chatId').value.trim()?'?chatId='+encodeURIComponent(chat()):'')),null,2);});
safe(enter)();
`;
