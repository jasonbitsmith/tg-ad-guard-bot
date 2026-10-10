// Group activity statistics and scheduled announcements.
// Methods are copied onto GuardState.prototype in ../state.js.
import { telegram } from '../telegram.js';
import { DAY } from './shared.js';

const MAX_ANNOUNCEMENTS = 10;
const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
// Beijing calendar day, e.g. 2026-10-09.
export const beijingDay = (time = Date.now()) => new Date(time + 8 * 3600000).toISOString().slice(0, 10);
const beijingMinutes = (time = Date.now()) => { const date = new Date(time + 8 * 3600000); return date.getUTCHours() * 60 + date.getUTCMinutes(); };
const beijingWeekday = (time = Date.now()) => new Date(time + 8 * 3600000).getUTCDay();
const minutesOf = value => { const [hour, minute] = String(value).split(':').map(Number); return hour * 60 + minute; };

export function normalizeAnnouncement(item) {
  const time = String(item?.time || '').trim(), text = String(item?.text || '').trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('请填写有效的发送时间，例如 09:00');
  if (!text || text.length > 2000) throw new Error('公告内容不能为空，且不超过 2000 个字');
  const id = /^[a-f0-9-]{8,40}$/.test(String(item?.id || '')) ? String(item.id) : crypto.randomUUID();
  // Weekdays as getUTCDay numbers (0 = Sunday); missing means every day.
  const days = item?.days === undefined ? [0, 1, 2, 3, 4, 5, 6] : [...new Set(Array.isArray(item.days) ? item.days.map(Number) : [])].filter(day => Number.isInteger(day) && day >= 0 && day <= 6).sort();
  if (!days.length) throw new Error('请至少选择一天');
  return { id, time, days, text, enabled: item?.enabled !== false, replacePrevious: item?.replacePrevious !== false, pin: item?.pin === true };
}

