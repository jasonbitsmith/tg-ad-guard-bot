import { validateBackup, validateConfig, diffValues } from '../src/operations.js';
import { DEFAULT_POLICY } from '../src/filters.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, DEFAULT_KEYWORDS, extractDomains, parseCommand, normalize, normalizeDomain } from '../src/filters.js';
import { telegram, secureEqual } from '../src/telegram.js';
import { dmitNotification, dmitOfficialNotification, parseDmitOfficialRestocks, parseDmitPricing, withDmitAffiliate } from '../src/dmit.js';
import { sampleMatches, validateSample } from '../src/samples.js';

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
test('洗米招揽、手机拍违停和投资带单广告首条永久封禁', () => {
  assert.equal(classify(msg('做洗米 赚一万'), DEFAULT_KEYWORDS).permanentBan, true);
  assert.equal(classify(msg('手机拍违停 一百一张，日结七百左右'), DEFAULT_KEYWORDS).permanentBan, true);
  assert.equal(classify(msg('又赚钱了，跟对他很重要，别等爆仓才后悔 @Aaswed52'), DEFAULT_KEYWORDS).permanentBan, true);
  assert.equal(classify(msg('今天洗米做饭，花了 100 元'), DEFAULT_KEYWORDS).permanentBan, false);
  assert.equal(classify(msg('有人知道为什么会爆仓吗？'), DEFAULT_KEYWORDS).permanentBan, false);
});
test('付费拍照广告昵称加短账号会封禁，普通昵称和正文账号不误判', () => {
  const ad = { ...msg('vf3295292528'), from: { id: 1, first_name: '📷拍*违*停 🚘一*百*元/张🧧' } };
  assert.equal(classify(ad, DEFAULT_KEYWORDS).permanentBan, true);
  assert.equal(classify({ ...ad, text: '你好，想问下 VPS 配置' }, DEFAULT_KEYWORDS).permanentBan, false);
  assert.equal(classify(msg('vf3295292528'), DEFAULT_KEYWORDS).permanentBan, false);
  assert.equal(classify({ ...ad, from: { id: 1, first_name: '摄影爱好者' } }, DEFAULT_KEYWORDS).permanentBan, false);
});
test('码多来收益刷屏模板首条即永久封禁', () => {
  assert.equal(classify(msg('码多来捡钱 一小时1000'), DEFAULT_KEYWORDS).permanentBan, true);
  assert.equal(classify(msg('码多来干 挣9q'), DEFAULT_KEYWORDS).permanentBan, true);
  assert.ok(classify(msg('码多来捡钱 一小时1000'), DEFAULT_KEYWORDS).score >= 4);
  assert.equal(classify(msg('今天写了很多代码来完成任务'), DEFAULT_KEYWORDS).permanentBan, false);
});
test('拆词商品分销和图片收益引流首条即永久封禁', () => {
  assert.equal(classify(msg('免.税集.团7.折出水果机 17.p.m.ax入手只4k 全球禾激活 渠道正品 日搞1w 当.日.下.单 现.货.秒.发 寻线下门店代理 零和散户出货'), DEFAULT_KEYWORDS).permanentBan, true);
  const chart = msg('#W\n30个点的利润'); chart.photo = [{ file_unique_id: 'chart' }];
  assert.equal(classify(chart, DEFAULT_KEYWORDS).permanentBan, true);
  assert.equal(classify(msg('17pm 手机今天降价 500 元'), DEFAULT_KEYWORDS).permanentBan, false);
  const ordinaryChart = msg('这张图是本月服务器流量统计'); ordinaryChart.photo = [{ file_unique_id: 'usage' }];
  assert.equal(classify(ordinaryChart, DEFAULT_KEYWORDS).permanentBan, false);
});
test('图片配文只有百分数不算收益广告，带收益词或联系方式仍封禁', () => {
  const photo = text => { const m = msg(text); m.photo = [{ file_unique_id: 'p-' + text }]; return m; };
  for (const text of ['今天手机电量只剩 15%', '这件衣服打 30% 折扣', '本月 CPU 占用 85%'])
    assert.equal(classify(photo(text), DEFAULT_KEYWORDS).permanentBan, false, text);
  for (const text of ['USDT 一天收益 30%', '带单胜率 95% 跟上', '今日 88% 盈利 私聊我', '翻倍 120% 加微信'])
    assert.equal(classify(photo(text), DEFAULT_KEYWORDS).permanentBan, true, text);
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
test('DMIT 定价页按产品代码识别库存并生成频道推送', () => {
  const html = `<section><h2>HKG.AS3.PRO.TINY</h2><p>1 vCPU / 1 GB RAM / 20 GB NVMe SSD / 1000 GB traffic @ 1 Gbps / $6.90 / mo</p><a href="/aff.php?pid=88">Order Now</a></section><section><h2>LAX.PRO.TINY</h2><p>Out of Stock</p></section>`;
  const items = parseDmitPricing(html, 'https://www.dmit.io/pages/pricing');
  assert.deepEqual(items.map(item => [item.product, item.inStock]), [['HKG.AS3.PRO.TINY', true], ['LAX.PRO.TINY', false]]);
  assert.equal(items[0].region, '香港'); assert.equal(items[0].route, 'CN2 GIA');
  assert.equal(items[0].orderUrl, 'https://www.dmit.io/aff.php?pid=88');
  assert.match(dmitNotification(items[0], '@jason_vps_deal'), /产品：HKG\.AS3\.PRO\.TINY/);
  assert.equal(withDmitAffiliate(items[0].orderUrl, '16962'), 'https://www.dmit.io/aff.php?pid=88&aff=16962');
});

test('DMIT official fallback only accepts restock announcements', () => {
  const html = `<div data-post="DMIT_INC/10"><div class="tgme_widget_message_text js-message_text">LAX.AS3.PRO.TINY is back in stock now.</div></div>
    <div data-post="DMIT_INC/11"><div class="tgme_widget_message_text js-message_text">Network maintenance notice.</div></div>`;
  const items = parseDmitOfficialRestocks(html);
  assert.deepEqual(items, [{ id: '10', message: 'LAX.AS3.PRO.TINY is back in stock now.', url: 'https://t.me/DMIT_INC/10' }]);
  assert.match(dmitOfficialNotification(items[0], '@jason_vps_deal'), /官方补货公告/);
});
test('全局广告样本文字、域名和图片指纹均可命中', () => {
  const rules = [validateSample('text', '水果机渠道出货', '拆词广告'), validateSample('domain', 'spam.example'), validateSample('photo', 'same-picture', '重复海报')];
  const photo = msg('水果机 渠道 出货 https://sub.spam.example'); photo.photo = [{ file_unique_id: 'same-picture' }];
  assert.equal(sampleMatches(photo, rules).length, 3);
  assert.throws(() => validateSample('unknown', 'x'));
});


test('后台脚本语法有效，待审及停用样本不参与处罚', async()=>{
  const {ADMIN_JS}=await import('../src/admin.js');assert.doesNotThrow(()=>new Function(ADMIN_JS));
  assert.equal(sampleMatches({text:'广告'},[{kind:'text',value:'广告',status:'pending'},{kind:'text',value:'广告',status:'disabled'}]).length,0);
});

test('过短文字样本不能启用，完整样本仍支持拆词匹配',()=>{
  assert.throws(()=>validateSample('text','赚'),/至少/);
  assert.throws(()=>validateSample('text','私.聊'),/至少/);
  const pending=validateSample('text','赚','',true);assert.equal(pending.value,'赚');
  assert.equal(sampleMatches({text:'水果.机.渠道.出货'},[validateSample('text','水果机渠道出货')]).length,1);
});

test('备份校验限制范围、不接受密钥和未知配置，活动短样本不可导入',()=>{
 const config={...DEFAULT_POLICY,keywords:['测试词']};const backup={schema:1,created:'now',groups:[{id:'-1',title:'测试',config}],samples:[],federation:['-1']};
 assert.equal(validateBackup(backup).groups[0].id,'-1');assert.equal(backup.groups[0].config,config);
 assert.throws(()=>validateBackup({...backup,BOT_TOKEN:'secret'}),/不支持/);
 assert.throws(()=>validateBackup({...backup,groups:[{...backup.groups[0],config:{...config,password:'secret'}}]}),/未知/);
 assert.throws(()=>validateBackup({...backup,samples:[{kind:'text',value:'赚',status:'active'}]}),/至少/);
 assert.throws(()=>validateBackup({...backup,federation:['-2']}),/联防/);
 assert.throws(()=>validateConfig({...config,quietEnabled:true,quietStart:'00:00',quietEnd:'00:00'}),/静默/);
 assert.equal(validateConfig({...config,newMemberLinkMinutes:1440}).newMemberLinkMinutes,1440);
 assert.deepEqual(diffValues({a:1,b:2},{a:3,b:2}),[{field:'a',before:1,after:3}]);
});


test('富文本读取标题、嵌套段落和隐藏链接，不读取回复或用户资料', async () => {
  const {moderationMessage}=await import('../src/message-content.js');
  const input={from:{first_name:'兼职招聘'},reply_to_message:{text:'兼职'},rich_message:{blocks:[
    {type:'heading',size:1,text:['替我',{type:'bold',text:'收钱'},' 一天7k']},
    {type:'details',summary:'说明',blocks:[{type:'paragraph',text:{type:'url',text:'了解',url:'https://blocked.example/path'}}]},
  ]}};
  const parsed=moderationMessage(input);assert.match(parsed.text,/替我收钱/);assert.ok(!parsed.text.includes('兼职'));
  assert.ok(classify(parsed,[],false,{denylist:['blocked.example']}).blockedDomains.includes('blocked.example'));
  assert.equal(classify(parsed,[]).permanentBan,true);
  const deep={type:'bold'};deep.text=deep;assert.doesNotThrow(()=>moderationMessage({rich_message:{blocks:[deep]}}));
});

test('截图招揽文案首次命中，正常摄影、抖音和防诈讨论不命中', () => {
  for(const body of ['替我收钱 一天7k','有一台手机能拍照就可做，拍商家收款码照片80/张，日入3500，小白可做，具体了解 @example_user','小白轻松上手，只要你有抖音号我就帮你赚钱，日赚3500']) {
    const verdict=classify(msg(body),[]);assert.equal(verdict.permanentBan,true,body);assert.ok(verdict.score>=4);
  }
  for(const body of ['抖音号怎么绑定手机','相机拍豪车照片，每张80元，讨论正常摄影收费','不要相信替我收钱一天7k的骗局']) {
    const verdict=classify(msg(body),[]);assert.ok(verdict.score<4,body);
  }
});


test('账号供应广告需产品、供应、生产及售后信号；正常求助和防骗不命中', async () => {
  const { aiReviewCandidate } = await import('../src/ai-review.js');
  for (const body of [
    '新 批 次 纯 手 工：GV / 墨工 / Nextdoor / ChatSMS 🌟 纯海外独享环境，无封号风险，登录包保，支持一手测试！',
    '批量出售 Nextdoor 成品号，售后包保',
    '供应 Google Voice 手工号，登陆包保',
  ]) {
    const verdict=classify(msg(body),[]);assert.equal(verdict.permanentBan,true,body);assert.ok(verdict.score>=4,body);assert.equal(aiReviewCandidate(body,verdict),false);
  }
  for (const body of [
    'GV 被停用了有解决办法吗？', 'Nextdoor 怎么注册？', 'ChatSMS 和 GV 有什么区别？',
    '供应商 SMS-GV-TN-TF-SL-ID', '纯海外独享环境，无封号风险',
    '纯手工 GV 怎么申请，我想自己注册', '警惕新批次纯手工 GV 登录包保这种骗局',
  ]) {const verdict=classify(msg(body),[]);assert.equal(verdict.permanentBan,false,body);assert.ok(verdict.score<4,body);}
  const candidate='新批次纯手工 Nextdoor，有需要的来';
  assert.equal(aiReviewCandidate(candidate,classify(msg(candidate),[])),true);
});
