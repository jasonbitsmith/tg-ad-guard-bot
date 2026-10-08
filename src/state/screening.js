// Member screening before any message is judged: the public CAS spammer
// list and ad text in a member's display name or bio.
// Methods are copied onto GuardState.prototype in ../state.js.
import { classify, normalize } from '../filters.js';
import { DAY } from './shared.js';

export class ScreeningMethods {
  // CAS (cas.chat) is a public list of accounts banned for spam across many
  // Telegram groups. Lookups fail open: an outage must never block members.
  async casListed(userId) {
    const key = `cas:${userId}`;
    const cached = this.read(key);
    if (cached !== null) return cached;
    try {
      const response = await fetch(`https://api.cas.chat/check?user_id=${Number(userId)}`, { signal: AbortSignal.timeout(2500) });
      if (!response.ok) throw new Error('CAS unavailable');
      const listed = (await response.json())?.ok === true;
      this.write(key, listed, listed ? 30 * DAY : DAY);
      return listed;
    } catch {
      this.write(key, false, 10 * 60000);
      return false;
    }
  }

  // A nickname alone never bans (see classify); here the name and bio must
  // together contain a blacklist keyword and reach the removal score, or match
  // a confirmed campaign or blocked domain.
  async profileVerdict(user, policy, tg) {
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
    const fingerprint = normalize(name);
    const key = `profile:${user.id}`;
    const cached = this.read(key);
    if (cached && cached.fingerprint === fingerprint) return cached.verdict;
    let bio = '';
    try { bio = String((await tg('getChat', { chat_id: user.id }))?.bio || '').slice(0, 300); } catch { /* Bio is optional. */ }
    let verdict = null;
    const text = [name, bio].filter(Boolean).join('\n');
    if (text) {
      const result = classify({ text }, policy.keywords, false, { allowlist: policy.domainAllowlist, denylist: policy.domainDenylist });
      if (result.permanentBan || result.blockedDomains.length || (result.hits.length && result.score >= 4)) verdict = { reasons: result.reasons.slice(0, 4), text: text.slice(0, 300) };
    }
    this.write(key, { fingerprint, verdict }, DAY);
    return verdict;
  }

  async screenMember(user, policy, tg) {
    if (!Number.isSafeInteger(user?.id) || user.is_bot || this.read(`allow:${user.id}`) || this.owners().includes(String(user.id))) return null;
    if (policy.casEnabled !== false && await this.casListed(user.id)) return { kind: 'cas', reasons: ['全网广告号黑名单（CAS）'] };
    if (policy.profileCheckEnabled !== false) {
      const profile = await this.profileVerdict(user, policy, tg);
      if (profile) return { kind: 'profile', reasons: ['昵称或简介含广告', ...profile.reasons], text: profile.text };
    }
    return null;
  }

  async screenBanPlan(chat, user, screen, messageIds, extra = {}) {
    const ops = messageIds.map(id => ({ method: 'deleteMessage', params: { chat_id: chat.id, message_id: id } }));
    ops.push({ method: 'banChatMember', params: { chat_id: chat.id, user_id: user.id, until_date: 0 } }, ...(extra.ops || []));
    const federationTargets = await this.env.GUARD_STATE.getByName('admin').federationTargets(chat.id);
    return { ops, entry: { chatId: chat.id, chatTitle: chat.title || '', userId: String(user.id), userName: [user.first_name, user.last_name].filter(Boolean).join(' '), messageId: messageIds[0], text: (extra.text ?? screen.text ?? '').slice(0, 300), reasons: screen.reasons, action: `${screen.kind}-${federationTargets.length ? 'federated-permanent-ban' : 'permanent-ban'}`, federationTargets } };
  }

  // Undo of a single-group ban from the owner's notice: unban and trust,
  // then report the real outcome back onto the notice.
  async queueManualUnban(userId, source, noticeId) {
    const chat = this.read('chat');
    if (!chat?.id) throw new Error('该群暂无记录，无法解封');
    this.allowMember(userId);
    const id = `owner-unban:${userId}:${Date.now()}`;
    const ops = [{ method: 'unbanChatMember', params: { chat_id: chat.id, user_id: Number(userId), only_if_banned: true } }];
    if (noticeId) ops.push({ local: 'notice-progress', noticeId, line: '✅ 解封成功，此人可以重新进群，且不会再被自动处理' });
    const plan = { ops, entry: { chatId: chat.id, chatTitle: chat.title || '', userId: String(userId), actorId: source, action: 'owner-undo-unban', noticeId, reasons: ['所有者撤销误封，已加入本群白名单'] } };
    await this.schedule(Date.now() + 100);
    this.sql.exec('INSERT OR IGNORE INTO jobs(id,payload,plan,due,created) VALUES (?,?,?,?,?)', id, '{}', JSON.stringify(plan), Date.now(), Date.now());
    return { queued: true };
  }
  // What this group knows about a member, for the owner's profile card.
  memberSummary(userId) {
    const profile = this.sql.exec('SELECT username,name,seen FROM member_profiles WHERE user_id=?', String(userId)).toArray()[0];
    const time = ts => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ts));
    const messages = this.sql.exec("SELECT ts,data FROM logs WHERE CAST(json_extract(data,'$.userId') AS TEXT)=? ORDER BY id DESC LIMIT 20", String(userId)).toArray()
      .map(row => ({ ts: row.ts, log: JSON.parse(row.data) })).filter(item => item.log.action && item.log.outcome !== 'retrying').slice(0, 5)
      .map(item => ({ time: time(item.ts), action: String(item.log.action), text: String(item.log.text || '').slice(0, 120) }));
    return { name: profile?.name || '', username: profile?.username || '', seen: profile?.seen || null, casListed: this.read(`cas:${userId}`) === true, messages };
  }
  // Trusted members skip spam checks and, on their next join, verification.
  allowMember(userId) { this.write(`allow:${userId}`, true); this.write(`verification-pass:${userId}`, true, 7 * DAY); return true; }
}
