import { telegram, digest } from '../telegram.js';
import { classify } from '../filters.js';
import { moderationMessage } from '../message-content.js';
import { DAY, ADMIN_STATUS } from './shared.js';

// Fingerprints are only corroborating evidence, never a reason to ban by themselves.
export function campaignFingerprint(text) {
  const traditional = {機:'机',號:'号',錢:'钱',帳:'账',戶:'户',純:'纯',風:'风',險:'险',錄:'录',應:'应',貨:'货',結:'结',賺:'赚',萬:'万',張:'张',來:'来',購:'购',營:'营',銷:'销',兼:'兼'};
  return String(text || '').normalize('NFKC').toLowerCase().replace(/[機號錢帳戶純風險錄應貨結賺萬張來購營銷]/g,c=>traditional[c]).replace(/https?:\/\/\S+|@[a-z0-9_]{5,}/g,'').replace(/[^\p{L}\p{N}]/gu,'').slice(0,400);
}
export function operationSteps(ops = [], state = 'pending') {
  return ops.filter(x=>x.method || ['federation-dispatch','case-unban'].includes(x.local)).map(x=>({
    method:x.serviceCleanup?'deleteServiceMessage':x.method||x.local,
    status:x.skipped?'skipped':x.done?'success':x.error?(state==='pending'?'retrying':'failed'):'pending',
    error:x.error||null,skipped:x.skipped||null,doneAt:x.doneAt||null,
  }));
}

