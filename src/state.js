import { DurableObject } from 'cloudflare:workers';
import { telegram } from './telegram.js';
import { classify, normalize, normalizeDomain, DEFAULT_KEYWORDS, DEFAULT_POLICY, parseCommand, validateWord } from './filters.js';

const DAY = 86400000;
const ADMIN_STATUS = ['administrator', 'creator'];
// Groups discovered in the v1 interception history. Telegram has no Bot API
// endpoint that lists every group containing a bot, so these are explicitly
// seeded once into the v2 admin registry during the migration.
const LEGACY_CHATS = [
  { id: '-100999888777', title: '模拟VPS群' },
  { id: '-1003510391132', title: 'Jason 的全球手机号保号实验室' },
  { id: '-1003941419403', title: 'Jason-AI调教实验室' },
  { id: '-1003590410271', title: 'Jason - VPS 交流互助交流' },
  { id: '-1003336565693', title: 'Jason海外收款互助交流群' },
  { id: '-1003495086337', title: 'Jason - 数字生活指南' },
];
const HELP = '群管理指令（管理员使用）\n/status 状态及权限检查\n/addword 词、/removeword 词、/listwords（仅本群）\n回复消息或指定用户 ID：\n/warnings、/clearwarn、/allow、/unallow、/unban、/unmute\n/ban 手动封禁、/kick 移出（会涉及删除历史消息）\n自动策略：广告命中后直接删消息，不发送警告、不累计警告、不自动禁言。已确认的收米日薪、拍照日结批量广告会直接永久封禁。';

