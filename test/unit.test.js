import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, DEFAULT_KEYWORDS, extractDomains, parseCommand, normalize, normalizeDomain } from '../src/filters.js';
import { telegram, secureEqual } from '../src/telegram.js';

const msg = text => ({ text, from: { id: 1, first_name: '群友' } });
test('黑名单关键词首次命中即要求删除，非关键词普通聊天不处理', () => {
  for (const text of ['请警惕刷单骗局，不要转账','有人了解 USDT 的风险吗？','周末有兼职经验分享吗？','我们正在招聘工程师']) {
    assert.equal(classify(msg(text), DEFAULT_KEYWORDS).deleteOnKeyword, true, text);
  }
  assert.equal(classify(msg('欢迎大家交流'), DEFAULT_KEYWORDS).deleteOnKeyword, false);
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
test('招揽口号叠加日收入承诺会被处理，普通收入讨论不误删', () => {
  assert.equal(classify(msg('有码来吃肉 一天8K'), DEFAULT_KEYWORDS).permanentBan, true);
  assert.ok(classify(msg('带你吃肉，每日 1.2w，想来的私聊'), DEFAULT_KEYWORDS).score >= 4);
  assert.equal(classify(msg('帮我收米 一天赚8K'), DEFAULT_KEYWORDS).permanentBan, true);
  assert.equal(classify(msg('招代收 一天8K'), DEFAULT_KEYWORDS).permanentBan, true);
  assert.ok(classify(msg('来收米 一天1W'), DEFAULT_KEYWORDS).score >= 4);
  assert.ok(classify(msg('有人了解这个岗位一天 8K 的说法是否真实吗？'), DEFAULT_KEYWORDS).score < 4);
  assert.ok(classify(msg('今天和朋友吃肉，花了 8K 买服务器'), DEFAULT_KEYWORDS).score < 4);
});
test('拍照日结兼职招揽会被处理', () => {
  assert.equal(classify(msg('拍·照兼职📱 日·结7百左右💰'), DEFAULT_KEYWORDS).permanentBan, true);
  assert.ok(classify(msg('日结 700，拍照即可做'), DEFAULT_KEYWORDS).score >= 4);
  assert.ok(classify(msg('拍照留档，日结费用已报销'), DEFAULT_KEYWORDS).score < 4);
});
test('域名黑名单覆盖裸链接和隐藏链接，白名单只降低链接分', () => {
  assert.deepEqual(extractDomains('看 example.com 和 https://sub.example.net/path'), ['example.com', 'sub.example.net']);
  assert.equal(normalizeDomain('HTTPS://WWW.Example.COM/path'), 'example.com');
  assert.throws(() => normalizeDomain('not a domain'));
  assert.ok(classify(msg('请访问 https://bad.example/path'), DEFAULT_KEYWORDS, false, { denylist: ['bad.example'] }).score >= 7);
  assert.ok(classify(msg('普通链接 https://docs.example.com/guide'), DEFAULT_KEYWORDS, false, { allowlist: ['example.com'] }).score < 4);
  const hidden = msg('点击这里'); hidden.entities = [{ type: 'text_link', offset: 0, length: 4, url: 'https://track.bad.example/a' }];
  assert.ok(classify(hidden, DEFAULT_KEYWORDS, false, { denylist: ['bad.example'] }).score >= 7);
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
