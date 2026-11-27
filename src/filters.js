export const DEFAULT_KEYWORDS = ['日结','急招','兼职','看我简介','看简介','刷单','点赞赚钱','无需经验','无押金','免费领取','招聘','招代理','加v','加微信','私聊我','接单','日入','稳赚','博彩','空投','USDT','代收代付','跑分','洗钱'];
export const CONTENT_LOCK_TYPES = Object.freeze(['link', 'invite', 'forward', 'inline', 'photo', 'video', 'gif', 'file', 'audio', 'sticker']);
export const DEFAULT_POLICY = Object.freeze({ aiReviewEnabled: true, casEnabled: true, profileCheckEnabled: true, deleteServiceMessages: true, veteranTrustEnabled: true, announcements: [], warnThreshold: 3, muteMinutes: 10, repeatThreshold: 3, floodThreshold: 8, newMemberMinutes: 10, newMemberLinkGuard: true, newMemberLinkMinutes: 30, newMemberMediaGuard: true, newMemberMediaMinutes: 30, contentLocks: {}, knowledgeBase: [], welcomeMessage: '', rulesMessage: '', welcomeEnabled: true, welcomeButtons: [], welcomeDeleteMinutes: 10, welcomeKeepLatest: true, welcomeShowCount: true, welcomeBanner: 'default', domainAllowlist: [], domainDenylist: [], verificationMode: 'off', verificationMinutes: 10, verificationChannel: '', verificationTimeoutAction: 'ban', raidEnabled: true, raidJoinLimit: 4, raidMinutes: 30, quietEnabled: false, quietStart: '00:00', quietEnd: '08:00', quietNotify: true, quietEndNoticeMinutes: 30 });

const AD_TRADITIONAL={廣:'广',機:'机',號:'号',錢:'钱',帳:'账',戶:'户',純:'纯',風:'风',險:'险',錄:'录',應:'应',貨:'货',結:'结',賺:'赚',萬:'万',張:'张',來:'来',購:'购',營:'营',銷:'销',聯:'联',繫:'系',穩:'稳',無:'无',經:'经',驗:'验',註:'注',冊:'册',務:'务',售:'售',單:'单',轉:'转',碼:'码',領:'领',幣:'币',約:'约',軌:'轨',跡:'迹',請:'请',帶:'带',盤:'盘',損:'损',進:'进',倉:'仓',續:'续',槓:'杠',桿:'杆',點:'点',個:'个',實:'实',訊:'讯'};
const AD_TRADITIONAL_RE=new RegExp(`[${Object.keys(AD_TRADITIONAL).join('')}]`,'g');
const STRIP_INVISIBLE_RE = /[\u200b-\u200f\u2060\ufeff\u00ad·•・∙‧]/g;
const COLLAPSE_SPACE_RE = /\s+/g;
const DOMAIN_VALID_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const DOMAIN_EXTRACT_RE = /(?:https?:\/\/|www\.)[^\s<>()]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+){1,}\b/gi;
const LATIN_WORD_RE = /^[a-z0-9]+$/;
const LATIN_KEYWORD_CACHE = new Map();

