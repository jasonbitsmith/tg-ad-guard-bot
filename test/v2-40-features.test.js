import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { Miniflare, convertV4MiniflareOptions, Response as MFResponse } from 'miniflare';
import { parseMuteDuration, formatMuteDuration } from '../src/state/moderation.js';
import { parseBroadcastGroups, formatBroadcastGroupsText, parseBroadcastButton } from '../src/state/broadcast.js';
import { ADMIN_JS } from '../src/admin.js';

test('禁言时长解析与格式化覆盖中英文单位与上下限', () => {
  assert.equal(parseMuteDuration(''), 600);
  assert.equal(parseMuteDuration('30m'), 1800);
  assert.equal(parseMuteDuration('30分钟'), 1800);
  assert.equal(parseMuteDuration('2h'), 7200);
  assert.equal(parseMuteDuration('2小时'), 7200);
  assert.equal(parseMuteDuration('3d'), 3 * 86400);
  assert.equal(parseMuteDuration('1天'), 86400);
  assert.equal(parseMuteDuration('15'), 900);
  assert.equal(parseMuteDuration('0m'), null);
  assert.equal(parseMuteDuration('400d'), null);
  assert.equal(parseMuteDuration('abc'), null);
  assert.equal(formatMuteDuration(1800), '30 分钟');
  assert.equal(formatMuteDuration(7200), '2 小时');
  assert.equal(formatMuteDuration(2 * 86400), '2 天');
});

test('群发目标分组与跳转按钮解析（含短链解析与校验）', () => {
  const valid = new Set(['@jason_vps_deal', '@wpzyz', '@jasonsimlab']);
  const groups = parseBroadcastGroups('VPS组: @jason_vps_deal, @wpzyz\nSIM组：@JasonSIMLab', valid);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].targets, ['@jason_vps_deal', '@wpzyz']);
  assert.equal(formatBroadcastGroupsText(groups), 'VPS组: @jason_vps_deal, @wpzyz\nSIM组: @JasonSIMLab');
  assert.throws(() => parseBroadcastGroups('未知组: @not_in_list', valid), /不在当前群发目标/);
  assert.throws(() => parseBroadcastGroups('重复: @wpzyz\n重复: @wpzyz', valid), /重复/);

  const resolve = slug => slug === 'dmit' ? 'https://bot.jasonselect.com/go/dmit' : null;
  assert.deepEqual(parseBroadcastButton('🛒 立即查看 | dmit', resolve), { text: '🛒 立即查看', url: 'https://bot.jasonselect.com/go/dmit', slug: 'dmit' });
  assert.deepEqual(parseBroadcastButton('📣 频道 ｜ @jason_vps_deal', resolve), { text: '📣 频道', url: 'https://t.me/jason_vps_deal' });
  assert.deepEqual(parseBroadcastButton('官网 | https://example.com/a', resolve), { text: '官网', url: 'https://example.com/a' });
  assert.throws(() => parseBroadcastButton('买 | missing-slug', resolve), /找不到叫「missing-slug」的短链接/);
  assert.throws(() => parseBroadcastButton('只有文字没有分隔符', resolve), /格式/);
});

