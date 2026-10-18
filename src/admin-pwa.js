import { SENTINEL_ICONS } from './assets/sentinel-icons.js';
const manifest={id:'/admin/',name:'Jason Sentinel',short_name:'Sentinel',description:'Jason 的 Telegram 社群安全控制台',lang:'zh-CN',start_url:'/admin/?source=desktop',scope:'/admin/',display:'standalone',display_override:['standalone'],background_color:'#0b1020',theme_color:'#0b1020',icons:[{src:'/admin/icons/sentinel-192.png',sizes:'192x192',type:'image/png',purpose:'any'},{src:'/admin/icons/sentinel-512.png',sizes:'512x512',type:'image/png',purpose:'any'},{src:'/admin/icons/sentinel-maskable.png',sizes:'512x512',type:'image/png',purpose:'maskable'}]};
const offline='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Jason Sentinel · 离线</title><style>body{font:16px/1.7 system-ui;max-width:560px;margin:15vh auto;padding:24px;background:#0b1020;color:#edf3ff}a{color:#77dded}</style><h1>Jason Sentinel</h1><h2>暂时无法连接后台</h2><p>请检查网络，恢复连接后重新打开。管理数据不会离线缓存；本页不代表最新群状态。</p><a href="/admin/">重新连接 →</a></html>';
const sw=`const OFFLINE=${JSON.stringify(offline)};
self.addEventListener('install',()=>{});
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('message',event=>{if(event.data?.type==='ACTIVATE_UPDATE')self.skipWaiting();});
// Only navigations receive a static offline explanation. Never cache login, API data, cookies or administrative actions.
self.addEventListener('fetch',event=>{const u=new URL(event.request.url);if(event.request.method!=='GET'||event.request.mode!=='navigate'||u.origin!==self.location.origin||!u.pathname.startsWith('/admin/')||u.pathname.startsWith('/admin/api/'))return;event.respondWith(fetch(event.request).catch(()=>new Response(OFFLINE,{status:503,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}})));});`;
export const PWA_JS=`'use strict';
(()=>{let promptEvent,registration;const install=document.getElementById('sentinel-install'),message=document.getElementById('sentinel-app-message'),update=document.getElementById('sentinel-update');const standalone=matchMedia('(display-mode: standalone)').matches||navigator.standalone;
if(standalone)install.hidden=true;
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();promptEvent=e;if(!standalone)install.hidden=false;});
window.addEventListener('appinstalled',()=>{install.hidden=true;promptEvent=null;message.textContent='Jason Sentinel 已安装，可从桌面或应用列表打开。';});
install.onclick=async()=>{if(promptEvent){await promptEvent.prompt();await promptEvent.userChoice;promptEvent=null;}else message.textContent='在 Chrome 右上角菜单中选择“投放、保存和分享”→“安装 Jason Sentinel”；若已安装，可在应用列表中打开。Safari 可选择“文件”→“添加到程序坞”。';};
if('serviceWorker' in navigator){navigator.serviceWorker.register('/admin/sw.js',{scope:'/admin/',updateViaCache:'none'}).then(r=>{registration=r;if(r.waiting)update.hidden=false;r.addEventListener('updatefound',()=>{const worker=r.installing;worker?.addEventListener('statechange',()=>{if(worker.state==='installed'&&navigator.serviceWorker.controller)update.hidden=false;});});}).catch(()=>{message.textContent='应用安装支持暂未加载，仍可正常使用网页。';});}
update.onclick=()=>{if(!confirm('请先保存正在编辑的配置。确定刷新到新版本？'))return;if(registration?.waiting){registration.waiting.postMessage({type:'ACTIVATE_UPDATE'});}else location.reload();};let refreshing=false;navigator.serviceWorker?.addEventListener('controllerchange',()=>{if(refreshing||update.hidden)return;refreshing=true;location.reload();});
window.addEventListener('offline',()=>message.textContent='当前已断网，请暂停管理操作。恢复连接后先核对操作记录，勿重复提交。');window.addEventListener('online',()=>message.textContent='网络已恢复，请刷新核对最新状态。');
})();`;
export function adminPwaResponse(request,url,headers,version='2.32.0'){
 if(!['GET','HEAD'].includes(request.method))return null;
 let content,type;
 if(url.pathname==='/admin/manifest.webmanifest'){content=JSON.stringify(manifest);type='application/manifest+json';}
 else if(url.pathname==='/admin/pwa.js'){content=PWA_JS;type='text/javascript; charset=utf-8';}
 else if(url.pathname==='/admin/sw.js'){content='const BUILD='+JSON.stringify(version)+';\n'+sw;type='text/javascript; charset=utf-8';}
 else {const icon=url.pathname.match(/^\/admin\/icons\/sentinel-(192|512|maskable)\.png$/);if(!icon)return null;content=Uint8Array.from(atob(SENTINEL_ICONS[icon[1]]),c=>c.charCodeAt(0));type='image/png';}
 return new Response(request.method==='HEAD'?null:content,{headers:{...headers,'Content-Type':type,...(url.pathname==='/admin/sw.js'?{'Service-Worker-Allowed':'/admin/'}:{})}});
}