export class GuardState extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.running = false;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, payload TEXT NOT NULL, plan TEXT, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL, created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status,due);
      CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS logs_time ON logs(ts);
      CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, title TEXT NOT NULL);`);
    for (const chat of LEGACY_CHATS) {
      this.sql.exec('INSERT OR IGNORE INTO chats VALUES (?,?)', chat.id, chat.title);
    }
  }
  read(key, fallback = null) {
    const row = this.sql.exec('SELECT value FROM records WHERE key=? AND expires>?', key, Date.now()).toArray()[0];
    return row ? JSON.parse(row.value) : fallback;
  }
  write(key, value, ttl = 3650 * DAY) {
    this.sql.exec('INSERT OR REPLACE INTO records VALUES (?,?,?)', key, JSON.stringify(value), Date.now() + ttl);
  }
  remove(key) { this.sql.exec('DELETE FROM records WHERE key=?', key); }
  log(entry) {
    this.sql.exec('INSERT INTO logs(ts,data) VALUES (?,?)', Date.now(), JSON.stringify({ ...entry, ts: new Date().toISOString() }));
  }
  async schedule(when) {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > when) await this.ctx.storage.setAlarm(when);
  }
  async register(chat) {
    this.sql.exec('INSERT INTO chats VALUES (?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title WHERE title != excluded.title', String(chat.id), String(chat.title || chat.id));
  }
  listChats() { return this.sql.exec('SELECT * FROM chats ORDER BY title COLLATE NOCASE LIMIT 1000').toArray(); }

  async enqueue(update) {
    // Schedule before acknowledging durable receipt; an alarm survives request termination.
    await this.schedule(Date.now() + 200);
    const id = `u:${update.update_id}`;
    this.sql.exec('INSERT OR IGNORE INTO jobs(id,payload,due,created) VALUES (?,?,?,?)', id, JSON.stringify(update), Date.now(), Date.now());
    return { accepted: true };
  }
  async alarm() {
    if (this.running) { await this.schedule(Date.now() + 1000); return; }
    this.running = true;
    try {
      await this.ctx.storage.setAlarm(Date.now() + 60000);
      const started = Date.now();
      for (let n = 0; n < 10 && Date.now() - started < 20000; n++) {
        // Keep each group's processing order across retries. Otherwise a later warning
        // could be overwritten by a previously planned event that was rate-limited.
        const job = this.sql.exec("SELECT * FROM jobs WHERE status='pending' ORDER BY rowid LIMIT 1").toArray()[0];
        if (!job || job.due > Date.now()) break;
        await this.runJob(job);
      }
      this.sql.exec('DELETE FROM records WHERE expires<=?', Date.now());
      this.sql.exec("DELETE FROM jobs WHERE status!='pending' AND created<?", Date.now() - 7 * DAY);
      this.sql.exec('DELETE FROM logs WHERE ts<?', Date.now() - 30 * DAY);
    } finally {
      this.running = false;
      const next = this.sql.exec("SELECT due FROM jobs WHERE status='pending' ORDER BY rowid LIMIT 1").toArray()[0]?.due;
      await this.ctx.storage.setAlarm(next === null || next === undefined ? Date.now() + DAY : Math.max(Date.now() + 100, next));
    }
  }
  async runJob(job) {
    let plan = job.plan ? JSON.parse(job.plan) : null;
    try {
      if (!plan) {
        plan = await this.plan(JSON.parse(job.payload));
        // No await between state decisions and recording the plan.
        this.sql.exec('UPDATE jobs SET plan=? WHERE id=?', JSON.stringify(plan), job.id);
      }
      const tg = telegram(this.env.BOT_TOKEN);
      for (const op of plan.ops) {
        if (op.done) continue;
        if (op.local === 'warning') {
          if (!this.read(`offence:${op.messageId}`)) {
            this.write(`warn:${op.userId}`, op.count, DAY);
            this.write(`offence:${op.messageId}`, true, DAY);
          }
        } else if (op.local === 'processed') {
          this.write(`offence:${op.messageId}`, true, DAY);
        } else {
          // A retry must never turn an expired temporary mute into a permanent restriction.
          if (op.method === 'restrictChatMember' && op.params.until_date && op.params.until_date < Date.now() / 1000 + 35) {
            op.skipped = '临时禁言时段已过';
          } else {
            try { op.result = await tg(op.method, op.params); }
            catch (error) {
              if (op.method === 'deleteMessage' && error.code === 400 && /message to delete not found/i.test(error.message)) op.result = { alreadyAbsent: true };
              else throw error;
            }
          }
        }
        op.done = true;
        this.sql.exec('UPDATE jobs SET plan=? WHERE id=?', JSON.stringify(plan), job.id);
      }
      if (plan.entry) this.log({ ...plan.entry, outcome: plan.ops.some(x => x.skipped) ? 'partial' : 'success', steps: plan.ops.map(x => ({ method: x.method || x.local, done: x.done, skipped: x.skipped })) });
      this.sql.exec("UPDATE jobs SET status='done',payload='{}',plan=NULL WHERE id=?", job.id);
    } catch (error) {
      const attempts = job.attempts + 1;
      const retry = error.retryable !== false && attempts < 6 && Date.now() - job.created < DAY;
      const delay = Math.max(Number(error.retryAfter || 0) * 1000, Math.min(300000, 2000 * 2 ** attempts));
      this.sql.exec('UPDATE jobs SET attempts=?,status=?,due=? WHERE id=?', attempts, retry ? 'pending' : 'failed', Date.now() + delay, job.id);
      const msg = JSON.parse(job.payload).message || JSON.parse(job.payload).edited_message;
      this.log({ ...(plan?.entry || {}), chatId: msg?.chat?.id, userId: msg?.from?.id, action: plan?.entry?.action || '处理消息', outcome: retry ? 'retrying' : 'failed', error: String(error.message || 'unknown error').slice(0, 400), updateId: job.id, attempts, steps: plan?.ops.map(x => ({ method: x.method || x.local, done: !!x.done })) || [] });
      // Permanent failures remain visible without retaining full incoming messages indefinitely.
      if (!retry) this.sql.exec("UPDATE jobs SET payload='{}' WHERE id=?", job.id);
    }
  }

  async config() {
    const config = this.read('config');
    if (config) {
      const merged = { ...DEFAULT_POLICY, ...config, keywords: Array.isArray(config.keywords) ? config.keywords : DEFAULT_KEYWORDS };
      if (JSON.stringify(merged) !== JSON.stringify(config)) this.write('config', merged);
      return merged;
    }
    const legacy = await this.env.BOT_KV.get('keywords', 'json');
    const initial = { keywords: Array.isArray(legacy) ? legacy.filter(w => typeof w === 'string' && w.trim() && w.length <= 80).slice(0, 500) : DEFAULT_KEYWORDS, ...DEFAULT_POLICY };
    // Another RPC may have completed initialization while KV was being read.
    const winner = this.read('config');
    if (winner) return winner;
    this.write('config', initial);
    return initial;
  }
  owners() { return (this.env.ADMIN_IDS || '').split(',').map(x => x.trim()).filter(Boolean); }
  async me(tg) {
    let me = this.read('me');
    if (!me) { me = await tg('getMe'); this.write('me', me, 3600000); }
    return me;
  }
  async member(tg, chatId, userId) {
    return tg('getChatMember', { chat_id: chatId, user_id: userId });
  }
  async privileged(tg, chatId, userId) {
    if (this.owners().includes(String(userId))) return true;
    // Do not interpret an API error as "not an admin".
    return ADMIN_STATUS.includes((await this.member(tg, chatId, userId)).status);
  }
  async plan(update) {
    const empty = { ops: [] };
    const msg = update.message || update.edited_message;
    if (!msg || !['group','supergroup'].includes(msg.chat?.type)) return empty;
    const tg = telegram(this.env.BOT_TOKEN);
    const chatId = msg.chat.id;
    this.write('chat', msg.chat);
    if (msg.new_chat_members) {
      for (const member of msg.new_chat_members) this.write(`join:${member.id}`, Date.now(), DAY);
      const config = await this.config();
      const names = msg.new_chat_members.filter(member => !member.is_bot).map(member => [member.first_name, member.last_name].filter(Boolean).join(' ') || '新成员');
      const message = [config.welcomeMessage && config.welcomeMessage.replaceAll('{name}', names.join('、')).replaceAll('{group}', msg.chat.title || ''), config.rulesMessage && `群规：${config.rulesMessage}`].filter(Boolean).join('\n\n').slice(0, 4000);
      return message ? { ops: [{ method: 'sendMessage', params: { chat_id: chatId, text: message } }], entry: { chatId, chatTitle: msg.chat.title || '', action: 'welcome-and-rules', outcome: 'pending' } } : empty;
    }
    // Anonymous group admins and automatic linked-channel posts are trusted separately.
    if (msg.sender_chat?.id === chatId || msg.is_automatic_forward) return empty;
    if (!msg.sender_chat && (!msg.from || msg.from.is_bot)) return empty;
    const senderId = msg.sender_chat ? `channel:${msg.sender_chat.id}` : String(msg.from.id);
    const text = msg.text || msg.caption || '';
    if (!msg.sender_chat && text.startsWith('/')) {
      const me = await this.me(tg);
      const command = parseCommand(text, me.username || '');
      if (command && ['start','help','status','addword','removeword','listwords','warnings','clearwarn','allow','unallow','unban','unmute','ban','kick'].includes(command.command)) {
        // Editing an old command must not re-run a destructive operation.
        if (update.edited_message) return empty;
        if (await this.privileged(tg, chatId, msg.from.id)) return this.commandPlan(command, msg, tg);
        // Non-admin slash commands still pass through spam detection.
      }
    }
    let membership;
    if (!msg.sender_chat) {
      if (this.owners().includes(String(msg.from.id))) return empty;
      membership = await this.member(tg, chatId, msg.from.id);
      if (ADMIN_STATUS.includes(membership.status)) return empty;
    }
    if (this.read(`allow:${senderId}`) || this.read(`offence:${msg.message_id}`)) return empty;
    const policy = await this.config();
    const joined = this.read(`join:${senderId}`, 0);
    const verdict = classify(msg, policy.keywords, joined > Date.now() - policy.newMemberMinutes * 60000, { allowlist: policy.domainAllowlist, denylist: policy.domainDenylist });
    let samples = this.read(`flood:${senderId}`, []).filter(x => x.at > Date.now() - 60000 && x.id !== msg.message_id);
    const fingerprint = normalize(text) || msg.sticker?.file_unique_id || msg.photo?.at(-1)?.file_unique_id || msg.document?.file_unique_id || msg.video?.file_unique_id || '';
    if (fingerprint) samples.push({ id: msg.message_id, at: Date.now(), text: fingerprint });
    samples = samples.slice(-50);
    this.write(`flood:${senderId}`, samples, 120000);
    const repeat = fingerprint ? samples.filter(x => x.text === fingerprint).length : 0;
    if (repeat >= policy.repeatThreshold || samples.length >= policy.floodThreshold) {
      verdict.score = Math.max(4, verdict.score);
      verdict.reasons.push(repeat >= policy.repeatThreshold ? `60 秒内相同内容 ${repeat} 次（含交替刷屏）` : `60 秒内消息 ${samples.length} 条`);
    }
    // Coordinated spam often rotates accounts to evade per-sender flood limits.
    // Keep a short group-scoped fingerprint window only for substantial text.
    if (fingerprint.length >= 6) {
      const key = `groupflood:${fingerprint.slice(0, 160)}`;
      let groupSamples = this.read(key, []).filter(x => x.at > Date.now() - 10 * 60000 && x.id !== msg.message_id);
      groupSamples.push({ id: msg.message_id, at: Date.now(), senderId });
      groupSamples = groupSamples.slice(-50); this.write(key, groupSamples, 15 * 60000);
      if (new Set(groupSamples.map(x => x.senderId)).size >= 2) {
        verdict.score = Math.max(4, verdict.score);
        verdict.reasons.push('10 分钟内多个账号重复相同内容');
      }
    }
    if (!verdict.score && !verdict.deleteOnKeyword) return empty;
    const entry = { chatId, chatTitle: msg.chat.title || '', userId: senderId, userName: msg.sender_chat?.title || [msg.from?.first_name,msg.from?.last_name].filter(Boolean).join(' '), messageId: msg.message_id, text: text.slice(0, 300), score: verdict.score, reasons: verdict.reasons, keywordHits: verdict.hits, domains: verdict.domains };
    if (verdict.score < 4 && !verdict.deleteOnKeyword) return { ops: [], entry: { ...entry, action: 'review' } };
    const ops = [{ method: 'deleteMessage', params: { chat_id: chatId, message_id: msg.message_id } }];
    if (msg.sender_chat) {
      ops.push({ local: 'processed', messageId: msg.message_id });
      return { ops, entry: { ...entry, action: 'delete-channel-message' } };
    }
    if (verdict.permanentBan) {
      ops.push({ method: 'banChatMember', params: { chat_id: chatId, user_id: msg.from.id, until_date: 0 } });
      ops.push({ local: 'processed', messageId: msg.message_id });
      return { ops, entry: { ...entry, action: 'delete-and-permanent-ban' } };
    }
    ops.push({ local: 'processed', messageId: msg.message_id });
    return { ops, entry: { ...entry, action: 'delete-message' } };
  }

  async commandPlan({ command, arg }, msg, tg) {
    const chatId = msg.chat.id;
    const entry = { chatId, chatTitle: msg.chat.title || '', actorId: msg.from.id, action: command, text: arg.slice(0, 100), reasons: ['管理员操作'] };
    const reply = text => ({ ops: [{ method: 'sendMessage', params: { chat_id: chatId, text: text.slice(0, 4000) } }], entry });
    if (['ban','kick','unban','unmute'].includes(command) && !this.owners().includes(String(msg.from.id))) {
      const actor = await this.member(tg, chatId, msg.from.id);
      if (actor.status !== 'creator' && !actor.can_restrict_members) return reply('你没有限制群成员的管理权限，未执行该操作。');
    }
    if (command === 'start' || command === 'help') return reply(HELP);
    if (command === 'status') {
      const me = await this.me(tg);
      const member = await this.member(tg, chatId, me.id);
      const policy = await this.config();
      return reply(`运行正常 · v2\n广告命中：直接删除，不发送或累计警告\n收米日薪、拍照日结批量广告：直接永久封禁\n删消息权限：${member.can_delete_messages ? '有' : '无'}\n限制成员权限：${member.can_restrict_members ? '有' : '无'}\n群类型：${msg.chat.type}\n词库：本群独立 ${policy.keywords.length} 个词\n群内自动通知：关闭，处理结果在后台查看`);
    }
    if (['addword','removeword','listwords'].includes(command)) {
      const config = await this.config();
      if (command === 'listwords') return reply(`本群黑名单关键词（命中即删消息）：\n${config.keywords.join('、')}`);
      let word;
      try { word = validateWord(arg); } catch (e) { return reply(e.message); }
      if (command === 'addword') {
        if (config.keywords.length >= 500) return reply('词库已达 500 个，请先清理。');
        if (!config.keywords.includes(word)) config.keywords.push(word);
      } else config.keywords = config.keywords.filter(w => w !== word);
      this.write('config', config);
      return reply(`已${command === 'addword' ? '添加' : '移除'}本群关键词：${word}`);
    }
    const target = /^\d{1,16}$/.test(arg) ? Number(arg) : msg.reply_to_message?.from?.id;
    if (!target || !Number.isSafeInteger(target) || (msg.reply_to_message?.sender_chat && !arg)) return reply('请回复普通用户的消息，或在指令后填写数字用户 ID。频道身份请由管理员在 Telegram 中处理。');
    entry.userId = target;
    if (command === 'warnings') return reply(`用户 ${target}：${this.read(`warn:${target}`, 0)} 次警告；白名单：${this.read(`allow:${target}`) ? '是' : '否'}`);
    if (['clearwarn','allow','unallow'].includes(command)) {
      if (command === 'clearwarn' || command === 'allow') { this.remove(`warn:${target}`); this.remove(`flood:${target}`); }
      if (command === 'allow') this.write(`allow:${target}`, true);
      if (command === 'unallow') this.remove(`allow:${target}`);
      return reply(`已执行 ${command}：${target}。白名单不自动解除现有限制；需要时再使用 /unmute 或 /unban。`);
    }
    const member = await this.member(tg, chatId, target);
    if (ADMIN_STATUS.includes(member.status) || this.owners().includes(String(target)) || target === (await this.me(tg)).id) return reply('不能对群管理员、机器人所有者或机器人自身执行处罚。');
    const params = { chat_id: chatId, user_id: target };
    let ops = [];
    if (command === 'ban' || command === 'kick') {
      ops.push({ method: 'banChatMember', params });
      if (command === 'kick') ops.push({ method: 'unbanChatMember', params: { ...params, only_if_banned: true } });
    }
    if (command === 'unban') ops = [{ method: 'unbanChatMember', params: { ...params, only_if_banned: true } }];
    if (command === 'unmute') {
      if (msg.chat.type !== 'supergroup') return reply('普通群不支持禁言权限操作。');
      if (member.status === 'kicked') return reply('该用户已被封禁，请先使用 /unban。');
      const chat = await tg('getChat', { chat_id: chatId });
      if (!chat.permissions) return reply('无法读取群默认权限，未修改用户权限。');
      ops = [{ method: 'restrictChatMember', params: { ...params, permissions: chat.permissions, use_independent_chat_permissions: true } }];
    }
    ops.push({ method: 'sendMessage', params: { chat_id: chatId, text: `已成功执行 /${command}：${target}` } });
    return { ops, entry };
  }

  async adminData(before = 0) {
    const config = await this.config();
    const rows = this.sql.exec('SELECT id,data FROM logs WHERE id<? ORDER BY id DESC LIMIT 50', before > 0 ? before : Number.MAX_SAFE_INTEGER).toArray();
    return { config, logs: rows.map(r => ({ ...JSON.parse(r.data), id: r.id })), next: rows.length === 50 ? rows.at(-1).id : null, pending: this.sql.exec("SELECT COUNT(*) AS n FROM jobs WHERE status='pending'").toArray()[0].n, failed: this.sql.exec("SELECT COUNT(*) AS n FROM jobs WHERE status='failed'").toArray()[0].n };
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
    this.write('config', config);
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
    this.write('config', config);
    this.log({ action: `domain-${list}-${action}`, actorId: 'web-admin', text: domain, outcome: 'success' });
    return { allowlist: config.domainAllowlist, denylist: config.domainDenylist };
  }
  async editWelcome(welcomeMessage, rulesMessage) {
    if (typeof welcomeMessage !== 'string' || typeof rulesMessage !== 'string' || welcomeMessage.length > 2500 || rulesMessage.length > 2500) throw new Error('欢迎语和群规均不能超过 2500 个字符');
    const config = await this.config();
    config.welcomeMessage = welcomeMessage.trim(); config.rulesMessage = rulesMessage.trim();
    this.write('config', config);
    this.log({ action: 'welcome-rules-update', actorId: 'web-admin', outcome: 'success' });
    return { welcomeMessage: config.welcomeMessage, rulesMessage: config.rulesMessage };
  }

  async loginAttempt(ip) {
    await this.schedule(Date.now() + 900000);
    const key = `login:${ip}`;
    const count = this.read(key, 0);
    if (count >= 10) return false;
    this.write(key, count + 1, 900000);
    return true;
  }
  createSession(hash, passwordHash) { this.write(`session:${hash}`, passwordHash, 8 * 3600000); }
  hasSession(hash, passwordHash) { return this.read(`session:${hash}`) === passwordHash; }
  deleteSession(hash) { this.remove(`session:${hash}`); }
}
