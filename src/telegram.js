export class TelegramError extends Error {
  constructor(method, code, description, retryAfter = 0) {
    super(`${method}: ${description}`);
    this.name = 'TelegramError';
    this.code = code;
    this.retryAfter = retryAfter;
    this.retryable = code === 429 || code >= 500;
  }
}

export function telegram(token, transport = fetch) {
  return async (method, params = {}) => {
    let response;
    try {
      response = await transport(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params), signal: AbortSignal.timeout(8000),
      });
    } catch {
      // Never propagate fetch errors containing the token-bearing request URL.
      throw new TelegramError(method, 503, 'network timeout or connection failure');
    }
    let data;
    try { data = await response.json(); } catch {
      throw new TelegramError(method, 502, 'invalid upstream response');
    }
    if (!response.ok || data.ok !== true) {
      const description = String(data.description || 'upstream failure').replaceAll(token, '[redacted]').slice(0, 300);
      throw new TelegramError(method, data.error_code || response.status, description, data.parameters?.retry_after || 0);
    }
    return data.result;
  };
}

export function telegramUpload(token, method, fields, file, transport = fetch) {
  return (async () => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    form.append(file.field, new File([file.bytes], file.name, { type: file.mime }));
    let response;
    try {
      response = await transport(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', body: form, signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new TelegramError(method, 503, 'network timeout or connection failure');
    }
    let data;
    try { data = await response.json(); } catch {
      throw new TelegramError(method, 502, 'invalid upstream response');
    }
    if (!response.ok || data.ok !== true) {
      const description = String(data.description || 'upstream failure').replaceAll(token, '[redacted]').slice(0, 300);
      throw new TelegramError(method, data.error_code || response.status, description, data.parameters?.retry_after || 0);
    }
    return data.result;
  })();
}

export async function secureEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([a, b].map(v => crypto.subtle.digest('SHA-256', enc.encode(v))));
  let diff = 0;
  const xx = new Uint8Array(x), yy = new Uint8Array(y);
  for (let i = 0; i < xx.length; i++) diff |= xx[i] ^ yy[i];
  return diff === 0;
}

export async function digest(value) {
  const data = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(data), x => x.toString(16).padStart(2, '0')).join('');
}
