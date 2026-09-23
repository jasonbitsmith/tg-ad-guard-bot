import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, DEFAULT_KEYWORDS, parseCommand, normalize } from '../src/filters.js';
import { telegram, secureEqual } from '../src/telegram.js';

const msg = text => ({ text, from: { id: 1, first_name: '群友' } });
test('风险讨论和单一泛关键词不会进入自动处罚', () => {
  for (const text of ['请警惕刷单骗局，不要转账','有人了解 USDT 的风险吗？','周末有兼职经验分享吗？','欢迎大家交流','我们正在招聘工程师']) {
    assert.ok(classify(msg(text), DEFAULT_KEYWORDS).score < 4, text);
  }
});
test('引流和收益承诺组合触发处理，零宽字符与大小写不能绕过', () => {
  assert.ok(classify(msg('刷\u200b单 稳赚 无押金 私聊我 https://example.test'), DEFAULT_KEYWORDS).score >= 7);
  assert.ok(classify(msg('usdt 日结 联系我 @spamuser'), DEFAULT_KEYWORDS).score >= 4);
  assert.equal(normalize('ＵＳＤＴ'), 'usdt');
});
test('隐藏链接参与判断，昵称关键词本身不处罚', () => {
  const a = msg('兼职招聘'); a.entities = [{ type: 'text_link', offset: 0, length: 4, url: 'https://t.me/+invite' }];
  assert.ok(classify(a, DEFAULT_KEYWORDS).score >= 4);
  assert.ok(classify({ ...msg('你好'), from: { first_name: '兼职工程师' } }, DEFAULT_KEYWORDS).score < 4);
});
test('跨境电商专用卡推销会被处理，正常平台讨论不误删', () => {
  assert.ok(classify(msg('新卡头电商 AI专用卡，希音/亚马逊/速卖通/eBay 等'), DEFAULT_KEYWORDS).score >= 4);
  assert.ok(classify(msg('跨境电商收款卡支持 Amazon、TEMU、TikTok Shop'), DEFAULT_KEYWORDS).score >= 4);
  assert.ok(classify(msg('有人用亚马逊吗？想交流一下开店经验'), DEFAULT_KEYWORDS).score < 4);
  assert.ok(classify(msg('速卖通和 eBay 哪个更适合新手？'), DEFAULT_KEYWORDS).score < 4);
});
test('只处理发给自己的命令', () => {
  assert.equal(parseCommand('/ban@OtherBot 1', 'GuardBot'), null);
  assert.deepEqual(parseCommand('/ban@GuardBot 123', 'GuardBot'), { command: 'ban', arg: '123' });
});
test('Telegram 失败不会返回虚假的成功，429 保留重试时间', async () => {
  const tg = telegram('secret-token', async () => Response.json({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 15 } }, { status: 429 }));
  await assert.rejects(tg('banChatMember'), e => e.retryable && e.retryAfter === 15);
  const denied = telegram('secret-token', async () => Response.json({ ok: false, error_code: 403, description: 'Forbidden' }));
  await assert.rejects(denied('deleteMessage'), e => !e.retryable && e.code === 403);
});
test('网络错误不会泄漏机器人 token', async () => {
  const tg = telegram('secret-token', async () => { throw Error('https://api.telegram.org/botsecret-token'); });
  await assert.rejects(tg('getMe'), e => e.retryable && !e.message.includes('secret-token'));
});
test('缺失 webhook 验证值不接受', async () => {
  assert.equal(await secureEqual('', ''), false);
  assert.equal(await secureEqual('value', 'value'), true);
  assert.equal(await secureEqual('value', 'other'), false);
});
