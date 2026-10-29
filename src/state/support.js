import { supportOwner, supportContent } from '../support.js';
import { DAY } from './shared.js';
const clean=(s,max=100)=>String(s||'').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,' ').slice(0,max);
const say=(id,text,reply)=>({method:'sendMessage',params:{chat_id:Number(id),text,link_preview_options:{is_disabled:true},...(reply?{reply_parameters:{message_id:reply,allow_sending_without_reply:true}}:{})}});
const copy=(to,msg)=>({method:'copyMessage',params:{chat_id:Number(to),from_chat_id:msg.chat.id,message_id:msg.message_id}});
export class SupportMethods {
  async queueSupportMessage(updateId,msg){
    const owner=supportOwner(this.env),user=String(msg.from.id);
    if(!owner||!this.env.SUPPORT_BOT_TOKEN)throw Error('Support not configured');
    await this.schedule(Date.now()+200);
    const receipt='support:received:'+updateId;
    if(this.read(receipt))return {duplicate:true};
    // Every decision below is synchronous through durable enqueue. Concurrent
    // deliveries cannot race quota, blocking, mapping or update deduplication.
    const add=ops=>{
      const plan={ops,entry:{action:'support-relay'},support:{owner,user}};
      this.sql.exec('INSERT OR IGNORE INTO jobs(id,payload,plan,due,created) VALUES (?,?,?,?,?)','support:'+updateId,'{}',JSON.stringify(plan),Date.now(),Date.now());
      this.write(receipt,true,30*DAY);
      return {queued:true};
    };
    const text=String(msg.text||'').trim();
    if(user===owner){
      const target=msg.reply_to_message?this.read('support:map:'+owner+':'+msg.reply_to_message.message_id):null;
      if(/^\/start(?:@\w+)?(?:\s|$)/i.test(text)||text==='/help')return add([say(owner,'客服入口已准备好。用户发来的消息会转到这里。\n\n请使用 Telegram「回复」对应咨询消息，再发送文字、图片或文件，即可回复该用户。\n回复咨询并发送 /block 可屏蔽骚扰；/unblock 用户ID 可解除。请勿发送密码或验证码。')]);
      const unblock=text.match(/^\/unblock\s+([1-9]\d{0,15})$/);
      if(unblock){this.remove('support:block:'+unblock[1]);return add([say(owner,'已解除该用户的客服屏蔽。')]);}
      if(!target)return add([say(owner,'请先「回复」一条机器人转来的咨询消息。超过 30 天的对应记录可能已过期，不能直接指定其他人的用户名回复。',msg.message_id)]);
      if(text==='/block'){this.write('support:block:'+target.userId,true,3650*DAY);return add([say(owner,'已屏蔽该用户的客服消息。解除：/unblock '+target.userId,msg.message_id)]);}
      if(this.read('support:block:'+target.userId))return add([say(owner,'该用户已屏蔽。请先 /unblock '+target.userId,msg.message_id)]);
      if(!supportContent(msg))return add([say(owner,'暂不支持该类型，请使用文字、图片、语音、视频或文件。',msg.message_id)]);
      const op=copy(target.userId,msg);op.supportReply=true;
      const plan={ops:[op,say(owner,'✅ 回复已送达。',msg.message_id)],entry:{action:'support-reply'},support:{owner,user:String(target.userId)}};
      this.sql.exec('INSERT OR IGNORE INTO jobs(id,payload,plan,due,created) VALUES (?,?,?,?,?)','support:'+updateId,'{}',JSON.stringify(plan),Date.now(),Date.now());
      this.write(receipt,true,30*DAY);
      return {queued:true};
    }
    if(this.read('support:block:'+user))return {blocked:true};
    const quota=this.read('support:quota:'+user,{minute:0,m:0,day:0,d:0}),minute=Math.floor(Date.now()/60000),day=Math.floor(Date.now()/DAY);
    if(quota.minute!==minute){quota.minute=minute;quota.m=0;}if(quota.day!==day){quota.day=day;quota.d=0;}
    if(quota.m>=12||quota.d>=100){
      if(this.read('support:throttle:'+user))return {limited:true};
      this.write('support:throttle:'+user,true,60000);return add([say(user,'消息较多，请稍后再发；已转交的咨询不会丢失。')]);
    }
    quota.m++;quota.d++;this.write('support:quota:'+user,quota,2*DAY);
    const global=this.read('support:global',{minute,m:0});if(global.minute!==minute){global.minute=minute;global.m=0;}
    if(global.m>=100)return {limited:true};global.m++;this.write('support:global',global,120000);
    if(/^\/start(?:@\w+)?(?:\s|$)/i.test(text)||text==='/help')return add([say(user,'欢迎联系 Jason Select Support。\n请直接发送你的问题、订单号或截图，Jason 会通过本机器人回复。\n发送内容将转交给 Jason；请勿发送密码、登录验证码或银行卡完整信息。')]);
    if(!supportContent(msg))return add([say(user,'暂不支持该消息类型，请改发文字、图片、语音、视频或文件。')]);
    const header=say(owner,`📩 客服咨询\n用户：${clean([msg.from.first_name,msg.from.last_name].filter(Boolean).join(' '))||'未提供姓名'}${msg.from.username?' @'+clean(msg.from.username,32):''}\n用户 ID：${user}\n请「回复」本条或下面的消息，机器人会把回复发给这位用户。`);
    header.supportIncoming=true;
    const content=copy(owner,msg);content.supportIncoming=true;
    const ops=[header,{local:'support-map'},content,{local:'support-map'}];
    if(!this.read('support:ack:'+user)){this.write('support:ack:'+user,true,60000);ops.push(say(user,'✅ 消息已转交给 Jason，请等待回复。'));}
    return add(ops);
  }
  rememberSupportMessages(plan){
    for(const op of plan.ops){
      if(op.supportIncoming&&Number.isSafeInteger(op.result?.message_id))this.write('support:map:'+plan.support.owner+':'+op.result.message_id,{userId:plan.support.user},30*DAY);
    }
  }
  supportJobAllowed(plan){
    return !!this.env.SUPPORT_BOT_TOKEN&&plan?.support?.owner===supportOwner(this.env)
      &&(plan.support.user===plan.support.owner||!this.read('support:block:'+plan.support.user));
  }
}
