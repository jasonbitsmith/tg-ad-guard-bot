// Cross-group ban federation: cases, dispatch, retry and reversal.
// Methods are copied onto GuardState.prototype in ../state.js.
import { telegram } from '../telegram.js';
import { DAY, ADMIN_STATUS } from './shared.js';

export class FederationMethods {
  federation() { return this.sql.exec('SELECT chat_id FROM federation WHERE enabled=1 ORDER BY chat_id').toArray().map(row => row.chat_id); }
  setFederation(chatId, enabled) {
    if (!/^-[0-9]{1,16}$/.test(String(chatId))) throw new Error('无效群 ID');
    if (enabled) {this.sql.exec('INSERT OR IGNORE INTO chats VALUES (?,?)',String(chatId),String(chatId));this.sql.exec('INSERT OR REPLACE INTO federation(chat_id,enabled) VALUES (?,1)', String(chatId));}
    else this.sql.exec('DELETE FROM federation WHERE chat_id=?', String(chatId));
    this.log({ action: enabled ? 'federation-join' : 'federation-leave', actorId: 'web-admin', chatId: String(chatId), outcome: 'success' });
    return this.federation();
  }
  federationTargets(sourceChatId) { const chats=this.federation();return chats.includes(String(sourceChatId))?chats.filter(chatId=>chatId!==String(sourceChatId)):[]; }
  listCases(){return this.sql.exec("SELECT value FROM records WHERE key LIKE 'federation-case:%' AND expires>? ORDER BY rowid DESC LIMIT 100",Date.now()).toArray().map(x=>JSON.parse(x.value));}
  searchCases(filters={}){
    const clauses=["key LIKE 'federation-case:%'",'expires>?'], args=[Date.now()];
    if(filters.chatId){if(!/^-[0-9]+$/.test(String(filters.chatId)))throw new Error('群 ID 无效');clauses.push("EXISTS (SELECT 1 FROM json_each(records.value,'$.groups') g WHERE json_extract(g.value,'$.chatId')=?)");args.push(String(filters.chatId));}
    if(filters.userId){if(!/^\d{1,16}$/.test(String(filters.userId)))throw new Error('用户 ID 无效');clauses.push("CAST(json_extract(value,'$.userId') AS TEXT)=?");args.push(String(filters.userId));}
    if(filters.status){if(!['pending','retrying','success','failed','cancelled','skipped','reversed'].includes(filters.status))throw new Error('记录状态无效');
      if(filters.status==='reversed')clauses.push("json_extract(value,'$.reversed')=1");
      else{clauses.push("EXISTS (SELECT 1 FROM json_each(records.value,'$.groups') g WHERE (json_extract(g.value,'$.status')=? OR json_extract(g.value,'$.undoStatus')=?)"+(filters.chatId?" AND json_extract(g.value,'$.chatId')=?":"")+")");args.push(filters.status,filters.status);if(filters.chatId)args.push(String(filters.chatId));}
    }
    if(filters.before){const before=Number(filters.before);if(!Number.isSafeInteger(before)||before<=0)throw new Error('分页参数无效');clauses.push('rowid<?');args.push(before);}
    const rows=this.sql.exec('SELECT rowid AS cursor,value FROM records WHERE '+clauses.join(' AND ')+' ORDER BY rowid DESC LIMIT 51',...args).toArray();
    return {cases:rows.slice(0,50).map(x=>JSON.parse(x.value)),next:rows.length>50?rows[49].cursor:null};
  }
  ensureCase(body){
    const key=`federation-case:${body.id}`;if(this.read(key))return this.read(key);
    const record={id:body.id,userId:Number(body.userId),sourceChatId:String(body.chatId),sampleIds:body.sampleIds||[],created:new Date().toISOString(),reversed:false,groups:[String(body.chatId),...(body.federationTargets||[]).map(String)].map(chatId=>({chatId,status:'pending',owned:false}))};
    this.write(key,record,90*DAY);return record;
  }
  caseStatus(id,chatId,patch){const key=`federation-case:${id}`,record=this.read(key);if(!record)return;const item=record.groups.find(x=>x.chatId===String(chatId));if(item)Object.assign(item,patch);this.write(key,record,90*DAY);}
  caseReversed(id){return this.read(`federation-case:${id}`)?.reversed===true;}
  async dispatchFederation(id){
    const record=this.read(`federation-case:${id}`);if(!record || record.reversed)return;
    const results=await Promise.allSettled(record.groups.filter(x=>x.chatId!==record.sourceChatId).map(x=>this.env.GUARD_STATE.getByName('chat:'+x.chatId).queueFederation(id,x.chatId,record.userId,record.sourceChatId)));
    if(results.some(x=>x.status==='rejected'))throw new Error('部分联防任务入队失败，正在重试');
  }
  async queueFederation(caseId,chatId,userId,sourceChatId){
    const id=`federation:${caseId}:${chatId}`;
    const plan={ops:[{method:'banChatMember',params:{chat_id:Number(chatId),user_id:userId,until_date:0},trackCase:caseId}],entry:{chatId:String(chatId),userId,sourceChatId,caseId,action:'federation-ban'}};
    await this.schedule(Date.now()+100);this.sql.exec('INSERT OR IGNORE INTO jobs(id,payload,plan,due,created) VALUES (?,?,?,?,?)',id,'{}',JSON.stringify(plan),Date.now(),Date.now());
  }
  async retryCase(id,chatId){const record=this.read(`federation-case:${id}`);if(!record || record.reversed || !record.groups.some(x=>x.chatId===String(chatId)))throw new Error('联防记录无效或已撤销');return this.env.GUARD_STATE.getByName('chat:'+chatId).retryJob(String(chatId)===record.sourceChatId?id.slice(String(chatId).length+1):`federation:${id}:${chatId}`);}
  async reverseCase(id){
    const key=`federation-case:${id}`,record=this.read(key);if(!record)throw new Error('此记录没有可核验的联防封禁信息');
    record.reversed=true;this.write(key,record,90*DAY);
    for(const sampleId of record.sampleIds){if(this.listSamples().some(x=>x.id===sampleId))await this.editSample('disable',{id:sampleId});}
    const results=await Promise.allSettled(record.groups.map(x=>this.env.GUARD_STATE.getByName('chat:'+x.chatId).queueCaseUndo(id,x.chatId,record.userId)));
    this.log({action:'federation-undo-request',caseId:id,userId:record.userId,actorId:'web-admin',outcome:results.some(x=>x.status==='rejected')?'partial':'success'});
    return {queued:results.filter(x=>x.status==='fulfilled').length,failed:results.filter(x=>x.status==='rejected').length,record:this.read(key)};
  }
  async queueCaseUndo(caseId,chatId,userId){
    const id=`undo:${caseId}:${chatId}`,plan={ops:[{local:'case-unban',caseId,userId,chatId}],entry:{action:'federation-undo',caseId,chatId:String(chatId),userId,actorId:'web-admin'}};
    await this.schedule(Date.now()+100);this.sql.exec('INSERT OR IGNORE INTO jobs(id,payload,plan,due,created) VALUES (?,?,?,?,?)',id,'{}',JSON.stringify(plan),Date.now(),Date.now());
    this.sql.exec("UPDATE jobs SET status='pending',attempts=0,due=?,created=? WHERE id=? AND status='failed'",Date.now(),Date.now(),id);
  }
  async queueReview(chatId,userId,messageId) {
    const tg=telegram(this.env.BOT_TOKEN), member=await this.member(tg,Number(chatId),userId);
    if(ADMIN_STATUS.includes(member.status) || this.owners().includes(String(userId))) throw new Error('不能处理群管理员或机器人所有者');
    const targets=await this.env.GUARD_STATE.getByName('admin').federationTargets(chatId);
    const ops=[{method:'deleteMessage',params:{chat_id:Number(chatId),message_id:messageId}},{method:'banChatMember',params:{chat_id:Number(chatId),user_id:userId,until_date:0}}];
    const id=`review:${chatId}:${messageId}:${userId}`;
    await this.schedule(Date.now()+100);
    this.sql.exec('INSERT OR IGNORE INTO jobs(id,payload,plan,due,created) VALUES (?,?,?,?,?)',id,'{}',JSON.stringify({ops,entry:{chatId,actorId:'web-admin',userId:String(userId),messageId,action:'review-resolve-ban',federationTargets:targets}}),Date.now(),Date.now());
    return {ok:true,queued:true,federationTargets:targets.length};
  }
  async retryJob(id) {
    const job=this.sql.exec("SELECT * FROM jobs WHERE id=? AND status='failed'", String(id)).toArray()[0];
    if (!job?.plan) throw new Error('没有可重试的执行计划');
    this.sql.exec("UPDATE jobs SET status='pending',attempts=0,due=?,created=? WHERE id=?",Date.now(),Date.now(),job.id);
    await this.schedule(Date.now()+100); return {ok:true,queued:true};
  }
}
