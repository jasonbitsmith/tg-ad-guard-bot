import { normalize, normalizeDomain } from './filters.js';

export function validateSample(kind, value, label = '', allowShort = false) {
  if (!['text', 'domain', 'photo'].includes(kind)) throw new Error('无效样本类型');
  if (typeof value !== 'string' || !value.trim() || value.length > 500) throw new Error('样本内容须为 1–500 个字符');
  const normalized = kind === 'domain' ? normalizeDomain(value) : kind === 'text' ? normalize(value).replace(/[^\p{L}\p{N}@]+/gu, '') : value.trim();
  if (kind === 'text' && [...normalized].length < 6 && !allowShort) throw new Error('文字样本归一化后至少需要 6 个字或字符，请使用完整广告特征');
  if (!normalized) throw new Error('样本内容无效');
  if (typeof label !== 'string' || label.length > 120) throw new Error('备注不能超过 120 个字符');
  return { kind, value: normalized, label: label.trim() };
}

export function sampleMatches(msg, rules = [], body = '') {
  const photos = Array.isArray(msg.photo) ? msg.photo.map(item => item.file_unique_id).filter(Boolean) : [];
  const text = normalize(body || msg.text || msg.caption || '');
  const compact = text.replace(/[^\p{L}\p{N}@]+/gu, '');
  const domains = new Set((text.match(/(?:https?:\/\/|www\.)[^\s<>()]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+){1,}\b/gi) || []).map(value => {
    try { return normalizeDomain(value); } catch { return null; }
  }).filter(Boolean));
  return rules.filter(rule => (!rule.status || rule.status === 'active') && ((rule.kind === 'text' && compact.includes(rule.value))
    || (rule.kind === 'photo' && photos.includes(rule.value))
    || (rule.kind === 'domain' && [...domains].some(domain => domain === rule.value || domain.endsWith('.' + rule.value)))));
}
