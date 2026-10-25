import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unreadableContent } from '../src/message-content.js';
import { failureAdvice, operationSteps } from '../src/state/operations.js';
import { MonitorsMethods } from '../src/state/monitors.js';
import { NoticesMethods } from '../src/state/notices.js';
import { BackupMethods } from '../src/state/backup.js';

class Records {
  constructor() { this.records = new Map(); this.logs = []; this.alerts = []; }
  read(key, fallback = null) { const x = this.records.get(key); return x && x.expires > Date.now() ? structuredClone(x.value) : fallback; }
  write(key, value, ttl = 1e12) { this.records.set(key, { value: structuredClone(value), expires: Date.now() + ttl }); }
  remove(key) { this.records.delete(key); }
  log(x) { this.logs.push(x); }
  owners() { return ['99']; }
  async alertOwner(kind, text) { this.alerts.push({ kind, text }); return true; }
}

// A method module on top of an in-memory store, like GuardState does with real storage.
function mixin(Methods) {
  const object = Object.assign(Object.create(Methods.prototype), new Records(), { env: { BOT_TOKEN: 'x' } });
  for (const name of ['read', 'write', 'remove', 'log', 'owners', 'alertOwner']) object[name] = Records.prototype[name];
  return object;
}

test('不认识的消息类型：只有没有文字、也没有已知内容时才算', () => {
  const base = { message_id: 1, date: 0, chat: { id: -1 }, from: { id: 2 } };
  assert.deepEqual(unreadableContent({ ...base, holiday_card: {} }), ['holiday_card']);
  assert.deepEqual(unreadableContent({ ...base, text: 'hi', holiday_card: {} }), []);
  assert.deepEqual(unreadableContent({ ...base, photo: [{}], holiday_card: {} }), []);
  assert.deepEqual(unreadableContent({ ...base, sticker: {} }), []);
  assert.deepEqual(unreadableContent({ ...base, new_chat_title: 'x' }), []);
  assert.deepEqual(unreadableContent({ ...base, reply_markup: {} }), []);
});

test('失败任务写明原因和建议', () => {
  assert.match(failureAdvice('deleteMessage: Bad Request: message to delete not found').reason, /已经被删掉/);
  assert.match(failureAdvice('banChatMember: Bad Request: not enough rights to restrict/unrestrict chat member').action, /封禁成员/);
  assert.match(failureAdvice('network timeout or connection failure').action, /重试/);
  assert.match(failureAdvice('something new').reason, /其他原因/);
  const [step] = operationSteps([{ method: 'banChatMember', error: 'Bad Request: not enough rights' }], 'failed');
  assert.equal(step.status, 'failed'); assert.ok(step.advice);
  assert.equal(operationSteps([{ method: 'banChatMember', done: true }], 'done')[0].advice, null);
});

test('机器人已不在的群：两次确认后才移除，并只通知一次', async () => {
  const m = mixin(MonitorsMethods); m.removed = [];
  m.unregister = id => m.removed.push(id);
  const chat = { id: '-100', title: '旧群' };
  assert.equal(await m.botGone(chat, '已退出'), false);
  assert.equal(await m.botGone(chat, '已退出'), false, '不到四分钟不移除');
  m.records.get('bot-gone:-100').value = Date.now() - 5 * 60000;
  assert.equal(await m.botGone(chat, '已退出'), true);
  assert.deepEqual(m.removed, ['-100']); assert.equal(m.alerts.length, 1); assert.match(m.alerts[0].text, /旧群/);
});

test('新版本上线后只私信一次更新内容', async t => {
  const previous = globalThis.fetch, sent = [];
  globalThis.fetch = async (url, init) => { sent.push(JSON.parse(init.body)); return Response.json({ ok: true, result: { message_id: 1 } }); };
  t.after(() => { globalThis.fetch = previous; });
  const n = mixin(NoticesMethods);
  assert.equal(await n.announceVersion('9.9.9', '• 改了一点'), true);
  assert.equal(await n.announceVersion('9.9.9', '• 改了一点'), false);
  assert.equal(sent.length, 1); assert.equal(sent[0].chat_id, 99); assert.match(sent[0].text, /v9\.9\.9[\s\S]*改了一点/);
});

test('每周备份后逐份检查能否恢复，坏的会提醒', async () => {
  const b = mixin(BackupMethods);
  b.write('backup:auto-index', [{ id: '2026-10-19' }, { id: '2026-10-12' }]);
  b.automaticBackup = async id => { if (id === '2026-10-12') throw Error('备份校验失败，请勿恢复'); return {}; };
  const status = await b.verifyAutomaticBackups();
  assert.equal(status.checked, 2); assert.deepEqual(status.failed.map(x => x.id), ['2026-10-12']);
  assert.equal(b.alerts.length, 1); assert.match(b.alerts[0].text, /2026-10-12/);
  assert.equal(b.read('backup:verify-status').checked, 2);
});