export class OperationsMethods {
  async missedPlan(msg,tg) {
    const target=moderationMessage(msg.reply_to_message);
    if(!target?.from?.id || target.sender_chat || (target.chat?.id && target.chat.id!==msg.chat.id))throw Error('请回复广告消息发送 /漏拦 或 /missed');
    if(!await this.privileged(tg,msg.chat.id,msg.from.id))throw Error('仅管理员可以确认漏拦广告；成员请使用 /report');
    const plan=await this.spamPlan(msg,tg);
    plan.entry.action='missed-ad-confirmed';plan.entry.reasons=['管理员确认漏拦广告；样本待审核'];
    const sampleOps=plan.ops.filter(x=>x.local==='sample');
    const text=String(target.text||target.caption||'').slice(0,4000);
    if(text.length>=6 && target.photo?.length)sampleOps.push({local:'sample',sample:{kind:'text',value:text.slice(0,500),label:'漏拦广告正文（待审核）',pending:true}});
    plan.ops=plan.ops.filter(x=>x.local!=='sample');
    plan.ops.push({local:'missed-record',body:{id:String(msg.chat.id)+':'+target.message_id,chatId:String(msg.chat.id),topicId:target.message_thread_id||msg.message_thread_id||null,userId:target.from.id,messageId:target.message_id,actorId:msg.from.id,text,photoId:target.photo?.at(-1)?.file_unique_id||null,created:new Date().toISOString()}},...sampleOps);
    plan.ops.push({method:'sendMessage',params:{chat_id:msg.chat.id,...(msg.message_thread_id?{message_thread_id:msg.message_thread_id}:{}),text:'✅ 已确认漏拦广告，已提交删除和封禁任务。样本已存为待审核；实际结果请看后台「处罚执行」。'},cleanupAfter:20000,optional:true});
    plan.entry.federationTargets=await this.env.GUARD_STATE.getByName('admin').federationTargets(msg.chat.id);
    return plan;
  }
  saveMissedRecord(body) {
    this.write('missed-ad:'+body.id,body,90*DAY);
    const excess=this.sql.exec("SELECT key FROM records WHERE key LIKE 'missed-ad:%' ORDER BY rowid DESC LIMIT -1 OFFSET 300").toArray();
    for(const row of excess)this.remove(row.key);
  }
  missedRecords(){return this.sql.exec("SELECT value FROM records WHERE key LIKE 'missed-ad:%' AND expires>? ORDER BY rowid DESC LIMIT 100",Date.now()).toArray().map(x=>JSON.parse(x.value));}
  operationList() {
    const jobs=this.sql.exec("SELECT id,status,attempts,due,created,plan FROM jobs WHERE plan IS NOT NULL ORDER BY created DESC LIMIT 50").toArray().map(x=>({id:x.id,status:x.status,attempts:x.attempts,due:x.due,created:x.created,...JSON.parse(x.plan).entry,steps:operationSteps(JSON.parse(x.plan).ops,x.status)}));
    const done=this.sql.exec("SELECT data FROM logs WHERE json_extract(data,'$.updateId') IS NOT NULL ORDER BY id DESC LIMIT 100").toArray().map(x=>JSON.parse(x.data));
    const ids=new Set(jobs.map(x=>x.id));
    for(const log of done){if(ids.has(log.updateId))continue;ids.add(log.updateId);jobs.push({...log,id:log.updateId,status:log.outcome,steps:log.operationSteps||log.steps?.map(x=>({...x,status:x.skipped?'skipped':x.done?'success':'failed'}))||[]});}
    return jobs.slice(0,100);
  }
  async groupOverview() {
    const config=await this.config();
    return {health:this.healthSummary(),lastReceived:this.read('health:last-received'),verification:config.verificationMode,federation:await this.env.GUARD_STATE.getByName('admin').federationTargets(this.read('chat')?.id),quiet:config.quietEnabled,raid:this.raidState(),pendingVerifications:this.sql.exec('SELECT COUNT(*) AS n FROM verifications').toArray()[0].n};
  }
  async operationsOverview() {
    const tg=telegram(this.env.BOT_TOKEN),me=await this.me(tg),federation=this.federation();
    const chats=this.listChats();const groups=[];
    // Bound concurrency; large registries must not burst Telegram's API.
    for(let i=0;i<chats.length;i+=5)groups.push(...await Promise.all(chats.slice(i,i+5).map(async chat=>{
      let permissions={},details={},error='';
      try{const member=await tg('getChatMember',{chat_id:Number(chat.id),user_id:me.id});permissions={deleteMessages:member.status==='creator'||!!member.can_delete_messages,restrictMembers:member.status==='creator'||!!member.can_restrict_members,inviteUsers:member.status==='creator'||!!member.can_invite_users};}catch{error='无法读取权限，请稍后重试';}
      try{details=await this.env.GUARD_STATE.getByName('chat:'+chat.id).groupOverview();}catch{error+=(error?'；':'')+'无法读取本群状态';}
      return {...chat,...details,permissions,federation:federation.includes(chat.id),error,attention:!!error||!permissions.deleteMessages||!permissions.restrictMembers||!!details.health?.failed||!!details.health?.overdueSeconds};
    })));
    return {groups:groups.sort((a,b)=>Number(b.attention)-Number(a.attention)),checked:new Date().toISOString()};
  }
  raidState(){const until=this.read('raid:until',0);return {active:until>Date.now(),until,reason:this.read('raid:reason','入群数量触发')};}
  async setEmergency(enabled,minutes=30,reason='管理员手动开启') {
    if(typeof enabled!=='boolean'||!Number.isInteger(minutes)||minutes<5||minutes>120)throw Error('防护时长须为 5–120 分钟');
    if(enabled){this.write('raid:until',Date.now()+minutes*60000,minutes*60000);this.write('raid:reason',reason,minutes*60000);}else{this.remove('raid:until');this.remove('raid:joins');this.remove('raid:ads');this.write('raid:suppressed',true,5*60000);}
    this.log({chatId:this.read('chat')?.id,action:enabled?'emergency-start':'emergency-stop',actorId:reason==='管理员手动开启'?'web-admin':'automatic',outcome:'success',reasons:[reason]});return this.raidState();
  }
  async observeAdBurst(msg,policy) {
    if(!policy.raidEnabled||this.read('raid:suppressed'))return;
    const ads=this.read('raid:ads',[]).filter(x=>x.at>Date.now()-300000&&x.messageId!==msg.message_id);
    ads.push({messageId:msg.message_id,userId:msg.from?.id,at:Date.now()});this.write('raid:ads',ads.slice(-50),300000);
    if(new Set(ads.map(x=>x.userId).filter(Boolean)).size>=policy.raidJoinLimit&&!this.raidState().active)await this.setEmergency(true,policy.raidMinutes,'5 分钟内多个账号发布明确广告');
  }
  observeCampaign(text,senderId,messageId,verdict) {
    const fingerprint=campaignFingerprint(text);if(fingerprint.length<6)return;
    const key='campaign:'+fingerprint;let items=this.read(key,[]).filter(x=>x.at>Date.now()-600000&&x.messageId!==messageId);
    const confirmed=verdict.permanentBan||verdict.deleteOnKeyword;items.push({senderId,messageId,at:Date.now(),confirmed});items=items.slice(-30);this.write(key,items,600000);
    if(new Set(items.map(x=>x.senderId)).size>=2&&items.some(x=>x.confirmed)&&verdict.score>0){verdict.reasons.push('10 分钟内多个账号重复相同内容','多个账号发送符号/繁简变体，且已有明确广告证据');verdict.score=Math.max(4,verdict.score);}
  }
  async ruleReplay(body) {
    const config=await this.config(),kind=body.kind,value=String(body.value||'').trim();
    if(!['keyword','domain'].includes(kind)||!value||value.length>253)throw Error('请填写关键词或域名');
    const examples=await this.env.GUARD_STATE.getByName('admin').listReviewExamples();
    const cases=examples.map(x=>{const result=kind==='keyword'?classify({text:x.text},[value],false):classify({text:x.text},[],false,{denylist:[value]});return {...x,matched:kind==='keyword'?result.hits.length>0:result.blockedDomains.length>0};});
    return {cases,normalHits:cases.filter(x=>x.verdict==='normal'&&x.matched).length,adHits:cases.filter(x=>x.verdict==='advertisement'&&x.matched).length,total:cases.length,keywordCount:config.keywords.length};
  }
  async rememberInvite(update) {
    const event=update.chat_join_request||update.chat_member;if(!event)return;
    const user=update.chat_join_request?.from||event.new_chat_member?.user;
    if(!user?.id||user.is_bot)return;
    const link=event.invite_link;if(!link?.invite_link)return;
    const key='invite-source:'+await digest(link.invite_link);
    // Store a label and hashed identifier, never the reusable private invitation URL.
    const record=this.read(key,{id:key.slice(14),label:String(link.name||'未命名邀请链接').slice(0,80),requests:0,joins:0,advertisements:0,verificationFailures:0});
    const marker=key+':'+update.update_id;if(this.read(marker))return;
    if(update.chat_join_request)record.requests++;
    else {const next=event.new_chat_member,old=event.old_chat_member;const present=x=>['member','administrator','creator'].includes(x?.status)||(x?.status==='restricted'&&x.is_member===true);if(!present(next)||present(old))return;record.joins++;this.write(`join:${user.id}`,Date.now(),DAY);}
    record.lastSeen=new Date().toISOString();this.write(key,record,90*DAY);this.write(marker,true,DAY);this.write('member-invite:'+user.id,key,30*DAY);
  }
  recordInviteOutcome(entry,ops=[]) {
    const key=this.read('member-invite:'+entry.userId);if(!key)return;const record=this.read(key);if(!record)return;
    const type=/verification-timeout|join-request-declined/.test(entry.action)?'verificationFailures':/permanent-ban|federated-permanent-ban|missed-ad-confirmed/.test(entry.action)?'advertisements':null;
    if(!type)return;const method=type==='advertisements'?'banChatMember':entry.action==='join-request-declined'?'declineChatJoinRequest':'banChatMember';if(!ops.some(x=>x.method===method&&x.done&&!x.skipped))return;const marker='invite-outcome:'+entry.userId+':'+type;if(this.read(marker))return;
    record[type]++;this.write(key,record,90*DAY);this.write(marker,true,30*DAY);
  }
  inviteStats(){return {sources:this.sql.exec("SELECT value FROM records WHERE key LIKE 'invite-source:%' AND key NOT LIKE 'invite-source:%:%' AND expires>? ORDER BY rowid DESC LIMIT 100",Date.now()).toArray().map(x=>JSON.parse(x.value)),note:'仅统计启用后收到的带邀请链接事件；不保存私人邀请链接。验证失败不等于广告。'};}
  async memberRecovery(query) {
    const target=String(query||'').trim();if(!/^(?:\d{1,16}|@[a-zA-Z0-9_]{5,32})$/.test(target))throw Error('请输入数字用户 ID 或 @用户名');
    let userId=target;
    if(target.startsWith('@')){const results=await Promise.all(this.listChats().map(chat=>this.env.GUARD_STATE.getByName('chat:'+chat.id).resolveMember(target)));userId=results.find(Boolean);if(!userId)return {userId:null,groups:[],cases:[],note:'未记录此用户名，请用数字用户 ID'};}
    const groups=await Promise.all(this.listChats().map(async chat=>({...chat,...await this.env.GUARD_STATE.getByName('chat:'+chat.id).recoveryInfo(userId)})));
    return {userId,groups:groups.filter(x=>x.ban),cases:this.userCases(userId)};
  }
  resolveMember(username){return this.sql.exec('SELECT user_id FROM member_profiles WHERE LOWER(username)=? ORDER BY seen DESC LIMIT 1',username.slice(1).toLowerCase()).toArray()[0]?.user_id||null;}
  recoveryInfo(userId){return {ban:this.memberBan(userId),verification:this.verification(userId),trusted:!!this.read('allow:'+userId)};}
  userCases(userId){return this.sql.exec("SELECT value FROM records WHERE key LIKE 'federation-case:%' AND CAST(json_extract(value,'$.userId') AS TEXT)=? AND expires>? ORDER BY rowid DESC LIMIT 1000",String(userId),Date.now()).toArray().map(x=>JSON.parse(x.value));}
  async recoverMember(body) {
    const id=String(body.userId);if(!/^\d{1,16}$/.test(id)||!['group','federation'].includes(body.scope))throw Error('恢复参数无效');
    const result={queued:0,failed:0};
    if(body.scope==='federation')for(const record of this.userCases(id)){const reversed=await this.reverseCase(record.id);result.queued+=reversed.queued;result.failed+=reversed.failed;}
    const chats=body.scope==='group'?this.listChats().filter(x=>x.id===String(body.chatId)):[];
    if(body.scope==='group'&&!chats.length)throw Error('未找到已登记群');
    for(const chat of chats){const state=this.env.GUARD_STATE.getByName('chat:'+chat.id);if((await state.recoveryInfo(id)).ban){try{await state.queueManualUnban(id,'web-admin',null);result.queued++;}catch{result.failed++;}}}
    return {...result,note:'仅提交解封任务；请刷新处罚执行查看实际结果。联防撤销保留不属于本次操作的其他封禁。'};
  }
}
