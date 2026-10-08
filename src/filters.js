export const DEFAULT_KEYWORDS = ['日结','急招','兼职','看我简介','看简介','刷单','点赞赚钱','无需经验','无押金','免费领取','招聘','招代理','加v','加微信','私聊我','接单','日入','稳赚','博彩','空投','USDT','代收代付','跑分','洗钱'];
export const CONTENT_LOCK_TYPES = Object.freeze(['link', 'invite', 'forward', 'inline', 'photo', 'video', 'gif', 'file', 'audio', 'sticker']);
export const DEFAULT_POLICY = Object.freeze({ aiReviewEnabled: true, casEnabled: true, profileCheckEnabled: true, warnThreshold: 3, muteMinutes: 10, repeatThreshold: 3, floodThreshold: 8, newMemberMinutes: 10, newMemberLinkGuard: true, newMemberLinkMinutes: 30, newMemberMediaGuard: true, newMemberMediaMinutes: 30, contentLocks: {}, knowledgeBase: [], welcomeMessage: '', rulesMessage: '', domainAllowlist: [], domainDenylist: [], verificationMode: 'off', verificationMinutes: 10, verificationChannel: '', verificationTimeoutAction: 'ban', raidEnabled: true, raidJoinLimit: 4, raidMinutes: 30, quietEnabled: false, quietStart: '00:00', quietEnd: '08:00', quietNotify: true });

