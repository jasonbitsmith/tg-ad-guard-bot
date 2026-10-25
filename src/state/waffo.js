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
    const duplicate = !!this.read('waffo:receipt:' + key);
    this.write('waffo:last-received', { at: new Date().toISOString(), duplicate }, 400 * DAY);
    if (duplicate) return { duplicate: true };
    const plan = {
      ops: [{ method: 'sendMessage', params: { chat_id: Number(recipient), text: waffoMessage(payment), link_preview_options: { is_disabled: true } } }],
      entry: { action: 'waffo-payment-notification' },
    };
    this.sql.exec('INSERT OR IGNORE INTO jobs(id,payload,plan,due,created) VALUES (?,?,?,?,?)', 'waffo:' + key, '{}', JSON.stringify(plan), Date.now(), Date.now());
    this.write('waffo:receipt:' + key, true, 90 * DAY);
    return { duplicate: false };
  }

  // What the admin shows: when a verified payment last arrived, and whether
  // the last few notifications reached the owner's Telegram.
  waffoStatus() {
    const enabled = this.env.WAFFO_NOTIFY_ENABLED === 'true' && !!waffoRecipient(this.env);
    const recent = this.sql.exec("SELECT status,created,plan FROM jobs WHERE id LIKE 'waffo:%' ORDER BY created DESC LIMIT 5").toArray().map(row => {
      const op = row.plan ? JSON.parse(row.plan).ops?.find(x => x.error) : null;
      return { at: new Date(row.created).toISOString(), status: row.status, error: op?.error || null };
    });
    return { enabled, lastReceived: this.read('waffo:last-received'), recent };
  }
}
