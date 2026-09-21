export const DEFAULT_KEYWORDS = [
  "日结", "急招", "兼职", "看我简介", "看简介", "有人带", "拍照采集",
  "刷单", "点赞赚钱", "无需经验", "无押金", "免费领取", "招聘", "招代理",
  "招团队", "加v", "加V", "加微信", "加w", "接单", "包吃住",
  "日入", "月入过万", "抢红包", "稳赚", "菠菜", "博彩", "彩票", "六合彩",
  "空投", "USDT", "搭建团队", "代收代付", "跑分", "洗钱", "收米", "替我收米",
  "确实赚钱", "確實賺錢", "喊单", "喊單", "老师带单", "老師帶單", "跟他做单", "跟他做單", "倍收益",
];

const EMOJI_REGEX =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu;
const URL_REGEX = /(https?:\/\/|t\.me\/|telegram\.me\/|www\.)\S+/i;
// t.me/+xxx 或 t.me/joinchat/xxx 是私密邀请链接的专属格式，正常分享公开频道/机器人
// 用的是 t.me/用户名，不会长这样——邀请链接本身就是"拉人进群/频道"的广告行为，足够可信
const INVITE_LINK_REGEX = /(t\.me|telegram\.me)\/(joinchat\/|\+)\S+/i;
const CONTACT_REGEX = /(加[vVwW微]|微信[:：]?\s*\w+|QQ[:：]?\s*\d+|电报[:：]?\s*@?\w+)/;
const BRACKET_AD_REGEX = /[【\[][^】\]]{0,20}[】\]]/;
// 广告号常见的"【拍照*一百*-张】"这类价目式括号：括号内带星号/价格分隔符，
// 正常用户起名几乎不会用这种格式，单独出现就足够可信
const STRICT_BRACKET_AD_REGEX = /[【\[][^】\]]*[*＊][^】\]]*[】\]]/;

// 交易所邀请码返利广告常见套路：从某个"喊单/交易信号"频道转发一张收益截图卡片，
// 配文带 #代币 + 涨幅百分比/"倍"。真正的邀请码文字通常写在图片里（OCR 不到），
// 能拿到的只有转发配文，所以用"涨幅数字 + 倍数"这种财经话术特征来判断
const GAIN_PERCENT_REGEX = /[+＋]?\d{2,4}(\.\d+)?\s*%/;
const MULTIPLIER_WORD_REGEX = /\d+\s*倍/g;

// 零宽字符：广告号常把它们插进关键词中间（比如"收​米"）来躲避字符串匹配，
// 肉眼完全看不出来。匹配前统一清除。
const INVISIBLE_REGEX = /[​‌‍⁠﻿­]/g;
// 间隔号/项目符号：同样常被插在关键词字与字之间拆词（比如"做·完·结算"）
const OBFUSCATION_DOT_REGEX = /[·•・∙‧]/g;

function clean(s) {
  return (s || "").replace(INVISIBLE_REGEX, "").replace(OBFUSCATION_DOT_REGEX, "");
}

function emojiDensity(text) {
  if (!text) return 0;
  const emojiCount = (text.match(EMOJI_REGEX) || []).length;
  return emojiCount / Math.max(text.length, 1);
}

function emojiCount(text) {
  return (text.match(EMOJI_REGEX) || []).length;
}

export function checkMessage({
  text,
  displayName,
  isNewMember,
  enableProfileHeuristic,
  keywords,
  isForwardedFromChannel,
}) {
  const reasons = [];
  const body = clean(text);
  const name = clean(displayName);

  const hitKeywords = keywords.filter((w) => body.includes(w));
  if (hitKeywords.length > 0) {
    reasons.push(`命中关键词: ${hitKeywords.join(", ")}`);
  }

  // 很多广告号把"看我简介"之类的引流话术写在昵称里，而不是消息正文
  const nameHitKeywords = keywords.filter((w) => name.includes(w));
  if (nameHitKeywords.length > 0) {
    reasons.push(`昵称命中关键词: ${nameHitKeywords.join(", ")}`);
  }

  const hasUrl = URL_REGEX.test(body);
  const hasContact = CONTACT_REGEX.test(body);
  const hasInviteLink = INVITE_LINK_REGEX.test(body);
  if (hasUrl && (hitKeywords.length > 0 || hasContact)) {
    reasons.push("含链接且伴随广告特征");
  }
  if (hasContact) {
    reasons.push("含联系方式(加V/微信/QQ等)");
  }
  if (hasInviteLink) {
    reasons.push("含 Telegram 邀请链接");
  }

  const density = emojiDensity(body);
  const nameDensity = emojiDensity(name);
  const nameEmojiCount = emojiCount(name);
  const nameHasBracketAd = BRACKET_AD_REGEX.test(name);
  const nameHasStrictBracketAd = STRICT_BRACKET_AD_REGEX.test(name);
  // 昵称里连续出现 2 个以上星号（比如"拍*违*停""一*百*元/张"）是这类价目式
  // 广告名的核心特征，即使去掉了【】括号也一样成立
  const nameAsteriskCount = (name.match(/[*＊]/g) || []).length;

  if (enableProfileHeuristic) {
    if (nameHasStrictBracketAd || nameAsteriskCount >= 2) {
      // 极强信号，单独出现就判定，不要求正文再命中关键词——
      // 否则广告号只要正文写得含糊就能绕过去
      reasons.push("疑似广告号画像(昵称含价目式广告标记)");
    } else if (
      (nameHasBracketAd || nameEmojiCount >= 3) &&
      (hitKeywords.length > 0 || density > 0.15)
    ) {
      // 普通【】括号昵称、或只带一两个装饰表情的昵称都很常见（"【已认证】""井鱼🐟"），
      // 单独出现不够可信，需要正文再有关键词或表情轰炸才判定，避免误伤正常用户
      reasons.push("疑似广告号画像(昵称括号/表情 + 招聘类文案)");
    }
  }

  // 从频道转发的"涨幅%/翻倍"喊单卡片：单独一条正常聊天提到涨幅很常见，
  // 但"转发自频道 + 涨幅数字/倍数话术"这个组合基本只在这类返利广告里出现
  if (isForwardedFromChannel) {
    const multiplierCount = (body.match(MULTIPLIER_WORD_REGEX) || []).length;
    if (GAIN_PERCENT_REGEX.test(body) || multiplierCount >= 2) {
      reasons.push("转发自频道且含涨幅/倍数话术(疑似交易所返利广告)");
    }
  }

  // 表情轰炸类判定要求正文有一定长度，避免把"😂"这种正常的单条表情回复误判为广告
  if (isNewMember && body.length >= 8) {
    if (density > 0.2) {
      reasons.push("新成员消息表情符号密度过高");
    }
    if (hasUrl && body.length < 60) {
      reasons.push("新成员发送短文本+链接，疑似广告");
    }
  }

  return { isSpam: reasons.length > 0, reasons };
}
