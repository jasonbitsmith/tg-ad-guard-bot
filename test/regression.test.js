// 考题库：每一次确认过的漏拦和误封都在这里留一条。
// 改规则或改代码后 npm test 会把它们全部重跑一遍，防止「修好 A 又弄坏 B」。
// 新增一条：写清楚日期和发生了什么，expect 选下面四种之一。
//   ban    明确广告：删除并永久封禁
//   act    会被处理（删除），但不算确认广告
//   light  只有一点可疑：不封号（最多单独删除或交给 AI / 私信所有者）
//   clean  正常消息：完全不处理
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, DEFAULT_KEYWORDS } from '../src/filters.js';
import { moderationMessage } from '../src/message-content.js';

// 群里实际用过的关键词，包括 2026-10-13 误封事故里的单字母 u。
const KEYWORDS = [...DEFAULT_KEYWORDS, 'u'];

const CASES = [
  // 漏拦
  { when: '2026-10-15', what: '名片广告「点我头像 - 币圈+美股」', expect: 'ban', message: { contact: { first_name: '点我头像 - 币圈+美股', phone_number: '+8613594323629' } } },
  { when: '2026-10-16', what: '清单消息里的假币广告和入群链接', expect: 'ban', message: { checklist: { title: '假币玩妹嫖娼🔥假钞日常出货都可', tasks: [{ id: 1, text: '假币日常🔥使用交流群' }, { id: 2, text: 'https://t.me/+t9xrbFouuXQ2ZDlx' }] } } },
  { when: '2026-10-16', what: '谐音假钞广告（段钞 / 漂唱 / 验糙机）', expect: 'ban', message: { text: '出段钞可漂唱包过验糙机 手感一致 @abcdef1' } },
  { when: '2026-10-16', what: '按钮里的兼职广告', expect: 'act', message: { text: '点这里', reply_markup: { inline_keyboard: [[{ text: '兼职日结 加微信', url: 'https://t.me/abcdefg' }]] } } },
  { when: '2026-10-17', what: '开盒 / 查档服务广告', expect: 'ban', message: { text: '一直在秒 从未停歇专业开盒 查档秒出 @kaihe888' } },
  { when: '2026-10-21', what: '转发自合约喊单频道「King的幣圈合約交易軌跡」的无文字图片', expect: 'ban', message: { photo: [{ file_unique_id: 'king' }], forward_origin: { type: 'channel', chat: { type: 'channel', title: 'King的幣圈合約交易軌跡' } } } },
  { when: '2026-10-21', what: '复制来的合约收益图 + VIP 引流', expect: 'ban', message: { photo: [{ file_unique_id: 'vip' }], caption: '#SNDK 合约 做多 12% 想跟单进VIP群' } },
  { when: '2026-10-14', what: '同城色情群引流「进上海4T群」', expect: 'ban', message: { text: '有没有人进上海4T群' } },
  { when: '2026-10-09', what: '洗米（洗钱）招揽的拆字写法', expect: 'ban', message: { text: '带你洗mi 一天赚3000' } },
  { when: '2026-10-28', what: '「日常交流」里 yang bai 连发三次的价格色情广告「388全套--有工作室」', expect: 'ban', message: { text: '388全套--有工作室' } },
  { when: '2026-10-28', what: '同类价格菜单写法（快餐 / 包夜 / 可上门）', expect: 'ban', message: { text: '快餐300 包夜800 可上门' } },
  // 误封 / 不该处理的正常消息
  { when: '2026-10-13', what: '关键词 u 误伤 Ultra（英文关键词只匹配整词）', expect: 'clean', message: { text: 'Ultra 套餐值得买吗' } },
  { when: '2026-10-14', what: '只提到 USDT 的正常提问不能封号', expect: 'light', message: { text: 'USDT 怎么买比较安全？' } },
  { when: '2026-10-15', what: '普通人名名片：只删不封', expect: 'act', message: { contact: { first_name: '张伟', phone_number: '+8613594323629' } } },
  { when: '2026-10-16', what: '提醒大家警惕假币', expect: 'clean', message: { text: '大家警惕假币骗局，不要转账' } },
  { when: '2026-10-17', what: '被开盒的受害者求助', expect: 'clean', message: { text: '我被开盒了怎么办，要不要报警' } },
  { when: '2026-10-14', what: '正常问 VPS 群', expect: 'clean', message: { text: '有没有人进上海VPS群' } },
  { when: '2026-10-21', what: '普通币圈新闻转发：只私信所有者，不封号', expect: 'light', message: { text: '比特币今日上涨 3%', forward_origin: { type: 'channel', chat: { type: 'channel', title: '币圈快讯' } } } },
  { when: '2026-10-21', what: '截图里只是手机电量百分比', expect: 'clean', message: { photo: [{ file_unique_id: 'battery' }], caption: '手机电量 85% 了' } },
  { when: '2026-10-28', what: '正常聊天里的「全套」', expect: 'clean', message: { text: '这台服务器全套配置下来 388 元，值不值' } },
  { when: '2026-10-28', what: '正常聊天里的「工作室」和价格', expect: 'clean', message: { text: '我们工作室买了 388 全套设备，还挺好用' } },
];

const outcome = verdict => verdict.permanentBan ? 'ban' : verdict.score >= 4 ? 'act' : verdict.score > 0 || verdict.hits.length ? 'light' : 'clean';

for (const item of CASES) {
  test(`考题 ${item.when}：${item.what}`, () => {
    const message = moderationMessage({ message_id: 1, date: 0, chat: { id: -1, type: 'supergroup', title: '测试群' }, from: { id: 5, first_name: '群友' }, ...item.message });
    const verdict = classify(message, KEYWORDS, false);
    assert.equal(outcome(verdict), item.expect, `实际得分 ${verdict.score}，依据：${verdict.reasons.join('；') || '无'}`);
  });
}
