import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {ADMIN_PAGE,ADMIN_JS} from '../src/admin.js';
import {WORKSPACE_JS} from '../src/admin-workspace.js';
test('workspace categorizes every existing admin panel exactly once',()=>{
 const context={};vm.runInNewContext(WORKSPACE_JS+';this.sections=WORKSPACE_SECTIONS',context);
 const categories=context.sections;assert.equal(categories.length,7);
 const assigned=categories.flatMap(s=>s[3]);assert.equal(new Set(assigned).size,assigned.length);
 const headings=[...ADMIN_PAGE.matchAll(/<h2>([^<]+)<\/h2>/g)].map(m=>m[1]);
 for(const title of headings)assert.ok(assigned.includes(title),'Unreachable panel: '+title);
 for(const category of categories)assert.equal([...category[0]].length,4);
 new vm.Script(ADMIN_JS);
});
test('workspace metrics use actual queue and verification data including empty groups',()=>{
 let cards=[];const context={document:{createElement:()=>({append(){},set textContent(v){this.text=v}})},$:()=>({replaceChildren(...nodes){cards=nodes}})};
 vm.runInNewContext(WORKSPACE_JS+';this.render=renderWorkspaceMetrics',context);
 context.render([]);assert.equal(cards.length,4);
 // Capture each value without depending on presentation markup.
 const values=[];context.document.createElement=tag=>({append(){},set textContent(v){if(tag==='strong')values.push(v)}});
 context.render([{attention:true,health:{pending:2},pendingVerifications:3},{error:'Unavailable'}]);
 assert.deepEqual(values,[2,2,2,3]);
});
