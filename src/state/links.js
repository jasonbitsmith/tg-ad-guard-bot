// Affiliate short links: https://<bot domain>/go/<slug> redirects to the real
// affiliate URL and counts the click. Lives on the global "admin" object.
// Methods are copied onto GuardState.prototype in ../state.js.
import { DAY } from './shared.js';
import { beijingDay } from './community.js';

const MAX_LINKS = 200;
const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
// Link previews and crawlers fetch the URL without a person clicking it.
const AUTOMATED = /bot|crawl|spider|preview|facebookexternalhit|slurp|curl|wget|python|headless/i;

export const linkBase = env => String(env.PUBLIC_URL || 'https://bot.jasonselect.com').replace(/\/+$/, '');
export const isAutomatedClient = userAgent => !userAgent || AUTOMATED.test(userAgent);

export function normalizeSlug(value) {
  const slug = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(slug)) throw new Error('短链接名称只能用英文字母、数字和横线，最多 40 个字符，例如 dmit 或 bwg-cn2');
  return slug;
}
export function normalizeTarget(value) {
  let url;
  try { url = new URL(String(value ?? '').trim()); } catch { throw new Error('请填写完整的推广链接，以 https:// 开头'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 2000) throw new Error('推广链接必须以 https:// 开头，且不超过 2000 个字符');
  return url.href;
}

export class LinksMethods {
  linkTables() {
    if (this.linksReady) return;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS short_links (slug TEXT PRIMARY KEY, target TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', auto INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS link_clicks (slug TEXT NOT NULL, day TEXT NOT NULL, clicks INTEGER NOT NULL DEFAULT 0, visitors INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(slug,day));
      CREATE TABLE IF NOT EXISTS link_visitors (slug TEXT NOT NULL, day TEXT NOT NULL, visitor TEXT NOT NULL, PRIMARY KEY(slug,day,visitor));`);
    this.linksReady = true;
  }
  // Clicks per link between two Beijing days, inclusive.
  linkStats(from, to) {
    this.linkTables();
    return this.sql.exec(`SELECT l.slug, l.target, l.note, l.auto, l.created, COALESCE(SUM(c.clicks),0) AS clicks, COALESCE(SUM(c.visitors),0) AS visitors
      FROM short_links l LEFT JOIN link_clicks c ON c.slug=l.slug AND c.day>=? AND c.day<=? GROUP BY l.slug ORDER BY clicks DESC, l.slug`, from, to).toArray()
      .map(row => ({ slug: row.slug, target: row.target, note: row.note, auto: !!row.auto, created: row.created, clicks: Number(row.clicks), visitors: Number(row.visitors) }));
  }
  listLinks(now = Date.now()) {
    const today = beijingDay(now), week = this.linkStats(beijingDay(now - 6 * DAY), today), month = this.linkStats(beijingDay(now - 29 * DAY), today);
    const todayStats = new Map(this.linkStats(today, today).map(row => [row.slug, row])), monthStats = new Map(month.map(row => [row.slug, row]));
    const base = linkBase(this.env);
    return { base, links: week.map(row => ({ ...row, url: `${base}/go/${row.slug}`, today: todayStats.get(row.slug)?.clicks || 0, week: row.clicks, weekVisitors: row.visitors, month: monthStats.get(row.slug)?.clicks || 0 })) };
  }
  editLink(action, item) {
    this.linkTables();
    const slug = normalizeSlug(item?.slug);
    if (action === 'remove') {
      this.sql.exec('DELETE FROM short_links WHERE slug=?', slug);
      this.sql.exec('DELETE FROM link_clicks WHERE slug=?', slug);
      this.sql.exec('DELETE FROM link_visitors WHERE slug=?', slug);
    } else if (action === 'upsert') {
      const target = normalizeTarget(item?.target), note = String(item?.note ?? '').trim().slice(0, 60);
      const exists = this.sql.exec('SELECT 1 FROM short_links WHERE slug=?', slug).toArray().length;
      if (!exists && this.sql.exec('SELECT COUNT(*) AS n FROM short_links').toArray()[0].n >= MAX_LINKS) throw new Error(`最多 ${MAX_LINKS} 个短链接`);
      this.sql.exec('INSERT INTO short_links(slug,target,note,auto,created) VALUES (?,?,?,0,?) ON CONFLICT(slug) DO UPDATE SET target=excluded.target,note=excluded.note,auto=0', slug, target, note, Date.now());
    } else throw new Error('无效短链接操作');
    this.log({ action: `short-link-${action}`, actorId: 'web-admin', outcome: 'success', text: slug });
    return this.listLinks();
  }
  // Links created by the bot itself (DMIT restock buttons). A link the owner
  // edited by hand (auto=0) keeps the owner's target.
  autoLink(slug, target, note) {
    this.linkTables();
    slug = normalizeSlug(slug); target = normalizeTarget(target);
    this.sql.exec("INSERT INTO short_links(slug,target,note,auto,created) VALUES (?,?,?,1,?) ON CONFLICT(slug) DO UPDATE SET target=excluded.target,note=excluded.note WHERE short_links.auto=1", slug, target, String(note).slice(0, 60), Date.now());
    return `${linkBase(this.env)}/go/${slug}`;
  }
  // Returns the target for a slug and counts the visit. `visitor` is a hash
  // (never a raw IP) used only to count distinct visitors per day.
  openLink(slug, visitor, count = true, now = Date.now()) {
    this.linkTables();
    let key;
    try { key = normalizeSlug(slug); } catch { return null; }
    const row = this.sql.exec('SELECT target FROM short_links WHERE slug=?', key).toArray()[0];
    if (!row) return null;
    if (count) {
      const day = beijingDay(now);
      let fresh = 0;
      if (visitor) {
        const id = String(visitor).slice(0, 64);
        if (!this.sql.exec('SELECT 1 FROM link_visitors WHERE slug=? AND day=? AND visitor=?', key, day, id).toArray().length) {
          this.sql.exec('INSERT INTO link_visitors(slug,day,visitor) VALUES (?,?,?)', key, day, id);
          fresh = 1;
        }
      }
      this.sql.exec('INSERT INTO link_clicks(slug,day,clicks,visitors) VALUES (?,?,1,?) ON CONFLICT(slug,day) DO UPDATE SET clicks=clicks+1,visitors=visitors+excluded.visitors', key, day, fresh);
      if (!this.read('links-pruned')) {
        this.write('links-pruned', true, DAY);
        this.sql.exec('DELETE FROM link_visitors WHERE day<?', beijingDay(now - 2 * DAY));
        this.sql.exec('DELETE FROM link_clicks WHERE day<?', beijingDay(now - 400 * DAY));
      }
    }
    return row.target;
  }
  // Section appended to the Monday weekly report; empty when no links exist.
  linkReportLines(from, to) {
    const rows = this.linkStats(from, to);
    if (!rows.length) return [];
    const total = rows.reduce((sum, row) => sum + row.clicks, 0);
    const lines = ['', `🔗 <b>推广链接点击</b>｜共 ${total} 次`];
    const clicked = rows.filter(row => row.clicks);
    if (!clicked.length) lines.push('本周没有人点击推广链接。');
    clicked.slice(0, 10).forEach((row, index) => lines.push(`${['🥇', '🥈', '🥉'][index] || `${index + 1}.`} ${esc(row.note || row.slug)}：${row.clicks} 次 · ${row.visitors} 人`));
    return lines;
  }
}
