export const DEFAULT_KEYWORDS = [
  "日结", "急招", "兼职", "看我简介", "看简介", "有人带", "拍照采集",
  "刷单", "点赞赚钱", "无需经验", "无押金", "免费领取", "招聘", "招代理",
  "招团队", "加v", "加V", "加微信", "加w", "私聊我", "接单", "包吃住",
  "日入", "月入过万", "抢红包", "稳赚", "菠菜", "博彩", "彩票", "六合彩",
  "空投", "USDT", "搭建团队", "代收代付", "跑分", "洗钱", "收米", "替我收米",
];

const EMOJI_REGEX =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu;
const URL_REGEX = /(https?:\/\/|t\.me\/|telegram\.me\/|www\.)\S+/i;
const CONTACT_REGEX = /(加[vVwW微]|微信[:：]?\s*\w+|QQ[:：]?\s*\d+|电报[:：]?\s*@?\w+)/;
const BRACKET_AD_REGEX = /[【\[][^】\]]{0,20}[】\]]/;

function emojiDensity(text) {
  if (!text) return 0;
  const emojiCount = (text.match(EMOJI_REGEX) || []).length;
  return emojiCount / Math.max(text.length, 1);
}

export function checkMessage({ text, displayName, isNewMember, enableProfileHeuristic, keywords }) {
  const reasons = [];
  const body = text || "";

  const hitKeywords = keywords.filter((w) => body.includes(w));
  if (hitKeywords.length > 0) {
    reasons.push(`命中关键词: ${hitKeywords.join(", ")}`);
  }

  // 很多广告号把"看我简介"之类的引流话术写在昵称里，而不是消息正文
  const nameHitKeywords = keywords.filter((w) => (displayName || "").includes(w));
  if (nameHitKeywords.length > 0) {
    reasons.push(`昵称命中关键词: ${nameHitKeywords.join(", ")}`);
  }

  const hasUrl = URL_REGEX.test(body);
  const hasContact = CONTACT_REGEX.test(body);
  if (hasUrl && (hitKeywords.length > 0 || hasContact)) {
    reasons.push("含链接且伴随广告特征");
  }
  if (hasContact) {
    reasons.push("含联系方式(加V/微信/QQ等)");
  }

  const density = emojiDensity(body);
  const nameDensity = emojiDensity(displayName || "");
  const nameHasBracketAd = BRACKET_AD_REGEX.test(displayName || "");

  if (enableProfileHeuristic) {
    if ((nameDensity > 0.15 || nameHasBracketAd) && (hitKeywords.length > 0 || density > 0.15)) {
      reasons.push("疑似广告号画像(昵称表情/广告括号 + 招聘类文案)");
    }
  }

  if (isNewMember) {
    if (density > 0.2) {
      reasons.push("新成员消息表情符号密度过高");
    }
    if (hasUrl && body.length < 60) {
      reasons.push("新成员发送短文本+链接，疑似广告");
    }
  }

  return { isSpam: reasons.length > 0, reasons };
}
