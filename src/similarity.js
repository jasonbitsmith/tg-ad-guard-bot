import { campaignFingerprint } from './state/operations.js';

// Text reduced to what an ad campaign keeps when it rewords itself: no links,
// handles, long numbers, punctuation or spacing, traditional characters folded.
// Review examples were stored with placeholders for those; drop them too.
export function similarityText(text) {
  return campaignFingerprint(String(text || '').replace(/\[(?:号码|链接|邮箱)\]/g, '').replace(/@user\b/g, '').replace(/\d{7,}/g, ''));
}

function bigrams(text) {
  const chars = [...text], set = new Set();
  for (let i = 0; i < chars.length - 1; i++) set.add(chars[i] + chars[i + 1]);
  return set;
}

// Share of character pairs two texts have in common (0 to 1). A reworded copy
// of an ad ("加我领福利" → "加我 领 福利!!", a few words swapped) stays high;
// different messages on the same topic stay low.
export function similarity(a, b) {
  const x = bigrams(a), y = bigrams(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const pair of x) if (y.has(pair)) shared++;
  return shared / (x.size + y.size - shared);
}

// The confirmed ad most like this message, unless a confirmed normal message
// is at least as close (then it is not treated as a match).
export function closestAd(text, examples, minLength = 10) {
  const target = similarityText(text);
  if ([...target].length < minLength) return null;
  let ad = null, normal = 0;
  for (const example of examples) {
    const value = example.compact ?? similarityText(example.text);
    if ([...value].length < minLength) continue;
    const score = similarity(target, value);
    if (example.verdict === 'advertisement' && score > (ad?.score || 0)) ad = { score, text: example.text };
    if (example.verdict === 'normal') normal = Math.max(normal, score);
  }
  return ad && ad.score > normal ? ad : null;
}
