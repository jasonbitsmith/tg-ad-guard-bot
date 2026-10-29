import { secureEqual } from './telegram.js';

export function supportOwner(env) {
  const id=String(env.SUPPORT_OWNER_ID||'').trim();
  return /^[1-9]\d{0,15}$/.test(id)&&Number.isSafeInteger(Number(id))&&(env.ADMIN_IDS||'').split(',').map(x=>x.trim()).includes(id)?id:null;
}
export const supportContent = msg => !!(msg.text||msg.photo||msg.video||msg.document||msg.voice||msg.audio||msg.sticker||msg.animation||msg.video_note);
export async function supportWebhook(request,env){
  const reply=(text,status=200)=>new Response(text,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  if(request.method!=='POST')return reply('Method not allowed',405);
  if(!env.SUPPORT_BOT_TOKEN||!env.SUPPORT_WEBHOOK_SECRET||!supportOwner(env)||!env.GUARD_STATE)return reply('Not configured',503);
  if(!await secureEqual(request.headers.get('X-Telegram-Bot-Api-Secret-Token'),env.SUPPORT_WEBHOOK_SECRET))return reply('Forbidden',403);
  let update;
  try{
    const reader=request.body?.getReader();if(!reader)throw Error();
    let size=0;const chunks=[];
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>128000){await reader.cancel();throw Error();}chunks.push(value);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    update=JSON.parse(new TextDecoder().decode(bytes));
  }catch{return reply('Invalid body',400);}
  if(!Number.isSafeInteger(update?.update_id)||update.update_id<0)return reply('Invalid update',400);
  // Edits and all group/channel traffic are deliberately ignored.
  const msg=update.message;
  if(!msg||msg.chat?.type!=='private'||msg.from?.is_bot)return reply('Ignored');
  if(!Number.isSafeInteger(msg.chat.id)||msg.chat.id<=0||msg.from?.id!==msg.chat.id||!Number.isSafeInteger(msg.message_id)||msg.message_id<=0)return reply('Invalid message',400);
  try{await env.GUARD_STATE.getByName('support:inbox').queueSupportMessage(update.update_id,msg);return reply('OK');}
  catch{return reply('Retry later',503);}
}