// Precompiled ad-detection patterns hoisted to module scope to avoid per-message RegExp allocation.
const NON_WORD_AT_RE = /[^\p{L}\p{N}@]+/gu;
const NON_WORD_RE = /[^\p{L}\p{N}]+/gu;
const PHOTO_NAME_PITCH_RE = /拍(?:违停|违章|照).{0,16}(?:一百|100|百元|\d+元).{0,4}(?:张|次)/;
const SHORT_CONTACT_CODE_RE = /^@?[a-z][a-z0-9_]{4,31}$/;
const HAS_LINK_RE = /(?:https?:\/\/|www\.|t\.me\/|telegram\.me\/|tg:\/\/)/i;
const INVITATION_RE = /(?:t\.me|telegram\.me)\/(?:\+|joinchat\/)/i;
const CONTACT_RE = /(?:加\s*[vw微]|加微信|私聊我|联系我|看我?简介|微信\s*[:：]|qq\s*[:：]|@[a-z0-9_]{5,})/i;
const SCAM_PITCH_RE = /(?:稳赚|保本|稳赚不赔|无需经验|无押金|日入\s*\d|月入过万|点赞赚钱|代收代付|跑分|翻倍收益)/;
const RECRUITMENT_SLOGAN_RE = /(?:有码.{0,8}吃肉|(?:帮我|来)?收米|替我收钱|招代收|代收招募|来吃肉|带你吃肉|项目招募|团队招募)/;
const DAILY_INCOME_RE = /(?:一天|每日|日赚|日入).{0,4}\d+(?:\.\d+)?\s*(?:k|w|千|万)/i;
const PAID_PHOTO_TARGET_RE = /拍(?:商家收款码|店铺牌匾|豪车)照片/;
const PAID_PHOTO_COUNT_RE = /\d+(?:至\d+)?(?:张|每张)/;
const PAID_PHOTO_PITCH_RE = /(?:日入|日赚|稳定赚钱|小白可做)/;
const DOUYIN_APP_RE = /(?:抖音号|手机和抖音)/;
const DOUYIN_PITCH_RE = /(?:带你赚钱|帮你赚钱|新人可带|小白轻松上手)/;
const DOUYIN_INCOME_RE = /日(?:赚|入)\d+/;
const ACCOUNT_PRODUCT_RE = /(?:^|[^a-z0-9])(?:gv|nextdoor|chatsms)(?=$|[^a-z0-9])|google\s*voice|墨工/;
const ACCOUNT_SUPPLY_VERB_RE = /(?:新批次|批量|出货|供应|出售|售卖)/;
const ACCOUNT_SUPPLY_KIND_RE = /(?:纯手工|手工号|成品号|账号|帐号)/;
const ACCOUNT_SUPPLY_WARRANTY_RE = /(?:登[录陆]包保|售后包保|支持一手测试)/;
const ACCOUNT_SUPPLY_CAUTION_RE = /(?:警惕|谨防|骗局|诈骗|防骗|不要买|别买|识别广告)/;
const ACCOUNT_ITEM = '(?:qq|微信|vx|wx|支付宝|支书|zfb|飞机号|电报号|tg号)';
const ACCOUNT_PRICE = '\\d+(?:\\.\\d+)?(?:元|块)';
const ACCOUNT_SALE_PAIR_RE = new RegExp(`${ACCOUNT_ITEM}.{0,8}${ACCOUNT_PRICE}|${ACCOUNT_PRICE}.{0,8}${ACCOUNT_ITEM}`, 'u');
const ACCOUNT_SALE_SLANG_RE = /(?:首码|代注册|全网.{0,4}注册|卖号|出号|收号|实名号)/;
const PHOTO_GIG_RE = /(?:拍\s*照.{0,8}兼职.{0,12}(?:日\s*结|当天结)|(?:日\s*结|当天结).{0,16}拍\s*照.{0,8}(?:兼职|即可做|赚钱|收入))/;
const PHONE_PHOTO_GIG_RE = /(?:手机.{0,8}拍(?:违停|违章|车辆|照).{0,24}(?:日\s*结|当天结|一百|100|赚|收入)|拍(?:违停|违章).{0,24}(?:日\s*结|当天结|一百|100|赚|收入))/;
const XI_MI = '洗\\s*(?:米|mi|咪|眯|🍚)';
const MONEY_LAUNDERING_RE = new RegExp(`(?:做|招|带|收|来).{0,8}${XI_MI}.{0,16}(?:赚|收益|日(?:赚|入)|\\d)|${XI_MI}.{0,16}(?:赚|收益|日(?:赚|入)).{0,10}\\d`, 'u');
const EARN_HANDLE_RE = /赚\s*\d+(?:\.\d+)?\s*(?:k|w|q|千|万)/i;
const INVESTMENT_WIN_RE = /(?:又)?赚(?:钱|了)|盈利|收益/;
const INVESTMENT_CALL_RE = /(?:跟对(?:人|他)|带单|老师带|爆仓|翻仓)/;
const CODE_MONEY_RE = /(?:码多来.{0,16}捡钱.{0,16}(?:一\s*小时\s*\d+|\d+\s*(?:q|k|w|千|万))|码多来.{0,16}(?:干.{0,12})?挣\s*\d+\s*(?:q|k|w|千|万))/i;
const RESALE_SIGNAL_RES = [
  /(?:水果机|17pm|ax)/i,
  /(?:渠道正品|全球(?:未|禾)激活)/,
  /(?:日(?:搞|赚|入)\d+(?:q|k|w|千|万))/,
  /(?:当日下单.{0,12}(?:秒发|现货)|门店代理|散户出货)/,
];
const PERCENT_RE = /\d{2,3}(?:\.\d+)?\s*%/;
const PERCENT_PROFIT_WORD_RE = /(?:利润|收益|盈利|回报|翻倍|带单|跟单|爆仓)/;
const CRYPTO_CHART_PROFIT_RE = /(?:\d{1,4}\s*(?:个|点).{0,8}利润|\b(?:w|usdt)\b.{0,20}(?:利润|收益))/i;
const COMMERCE_CARD_RE = /(?:新\s*卡头|卡头|(?:电商|跨境)\s*(?:ai\s*)?专用卡|(?:电商|跨境).{0,12}(?:收款卡|支付卡|专用卡))/;
const COMMERCE_PLATFORM_RE = /(?:希音|shein|亚马逊|amazon|速卖通|aliexpress|ebay|temu|tiktok\s*shop|shopify)/g;
const CAUTION_RE = /(?:警惕|谨防|骗局|诈骗|不要转账|别转账|风险|反诈)/;
const CALL_TITLE_RE = /(?:合约|带单|喊单|跟单|交易信号|交易轨迹|操盘|实盘|策略|信号|vip|signals?)/i;
const CRYPTO_TITLE_RE = /(?:币圈|炒币|加密|crypto|btc|eth|usdt|比特|以太|期货|永续|现货|trading|trader)/i;
const CALL_BODY_RE = /(?:vip|移步|带单|喊单|跟单|止盈|止损|入场|做多|做空|多单|空单)/i;
const CONTRACT_PERCENT_RE = /\d+(?:\.\d+)?\s*%/;
const CONTRACT_TERM_RE = /(?:合约|永续|做多|做空|杠杆|\d+\s*x\b)/i;
const CONTRACT_VIP_RE = /(?:vip|移步|带单|喊单|跟单|进群)/i;
const LURE_CITIES = '(?:上海|北京|深圳|广州|杭州|成都|重庆|武汉|南京|苏州|天津|西安|长沙|郑州|东莞|佛山|厦门|福州|青岛|济南|宁波|合肥|昆明|沈阳|大连|哈尔滨|长春|南宁|南昌|贵阳|太原|石家庄|无锡|温州|珠海|海口|三亚|香港|澳门|台北|同城|本地)';
const CITY_GROUP_LURE_RE = new RegExp(`(?:进|加|入|拉).{0,2}${LURE_CITIES}.{0,2}(?!(?:4g|5g)群)\\d+[a-z]{1,2}群`, 'u');
const CONTACT_CARD_AD_RE = /(?:头像|币圈|美股|港股|a股|炒股|股票|带单|跟单|合约|理财|投资|私聊|私信|加我|赚|收益|盈利|副业|兼职|日结|导师|老师|项目|usdt|搬砖|客服|代理|福利|资源|招聘)/i;
const COUNTERFEIT_CASH_RE = /(?:假|仿真?|高仿)(?:币|钞|人民币|美金|美元)|钞.{0,12}(?:过验|验.?机|手感一致|手感一样|一比一|1比1)|(?:过验|验.?机).{0,12}钞/;
const SEX_SERVICE_RE = /(?:嫖娼|漂唱|飘唱|嫖昌|漂娼|飘娼|约炮|玩妹|白嫖妹|楼凤)/;
const ESCORT_VENUE_RE = /(?:工作室|上门|空降|楼凤|外围|小妹|妹子|学生妹|嫩妹|兼职妹|技师|会所)/;
const ESCORT_PACKAGES_RE = /(?:全套|半套|快餐|包夜|过夜|一条龙|大保健|莞式)/g;
const PRICED_PACKAGE_RE = /\d{3,4}(?:元|块|r|rmb)?(?:全套|半套|快餐|包夜|过夜|一条龙|大保健|莞式)(?!设备|配置|装备|器材|工具|教程|课程|资料|方案|系统|软件|服务器|家具|家电|衣服|下来)/i;
const EXPLICIT_ACT_RE = /(?:莞式|口爆|毒龙|胸推|冰火|69式|无套|内射)/;
const ILLEGAL_GOODS_SALE_RE = /(?:出货|日常出|出售|批发|包过|交流群|可漂|可嫖|专用)/;
const DOXX_TERM = '(?:开盒|查档|社工(?:库|查询|数据|机器人|最全|群)|sgk(?:bot|库)|户籍(?:查询|信息)|查户籍|查开房|开房记录|机主(?:信息|查询)|轨迹查询|身份证查询|查身份证|人肉(?:搜索|查询)|定位查人|手机号?定位)';
const DOXX_SERVICE = '(?:专业|秒出|秒查|秒开|速查|代查|包查|精准|全网|接单|承接|渠道|一手|出结果|价格|从未停歇|一直在秒|24小时|全天)';
const DOXX_VICTIM_RE = /(?:被开盒|被人肉|被查档|防开盒|防止开盒|小心|举报|违法|犯法|报警)/;
const DOXX_TERM_RE = new RegExp(DOXX_TERM, 'u');
const DOXX_SERVICE_PAIR_RE = new RegExp(`${DOXX_SERVICE}.{0,12}${DOXX_TERM}|${DOXX_TERM}.{0,12}${DOXX_SERVICE}`, 'u');

