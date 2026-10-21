import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions, Response as MFResponse } from 'miniflare';
import { waffoPayment, waffoMessage, waffoRecipient, waffoBotToken } from '../src/waffo.js';

const payment = (data = {}) => ({ eventType: 'order.completed', eventId: 'pay-1', mode: 'prod', storeId: 'STO_test', data: { orderId: 'ORD_test', paymentId: 'PAY_test', currency: 'USD', chargedAmount: '12.90', ...data } });

test('Waffo 收款金额使用实收，不将标价或零元验卡当成到账金额', () => {
  assert.equal(waffoPayment(payment({ chargedAmount:'3.50', total:'12.90', buyerEmail:'private@example.test' })).amount,'3.50');
  assert.equal(waffoPayment(payment({chargedAmount:'0.00'})),null);
  assert.equal(waffoPayment({...payment(),eventType:'refund.succeeded'}),null);
  const missing=waffoPayment(payment({chargedAmount:undefined,total:'99.00'}));
  assert.equal(missing.amount,null);
  assert.match(waffoMessage(missing),/未提供实收金额/);
  assert.doesNotMatch(JSON.stringify(missing),/buyerEmail|99.00/);
  assert.throws(()=>waffoPayment(payment({chargedAmount:'NaN'})));
  assert.equal(waffoRecipient({ADMIN_IDS:'99',WAFFO_NOTIFY_USER_ID:'-100123'}),null);
  assert.equal(waffoRecipient({ADMIN_IDS:'99',WAFFO_NOTIFY_USER_ID:'88'}),null);
  assert.equal(waffoRecipient({ADMIN_IDS:'99',WAFFO_NOTIFY_USER_ID:'99'}),'99');
  assert.equal(waffoBotToken({BOT_TOKEN:'guard',WAFFO_BOT_TOKEN:'orders'}),'orders');
  assert.equal(waffoBotToken({BOT_TOKEN:'guard'}),'guard');
  const a=waffoPayment({...payment(),eventType:'subscription.payment_succeeded'});
  const b=waffoPayment({...payment({paymentId:'PAY_renewal'}),eventType:'subscription.payment_succeeded'});
  assert.notEqual(a.identity,b.identity,'同一订阅的后续扣款仍通知');
});

test('Waffo 真实 RSA 验签、持久队列、重复回调与 Telegram 重试', async t => {
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const wrapper=`import worker, {GuardState as Base} from './index.js';
    export class GuardState extends Base {
      async alarm() {} // drive jobs explicitly; no background timing races
      async drainWaffoTest(){for(const job of this.sql.exec("SELECT * FROM jobs WHERE status='pending' AND id LIKE 'waffo:%'").toArray())await this.runJob(job);return this.sql.exec('SELECT id,status,attempts FROM jobs').toArray();}
      waffoRecordsTest(){return this.sql.exec('SELECT * FROM jobs').toArray();}
      disableWaffoTest(){this.env.WAFFO_NOTIFY_ENABLED='false';}
    }
    export default worker;`;
  const calls=[]; let fail=true;
  const mf=new Miniflare(convertV4MiniflareOptions({
    compatibilityDate:'2026-09-22',compatibilityFlags:['nodejs_compat'],
    modules:[{type:'ESModule',path:'wrapper.js',contents:wrapper},{type:'ESModule',path:'index.js',contents:await readFile(new URL('../dist/index.js',import.meta.url),'utf8')}],
    durableObjects:{GUARD_STATE:{className:'GuardState',useSQLite:true}},kvNamespaces:['BOT_KV'],
    bindings:{BOT_TOKEN:'fake',WAFFO_BOT_TOKEN:'orderfake',ADMIN_IDS:'99',WAFFO_NOTIFY_ENABLED:'true',WAFFO_NOTIFY_USER_ID:'99',WAFFO_STORE_ID:'STO_test',WAFFO_WEBHOOK_PUBLIC_KEY:publicKey.export({type:'spki',format:'pem'}).toString()},
    outboundService:async request=>{
      assert.equal(new URL(request.url).hostname,'api.telegram.org');
      if(new URL(request.url).pathname!=='/botorderfake/sendMessage') throw Error('收款通知错误地使用群管 Token');
      const params=await request.json();calls.push(params);
      if(fail){fail=false;return MFResponse.json({ok:false,error_code:429,description:'rate limit',parameters:{retry_after:1}},{status:429});}
      return MFResponse.json({ok:true,result:{message_id:77}});
    },
  }));
  t.after(()=>mf.dispose());
  const ns=await mf.getDurableObjectNamespace('GUARD_STATE'),state=ns.getByName('waffo:payments');
  const send=async(event,options={})=>{
    const raw=JSON.stringify(event),stamp=String(options.timestamp??Date.now());
    const signature=sign('RSA-SHA256',Buffer.from(stamp+'.'+raw),privateKey).toString('base64');
    return mf.dispatchFetch('https://bot.test/webhooks/waffo',{method:'POST',headers:{'Content-Type':'application/json','x-waffo-signature':`t=${stamp},v1=${options.bad?'bad':signature}`},body:raw});
  };
  assert.equal((await send(payment(),{bad:true})).status,401);
  assert.equal((await send(payment(),{timestamp:Date.now()-3600000})).status,401);
  assert.equal((await send({...payment(),storeId:'STO_other'})).status,400);
  assert.equal((await send({...payment(),mode:'test'})).status,400);
  assert.equal((await send({...payment(),eventType:'subscription.activated'})).status,200);
  assert.equal((await send(payment({chargedAmount:'0.00'}))).status,200);
  assert.equal((await state.waffoRecordsTest()).length,0);
  const event=payment({buyerEmail:'private@example.test',billingDetail:{address:'secret street'}});
  const responses=await Promise.all([send(event),send({...event,id:'different-delivery-id'}),send(event)]);
  assert.ok(responses.every(r=>r.status===200));
  assert.equal((await state.waffoRecordsTest()).length,1);
  assert.doesNotMatch(JSON.stringify(await state.waffoRecordsTest()),/private@example|secret street/);
  let jobs=await state.drainWaffoTest();assert.equal(jobs[0].status,'pending');assert.equal(jobs[0].attempts,1);
  jobs=await state.drainWaffoTest();assert.equal(jobs[0].status,'done');assert.equal(calls.length,2);
  assert.ok(calls.every(x=>x.chat_id===99));assert.match(calls[1].text,/12.90 USD/);
  await send(event);await state.drainWaffoTest();assert.equal(calls.length,2,'成功后重放不再次通知');
  // A pending notice must not reach old recipients after disabling.
  await send(payment({orderId:'ORD_2'}));await state.disableWaffoTest();await state.drainWaffoTest();
  assert.equal(calls.length,2);
});