test('v2.40.0 集成：老成员渐进式信任、/mute、/purge、群发分组/CTA/定时看板与客服备注/后台回复', async t => {
  const calls = [];
  const wrapper = `import worker, { GuardState as Base } from './index.js';
    export class GuardState extends Base {
      seedVeteranTest(userId){
        this.activityTables();
        this.sql.exec("INSERT OR REPLACE INTO activity(day,user_id,messages) VALUES ('2026-11-20',?,6),('2026-11-21',?,6),('2026-11-22',?,6)", String(userId), String(userId), String(userId));
      }
      async runAllPendingTest(){
        for(let i=0;i<100 && this.running;i++) await new Promise(r=>setTimeout(r,20));
        await this.alarm();
        return { data: await this.adminData(), jobs: this.sql.exec('SELECT id,status FROM jobs').toArray() };
      }
      async runAdminAlarmTest(){
        for(let i=0;i<100 && this.running;i++) await new Promise(r=>setTimeout(r,20));
        await this.alarm();
      }
    }
    export default worker;`;
  const mf = new Miniflare(convertV4MiniflareOptions({
    compatibilityDate: '2026-09-22',
    compatibilityFlags: ['nodejs_compat'],
    modules: [
      { type: 'ESModule', path: 'wrapper.js', contents: wrapper },
      { type: 'ESModule', path: 'index.js', contents: await readFile(new URL('../dist/index.js', import.meta.url), 'utf8') },
    ],
    durableObjects: { GUARD_STATE: { className: 'GuardState', useSQLite: true } },
    kvNamespaces: ['BOT_KV'],
    bindings: {
      BOT_TOKEN: 'fake',
      SUPPORT_BOT_TOKEN: 'support-fake',
      SUPPORT_WEBHOOK_SECRET: 'support-secret',
      SUPPORT_OWNER_ID: '99',
      WEBHOOK_SECRET: 'path',
      WEBHOOK_VERIFY_TOKEN: 'verify',
      ADMIN_PASSWORD: 'pw-test',
      ADMIN_IDS: '99',
      BROADCAST_TARGETS: '@jason_vps_deal,@wpzyz,@JasonSIMLab',
      BROADCAST_TEST_MODE: 'false',
      AI_REVIEW_ENABLED: 'false',
    },
    outboundService: async request => {
      const url = new URL(request.url);
      if (url.hostname === 'api.cas.chat') return MFResponse.json({ ok: false });
      const method = url.pathname.split('/').at(-1);
      const params = await request.json();
      const bot = url.pathname.includes('support-fake') ? 'support' : 'guard';
      calls.push({ bot, method, params });
      let result = true;
      if (method === 'getMe') result = { id: 555, username: 'GuardBot', is_bot: true };
      if (method === 'getChat') result = { id: params.chat_id, type: 'channel', title: String(params.chat_id), permissions: { can_send_messages: true } };
      if (method === 'getChatMember') {
        result = params.user_id === 555
          ? { status: 'administrator', can_delete_messages: true, can_restrict_members: true, can_post_messages: true }
          : params.user_id === 11
            ? { status: 'administrator', can_delete_messages: false, can_restrict_members: false }
            : { status: 'member' };
      }
      if (method === 'sendMessage' || method === 'copyMessage') result = { message_id: 700 + calls.length };
      return MFResponse.json({ ok: true, result });
    },
  }));
  t.after(() => mf.dispose());

  const ns = await mf.getDurableObjectNamespace('GUARD_STATE');
  let seq = 100;
  const sendGuard = body => mf.dispatchFetch('https://bot.test/webhook/path', {
    method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'verify' }, body: JSON.stringify(body),
  });
  const sendSupport = body => mf.dispatchFetch('https://bot.test/support/webhook', {
    method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'support-secret' }, body: JSON.stringify(body),
  });
  const login = await mf.dispatchFetch('https://bot.test/admin/api/login', {
    method: 'POST', headers: { Origin: 'https://bot.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'pw-test' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const api = (path, body) => mf.dispatchFetch('https://bot.test/admin/api/' + path, {
    method: body ? 'POST' : 'GET',
    headers: { Cookie: cookie, Origin: 'https://bot.test', 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  await t.test('老成员渐进式信任：非铁证转复核不封禁，铁证诈骗照常秒封', async () => {
    const groupState = ns.getByName('chat:-100501');
    await groupState.seedVeteranTest(701);
    const before = calls.length;
    // Borderline score=4 (keyword 兼职 + contact 私聊我 + link, not a permanentBan scam template, score < 7).
    await sendGuard({ update_id: ++seq, message: { message_id: 10, date: 1, chat: { id: -100501, type: 'supergroup', title: '信任测试群' }, from: { id: 701, first_name: '老群友' }, text: '周末有兼职吗 私聊我看看 https://example.org' } });
    const res = await groupState.runAllPendingTest();
    const after = calls.slice(before);
    assert.equal(after.some(c => c.method === 'banChatMember' && c.params.user_id === 701), false);
    assert.equal(res.data.logs[0].action, 'review');
    assert.ok(res.data.logs[0].reasons.some(r => r.includes('老成员渐进式信任')));
    assert.ok(after.some(c => c.method === 'sendMessage' && c.params.chat_id === 99 && c.params.text.includes('老成员渐进式信任')));

    // Hard evidence (permanentBan template) still bans immediately even for veterans.
    const beforeHard = calls.length;
    await sendGuard({ update_id: ++seq, message: { message_id: 11, date: 2, chat: { id: -100501, type: 'supergroup', title: '信任测试群' }, from: { id: 701, first_name: '老群友' }, text: '有码来吃肉 一天8K' } });
    await groupState.runAllPendingTest();
    assert.ok(calls.slice(beforeHard).some(c => c.method === 'banChatMember' && c.params.user_id === 701));
  });

  await t.test('群管指令 /mute 临时禁言与 /purge 批量清理', async () => {
    const groupState = ns.getByName('chat:-100502');
    const before = calls.length;
    await sendGuard({ update_id: ++seq, message: { message_id: 20, date: 1, chat: { id: -100502, type: 'supergroup', title: '指令测试群' }, from: { id: 99, first_name: 'Owner' }, text: '/mute 30m', reply_to_message: { message_id: 19, chat: { id: -100502 }, from: { id: 702, first_name: '刷屏人' }, text: '刷屏' } } });
    await groupState.runAllPendingTest();
    const muteCall = calls.slice(before).find(c => c.method === 'restrictChatMember' && c.params.user_id === 702);
    assert.ok(muteCall);
    assert.equal(muteCall.params.permissions.can_send_messages, false);
    assert.ok(muteCall.params.until_date > Math.floor(Date.now() / 1000) + 1700);

    // /purge deletes range inclusive and refuses >100 without count
    const beforePurge = calls.length;
    await sendGuard({ update_id: ++seq, message: { message_id: 34, date: 2, chat: { id: -100502, type: 'supergroup', title: '指令测试群' }, from: { id: 99, first_name: 'Owner' }, text: '/purge', reply_to_message: { message_id: 30, chat: { id: -100502 }, from: { id: 702 } } } });
    await groupState.runAllPendingTest();
    const purgeCall = calls.slice(beforePurge).find(c => c.method === 'deleteMessages');
    assert.deepEqual(purgeCall?.params.message_ids, [30, 31, 32, 33, 34]);

    const beforeTooBig = calls.length;
    await sendGuard({ update_id: ++seq, message: { message_id: 300, date: 3, chat: { id: -100502, type: 'supergroup', title: '指令测试群' }, from: { id: 99, first_name: 'Owner' }, text: '/purge', reply_to_message: { message_id: 50, chat: { id: -100502 }, from: { id: 702 } } } });
    await groupState.runAllPendingTest();
    assert.equal(calls.slice(beforeTooBig).some(c => c.method === 'deleteMessages'), false);
    assert.ok(calls.slice(beforeTooBig).some(c => c.method === 'sendMessage' && c.params.text.includes('100 条上限')));
  });

  await t.test('一键群发：分组预设、CTA 自动解析短链、定时看板与取消', async () => {
    assert.equal((await api('links/upsert', { item: { slug: 'dmit', target: 'https://www.dmit.io/aff.php?aff=16962', note: 'DMIT' } })).status, 200);
    const savedGroups = await (await api('broadcast/groups', { groupsText: 'VPS组: @jason_vps_deal, @wpzyz' })).json();
    assert.equal(savedGroups.groups.length, 1);

    const start = calls.length;
    await sendGuard({ update_id: ++seq, message: { message_id: 501, date: 1, chat: { id: 99, type: 'private' }, from: { id: 99 }, text: '群发' } });
    await sendGuard({ update_id: ++seq, message: { message_id: 502, date: 2, chat: { id: 99, type: 'private' }, from: { id: 99 }, text: 'DMIT 补货了！' } });
    const prompt = calls.slice(start).findLast(c => c.method === 'sendMessage' && JSON.stringify(c.params.reply_markup || {}).includes('bc:a:'));
    assert.ok(prompt);
    const buttons = prompt.params.reply_markup.inline_keyboard.flat();
    const groupBtn = buttons.find(b => b.callback_data.startsWith('bc:f:'));
    const ctaBtn = buttons.find(b => b.callback_data.startsWith('bc:k:'));
    assert.ok(groupBtn && groupBtn.text.includes('VPS组'));
    assert.ok(ctaBtn);
    const token = ctaBtn.callback_data.split(':')[2];
    const promptMsgId = 700 + calls.indexOf(prompt) + 1;

    // Set CTA button using short-link slug "dmit"
    await sendGuard({ update_id: ++seq, callback_query: { id: 'cb-k', from: { id: 99 }, data: ctaBtn.callback_data, message: { message_id: promptMsgId, chat: { id: 99, type: 'private' } } } });
    await sendGuard({ update_id: ++seq, message: { message_id: 503, date: 3, chat: { id: 99, type: 'private' }, from: { id: 99 }, text: '🛒 立即抢购 | dmit' } });

    // Select preset group "VPS组" -> switches to pick with 2 targets selected
    await sendGuard({ update_id: ++seq, callback_query: { id: 'cb-f', from: { id: 99 }, data: groupBtn.callback_data, message: { message_id: promptMsgId, chat: { id: 99, type: 'private' } } } });

    // Schedule 1 hour later
    await sendGuard({ update_id: ++seq, callback_query: { id: 'cb-w', from: { id: 99 }, data: `bc:w:${token}`, message: { message_id: promptMsgId, chat: { id: 99, type: 'private' } } } });
    await sendGuard({ update_id: ++seq, callback_query: { id: 'cb-h', from: { id: 99 }, data: `bc:h:${token}:h1`, message: { message_id: promptMsgId, chat: { id: 99, type: 'private' } } } });

    const settings = await (await api('broadcast')).json();
    assert.equal(settings.scheduled.length, 1);
    assert.equal(settings.scheduled[0].button.url, 'https://bot.jasonselect.com/go/dmit');
    assert.equal(settings.scheduled[0].labels.length, 2);

    // Owner checks /broadcasts privately
    const beforeList = calls.length;
    await sendGuard({ update_id: ++seq, message: { message_id: 504, date: 4, chat: { id: 99, type: 'private' }, from: { id: 99 }, text: '/broadcasts' } });
    assert.ok(calls.slice(beforeList).some(c => c.method === 'sendMessage' && c.params.text.includes('待发送的定时群发') && JSON.stringify(c.params.reply_markup).includes(`bc:x:${token}`)));

    // Cancel from admin API
    const afterCancel = await (await api('broadcast/cancel', { token })).json();
    assert.equal(afterCancel.scheduled.length, 0);

    // Immediate send with CTA button attaches inline_keyboard
    const startSend = calls.length;
    await sendGuard({ update_id: ++seq, message: { message_id: 510, date: 5, chat: { id: 99, type: 'private' }, from: { id: 99 }, text: '群发 限时活动' } });
    const prompt2 = calls.slice(startSend).findLast(c => c.method === 'sendMessage' && JSON.stringify(c.params.reply_markup || {}).includes('bc:a:'));
    const token2 = prompt2.params.reply_markup.inline_keyboard.flat().find(b => b.callback_data.startsWith('bc:a:')).callback_data.split(':')[2];
    const prompt2Id = 700 + calls.indexOf(prompt2) + 1;
    await sendGuard({ update_id: ++seq, callback_query: { id: 'cb-k2', from: { id: 99 }, data: `bc:k:${token2}`, message: { message_id: prompt2Id, chat: { id: 99, type: 'private' } } } });
    await sendGuard({ update_id: ++seq, message: { message_id: 511, date: 6, chat: { id: 99, type: 'private' }, from: { id: 99 }, text: '🛒 立即抢购 | dmit' } });
    await sendGuard({ update_id: ++seq, callback_query: { id: 'cb-a2', from: { id: 99 }, data: `bc:a:${token2}`, message: { message_id: prompt2Id, chat: { id: 99, type: 'private' } } } });
    await ns.getByName('admin').runAdminAlarmTest();
    const sentWithCta = calls.slice(startSend).filter(c => c.method === 'sendMessage' && ['@jason_vps_deal', '@wpzyz', '@jasonsimlab'].includes(String(c.params.chat_id)));
    assert.equal(sentWithCta.length, 3);
    assert.deepEqual(sentWithCta[0].params.reply_markup, { inline_keyboard: [[{ text: '🛒 立即抢购', url: 'https://bot.jasonselect.com/go/dmit' }]] });
  });

  await t.test('客服增强：/note 客户备注自动带出 + 后台直接回复与标记已处理', async () => {
    const inbox = ns.getByName('support:inbox');
    // Save note via owner direct /note command
    await sendSupport({ update_id: ++seq, message: { message_id: 801, date: 1, chat: { id: 99, type: 'private' }, from: { id: 99 }, text: '/note 88801 已购 RedPocket 年付' } });
    await inbox.runAdminAlarmTest();

    // Customer messages support -> header card shows the saved note
    const beforeIncoming = calls.length;
    await sendSupport({ update_id: ++seq, message: { message_id: 802, date: 2, chat: { id: 88801, type: 'private' }, from: { id: 88801, first_name: '客户甲', username: 'client_a' }, text: '请问怎么查物流？' } });
    await inbox.runAdminAlarmTest();
    assert.ok(calls.slice(beforeIncoming).some(c => c.bot === 'support' && c.method === 'sendMessage' && c.params.chat_id === 99 && c.params.text.includes('📝 备注：已购 RedPocket 年付')));

    // Admin API sees waiting customer with note, updates note, replies directly
    const info = await (await api('support')).json();
    assert.equal(info.waiting.length, 1);
    assert.equal(info.waiting[0].note, '已购 RedPocket 年付');

    const updatedNote = await (await api('support/note', { userId: '88801', note: '已发顺丰单号' })).json();
    assert.equal(updatedNote.waiting[0].note, '已发顺丰单号');

    const beforeReply = calls.length;
    const afterReply = await (await api('support/reply', { userId: '88801', text: '单号是 SF123456' })).json();
    assert.ok(afterReply);
    await inbox.runAdminAlarmTest();
    assert.ok(calls.slice(beforeReply).some(c => c.bot === 'support' && c.method === 'sendMessage' && c.params.chat_id === 88801 && c.params.text === '单号是 SF123456'));
    const finalInfo = await (await api('support')).json();
    assert.equal(finalInfo.waiting.length, 0);
  });
});

test('后台 UI 渲染群发分组、定时看板与客服直接回复控件', async () => {
  const nodes = new Map(), calls = [];
  function node(id = '', tag = 'DIV') {
    return {
      id, tagName: tag, value: '', textContent: '', checked: false, dataset: {}, children: [], isConnected: true,
      classList: { add() {}, remove() {} }, querySelector() { return null; }, querySelectorAll() { return []; },
      closest() { return null; }, append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; }, scrollIntoView() {},
    };
  }
  const document = {
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, node(id, id.endsWith('Form') ? 'FORM' : 'DIV')); return nodes.get(id); },
    body: node(), querySelector() { return null; }, querySelectorAll() { return []; }, createElement: tag => node('', tag.toUpperCase()),
  };
  let loggedIn = false;
  const responses = {
    broadcast: {
      testMode: false, custom: false, targets: [{ id: '@wpzyz', handle: '@wpzyz', label: '网盘（@wpzyz）', problem: '' }],
      groupsText: 'VPS组: @wpzyz',
      scheduled: [{ token: '0123456789abcdef', scheduledText: '今晚 20:00', kind: '这条消息', labels: ['网盘（@wpzyz）'], silent: true, pin: false, button: { text: '购买', url: 'https://bot.jasonselect.com/go/dmit' } }],
    },
    support: {
      settings: { faq: [], templates: [], hoursEnabled: true, start: '09:00', end: '23:00', offMessage: '休息中', remindHours: 2, adFilter: true },
      waiting: [{ userId: '88801', name: '客户甲', username: 'client_a', since: Date.now() - 600000, note: 'VIP 客户' }],
    },
  };
  const context = vm.createContext({
    document,
    window: { confirm: () => true, prompt: () => '新备注' },
    localStorage: { removeItem() {}, getItem() { return null; }, setItem() {} },
    Option: function (text, value) { return { text, value }; },
    fetch: async (url, options) => {
      calls.push({ url, body: options?.body ? JSON.parse(options.body) : null });
      if (url.endsWith('/login')) loggedIn = true;
      const tail = url.split('/admin/api/')[1];
      const data = tail === 'chats' ? { chats: [{ id: '-1001', title: '群1' }] } : responses[tail] || { ok: true, waiting: [], scheduled: [], targets: [] };
      return { ok: loggedIn, status: loggedIn ? 200 : 401, json: async () => data };
    },
  });
  vm.runInContext(ADMIN_JS, context);
  await new Promise(r => setImmediate(r));
  await document.getElementById('loginForm').onsubmit({ preventDefault() {}, currentTarget: document.getElementById('loginForm') });
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  assert.equal(document.getElementById('broadcastGroups').value, 'VPS组: @wpzyz');
  assert.equal(document.getElementById('broadcastScheduled').children.length, 1);
  const cancelBtn = document.getElementById('broadcastScheduled').children[0].children.find(x => x.textContent === '取消定时');
  await cancelBtn.onclick({ preventDefault() {}, currentTarget: cancelBtn });
  assert.ok(calls.some(c => c.url.endsWith('/broadcast/cancel') && c.body.token === '0123456789abcdef'));

  const waitRow = document.getElementById('supportWaiting').children[0];
  assert.ok(waitRow.children.some(x => x.textContent.includes('VIP 客户')));
  const replyInput = waitRow.children.find(x => x.tagName === 'INPUT');
  const replyBtn = waitRow.children.find(x => x.textContent === '发送回复');
  replyInput.value = '你好，已处理';
  await replyBtn.onclick({ preventDefault() {}, currentTarget: replyBtn });
  assert.ok(calls.some(c => c.url.endsWith('/support/reply') && c.body.userId === '88801' && c.body.text === '你好，已处理'));
});