export function normalize(text) {
  return String(text || '').normalize('NFKC').replace(AD_TRADITIONAL_RE,c=>AD_TRADITIONAL[c]).replace(STRIP_INVISIBLE_RE, '').replace(COLLAPSE_SPACE_RE, ' ').trim().toLowerCase();
}

export function normalizeDomain(value) {
  const candidate = String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split(':')[0].replace(/\.+$/, '');
  if (!candidate || candidate.length > 253 || !DOMAIN_VALID_RE.test(candidate)) throw new Error('请输入有效域名，例如 example.com');
  return candidate;
}

export function extractDomains(text, links = []) {
  const values = [String(text || ''), ...links.map(String)];
  const found = new Set();
  for (const value of values) {
    const matches = value.match(DOMAIN_EXTRACT_RE) || [];
    for (const match of matches) {
      try { found.add(normalizeDomain(match)); } catch { /* non-domain text */ }
    }
  }
  return [...found];
}

const matchesDomain = (domain, list) => list.some(item => domain === item || domain.endsWith('.' + item));

// A Latin keyword such as "u" or "usdt" must not sit inside a longer English
// word: "收u", "500u" or "usdt 日结" match, but "Ultra" or "sub" do not.
// Chinese keywords keep plain substring matching.
function keywordIn(text, word) {
  if (!word) return false;
  if (!LATIN_WORD_RE.test(word)) return text.includes(word);
  let pattern = LATIN_KEYWORD_CACHE.get(word);
  if (!pattern) {
    if (LATIN_KEYWORD_CACHE.size >= 500) LATIN_KEYWORD_CACHE.clear();
    pattern = new RegExp(`(?<![a-z])${word}(?![a-z])`);
    LATIN_KEYWORD_CACHE.set(word, pattern);
  }
  return pattern.test(text);
}

