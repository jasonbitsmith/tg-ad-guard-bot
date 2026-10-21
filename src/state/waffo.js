import { digest } from '../telegram.js';
import { waffoRecipient, waffoMessage } from '../waffo.js';
import { DAY } from './shared.js';

export class WaffoMethods {
  async queueWaffoPayment(payment) {
    const recipient = waffoRecipient(this.env);
    if (this.env.WAFFO_NOTIFY_ENABLED !== 'true' || !recipient) throw Error('Payment notifications disabled');
    const key = await digest(`${this.env.WAFFO_STORE_ID}:prod:${payment.identity}:${recipient}`);
    // Schedule before acknowledging. Recheck after the await, so concurrent
    // duplicate deliveries cannot both insert a plan or reset its progress.
    await this.schedule(Date.now() + 200);
    if (this.read('waffo:receipt:' + key)) return { duplicate: true };
    const plan = {
      ops: [{ method: 'sendMessage', params: { chat_id: Number(recipient), text: waffoMessage(payment), link_preview_options: { is_disabled: true } } }],
      entry: { action: 'waffo-payment-notification' },
    };
    this.sql.exec('INSERT OR IGNORE INTO jobs(id,payload,plan,due,created) VALUES (?,?,?,?,?)', 'waffo:' + key, '{}', JSON.stringify(plan), Date.now(), Date.now());
    this.write('waffo:receipt:' + key, true, 90 * DAY);
    return { duplicate: false };
  }
}
