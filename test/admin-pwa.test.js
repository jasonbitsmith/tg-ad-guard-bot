import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {adminPwaResponse,PWA_JS} from '../src/admin-pwa.js';
import {ADMIN_PAGE} from '../src/admin.js';
const response=(path,method='GET')=>{const u=new URL('https://bot.test'+path);return adminPwaResponse(new Request(u,{method}),u,{'Cache-Control':'no-store'});};
test('Sentinel manifest uses standalone admin scope and real PNG install icons',async()=>{
 const r=response('/admin/manifest.webmanifest');assert.equal(r.headers.get('content-type'),'application/manifest+json');const m=await r.json();assert.equal(m.name,'Jason Sentinel');assert.equal(m.display,'standalone');assert.equal(m.scope,'/admin/');assert.match(m.start_url,/^\/admin\//);
 for(const icon of m.icons){const r=response(icon.src);assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'image/png');const bytes=Buffer.from(await r.arrayBuffer());assert.equal(bytes.subarray(1,4).toString(),'PNG');const size=Number(icon.sizes.split('x')[0]);assert.equal(bytes.readUInt32BE(16),size);assert.equal(bytes.readUInt32BE(20),size);}
 assert.match(ADMIN_PAGE,/rel="manifest"/);assert.match(ADMIN_PAGE,/sentinel-install/);assert.match(ADMIN_PAGE,/\/admin\/pwa.js/);new vm.Script(PWA_JS);
});
test('Service worker is network-only and never handles API or mutation requests',async()=>{
 const r=response('/admin/sw.js');assert.equal(r.headers.get('Service-Worker-Allowed'),'/admin/');const code=await r.text();const events={};vm.runInNewContext(code,{self:{addEventListener:(k,f)=>events[k]=f,location:{origin:'https://bot.test'}},URL,Response,fetch:async()=>{throw Error('offline')}});
 for(const [path,mode,method]of [['/admin/api/chats','navigate','GET'],['/admin/api/save','navigate','POST'],['/admin/api/chats','cors','GET']]){let handled=false;events.fetch({request:{url:'https://bot.test'+path,mode,method},respondWith(){handled=true}});assert.equal(handled,false);}
 let pending;events.fetch({request:{url:'https://bot.test/admin/',mode:'navigate',method:'GET'},respondWith:p=>pending=p});const offline=await pending;assert.equal(offline.status,503);assert.match(await offline.text(),/不会离线缓存/);assert.doesNotMatch(code,/caches\./);
 assert.equal(response('/admin/sw.js','POST'),null);assert.equal(response('/admin/api/secret'),null);assert.equal(await response('/admin/icons/sentinel-192.png','HEAD').text(),'');
});