export function classify(msg, keywords, isNew = false, domainPolicy = {}) {
  const text = msg.text || msg.caption || '';
  const body = normalize(text);
  const compact = body.replace(NON_WORD_AT_RE, '');
  const name = normalize([msg.from?.first_name, msg.from?.last_name, msg.sender_chat?.title].filter(Boolean).join(' '));
  const compactName = name.replace(NON_WORD_RE, '');
  // Confirmed campaign: the paid-photo pitch is in the display name, while
  // the message contains only a contact identifier. Generic nicknames alone
  // must never cause a ban.
  const photoNamePitch = PHOTO_NAME_PITCH_RE.test(compactName);
  const shortContactCode = SHORT_CONTACT_CODE_RE.test(body) && /\d/.test(body);
  const profileContactPitch = photoNamePitch && shortContactCode;
  const entities = msg.entities || msg.caption_entities || [];
  const links = entities.filter(e => e.type === 'text_link' && typeof e.url === 'string').map(e => e.url);
  const destinations = [body, ...links.map(normalize)].join(' ');
  const domains = extractDomains(text, links);
  const allowlist = (domainPolicy.allowlist || []).map(normalizeDomain);
  const denylist = (domainPolicy.denylist || []).map(normalizeDomain);
  const blockedDomains = domains.filter(domain => matchesDomain(domain, denylist));
  const allowedDomains = domains.filter(domain => matchesDomain(domain, allowlist));
  const hasLink = HAS_LINK_RE.test(destinations) || entities.some(e => e.type === 'url');
  const invitation = INVITATION_RE.test(destinations);
  const contact = CONTACT_RE.test(body);
  const normalizedKeywords = keywords.map(normalize);
  const hits = [...new Set(normalizedKeywords.filter(w => keywordIn(body, w)))];
  const nameHits = normalizedKeywords.some(w => keywordIn(name, w));
  const scamPitch = SCAM_PITCH_RE.test(body);
  // Short-form recruitment ads often omit a URL and contact handle, using an
  // invitation slogan plus an implausible daily-income promise instead.
  const recruitmentSlogan = RECRUITMENT_SLOGAN_RE.test(body);
  const dailyIncome = DAILY_INCOME_RE.test(body);
  const paidPhotoRecruitment = PAID_PHOTO_TARGET_RE.test(compact) && PAID_PHOTO_COUNT_RE.test(compact) && PAID_PHOTO_PITCH_RE.test(compact) && contact;
  const douyinRecruitment = DOUYIN_APP_RE.test(compact) && DOUYIN_PITCH_RE.test(compact) && DOUYIN_INCOME_RE.test(compact);
  // Account supply ads can omit links and prices. Require a named product,
  // an explicit supply pitch, production wording and a sales guarantee.
  const accountProduct = ACCOUNT_PRODUCT_RE.test(body);
  const accountSupplyPitch = accountProduct && ACCOUNT_SUPPLY_VERB_RE.test(compact)
    && ACCOUNT_SUPPLY_KIND_RE.test(compact)
    && ACCOUNT_SUPPLY_WARRANTY_RE.test(compact)
    && !ACCOUNT_SUPPLY_CAUTION_RE.test(compact);
  // Account-selling names such as “z支书5元QQ(全网首码注册)”: a payment or
  // messenger account next to a price, plus account-trade slang (首码 etc.).
  // Plain sales talk (“出售 VPS 5元 加微信”) lacks the slang and is left alone.
  const accountSalePitch = ACCOUNT_SALE_PAIR_RE.test(compact) && ACCOUNT_SALE_SLANG_RE.test(compact);
  const photoGigPitch = PHOTO_GIG_RE.test(body);
  // These variants recruit people to photograph vehicles or alleged parking
  // violations, often omitting the word “兼职” entirely.
  const phonePhotoGigPitch = PHONE_PHOTO_GIG_RE.test(body);
  // “洗米” is an obfuscated money-laundering recruitment phrase, also spelled
  // 洗mi / 洗咪 / 洗🍚. An earning claim is required so food-related
  // conversation is never matched.
  const moneyLaunderingPitch = MONEY_LAUNDERING_RE.test(body);
  // A short message that is only a payout claim plus an @handle, e.g.
  // “来xx 赚8K @abcde”. Longer chat that happens to mention earnings is left alone.
  const earnHandlePitch = contact && body.length <= 60 && EARN_HANDLE_RE.test(body);
  // Investment lead scams pair a claimed win/loss with an @handle. Two pitch
  // signals are required to avoid blocking ordinary market discussion.
  const investmentLeadPitch = contact && INVESTMENT_WIN_RE.test(body) && INVESTMENT_CALL_RE.test(body);
  // Confirmed repeated scam campaign. These accounts use the unusual "码多来"
  // lead-in and rotate only the claimed hourly/daily payout, so a link or
  // contact handle cannot be required before removing the first message.
  const codeMoneyPitch = CODE_MONEY_RE.test(body);
  // Product-resale campaigns split every word with punctuation to evade exact
  // keywords. Require multiple campaign signals so normal device discussion is
  // not removed solely for mentioning a phone or a retailer.
  const resalePitch = RESALE_SIGNAL_RES.filter(re => re.test(compact)).length >= 2;
  // Screenshot/chart ads frequently put only a short profit claim in the
  // caption. Limit this to media messages with a trading marker. A bare
  // percentage (battery level, a discount) is not one on its own: it must come
  // with a profit word or a contact pitch.
  const hasMedia = Array.isArray(msg.photo) || !!msg.video || !!msg.animation || !!msg.document;
  const percentProfit = PERCENT_RE.test(body) && (PERCENT_PROFIT_WORD_RE.test(body) || contact);
  const cryptoChartPitch = hasMedia && (CRYPTO_CHART_PROFIT_RE.test(body) || percentProfit);
  // Product-card pitches aimed at cross-border sellers are commonly posted as
  // bare text, with the seller asking interested members to contact them later.
  // Require both the product language and a platform name so ordinary platform
  // discussions, questions, and single brand mentions are not auto-moderated.
  const commerceCardPitch = COMMERCE_CARD_RE.test(body);
  const commercePlatforms = [...new Set((body.match(COMMERCE_PLATFORM_RE) || []).map(normalize))];
  const caution = CAUTION_RE.test(body);
  // Contract "call" channels forward their posts into groups: a profit
  // screenshot, a chart and a short target such as "#SNDK 12%-14%📈", from a
  // channel like "King的幣圈合約交易軌跡". The channel name gives it away, so a
  // forward from a channel named for contract/call trading is banned on its
  // own (each album photo is a separate message, often without caption). A
  // forward from a channel that is only crypto-themed (news, price alerts) is
  // banned only when the post itself pitches calls or VIP, otherwise it is
  // reported to the owner.
  const forwardChannel = msg.forward_origin?.type === 'channel' ? msg.forward_origin.chat : msg.forward_from_chat?.type === 'channel' ? msg.forward_from_chat : null;
  const forwardTitle = forwardChannel ? normalize([forwardChannel.title, forwardChannel.username].filter(Boolean).join(' ')).replace(NON_WORD_RE, '') : '';
  const callTitle = CALL_TITLE_RE.test(forwardTitle);
  const cryptoTitle = CRYPTO_TITLE_RE.test(forwardTitle);
  const callChannelForward = !caution && ((callTitle && cryptoTitle) || (cryptoTitle && CALL_BODY_RE.test(body)));
  const cryptoChannelForward = !callChannelForward && cryptoTitle && !caution;
  // The same posts copied rather than forwarded: a media message whose text
  // (caption or OCR of the screenshot) shows a contract trade and a VIP lure.
  const contractCallPitch = hasMedia && CONTRACT_PERCENT_RE.test(body) && CONTRACT_TERM_RE.test(body) && CONTRACT_VIP_RE.test(body) && !caution;
  // Regional sex-group lures such as “有没有人进上海4T群”: a join verb, a city
  // name, then a short digit+letter code (4T, 3P) and 群. Requiring the code
  // keeps normal questions like “有没有人进上海VPS群/搬瓦工群” out.
  const cityGroupLure = CITY_GROUP_LURE_RE.test(compact) && !caution;
  // Members almost never share a phone contact card in these groups; ad
  // accounts do, naming the card with the pitch ("点我头像 - 币圈+美股").
  // A card whose name carries an ad pitch or keyword is a confirmed ad; any
  // other card is only deleted (see moderation).
  const contactCard = !!msg.contact;
  const cardName = contactCard ? normalize([msg.contact.first_name, msg.contact.last_name].filter(Boolean).join(' ')).replace(NON_WORD_RE, '') : '';
  const contactCardAd = contactCard && (
    CONTACT_CARD_AD_RE.test(cardName)
    || normalizedKeywords.some(w => keywordIn(cardName, w.replace(NON_WORD_RE, ''))));
  // Counterfeit cash and sex-service ads ("假币玩妹嫖娼", "出段钞可漂唱包过验糙机
  // 手感一致 @handle") use homophones for 假钞/嫖娼/验钞机. Cash words alone
  // can be normal talk, so a sale pitch, link or contact is also required.
  const counterfeitCash = COUNTERFEIT_CASH_RE.test(compact);
  const sexService = SEX_SERVICE_RE.test(compact);
  // Escort price menus ("388全套--有工作室"): a price right before a service
  // package (全套/半套/快餐/包夜), plus a venue, a second package or a contact.
  // "全套" alone is ordinary ("全套配置多少钱"), so the price and the venue or
  // second package are both required. Explicit act names need only a venue or
  // contact.
  const escortVenue = ESCORT_VENUE_RE.test(compact);
  const escortPackages = compact.match(ESCORT_PACKAGES_RE) || [];
  // A package followed by an object ("388全套设备") is a purchase, not a menu.
  const pricedPackage = PRICED_PACKAGE_RE.test(compact);
  const explicitAct = EXPLICIT_ACT_RE.test(compact);
  const escortPitch = !caution && (
    (pricedPackage && (escortVenue || new Set(escortPackages).size >= 2 || contact || hasLink))
    || (explicitAct && (escortVenue || pricedPackage || contact || hasLink)));
  const illegalGoodsPitch = escortPitch || ((counterfeitCash || sexService) && !caution
    && (contact || invitation || hasLink || ILLEGAL_GOODS_SALE_RE.test(compact)));
  // Doxxing services ("查档秒出" / "一直在秒 从未停歇专业开盒" / "社工最全") sell personal
  // records. A doxxing term must sit next to a service word, or come with a
  // contact/link, or also appear in the sender's name. Victims asking for help
  // ("我被开盒了") and warnings are left alone.
  const doxxVictim = DOXX_VICTIM_RE.test(compact) || caution;
  const doxxInBody = DOXX_TERM_RE.test(compact);
  const doxxPitch = !doxxVictim && (
    DOXX_SERVICE_PAIR_RE.test(compact)
    || (doxxInBody && (contact || hasLink))
    || (DOXX_TERM_RE.test(compactName) && (doxxInBody || contact || hasLink)));
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
  if (paidPhotoRecruitment) add(7, '包含按张付费拍照与收益招揽');
  if (douyinRecruitment) add(7, '包含抖音账号高收益招揽');
  if (accountSupplyPitch) add(7, '包含账号批量供应及售后保证招揽');
  if (accountSalePitch) add(7, '包含账号低价售卖话术（如首码注册）');
  if (photoGigPitch) add(4, '包含拍照日结兼职招揽');
  if (phonePhotoGigPitch) add(4, '包含手机拍违停日结招揽');
  if (profileContactPitch) add(7, '付费拍照广告昵称附短账号引流');
  if (moneyLaunderingPitch) add(4, '包含“洗米”收益招揽');
  if (cityGroupLure) add(4, '包含同城色情群引流话术（如“进上海4T群”）');
  if (earnHandlePitch && !moneyLaunderingPitch) add(4, '包含高收益承诺加账号引流');
  if (investmentLeadPitch) add(4, '包含投资带单收益引流');
  if (codeMoneyPitch) add(4, '包含“码多来”收益刷屏模板');
  if (resalePitch) add(4, '包含拆词商品分销和收益招揽');
  if (cryptoChartPitch) add(4, '图片附带加密货币收益引流文案');
  if (callChannelForward) add(7, `转发自合约喊单频道：${forwardChannel.title || forwardChannel.username || ''}`);
  else if (cryptoChannelForward) add(3, `转发自币圈频道：${forwardChannel.title || forwardChannel.username || ''}`);
  if (contractCallPitch && !callChannelForward) add(7, '图片带合约收益和 VIP 引流');
  if (commerceCardPitch && commercePlatforms.length) add(4, `跨境电商专用卡推销：${commercePlatforms.slice(0, 4).join('、')}`);
  if (illegalGoodsPitch) add(7, counterfeitCash ? '包含假钞/假币售卖引流' : '包含色情服务引流');
  if (doxxPitch) add(7, '包含开盒/查档（个人信息查询）引流');
  if (contactCardAd) add(7, '分享的联系人名片带广告名字');
  else if (contactCard) add(4, '分享了联系人名片（带电话号码）');
  if (isNew && (hasLink || contact)) add(1, '新成员引流信号');
  // Context reduces confidence, but is not an unconditional bypass.
  if (caution && !contact && !invitation) { score = Math.max(0, score - 3); reasons.push('存在风险提醒语境，降低置信度'); }
  // These are the confirmed campaign templates chosen for immediate removal
  // from the group.
  const permanentBan = (recruitmentSlogan && dailyIncome) || paidPhotoRecruitment || douyinRecruitment || accountSupplyPitch || accountSalePitch || photoGigPitch || phonePhotoGigPitch || profileContactPitch || moneyLaunderingPitch || cityGroupLure || earnHandlePitch || investmentLeadPitch || codeMoneyPitch || resalePitch || cryptoChartPitch || callChannelForward || contractCallPitch || contactCardAd || illegalGoodsPitch || doxxPitch;
  return { score, reasons, hits, deleteOnKeyword: hits.length > 0, domains, blockedDomains, hasLink, contact: contact || contactCard, contactCard, permanentBan, level: score >= 7 ? 'high' : score >= 4 ? 'medium' : score > 0 ? 'low' : 'clean' };
}

export function validateWord(word) {
  if (typeof word !== 'string' || !word.trim() || word.trim().length > 80) throw new Error('关键词须为 1–80 个字符');
  return word.trim();
}

// Used when adding a word: a single letter or digit catches ordinary chat.
export function validateNewWord(word) {
  word = validateWord(word);
  if (/^[a-z0-9]$/i.test(word)) throw new Error('关键词不能只有一个字母或数字，容易误封正常聊天，请写完整一点，例如“收u”');
  return word;
}

export function parseCommand(text, botUsername) {
  const match = /^\/([a-z]+|漏拦)(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/i.exec((text || '').trim());
  if (!match || (match[2] && match[2].toLowerCase() !== botUsername.toLowerCase())) return null;
  return { command: match[1]==='漏拦'?'missed':match[1].toLowerCase(), arg: (match[3] || '').trim() };
}