export class CommunityMethods {
  activityTables() {
    if (this.activityReady) return;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS activity (day TEXT NOT NULL, user_id TEXT NOT NULL, messages INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(day,user_id));
      CREATE TABLE IF NOT EXISTS activity_days (day TEXT PRIMARY KEY, joins INTEGER NOT NULL DEFAULT 0, leaves INTEGER NOT NULL DEFAULT 0);`);
    this.activityReady = true;
  }
  countMessage(userId, time = Date.now()) {
    this.activityTables();
    this.sql.exec('INSERT INTO activity(day,user_id,messages) VALUES (?,?,1) ON CONFLICT(day,user_id) DO UPDATE SET messages=messages+1', beijingDay(time), String(userId));
  }
  countMembers(field, count, time = Date.now()) {
    if (!count || !['joins', 'leaves'].includes(field)) return;
    this.activityTables();
    this.sql.exec(`INSERT INTO activity_days(day,${field}) VALUES (?,?) ON CONFLICT(day) DO UPDATE SET ${field}=${field}+excluded.${field}`, beijingDay(time), count);
  }
  // Activity between two Beijing days, inclusive.
  activityStats(from, to) {
    this.activityTables();
    const totals = this.sql.exec('SELECT COALESCE(SUM(messages),0) AS messages, COUNT(DISTINCT user_id) AS speakers FROM activity WHERE day>=? AND day<=?', from, to).toArray()[0];
    const members = this.sql.exec('SELECT COALESCE(SUM(joins),0) AS joins, COALESCE(SUM(leaves),0) AS leaves FROM activity_days WHERE day>=? AND day<=?', from, to).toArray()[0];
    const top = this.sql.exec('SELECT a.user_id AS userId, SUM(a.messages) AS messages, p.name AS name, p.username AS username FROM activity a LEFT JOIN member_profiles p ON p.user_id=a.user_id WHERE a.day>=? AND a.day<=? GROUP BY a.user_id ORDER BY messages DESC LIMIT 10', from, to).toArray()
      .map(row => ({ userId: row.userId, name: row.name || '', username: row.username || '', messages: Number(row.messages) }));
    return { from, to, messages: Number(totals.messages), speakers: Number(totals.speakers), joins: Number(members.joins), leaves: Number(members.leaves), top };
  }
  pruneActivity() {
    if (this.read('activity-pruned')) return;
    this.write('activity-pruned', true, DAY);
    this.activityTables();
    const cutoff = beijingDay(Date.now() - 90 * DAY);
    this.sql.exec('DELETE FROM activity WHERE day<?', cutoff);
    this.sql.exec('DELETE FROM activity_days WHERE day<?', cutoff);
  }
  // Global object: Monday 09:00 Beijing, last Monday–Sunday for every group.
  async sendWeeklyReport(now = Date.now()) {
    const local = new Date(now + 8 * 3600000);
    if (local.getUTCDay() !== 1 || local.getUTCHours() < 9) return false;
    const today = beijingDay(now), key = `weekly-report:${today}`;
    if (this.read(key, false) || this.weeklyReporting) return false;
    this.weeklyReporting = true;
    try {
      const from = beijingDay(now - 7 * DAY), to = beijingDay(now - DAY);
      const chats = this.listChats();
      const results = await Promise.allSettled(chats.map(chat => this.env.GUARD_STATE.getByName('chat:' + chat.id).activityStats(from, to)));
      const groups = chats.map((chat, index) => ({ chat, stats: results[index].status === 'fulfilled' ? results[index].value : null })).filter(item => item.stats && (item.stats.messages || item.stats.joins || item.stats.leaves));
      const short = day => day.slice(5).replace('-', '/');
      const lines = [`📊 <b>群活跃周报</b>｜${short(from)} – ${short(to)}`];
      if (!groups.length) lines.push('', '本周各群都没有发言或进出记录。');
      for (const { chat, stats } of groups.sort((a, b) => b.stats.messages - a.stats.messages)) {
        lines.push('', `🏠 <b>${esc(chat.title)}</b>`, `💬 发言 ${stats.messages} 条 · ${stats.speakers} 人说过话`, `👥 新进 ${stats.joins} 人 · 退出 ${stats.leaves} 人`);
        const top = stats.top.slice(0, 5).map((item, index) => `${['🥇', '🥈', '🥉', '4.', '5.'][index]} ${esc(item.name || (item.username ? '@' + item.username : item.userId))}：${item.messages} 条`);
        if (top.length) lines.push(...top);
      }
      lines.push(...this.linkReportLines(from, to));
      const text = lines.join('\n').slice(0, 4000);
      const tg = telegram(this.env.BOT_TOKEN), recipients = this.ownerChats();
      const sent = await Promise.allSettled(recipients.map(chatId => tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true })));
      const ok = sent.some(item => item.status === 'fulfilled');
      if (ok) this.write(key, true, 8 * DAY);
      this.log({ action: 'weekly-report', outcome: ok ? 'success' : 'retrying', text: `${from}~${to}`, recipients: recipients.length });
      return ok;
    } finally { this.weeklyReporting = false; }
  }

  async editAnnouncement(action, item) {
    const config = await this.config();
    const list = Array.isArray(config.announcements) ? config.announcements : [];
    if (action === 'remove') config.announcements = list.filter(entry => entry.id !== String(item?.id || ''));
    else if (action === 'upsert') {
      const next = normalizeAnnouncement(item), rest = list.filter(entry => entry.id !== next.id);
      if (rest.length >= MAX_ANNOUNCEMENTS) throw new Error(`每个群最多 ${MAX_ANNOUNCEMENTS} 条定时公告`);
      config.announcements = [...rest, next].sort((a, b) => a.time.localeCompare(b.time));
    } else throw new Error('无效公告操作');
    this.saveConfig(config, '定时公告');
    this.log({ action: `announcement-${action}`, actorId: 'web-admin', outcome: 'success', text: String(item?.time || item?.id || '') });
    await this.schedule(Date.now() + 1000);
    return { announcements: config.announcements };
  }
  // Runs from the group alarm (every minute while any announcement is on).
  // A late alarm still sends within 15 minutes of the set time, once a day.
  async announceTick(now = Date.now()) {
    const config = await this.config(), chat = this.read('chat');
    const list = (config.announcements || []).filter(item => item.enabled);
    if (!list.length || !chat?.id) return 0;
    const today = beijingDay(now), weekday = beijingWeekday(now), minutes = beijingMinutes(now), tg = telegram(this.env.BOT_TOKEN);
    let sent = 0;
    for (const item of list) {
      const late = minutes - minutesOf(item.time), key = `announce:${item.id}`, last = this.read(key, {});
      if (late < 0 || late > 15 || last.day === today || !(item.days || [0, 1, 2, 3, 4, 5, 6]).includes(weekday)) continue;
      // Mark first so a slow send never posts twice.
      this.write(key, { ...last, day: today }, 30 * DAY);
      try {
        const result = await tg('sendMessage', { chat_id: chat.id, text: item.text, disable_web_page_preview: true });
        if (item.replacePrevious && last.messageId) await tg('deleteMessage', { chat_id: chat.id, message_id: last.messageId }).catch(() => {});
        if (item.pin) await tg('pinChatMessage', { chat_id: chat.id, message_id: result.message_id, disable_notification: true }).catch(() => {});
        this.write(key, { day: today, messageId: result.message_id }, 30 * DAY);
        sent++;
        this.log({ chatId: chat.id, chatTitle: chat.title || '', action: 'announcement-sent', outcome: 'success', text: item.text.slice(0, 80), reasons: [`北京时间 ${item.time}`] });
      } catch (error) {
        // Not sent: allow another try on the next tick inside the window.
        this.write(key, last, 30 * DAY);
        this.log({ chatId: chat.id, chatTitle: chat.title || '', action: 'announcement-sent', outcome: 'failed', error: String(error.message || '').slice(0, 200), reasons: [`北京时间 ${item.time}`] });
      }
    }
    return sent;
  }
}
