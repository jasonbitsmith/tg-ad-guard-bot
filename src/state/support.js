import { supportOwner, supportContent } from '../support.js';
import { classify, DEFAULT_KEYWORDS } from '../filters.js';
import { DAY } from './shared.js';
const HOUR=3600000,HEADER_GAP=10*60000,ALBUM_WAIT=2000;
const clean=(s,max=100)=>String(s||'').replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g,' ').slice(0,max);
const say=(id,text,reply)=>({method:'sendMessage',params:{chat_id:Number(id),text,link_preview_options:{is_disabled:true},...(reply?{reply_parameters:{message_id:reply,allow_sending_without_reply:true}}:{})}});
const copy=(to,msg)=>({method:'copyMessage',params:{chat_id:Number(to),from_chat_id:msg.chat.id,message_id:msg.message_id}});
const isStart=text=>/^\/start(?:@\w+)?(?:\s|$)/i.test(text)||text==='/help';
const TIME=/^([01]\d|2[0-3]):[0-5]\d$/;
export const SUPPORT_DEFAULTS=Object.freeze({faq:[],hoursEnabled:true,start:'09:00',end:'23:00',offMessage:'现在是休息时间，Jason 上线后会第一时间回复你。',remindHours:2,templates:[],adFilter:true});
const OWNER_HELP='客服入口已准备好。用户发来的消息会转到这里。\n\n回复客户：用 Telegram「回复」对应咨询消息，再发文字、图片或文件。\n\n回复咨询时还可以发：\n/t 名字 发送快捷回复（只发 /t 查看全部名字）\n/done 不用回复，标记为已处理\n/block 屏蔽骚扰\n\n不用回复也能发：\n/pending 列出还在等你回复的客户\n/msg 用户ID 内容 主动给客户发消息\n/unblock 用户ID 解除屏蔽\n\n常见问题按钮、工作时间、提醒和快捷回复在管理后台「客服机器人」里设置。请勿发送密码或验证码。';
// Blocks of text separated by a blank line: first line is the title, the rest the body.
function parseBlocks(text,max,titleMax,bodyMax,label){
  const blocks=String(text||'').replace(/\r/g,'').split(/\n[ \t]*\n/).map(x=>x.trim()).filter(Boolean);
  if(blocks.length>max)throw Error(label+'最多 '+max+' 条');
  return blocks.map(block=>{
    const [title,...rest]=block.split('\n'),body=rest.join('\n').trim(),head=title.trim();
    if(!body)throw Error(label+'「'+head.slice(0,20)+'」下面要写内容');
    if(head.length>titleMax)throw Error(label+'「'+head.slice(0,20)+'」第一行太长，最多 '+titleMax+' 个字');
    if(body.length>bodyMax)throw Error(label+'「'+head.slice(0,20)+'」内容太长，最多 '+bodyMax+' 个字');
    return [head,body];
  });
}
const minuteOf=t=>Math.floor(((t+8*HOUR)%DAY)/60000);
const minutes=hhmm=>Number(hhmm.slice(0,2))*60+Number(hhmm.slice(3));
export function supportOffHours(settings,t=Date.now()){
  if(!settings.hoursEnabled)return false;
  const s=minutes(settings.start),e=minutes(settings.end),m=minuteOf(t);
  if(s===e)return false;
  return s<e?!(m>=s&&m<e):!(m>=s||m<e);
}
// The first working minute at or after t (Beijing time).
export function supportNextOpen(settings,t){
  if(!supportOffHours(settings,t))return t;
  return t+((minutes(settings.start)-minuteOf(t)+1440)%1440)*60000;
}
export class SupportMethods {
  supportConfig(){return {...SUPPORT_DEFAULTS,...this.read('support:settings',{})};}
  async supportSettings(){return this.supportConfig();}
  supportWaiting(){
    return this.sql.exec("SELECT key,value FROM records WHERE key LIKE 'support:waiting:%' AND expires>? ",Date.now()).toArray()
      .map(row=>({userId:row.key.slice('support:waiting:'.length),...JSON.parse(row.value)})).sort((a,b)=>a.since-b.since);
  }
  async supportAdmin(){return {settings:this.supportConfig(),waiting:this.supportWaiting().map(x=>({userId:x.userId,name:x.name,username:x.username,since:x.since}))};}
  async saveSupportSettings(body={}){
    const settings={
      faq:parseBlocks(body.faqText,8,30,1000,'常见问题').map(([q,a])=>({q,a})),
      templates:parseBlocks(body.templatesText,20,12,2000,'快捷回复').map(([name,text])=>({name,text})),
      hoursEnabled:body.hoursEnabled===true,start:String(body.start||''),end:String(body.end||''),
      offMessage:String(body.offMessage||'').trim(),remindHours:Number(body.remindHours),adFilter:body.adFilter===true,
    };
    for(const item of settings.faq)if(item.q.startsWith('/'))throw Error('常见问题不能用 / 开头');
    if(new Set(settings.faq.map(x=>x.q)).size!==settings.faq.length)throw Error('常见问题有重复');
    for(const item of settings.templates)if(!/^[\p{L}\p{N}_]+$/u.test(item.name))throw Error('快捷回复的名字「'+item.name+'」只能用文字、数字，不能有空格或符号');
    if(new Set(settings.templates.map(x=>x.name)).size!==settings.templates.length)throw Error('快捷回复的名字有重复');
    if(!TIME.test(settings.start)||!TIME.test(settings.end))throw Error('工作时间格式不对');
    if(!settings.offMessage||settings.offMessage.length>300)throw Error('不在线自动回复要写 1–300 个字');
    if(!Number.isInteger(settings.remindHours)||settings.remindHours<0||settings.remindHours>48)throw Error('提醒时间填 0–48 小时');
    this.write('support:settings',settings);
    return this.supportAdmin();
  }
  supportKeyboard(settings){
    if(!settings.faq.length)return {remove_keyboard:true};
    const rows=[];for(let i=0;i<settings.faq.length;i+=2)rows.push(settings.faq.slice(i,i+2).map(x=>({text:x.q})));
    return {keyboard:rows,resize_keyboard:true,is_persistent:true};
  }
  async queueSupportMessage(updateId,msg){
    const owner=supportOwner(this.env),user=String(msg.from.id),now=Date.now();
    if(!owner||!this.env.SUPPORT_BOT_TOKEN)throw Error('Support not configured');
    await this.schedule(now+200);
    const receipt='support:received:'+updateId;
    if(this.read(receipt))return {duplicate:true};
    // Every decision below is synchronous through durable enqueue. Concurrent
    // deliveries cannot race quota, blocking, mapping or update deduplication.
    const add=(ops,extra={},id='support:'+updateId,due=now)=>{
      const plan={ops,entry:{action:'support-relay'},support:{owner,user},...extra};
      this.sql.exec('INSERT OR IGNORE INTO jobs(id,payload,plan,due,created) VALUES (?,?,?,?,?)',id,'{}',JSON.stringify(plan),due,now);
      this.write(receipt,true,30*DAY);
      return {queued:true};
    };
    const text=String(msg.text||'').trim(),settings=this.supportConfig();
    if(user===owner){
      const target=msg.reply_to_message?this.read('support:map:'+owner+':'+msg.reply_to_message.message_id):null;
      if(isStart(text))return add([say(owner,OWNER_HELP)]);
      const unblock=text.match(/^\/unblock\s+([1-9]\d{0,15})$/);
      if(unblock){this.remove('support:block:'+unblock[1]);return add([say(owner,'已解除该用户的客服屏蔽。')]);}
      if(text==='/pending')return add(this.supportPendingOps(owner));
      const direct=text.match(/^\/msg\s+([1-9]\d{0,15})\s+([\s\S]+)$/);
      if(direct){
        if(direct[1]===owner)return add([say(owner,'不能给自己发。',msg.message_id)]);
        return this.supportReply(owner,direct[1],say(direct[1],direct[2].trim()),msg,add);
      }
      if(text.startsWith('/msg'))return add([say(owner,'用法：/msg 用户ID 要发的内容\n例如：/msg 123456789 你好，卡已经寄出。',msg.message_id)]);
      const quick=text.match(/^\/t(?:\s+(\S+))?$/);
      if(quick&&(!quick[1]||!settings.templates.some(x=>x.name===quick[1])))return add([say(owner,settings.templates.length?(quick[1]?'没有叫「'+clean(quick[1],20)+'」的快捷回复。':'')+'可用的快捷回复：'+settings.templates.map(x=>x.name).join('、')+'\n用法：回复客户消息，发 /t 名字':'还没有快捷回复，请到管理后台「客服机器人」里添加。',msg.message_id)]);
      if(!target)return add([say(owner,'请先「回复」一条机器人转来的咨询消息。超过 30 天的对应记录会过期，这时可以用 /msg 用户ID 内容 直接发。',msg.message_id)]);
      if(text==='/block'){this.write('support:block:'+target.userId,true,3650*DAY);this.remove('support:waiting:'+target.userId);return add([say(owner,'已屏蔽该用户的客服消息。解除：/unblock '+target.userId,msg.message_id)]);}
      if(text==='/done'){this.remove('support:waiting:'+target.userId);return add([say(owner,'已标记为处理完，不会再提醒。',msg.message_id)]);}
      if(quick){
        const item=settings.templates.find(x=>x.name===quick[1]);
        return this.supportReply(owner,target.userId,say(target.userId,item.text),msg,add,'✅ 已发送快捷回复「'+item.name+'」。');
      }
      if(!supportContent(msg))return add([say(owner,'暂不支持该类型，请使用文字、图片、语音、视频或文件。',msg.message_id)]);
      return this.supportReply(owner,target.userId,copy(target.userId,msg),msg,add);
    }
    if(this.read('support:block:'+user))return {blocked:true};
    const quota=this.read('support:quota:'+user,{minute:0,m:0,day:0,d:0}),minute=Math.floor(now/60000),day=Math.floor(now/DAY);
    if(quota.minute!==minute){quota.minute=minute;quota.m=0;}if(quota.day!==day){quota.day=day;quota.d=0;}
    if(quota.m>=12||quota.d>=100){
      if(this.read('support:throttle:'+user))return {limited:true};
      this.write('support:throttle:'+user,true,60000);return add([say(user,'消息较多，请稍后再发；已转交的咨询不会丢失。')]);
    }
    quota.m++;quota.d++;this.write('support:quota:'+user,quota,2*DAY);
    const global=this.read('support:global',{minute,m:0});if(global.minute!==minute){global.minute=minute;global.m=0;}
    if(global.m>=100)return {limited:true};global.m++;this.write('support:global',global,120000);
    if(isStart(text)){
      const welcome=say(user,'欢迎联系 Jason Select Support。\n'+(settings.faq.length?'常见问题可以直接点下面的按钮查看；其他问题请直接发送问题、订单号或截图，Jason 会通过本机器人回复。':'请直接发送你的问题、订单号或截图，Jason 会通过本机器人回复。')+'\n发送内容将转交给 Jason；请勿发送密码、登录验证码或银行卡完整信息。');
      welcome.params.reply_markup=this.supportKeyboard(settings);
      return add([welcome]);
    }
    const faq=text&&settings.faq.find(x=>x.q===text);
    if(faq){const answer=say(user,faq.a);answer.params.reply_markup=this.supportKeyboard(settings);return add([answer]);}
    if(!supportContent(msg))return add([say(user,'暂不支持该消息类型，请改发文字、图片、语音、视频或文件。')]);
    const name=clean([msg.from.first_name,msg.from.last_name].filter(Boolean).join(' '))||'未提供姓名';
    const username=typeof msg.from.username==='string'&&/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(msg.from.username)?msg.from.username:null;
    const who=name+(username?' @'+username:'');
    // Someone Jason has never answered who opens with an obvious ad is blocked
    // instead of being relayed; Jason only gets a one-line notice.
    if(settings.adFilter&&!this.read('support:known:'+user)&&classify(msg,DEFAULT_KEYWORDS).permanentBan){
      this.write('support:block:'+user,{ad:true,at:now},3650*DAY);this.remove('support:waiting:'+user);
      return add([say(owner,'🚫 已拦截一条疑似广告，并屏蔽了发送者\n用户：'+who+'\n用户 ID：'+user+(msg.text||msg.caption?'\n内容开头：'+clean(msg.text||msg.caption,80):'')+'\n如果拦错了，发 /unblock '+user)],{support:{owner,user:owner}});
    }
    const ops=[];
    // A header only when the conversation switches to this customer or has
    // gone quiet; consecutive messages from one person arrive as plain copies.
    const last=this.read('support:last-sender');
    if(last?.user!==user||now-last.at>HEADER_GAP){
      const header=say(owner,`📩 客服咨询\n用户：${who}\n用户 ID：${user}\n请「回复」本条或下面的消息，机器人会把回复发给这位用户。`);
      header.params.reply_markup={inline_keyboard:[[{text:'👤 查看用户',url:username?'https://t.me/'+username:'tg://user?id='+user}]]};
      header.supportIncoming=true;ops.push(header,{local:'support-map'});
    }
    this.write('support:last-sender',{user,at:now},DAY);
    let jobId='support:'+updateId,due=now;
    if(msg.media_group_id){
      const key='support:album:'+user+':'+clean(msg.media_group_id,40),album=this.read(key);
      // Later photos of an album join the copy job opened by the first one.
      if(album){album.ids.push(msg.message_id);this.write(key,album,60000);this.write(receipt,true,30*DAY);return {queued:true};}
      this.write(key,{ids:[msg.message_id]},60000);
      ops.push({local:'support-album',key},{method:'copyMessages',params:{chat_id:Number(owner),from_chat_id:msg.chat.id,message_ids:[]},supportIncoming:true},{local:'support-map'});
      jobId='support:later:'+updateId;due=now+ALBUM_WAIT;
    } else {const content=copy(owner,msg);content.supportIncoming=true;ops.push(content,{local:'support-map'});}
    if(supportOffHours(settings,now)){
      if(!this.read('support:offack:'+user)){this.write('support:offack:'+user,true,6*HOUR);this.write('support:ack:'+user,true,60000);ops.push(say(user,settings.offMessage+'\n（工作时间：北京时间 '+settings.start+'–'+settings.end+'）'));}
    } else if(!this.read('support:ack:'+user)){this.write('support:ack:'+user,true,60000);ops.push(say(user,'✅ 消息已转交给 Jason，请等待回复。'));}
    if(!this.read('support:waiting:'+user)){
      this.write('support:waiting:'+user,{since:now,name,username},30*DAY);
      if(settings.remindHours>0)this.supportRemind(owner,user,who,now,supportNextOpen(settings,now+settings.remindHours*HOUR),settings.remindHours);
    }
    return add(ops,{},jobId,due);
  }
  supportRemind(owner,user,who,since,due,hours){
    const note=say(owner,`⏰ 有客户等你回复超过 ${hours} 小时了\n用户：${who}\n用户 ID：${user}\n直接「回复」这条就能回他；不用回的话回复 /done。`);
    note.supportIncoming=true;
    const plan={ops:[note,{local:'support-map'}],entry:{action:'support-remind'},support:{owner,user},remind:{since}};
    this.sql.exec('INSERT OR IGNORE INTO jobs(id,payload,plan,due,created) VALUES (?,?,?,?,?)','support:later:remind:'+user+':'+since,'{}',JSON.stringify(plan),due,Date.now());
  }
  supportPendingOps(owner){
    const waiting=this.supportWaiting();
    if(!waiting.length)return [say(owner,'✅ 目前没有等你回复的客户。')];
    const ops=[say(owner,`共有 ${waiting.length} 位客户等你回复${waiting.length>10?'，下面是等得最久的 10 位':''}。直接「回复」下面某一条就能回那位客户；不用回的回复 /done。`)];
    for(const item of waiting.slice(0,10)){
      const hours=Math.floor((Date.now()-item.since)/HOUR),wait=hours?hours+' 小时':Math.max(1,Math.floor((Date.now()-item.since)/60000))+' 分钟';
      const note=say(owner,`⏳ 已等 ${wait}\n用户：${item.name||'未提供姓名'}${item.username?' @'+item.username:''}\n用户 ID：${item.userId}`);
      note.supportIncoming=true;note.supportUser=item.userId;ops.push(note);
    }
    ops.push({local:'support-map'});
    return ops;
  }
  supportReply(owner,userId,op,msg,add,done='✅ 回复已送达。'){
    if(this.read('support:block:'+userId))return add([say(owner,'该用户已屏蔽。请先 /unblock '+userId,msg.message_id)]);
    // Answering a customer ends their wait and marks them as a real contact.
    this.remove('support:waiting:'+userId);this.write('support:known:'+userId,true,365*DAY);
    return add([op,say(owner,done,msg.message_id)],{entry:{action:'support-reply'},support:{owner,user:String(userId)}});
  }
  fillSupportAlbum(op,plan){
    const album=this.read(op.key),index=plan.ops.indexOf(op),target=plan.ops[index+1];
    this.remove(op.key);
    target.params.message_ids=[...new Set(album?.ids||[])].sort((a,b)=>a-b).slice(0,100);
    if(!target.params.message_ids.length){target.skipped='相册已处理';target.done=true;}
  }
  async sendSupportHeader(tg,op){
    try{return await tg('sendMessage',op.params);}
    catch(error){
      // Some accounts cannot be mentioned by ID because of Telegram privacy.
      // Only a definite rejection of this user button permits a safe resend.
      if(error.code!==400||!op.params.reply_markup||!/BUTTON_USER_PRIVACY_RESTRICTED|BUTTON_USER_INVALID|USER_ID_INVALID/i.test(error.message))throw error;
      delete op.params.reply_markup;
      return tg('sendMessage',op.params);
    }
  }
  rememberSupportMessages(plan){
    for(const op of plan.ops){
      if(!op.supportIncoming)continue;
      const ids=Array.isArray(op.result)?op.result.map(x=>x?.message_id):[op.result?.message_id];
      for(const id of ids)if(Number.isSafeInteger(id))this.write('support:map:'+plan.support.owner+':'+id,{userId:op.supportUser||plan.support.user},30*DAY);
    }
  }
  supportJobAllowed(plan){
    return !!this.env.SUPPORT_BOT_TOKEN&&plan?.support?.owner===supportOwner(this.env)
      &&(plan.support.user===plan.support.owner||!this.read('support:block:'+plan.support.user))
      // A reminder is dropped once the customer has been answered.
      &&(!plan.remind||this.read('support:waiting:'+plan.support.user)?.since===plan.remind.since);
  }
}
