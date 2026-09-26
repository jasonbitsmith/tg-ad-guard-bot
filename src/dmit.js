const REGION = {
  HKG: '香港', HK: '香港', LAX: '洛杉矶', SJC: '圣何塞', SEA: '西雅图',
  TYO: '东京', FRA: '法兰克福', LON: '伦敦', SIN: '新加坡',
};
const ROUTE = { AS3: 'CN2 GIA', AS6: 'CN2 GIA', PRO: 'Premium', EB: 'Premium', T1: 'Premium' };

function decode(value = '') {
  return value.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}
function text(value = '') {
  return decode(value.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').trim();
}
function absolute(url, source) {
  try {
    const parsed = new URL(decode(url), source);
    return parsed.protocol === 'https:' && /(^|\.)dmit\.io$/i.test(parsed.hostname) ? parsed.href : null;
  } catch { return null; }
}
function productInfo(code, block) {
  const parts = code.split('.');
  const region = REGION[parts[0]] || parts[0];
  const route = ROUTE[parts.find(part => ROUTE[part])] || '页面待确认';
  const plain = text(block);
  const cpu = plain.match(/(\d+)\s*(?:v?cpu|core|核)/i)?.[1];
  const ram = plain.match(/(\d+(?:\.\d+)?)\s*(?:GB|G)\s*(?:RAM|Memory|内存)/i)?.[1];
  const disk = plain.match(/(\d+(?:\.\d+)?)\s*(?:GB|G|TB|T)\s*(?:NVMe|SSD|Storage|Disk|硬盘)/i)?.[1];
  const bandwidth = plain.match(/(\d+(?:\.\d+)?\s*(?:TB|GB|T|G)\s*(?:traffic|流量)?\s*@?\s*\d+(?:\.\d+)?\s*(?:Gbps|Mbps))/i)?.[1]
    || plain.match(/(\d+(?:\.\d+)?\s*(?:TB|GB|T|G)\s*(?:traffic|流量))/i)?.[1]
    || '页面待确认';
  const price = plain.match(/(?:US\$|\$)\s*(\d+(?:\.\d+)?)(?:\s*\/\s*(?:mo|month|月))?/i)?.[1];
  return { product: code, region, route, config: cpu && ram && disk ? `${cpu}C / ${ram}G / ${disk}G` : '页面待确认', bandwidth, price: price ? `$${price}/月` : '页面待确认' };
}

// The pricing page has changed markup several times. This parser intentionally
// relies on stable facts exposed by it: a product code and its Order/Out of Stock
// text, instead of a particular CSS class or theme.
export function parseDmitPricing(html, sourceUrl) {
  if (typeof html !== 'string' || html.length < 20) return [];
  const matches = [...html.matchAll(/\b(?:HKG|HK|LAX|SJC|SEA|TYO|FRA|LON|SIN)(?:\.[A-Z0-9_-]+){2,}\b/g)];
  const products = new Map();
  for (let i = 0; i < matches.length; i++) {
    const code = matches[i][0];
    // Fields and the purchase control normally follow the product code. Limiting
    // the range at the next code prevents a neighbouring sold-out card from
    // changing this product's state.
    const start = matches[i].index;
    const end = Math.min(html.length, matches[i + 1]?.index || matches[i].index + 5000);
    const block = html.slice(start, end);
    const links = [...block.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
    const order = links.find(link => /order\s*now|buy\s*now|立即购买|立即下单/i.test(text(link[2])) && absolute(link[1], sourceUrl));
    const out = /out\s*of\s*stock|sold\s*out|暂时缺货|无货/i.test(text(block));
    const id = code.toUpperCase();
    products.set(id, { id, ...productInfo(id, block), inStock: !!order && !out, orderUrl: order ? absolute(order[1], sourceUrl) : null });
  }
  return [...products.values()];
}

export function dmitNotification(item, channel) {
  return `✅ 【DMIT】监控雷达感知补货！\n\n• 产品：${item.product}\n• 区域：${item.region}\n• 线路：${item.route}\n• 配置：${item.config}\n• 流量/带宽：${item.bandwidth}\n• 价格：${item.price}\n\n🔍 更多产品，请关注 VPS 补货雷达\n${channel}`;
}

export function withDmitAffiliate(orderUrl, affiliateId) {
  if (!orderUrl || !/^\d{1,20}$/.test(String(affiliateId))) return orderUrl;
  try {
    const url = new URL(orderUrl);
    if (url.protocol !== 'https:' || !/(^|\.)dmit\.io$/i.test(url.hostname)) return orderUrl;
    url.searchParams.set('aff', String(affiliateId));
    return url.href;
  } catch { return orderUrl; }
}
