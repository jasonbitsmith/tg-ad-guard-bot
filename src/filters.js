export const DEFAULT_KEYWORDS = ['日结','急招','兼职','看我简介','看简介','刷单','点赞赚钱','无需经验','无押金','免费领取','招聘','招代理','加v','加微信','私聊我','接单','日入','稳赚','博彩','空投','USDT','代收代付','跑分','洗钱'];
export const DEFAULT_POLICY = Object.freeze({ warnThreshold: 3, muteMinutes: 10, repeatThreshold: 3, floodThreshold: 8, newMemberMinutes: 10 });

export function normalize(text) {
  return String(text || '').normalize('NFKC').replace(/[\u200b-\u200f\u2060\ufeff\u00ad·•・∙‧]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function classify(msg, keywords, isNew = false) {
  const text = msg.text || msg.caption || '';
  const body = normalize(text);
  const name = normalize([msg.from?.first_name, msg.from?.last_name, msg.sender_chat?.title].filter(Boolean).join(' '));
  const entities = msg.entities || msg.caption_entities || [];
  const links = entities.filter(e => e.type === 'text_link' && typeof e.url === 'string').map(e => e.url);
  const destinations = [body, ...links.map(normalize)].join(' ');
  const hasLink = /(?:https?:\/\/|www\.|t\.me\/|telegram\.me\/|tg:\/\/)/i.test(destinations) || entities.some(e => e.type === 'url');
  const invitation = /(?:t\.me|telegram\.me)\/(?:\+|joinchat\/)/i.test(destinations);
  const contact = /(?:加\s*[vw微]|加微信|私聊我|联系我|看我?简介|微信\s*[:：]|qq\s*[:：]|@[a-z0-9_]{5,})/i.test(body);
  const hits = [...new Set(keywords.map(normalize).filter(w => w && body.includes(w)))];
  const nameHits = keywords.map(normalize).some(w => w && name.includes(w));
  const scamPitch = /(?:稳赚|保本|稳赚不赔|无需经验|无押金|日入\s*\d|月入过万|点赞赚钱|代收代付|跑分|翻倍收益)/.test(body);
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
  if (hasLink) add(1, '包含链接（含隐藏链接）');
  if (contact) add(2, '包含联系或引流话术');
  if (invitation) add(2, '包含群邀请链接');
  if (scamPitch) add(2, '包含收益承诺或高风险招揽话术');
  if (commerceCardPitch && commercePlatforms.length) add(4, `跨境电商专用卡推销：${commercePlatforms.slice(0, 4).join('、')}`);
  if (isNew && (hasLink || contact)) add(1, '新成员引流信号');
  // Context reduces confidence, but is not an unconditional bypass.
  if (caution && !contact && !invitation) { score = Math.max(0, score - 3); reasons.push('存在风险提醒语境，降低置信度'); }
  return { score, reasons, level: score >= 7 ? 'high' : score >= 4 ? 'medium' : score > 0 ? 'low' : 'clean' };
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