export function normalize(text) {
  return String(text || '').normalize('NFKC').replace(/[\u200b-\u200f\u2060\ufeff\u00ad·•・∙‧]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function normalizeDomain(value) {
  const candidate = String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split(':')[0].replace(/\.+$/, '');
  if (!candidate || candidate.length > 253 || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(candidate)) throw new Error('请输入有效域名，例如 example.com');
  return candidate;
}

export function extractDomains(text, links = []) {
  const values = [String(text || ''), ...links.map(String)];
  const found = new Set();
  for (const value of values) {
    const matches = value.match(/(?:https?:\/\/|www\.)[^\s<>()]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+){1,}\b/gi) || [];
    for (const match of matches) {
      try { found.add(normalizeDomain(match)); } catch { /* non-domain text */ }
    }
  }
  return [...found];
}

const matchesDomain = (domain, list) => list.some(item => domain === item || domain.endsWith('.' + item));

export function classify(msg, keywords, isNew = false, domainPolicy = {}) {
  const text = msg.text || msg.caption || '';
  const body = normalize(text);
  const compact = body.replace(/[^\p{L}\p{N}@]+/gu, '');
  const name = normalize([msg.from?.first_name, msg.from?.last_name, msg.sender_chat?.title].filter(Boolean).join(' '));
  const compactName = name.replace(/[^\p{L}\p{N}]+/gu, '');
  // Confirmed campaign: the paid-photo pitch is in the display name, while
  // the message contains only a contact identifier. Generic nicknames alone
  // must never cause a ban.
  const photoNamePitch = /拍(?:违停|违章|照).{0,16}(?:一百|100|百元|\d+元).{0,4}(?:张|次)/.test(compactName);
  const shortContactCode = /^@?[a-z][a-z0-9_]{4,31}$/.test(body) && /\d/.test(body);
  const profileContactPitch = photoNamePitch && shortContactCode;
  // Paid-photo campaigns move the price into the display name and send only
  // recruitment snippets. Require both signals; a nickname alone is insufficient.
  const photoRecruitment = /(?:会拍照就行|拍照即可|做过地推拍照的?来|拍照兼职|拍照赚钱|当天结算|还缺人|找兼职的?来)/.test(compact);
  const profilePhotoRecruitment = photoNamePitch && photoRecruitment && !/(?:警惕|谨防|骗局|诈骗|不要|别信|拒绝)/.test(compact);
  const entities = msg.entities || msg.caption_entities || [];
  const links = entities.filter(e => e.type === 'text_link' && typeof e.url === 'string').map(e => e.url);
  const destinations = [body, ...links.map(normalize)].join(' ');
  const domains = extractDomains(text, links);
  const allowlist = (domainPolicy.allowlist || []).map(normalizeDomain);
  const denylist = (domainPolicy.denylist || []).map(normalizeDomain);
  const blockedDomains = domains.filter(domain => matchesDomain(domain, denylist));
  const allowedDomains = domains.filter(domain => matchesDomain(domain, allowlist));
  const hasLink = /(?:https?:\/\/|www\.|t\.me\/|telegram\.me\/|tg:\/\/)/i.test(destinations) || entities.some(e => e.type === 'url');
  const invitation = /(?:t\.me|telegram\.me)\/(?:\+|joinchat\/)/i.test(destinations);
  const contact = /(?:加\s*[vw微]|加微信|私聊我|联系我|看我?简介|微信\s*[:：]|qq\s*[:：]|@[a-z0-9_]{5,})/i.test(body);
  const hits = [...new Set(keywords.map(normalize).filter(w => w && body.includes(w)))];
  const nameHits = keywords.map(normalize).some(w => w && name.includes(w));
  const scamPitch = /(?:稳赚|保本|稳赚不赔|无需经验|无押金|日入\s*\d|月入过万|点赞赚钱|代收代付|跑分|翻倍收益)/.test(body);
  // Short-form recruitment ads often omit a URL and contact handle, using an
  // invitation slogan plus an implausible daily-income promise instead.
  const recruitmentSlogan = /(?:有码.{0,8}吃肉|(?:帮我|来)?收米|招代收|代收招募|来吃肉|带你吃肉|项目招募|团队招募)/.test(body);
  const dailyIncome = /(?:一天|每日|日赚|日入).{0,4}\d+(?:\.\d+)?\s*(?:k|w|千|万)/i.test(body);
  const photoGigPitch = /(?:拍\s*照.{0,8}兼职.{0,12}(?:日\s*结|当天结)|(?:日\s*结|当天结).{0,16}拍\s*照.{0,8}(?:兼职|即可做|赚钱|收入))/.test(body);
  // These variants recruit people to photograph vehicles or alleged parking
  // violations, often omitting the word “兼职” entirely.
  const phonePhotoGigPitch = /(?:手机.{0,8}拍(?:违停|违章|车辆|照).{0,24}(?:日\s*结|当天结|一百|100|赚|收入)|拍(?:违停|违章).{0,24}(?:日\s*结|当天结|一百|100|赚|收入))/.test(body);
  // “洗米” is an obfuscated money-laundering recruitment phrase. An earning
  // claim is required so food-related conversation is never matched.
  const moneyLaunderingPitch = /(?:做|招|带|收).{0,8}洗米.{0,16}(?:赚|收益|日(?:赚|入)|\d)|洗米.{0,16}(?:赚|收益|日(?:赚|入)).{0,10}\d/.test(body);
  // Investment lead scams pair a claimed win/loss with an @handle. Two pitch
  // signals are required to avoid blocking ordinary market discussion.
  const investmentSignals = [/(?:又)?赚(?:钱|了)|盈利|收益/.test(body), /(?:跟对(?:人|他)|带单|老师带|爆仓|翻仓)/.test(body)];
  const investmentLeadPitch = contact && investmentSignals.filter(Boolean).length >= 2;
  // Confirmed repeated scam campaign. These accounts use the unusual "码多来"
  // lead-in and rotate only the claimed hourly/daily payout, so a link or
  // contact handle cannot be required before removing the first message.
  const codeMoneyPitch = /(?:码多来.{0,16}捡钱.{0,16}(?:一\s*小时\s*\d+|\d+\s*(?:q|k|w|千|万))|码多来.{0,16}(?:干.{0,12})?挣\s*\d+\s*(?:q|k|w|千|万))/i.test(body);
  // Product-resale campaigns split every word with punctuation to evade exact
  // keywords. Require multiple campaign signals so normal device discussion is
  // not removed solely for mentioning a phone or a retailer.
  const resaleSignals = [
    /(?:水果机|17pm|ax)/i.test(compact),
    /(?:渠道正品|全球(?:未|禾)激活)/.test(compact),
    /(?:日(?:搞|赚|入)\d+(?:q|k|w|千|万))/.test(compact),
    /(?:当日下单.{0,12}(?:秒发|现货)|门店代理|散户出货)/.test(compact),
  ];
  const resalePitch = resaleSignals.filter(Boolean).length >= 2;
  // Screenshot/chart ads frequently put only a short profit claim in the
  // caption. Limit this to media messages with a trading marker. A bare
  // percentage (battery level, a discount) is not one on its own: it must come
  // with a profit word or a contact pitch.
  const hasMedia = Array.isArray(msg.photo) || !!msg.video || !!msg.animation || !!msg.document;
  const percentProfit = /\d{2,3}(?:\.\d+)?\s*%/.test(body) && (/(?:利润|收益|盈利|回报|翻倍|带单|跟单|爆仓)/.test(body) || contact);
  const cryptoChartPitch = hasMedia && (/(?:\d{1,4}\s*(?:个|点).{0,8}利润|\b(?:w|usdt)\b.{0,20}(?:利润|收益))/i.test(body) || percentProfit);
  // Product-card pitches aimed at cross-border sellers are commonly posted as
  // bare text, with the seller asking interested members to contact them later.
  // Require both the product language and a platform name so ordinary platform
  // discussions, questions, and single brand mentions are not auto-moderated.
  const commerceCardPitch = /(?:新\s*卡头|卡头|(?:电商|跨境)\s*(?:ai\s*)?专用卡|(?:电商|跨境).{0,12}(?:收款卡|支付卡|专用卡))/.test(body);
  const commercePlatforms = [...new Set((body.match(/(?:希音|shein|亚马逊|amazon|速卖通|aliexpress|ebay|temu|tiktok\s*shop|shopify)/g) || []).map(normalize))];
  const caution = /(?:警惕|谨防|骗局|诈骗|不要转账|别转账|风险|反诈)/.test(body);
  let score = 0;
  const reasons = [];
  const add = (points, reason) => { score += points; reasons.push(reason); };
  if (hits.length) add(Math.min(hits.length, 2), `关键词：${hits.slice(0, 6).join('、')}`);
  if (nameHits) add(1, '昵称存在广告相关词');
  if (hasLink && !allowedDomains.length) add(1, '包含链接（含隐藏链接）');
  if (allowedDomains.length) reasons.push(`白名单域名：${allowedDomains.slice(0, 4).join('、')}`);
  if (blockedDomains.length) add(7, `黑名单域名：${blockedDomains.slice(0, 4).join('、')}`);
  if (contact) add(2, '包含联系或引流话术');
  if (invitation) add(2, '包含群邀请链接');
  if (scamPitch) add(2, '包含收益承诺或高风险招揽话术');
  if (recruitmentSlogan && dailyIncome) add(4, '包含招揽口号和日收入承诺');
  if (photoGigPitch) add(4, '包含拍照日结兼职招揽');
  if (phonePhotoGigPitch) add(4, '包含手机拍违停日结招揽');
  if (profileContactPitch) add(7, '付费拍照广告昵称附短账号引流');
  if (profilePhotoRecruitment) add(7, '付费拍照广告昵称与招揽正文组合');
  if (moneyLaunderingPitch) add(4, '包含“洗米”收益招揽');
  if (investmentLeadPitch) add(4, '包含投资带单收益引流');
  if (codeMoneyPitch) add(4, '包含“码多来”收益刷屏模板');
  if (resalePitch) add(4, '包含拆词商品分销和收益招揽');
  if (cryptoChartPitch) add(4, '图片附带加密货币收益引流文案');
  if (commerceCardPitch && commercePlatforms.length) add(4, `跨境电商专用卡推销：${commercePlatforms.slice(0, 4).join('、')}`);
  if (isNew && (hasLink || contact)) add(1, '新成员引流信号');
  // Context reduces confidence, but is not an unconditional bypass.
  if (caution && !contact && !invitation) { score = Math.max(0, score - 3); reasons.push('存在风险提醒语境，降低置信度'); }
  // These are the confirmed campaign templates chosen for immediate removal
  // from the group.
  const permanentBan = (recruitmentSlogan && dailyIncome) || photoGigPitch || phonePhotoGigPitch || profileContactPitch || profilePhotoRecruitment || moneyLaunderingPitch || investmentLeadPitch || codeMoneyPitch || resalePitch || cryptoChartPitch;
  return { score, reasons, hits, deleteOnKeyword: hits.length > 0, domains, blockedDomains, hasLink, permanentBan, level: score >= 7 ? 'high' : score >= 4 ? 'medium' : score > 0 ? 'low' : 'clean' };
}

export function validateWord(word) {
  if (typeof word !== 'string' || !word.trim() || word.trim().length > 80) throw new Error('关键词须为 1–80 个字符');
  return word.trim();
}

export function parseCommand(text, botUsername) {
  const match = /^\/([a-z]+)(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/i.exec((text || '').trim());
  if (!match || (match[2] && match[2].toLowerCase() !== botUsername.toLowerCase())) return null;
  return { command: match[1].toLowerCase(), arg: (match[3] || '').trim() };
}
