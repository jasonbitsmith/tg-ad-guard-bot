// Audit log, backup export/restore, and rule trials.
// Methods are copied onto GuardState.prototype in ../state.js.
import { validateBackup, validateConfig, diffValues } from '../operations.js';
import { digest } from '../telegram.js';
import { classify, normalizeDomain, validateWord } from '../filters.js';
import { DAY } from './shared.js';

export class BackupMethods {

  recordAudit(entry){
    this.sql.exec('CREATE TABLE IF NOT EXISTS admin_audit (id INTEGER PRIMARY KEY AUTOINCREMENT,created INTEGER NOT NULL,data TEXT NOT NULL)');
    this.sql.exec('INSERT INTO admin_audit(created,data) VALUES (?,?)',Date.now(),JSON.stringify({...entry,at:new Date().toISOString()}));
    this.sql.exec('DELETE FROM admin_audit WHERE created<?',Date.now()-90*DAY);
  }
  listAudit(before=0){
    this.sql.exec('CREATE TABLE IF NOT EXISTS admin_audit (id INTEGER PRIMARY KEY AUTOINCREMENT,created INTEGER NOT NULL,data TEXT NOT NULL)');
    this.sql.exec("CREATE INDEX IF NOT EXISTS admin_audit_operation ON admin_audit(json_extract(data,'$.operation'),id)");
    const rows=this.sql.exec("SELECT a.id,a.data FROM admin_audit a WHERE a.id<? AND NOT EXISTS (SELECT 1 FROM admin_audit b WHERE json_extract(b.data,'$.operation')=json_extract(a.data,'$.operation') AND b.id>a.id) ORDER BY a.id DESC LIMIT 51",Number(before)>0?Number(before):Number.MAX_SAFE_INTEGER).toArray();
    return {entries:rows.slice(0,50).map(x=>({id:x.id,...JSON.parse(x.data)})),next:rows.length>50?rows[49].id:null};
  }
  async auditSnapshot(path,body){
    if(path==='quiet' && body.scope==='all'){const result={};for(const chat of this.listChats()){const config=await this.env.GUARD_STATE.getByName('chat:'+chat.id).config();result['quiet:'+chat.id]={quietEnabled:config.quietEnabled,quietStart:config.quietStart,quietEnd:config.quietEnd,quietNotify:config.quietNotify,quietEndNoticeMinutes:config.quietEndNoticeMinutes};}return result;}
    if(body.chatId && /^-[0-9]{1,16}$/.test(String(body.chatId)))return {...await this.env.GUARD_STATE.getByName('chat:'+String(body.chatId)).config(),trials:await this.env.GUARD_STATE.getByName('chat:'+String(body.chatId)).listTrials()};
    if(path.startsWith('samples/'))return {samples:this.listSamples()};
    if(path.startsWith('review-examples/'))return {examples:this.listReviewExamples().map(x=>({id:x.id,verdict:x.verdict}))};
    if(path.startsWith('federation/'))return {case:this.read('federation-case:'+String(body.id))};
    if(path==='federation')return {federation:this.federation()};
    if(path.startsWith('links/'))return {links:this.listLinks().links.map(x=>({slug:x.slug,target:x.target,note:x.note}))};
    if(path==='quiet' || path==='backup/restore'){const backup=await this.exportBackup();delete backup.created;return {backup};}
    return {};
  }
  async exportBackup(){
    const chats=await this.listChats();for(const id of this.federation())if(!chats.some(x=>x.id===id))chats.push({id,title:id});if(chats.length>100)throw Error('超过 100 群备份上限');
    const groups=[];for(const chat of chats)groups.push({...chat,config:await this.env.GUARD_STATE.getByName('chat:'+chat.id).config()});
    const rows=this.sql.exec('SELECT * FROM samples ORDER BY id LIMIT 1001').toArray();if(rows.length>1000)throw Error('超过 1000 样本备份上限');
    const samples=rows.map(row=>({kind:row.kind,value:row.value,label:row.label,status:row.kind==='text'&&[...row.value].length<6?'disabled':this.read('sample-status:'+row.id,'active')}));
    return validateBackup({schema:1,created:new Date().toISOString(),groups,samples,federation:this.federation()});
  }
  automaticBackupStatus(){return {enabled:this.env.AUTO_BACKUP_ENABLED!=='false',schedule:'北京时间每周一 03:00，首次启用立即备份',retention:8,last:this.read('backup:auto-status'),backups:this.read('backup:auto-index',[])};}
  async automaticBackup(id){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(String(id))||!this.read('backup:auto-index',[]).some(x=>x.id===id))throw Error('未找到自动备份');
    const encoded=await this.env.BOT_KV.get('automatic-backup:'+id);if(!encoded)throw Error('备份已过期或暂时无法读取');const entry=this.read('backup:auto-index',[]).find(x=>x.id===id);if(await digest(encoded)!==entry.checksum)throw Error('备份校验失败，请勿恢复');return validateBackup(JSON.parse(encoded));
  }
  async runAutomaticBackup(now=Date.now()){
    if(this.env.AUTO_BACKUP_ENABLED==='false'||this.backingUp||this.read('backup:auto-retry',0)>now)return;
    const local=new Date(now+8*3600000),monday=new Date(local);monday.setUTCDate(local.getUTCDate()-(local.getUTCDay()+6)%7);monday.setUTCHours(3,0,0,0);
    if(local<monday)monday.setUTCDate(monday.getUTCDate()-7);
    const id=monday.toISOString().slice(0,10);if(this.read('backup:auto-index',[]).some(x=>x.id===id))return;
    this.backingUp=true;
    try{
      const backup=await this.exportBackup(),encoded=JSON.stringify(backup),checksum=await digest(encoded);
      await this.env.BOT_KV.put('automatic-backup:'+id,encoded,{expirationTtl:90*86400});
      const entry={id,created:new Date(now).toISOString(),groups:backup.groups.length,samples:backup.samples.length,checksum};
      this.write('backup:auto-index',[entry,...this.read('backup:auto-index',[])].slice(0,8),100*DAY);
      this.write('backup:auto-status',{outcome:'success',at:entry.created,id});this.remove('backup:auto-retry');
      this.log({action:'automatic-backup',outcome:'success',backupId:id,groups:entry.groups,samples:entry.samples});
    }catch{
      this.write('backup:auto-status',{outcome:'failed',at:new Date(now).toISOString(),error:'自动备份未完成，15 分钟后重试'});this.write('backup:auto-retry',now+15*60000,DAY);
      this.log({action:'automatic-backup',outcome:'failed',error:'读取群配置或保存备份失败，未写入成功记录'});
      await this.alertOwner('automatic-backup-failure','每周自动备份失败，15 分钟后自动重试；已有备份保留。').catch(()=>{});
    }finally{this.backingUp=false;}
  }
  async backupFingerprint(){const backup=await this.exportBackup();delete backup.created;return digest(JSON.stringify(backup));}
  async previewBackup(input){
    const backup=validateBackup(input), current=await this.exportBackup(), token=crypto.randomUUID();
    const differences=backup.groups.map(item=>({id:item.id,title:item.title,changes:diffValues(current.groups.find(x=>x.id===item.id)?.config||{},item.config)})).filter(x=>x.changes.length);
    const key=x=>JSON.stringify([x.kind,x.value]);
    const target=new Set(backup.samples.map(key));
    const samples={restore:backup.samples.length,disable:current.samples.filter(x=>!target.has(key(x))&&x.status!=='disabled').length};
    this.write('backup-preview:'+token,{backup,baseline:await this.backupFingerprint()},15*60000);
    return {token,groups:differences,samples,federation:{before:current.federation,after:backup.federation},notes:'恢复只覆盖备份中的群；未包含的样本会停用。不会恢复密钥、会话、消息、执行队列或用户封禁。'};
  }
  async replaceBackupConfig(chat,expected){
    const config=validateConfig(chat.config), current=validateConfig(await this.config());if(expected && JSON.stringify(current)!==JSON.stringify(validateConfig(expected)) && JSON.stringify(current)!==JSON.stringify(config))throw Error('群 '+chat.id+' 配置在恢复过程中已变化，请重新预览');this.saveConfig(config,'从备份恢复');this.write('chat',{id:Number(chat.id),title:chat.title});
    await this.schedule(Date.now()+100);
    if(!config.quietEnabled && this.read('quiet:active'))await this.quietTick();
    return {ok:true};
  }
  async restoreBackup(token){
    if(this.restoring)throw Error('已有恢复操作正在执行，请稍后核对结果');this.restoring=true;
    try{return await this.applyBackup(token);}finally{this.restoring=false;}
  }
  async applyBackup(token){
    const result = await this.applyBackupJob(token);
    await this.broadcastSamplesChanged();
    return result;
  }
  async applyBackupJob(token){
    const key='backup-preview:'+String(token);let job=this.read(key);if(!job)throw Error('恢复预览已过期，请重新预览');
    if(job.complete)return {ok:true,complete:true,restored:job.done.length};
    if(!job.started){if(await this.backupFingerprint()!==job.baseline)throw Error('配置已变化，请重新预览，避免覆盖新修改');job.rollback=await this.exportBackup();job.started=true;job.done=[];this.write(key,job,DAY);this.write('backup:last-rollback',job.rollback,7*DAY);this.write('backup:active',String(token),DAY);}
    if(this.read('backup:active')!==String(token))throw Error('该恢复任务已被后续恢复替代，请重新预览');
    // Each completed group is durable. A retry only resumes the remaining groups.
    for(const chat of job.backup.groups){if(job.done.includes(chat.id))continue;await this.env.GUARD_STATE.getByName('chat:'+chat.id).replaceBackupConfig(chat,job.rollback.groups.find(x=>x.id===chat.id)?.config);await this.register(chat);job.done.push(chat.id);this.write(key,job,DAY);}
    const currentSamples=this.sql.exec('SELECT * FROM samples ORDER BY id LIMIT 1001').toArray().map(row=>({kind:row.kind,value:row.value,label:row.label,status:row.kind==='text'&&[...row.value].length<6?'disabled':this.read('sample-status:'+row.id,'active')}));
    if(JSON.stringify(currentSamples)!==JSON.stringify(job.rollback.samples) || JSON.stringify(this.federation())!==JSON.stringify(job.rollback.federation))throw Error('全局样本或联防名单在恢复过程中已变化，请重新预览');
    this.ctx.storage.transactionSync(()=>{
    for(const sample of job.backup.samples){this.sql.exec('INSERT OR IGNORE INTO samples(kind,value,label,created) VALUES (?,?,?,?)',sample.kind,sample.value,sample.label,Date.now());const row=this.sql.exec('SELECT id FROM samples WHERE kind=? AND value=?',sample.kind,sample.value).toArray()[0];this.sql.exec('UPDATE samples SET label=? WHERE id=?',sample.label,row.id);this.write('sample-status:'+row.id,sample.status);}
    const targets=new Set(job.backup.samples.map(x=>JSON.stringify([x.kind,x.value])));for(const row of this.sql.exec('SELECT id,kind,value FROM samples').toArray())if(!targets.has(JSON.stringify([row.kind,row.value])))this.write('sample-status:'+row.id,'disabled');
    this.sql.exec('UPDATE federation SET enabled=0');for(const chatId of job.backup.federation)this.sql.exec('INSERT INTO federation(chat_id,enabled) VALUES (?,1) ON CONFLICT(chat_id) DO UPDATE SET enabled=1',chatId);
    this.sql.exec("DELETE FROM records WHERE key LIKE 'sample-preview:%'");job.complete=true;this.write(key,job,DAY);
    });
    return {ok:true,complete:true,restored:job.done.length};
  }
  lastRollback(){return this.read('backup:last-rollback');}
  listTrials(){return this.read('rule-trials',[]);}
  async editTrial(action,body){
    let trials=this.listTrials();
    if(action==='add'){
      if(!['keyword','domain'].includes(body.kind))throw Error('试运行支持关键词和黑名单域名');
      const value=body.kind==='keyword'?validateWord(body.value):normalizeDomain(body.value);
      if(trials.some(x=>x.kind===body.kind&&x.value===value))throw Error('试运行规则已存在');if(trials.length>=100)throw Error('每群最多 100 条试运行规则');
      trials.push({id:crypto.randomUUID(),kind:body.kind,value,created:Date.now(),hits:0,examples:[]});
    }else{
      const item=trials.find(x=>x.id===body.id);if(!item)throw Error('试运行规则不存在');
      if(action==='promote'){if(item.kind==='keyword')await this.editWord('add',item.value);else await this.editDomain('add',item.value,'deny');}
      else if(action!=='remove')throw Error('操作无效');
      trials=trials.filter(x=>x.id!==body.id);
    }
    this.write('rule-trials',trials);return {trials};
  }
  observeTrials(msg){
    const trials=this.listTrials();let changed=false;
    for(const trial of trials){
      const match=trial.kind==='keyword'?classify(msg,[trial.value],false).hits.includes(trial.value):classify(msg,[],false,{denylist:[trial.value]}).blockedDomains.length>0;
      const key='trial-seen:'+trial.id+':'+msg.message_id;
      if(!match || this.read(key))continue;this.write(key,true,30*DAY);trial.hits++;trial.examples.unshift({at:new Date().toISOString(),messageId:msg.message_id,text:String(msg.text||msg.caption||'').slice(0,300)});trial.examples=trial.examples.slice(0,20);changed=true;
      this.log({action:'rule-trial-hit',outcome:'observed',chatId:msg.chat.id,messageId:msg.message_id,trialId:trial.id,text:String(msg.text||msg.caption||'').slice(0,300),reasons:['仅试运行，不据此处罚']});
    }
    if(changed)this.write('rule-trials',trials);
  }
}
