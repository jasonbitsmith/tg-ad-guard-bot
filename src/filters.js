import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORDS_FILE = path.join(__dirname, "words.json");

function loadWords() {
  return JSON.parse(fs.readFileSync(WORDS_FILE, "utf8"));
}

export function addKeyword(word) {
  const data = loadWords();
  if (!data.keywords.includes(word)) {
    data.keywords.push(word);
    fs.writeFileSync(WORDS_FILE, JSON.stringify(data, null, 2));
  }
}

export function removeKeyword(word) {
  const data = loadWords();
  data.keywords = data.keywords.filter((w) => w !== word);
  fs.writeFileSync(WORDS_FILE, JSON.stringify(data, null, 2));
}

export function listKeywords() {
  return loadWords().keywords;
}

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
    // 广告号画像：昵称表情密度高 + 带【】广告样式括号 + 消息本身也是短招聘文案
    if ((nameDensity > 0.15 || nameHasBracketAd) && (hitKeywords.length > 0 || density > 0.15)) {
      reasons.push("疑似广告号画像(昵称表情/广告括号 + 招聘类文案)");
    }
  }

  // 新成员在保护期内，放宽阈值：单独的表情轰炸或单条关键词即可判定
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
