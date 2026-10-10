// Per-group admin settings edited from the web panel.
// Methods are copied onto GuardState.prototype in ../state.js.
import { normalizeDomain, CONTENT_LOCK_TYPES, validateWord } from '../filters.js';
import { DAY, normalizeKnowledge } from './shared.js';

export class SettingsMethods {

  async adminData(before = 0) {
    const config = await this.config();
    const rows = this.sql.exec('SELECT id,data FROM logs WHERE id<? ORDER BY id DESC LIMIT 50', before > 0 ? before : Number.MAX_SAFE_INTEGER).toArray();
    return { aiQuota:{...this.aiQuota(),available:!!this.env.AI&&this.env.AI_REVIEW_ENABLED!=='false',enabled:config.aiReviewEnabled}, health:this.healthSummary(), ocrQuota:this.ocrQuota(this.read('chat')?.id || ''), failedJobs:this.sql.exec("SELECT id,attempts,created,plan FROM jobs WHERE status='failed' ORDER BY created DESC LIMIT 20").toArray().map(x=>({id:x.id,attempts:x.attempts,created:x.created,action:JSON.parse(x.plan||'{}').entry?.action})), config, versions: this.configVersions(), logs: rows.map(r => ({ ...JSON.parse(r.data), id: r.id })), next: rows.length === 50 ? rows.at(-1).id : null, pending: this.sql.exec("SELECT COUNT(*) AS n FROM jobs WHERE status='pending'").toArray()[0].n, failed: this.sql.exec("SELECT COUNT(*) AS n FROM jobs WHERE status='failed'").toArray()[0].n };
  }
  async keywordStats() {
    const since = Date.now() - 30 * DAY;
    const counts = new Map();
    for (const row of this.sql.exec('SELECT data FROM logs WHERE ts>=? ORDER BY id DESC LIMIT 5000', since).toArray()) {
      const hits = JSON.parse(row.data).keywordHits;
      if (Array.isArray(hits)) for (const word of hits) counts.set(word, (counts.get(word) || 0) + 1);
    }
    return { periodDays: 30, total: [...counts.values()].reduce((sum, count) => sum + count, 0), keywords: [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN')).slice(0, 50).map(([word, count]) => ({ word, count })) };
  }
  async editWord(action, word) {
    word = validateWord(word);
    const config = await this.config();
    if (action === 'add' && !config.keywords.includes(word)) {
      if (config.keywords.length >= 500) throw new Error('最多 500 个关键词');
      config.keywords.push(word);
    } else if (action === 'remove') config.keywords = config.keywords.filter(w => w !== word);
    this.saveConfig(config, `关键词${action}`);
    this.log({ action: `keyword-${action}`, actorId: 'web-admin', text: word, outcome: 'success' });
    return { keywords: config.keywords };
  }
  async editDomain(action, domain, list) {
    domain = normalizeDomain(domain);
    if (!['allow', 'deny'].includes(list)) throw new Error('无效名单类型');
    const config = await this.config();
    const key = list === 'allow' ? 'domainAllowlist' : 'domainDenylist';
    if (action === 'add' && !config[key].includes(domain)) {
      if (config[key].length >= 300) throw new Error('名单最多 300 个域名');
      config[key].push(domain);
    } else if (action === 'remove') config[key] = config[key].filter(item => item !== domain);
    this.saveConfig(config, `域名${list}${action}`);
    this.log({ action: `domain-${list}-${action}`, actorId: 'web-admin', text: domain, outcome: 'success' });
    return { allowlist: config.domainAllowlist, denylist: config.domainDenylist };
  }
  async editVerification(mode, minutes, channel, timeoutAction = 'ban') {
    if (!['off', 'math', 'button', 'channel', 'choice'].includes(mode)) throw new Error('无效验证方式');
    if (!['ban', 'kick'].includes(timeoutAction)) throw new Error('无效的超时处理方式');
    const value = Math.max(1, Math.min(60, Number(minutes)));
    if (!Number.isInteger(value)) throw new Error('验证时限须为 1–60 分钟');
    let normalizedChannel = String(channel || '').trim();
    if (normalizedChannel && !normalizedChannel.startsWith('@')) normalizedChannel = '@' + normalizedChannel;
    if ((mode === 'channel' || mode === 'choice') && !/^@[a-zA-Z0-9_]{5,}$/.test(normalizedChannel)) throw new Error('频道验证请填写公开频道用户名，例如 @jason_vps_deal');
    const config = await this.config();
    config.verificationMode = mode; config.verificationMinutes = value; config.verificationChannel = mode === 'channel' || mode === 'choice' ? normalizedChannel : ''; config.verificationTimeoutAction = timeoutAction;
    this.saveConfig(config, '新成员验证');
    this.log({ action: 'verification-update', actorId: 'web-admin', outcome: 'success', text: `${mode}:${value}:${config.verificationChannel}:${timeoutAction}` });
    return { verificationMode: config.verificationMode, verificationMinutes: config.verificationMinutes, verificationChannel: config.verificationChannel, verificationTimeoutAction: config.verificationTimeoutAction };
  }
  async editScreening(casEnabled, profileCheckEnabled, deleteServiceMessages) {
    if (![casEnabled, profileCheckEnabled, deleteServiceMessages].every(value => typeof value === 'boolean')) throw new Error('筛查设置无效');
    const config = await this.config();
    config.casEnabled = casEnabled; config.profileCheckEnabled = profileCheckEnabled; config.deleteServiceMessages = deleteServiceMessages;
    this.saveConfig(config, '入群筛查与系统提示');
    this.log({ action: 'screening-update', actorId: 'web-admin', outcome: 'success', text: `${casEnabled}:${profileCheckEnabled}:${deleteServiceMessages}` });
    return { casEnabled, profileCheckEnabled, deleteServiceMessages };
  }
  async editRaid(enabled, limit, minutes) {
    const joins = Number(limit), duration = Number(minutes);
    if (typeof enabled !== 'boolean' || !Number.isInteger(joins) || joins < 2 || joins > 30 || !Number.isInteger(duration) || duration < 5 || duration > 120) throw new Error('入群阈值须为 2–30 人，防护时长须为 5–120 分钟');
    const config = await this.config();
    config.raidEnabled = enabled; config.raidJoinLimit = joins; config.raidMinutes = duration;
    this.saveConfig(config, '反入群轰炸');
    this.log({ action: 'raid-update', actorId: 'web-admin', outcome: 'success', text: `${enabled}:${joins}:${duration}` });
    return { raidEnabled: config.raidEnabled, raidJoinLimit: config.raidJoinLimit, raidMinutes: config.raidMinutes };
  }
  async editNewMemberLinkGuard(enabled, minutes) {
    const duration = Number(minutes);
    if (typeof enabled !== 'boolean' || !Number.isInteger(duration) || duration < 1 || duration > 1440) throw new Error('链接隔离时长须为 1–1440 分钟');
    const config = await this.config();
    config.newMemberLinkGuard = enabled; config.newMemberLinkMinutes = duration;
    this.saveConfig(config, '新人链接隔离');
    this.log({ action: 'new-member-link-guard-update', actorId: 'web-admin', outcome: 'success', text: `${enabled}:${duration}` });
    return { newMemberLinkGuard: config.newMemberLinkGuard, newMemberLinkMinutes: config.newMemberLinkMinutes };
  }
  async editNewMemberMediaGuard(enabled, minutes) {
    const duration = Number(minutes);
    if (typeof enabled !== 'boolean' || !Number.isInteger(duration) || duration < 1 || duration > 1440) throw new Error('媒体隔离时长须为 1–1440 分钟');
    const config = await this.config();
    config.newMemberMediaGuard = enabled; config.newMemberMediaMinutes = duration;
    this.saveConfig(config, '新人媒体隔离');
    this.log({ action: 'new-member-media-guard-update', actorId: 'web-admin', outcome: 'success', text: `${enabled}:${duration}` });
    return { newMemberMediaGuard: config.newMemberMediaGuard, newMemberMediaMinutes: config.newMemberMediaMinutes };
  }
  async editContentLocks(locks) {
    if (!locks || typeof locks !== 'object' || Array.isArray(locks)) throw new Error('内容限制设置无效');
    const normalized = {};
    for (const type of CONTENT_LOCK_TYPES) {
      const item = locks[type];
      if (!item || item.enabled !== true) continue;
      normalized[type] = { enabled: true, action: item.action === 'ban' ? 'ban' : 'delete' };
    }
    const config = await this.config(); config.contentLocks = normalized;
    this.saveConfig(config, '内容类型限制');
    this.log({ action: 'content-locks-update', actorId: 'web-admin', outcome: 'success', text: JSON.stringify(normalized) });
    return { contentLocks: normalized };
  }
  async editKnowledge(action, item) {
    const config = await this.config();
    const current = normalizeKnowledge(config.knowledgeBase);
    if (action === 'remove') {
      const id = String(item?.id || '');
      config.knowledgeBase = current.filter(entry => entry.id !== id);
    } else if (action === 'upsert') {
      const candidate = normalizeKnowledge([{ ...item, id: item?.id || crypto.randomUUID() }])[0];
      if (!candidate) throw new Error('请填写有效标题、回复内容，以及 /英文指令或触发关键词');
      const next = current.filter(entry => entry.id !== candidate.id && (!candidate.command || entry.command !== candidate.command));
      if (next.length >= 50) throw new Error('每群最多 50 条知识库内容');
      next.push(candidate); config.knowledgeBase = next;
    } else throw new Error('无效知识库操作');
    this.saveConfig(config, '群知识库');
    this.log({ action: `knowledge-${action}`, actorId: 'web-admin', outcome: 'success', text: String(item?.title || item?.id || '') });
    return { knowledgeBase: config.knowledgeBase };
  }
}
