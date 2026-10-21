import { verifyWebhook } from '@waffo/pancake-ts';

const PAYMENT_EVENTS = new Set(['order.completed', 'subscription.payment_succeeded']);
const clean = (value, max = 160) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').trim().slice(0, max) : '';

export function waffoRecipient(env) {
  const id = String(env.WAFFO_NOTIFY_USER_ID || '').trim();
  return /^[1-9]\d{0,15}$/.test(id) && Number.isSafeInteger(Number(id))
    && (env.ADMIN_IDS || '').split(',').map(x => x.trim()).includes(id) ? id : null;
}

// Only called with a verified production envelope. Never retain buyer identities,
// billing details, metadata, or the full incoming payload in the notification queue.
export function waffoPayment(event) {
  if (!PAYMENT_EVENTS.has(event.eventType)) return null;
  const d = event.data;
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw Error('Invalid payment');
  const eventId = clean(event.eventId), orderId = clean(d.orderId), paymentId = clean(d.paymentId);
  if (!eventId || !orderId) throw Error('Missing payment identity');
  const amount = d.chargedAmount ?? d.amount;
  if (amount !== undefined && amount !== null && (typeof amount !== 'string' || !/^\d{1,18}(?:\.\d{1,8})?$/.test(amount))) throw Error('Invalid amount');
  // Zero-value card checks / free transactions are not incoming money.
  if (typeof amount === 'string' && /^0+(?:\.0+)?$/.test(amount)) return null;
  const currency = clean(d.currency, 12);
  if (!/^[A-Z]{3,10}$/.test(currency)) throw Error('Invalid currency');
  return {
    // A one-time order has one completed charge; recurring charges use paymentId
    // or eventId, never orderId alone (renewals share the same order).
    identity: event.eventType === 'order.completed' ? `order:${orderId}` : `payment:${paymentId || eventId}`,
    eventId, orderId, amount: amount ?? null, currency,
    timestamp: typeof event.timestamp === 'string' && Number.isFinite(Date.parse(event.timestamp)) ? new Date(event.timestamp).toISOString() : null,
    paymentId, recurring: event.eventType === 'subscription.payment_succeeded',
  };
}

export function waffoMessage(payment) {
  return [
    '💰 Waffo 收款成功',
    `金额：${payment.amount === null ? '官方未提供实收金额' : payment.amount + ' ' + payment.currency}`,
    `订单：${payment.orderId}`,
    ...(payment.paymentId ? [`支付编号：${payment.paymentId}`] : []),
    ...(payment.timestamp ? [`时间：${new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium', hour12: false }).format(new Date(payment.timestamp))}（北京时间）`] : []),
    ...(payment.recurring ? ['类型：订阅扣款成功'] : []),
    '状态：支付成功（不代表已结算或提现到账）',
  ].join('\n');
}

async function rawBody(request) {
  if (Number(request.headers.get('Content-Length')) > 128000) throw Error('Too large');
  const reader = request.body?.getReader();
  if (!reader) throw Error('Empty body');
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 128000) { await reader.cancel(); throw Error('Too large'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export async function waffoWebhook(request, env) {
  const response = (text, status = 200) => new Response(text, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  if (request.method !== 'POST') return response('Method not allowed', 405);
  if (env.WAFFO_NOTIFY_ENABLED !== 'true' || !env.WAFFO_STORE_ID || !waffoRecipient(env) || !env.BOT_TOKEN) return response('Not configured', 503);
  let raw;
  try { raw = await rawBody(request); } catch { return response('Invalid body', 400); }
  let event;
  try {
    event = verifyWebhook(raw, request.headers.get('x-waffo-signature'), {
      environment: 'prod',
      ...(env.WAFFO_WEBHOOK_PUBLIC_KEY ? { publicKey: env.WAFFO_WEBHOOK_PUBLIC_KEY } : {}),
    });
  } catch { return response('Invalid signature', 401); }
  if (event?.mode !== 'prod' || event.storeId !== env.WAFFO_STORE_ID) return response('Wrong event scope', 400);
  let payment;
  try { payment = waffoPayment(event); } catch { return response('Invalid payment', 400); }
  if (!payment) return response('Ignored');
  try {
    // Acknowledge only after durable persistence, not fire-and-forget waitUntil.
    await env.GUARD_STATE.getByName('waffo:payments').queueWaffoPayment(payment);
    return response('OK');
  } catch { return response('Retry later', 503); }
}
