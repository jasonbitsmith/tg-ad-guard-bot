import { DEFAULT_KEYWORDS } from "./filters.js";

const DAY = 60 * 60 * 24;

export async function getKeywords(env) {
  const raw = await env.BOT_KV.get("keywords");
  return raw ? JSON.parse(raw) : DEFAULT_KEYWORDS;
}

export async function setKeywords(env, list) {
  await env.BOT_KV.put("keywords", JSON.stringify(list));
}

export async function recordJoin(env, chatId, userId) {
  await env.BOT_KV.put(`join:${chatId}:${userId}`, String(Date.now()), {
    expirationTtl: DAY,
  });
}

export async function minutesSinceJoin(env, chatId, userId) {
  const v = await env.BOT_KV.get(`join:${chatId}:${userId}`);
  if (!v) return Infinity;
  return (Date.now() - Number(v)) / 60000;
}

export async function addWarning(env, chatId, userId) {
  const key = `warn:${chatId}:${userId}`;
  const raw = await env.BOT_KV.get(key);
  const count = raw ? Number(raw) + 1 : 1;
  await env.BOT_KV.put(key, String(count), { expirationTtl: DAY });
  return count;
}

export async function resetWarnings(env, chatId, userId) {
  await env.BOT_KV.delete(`warn:${chatId}:${userId}`);
}

const LOG_TTL = DAY * 30;

export async function addLog(env, entry) {
  const key = `log:${String(Date.now()).padStart(13, "0")}:${crypto.randomUUID().slice(0, 8)}`;
  await env.BOT_KV.put(key, JSON.stringify(entry), { expirationTtl: LOG_TTL });
}

export async function getLogs(env, limit = 100) {
  const keys = [];
  let cursor;
  do {
    const page = await env.BOT_KV.list({ prefix: "log:", cursor });
    keys.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const latestKeys = keys.slice(-limit).reverse();
  const values = await Promise.all(latestKeys.map((k) => env.BOT_KV.get(k)));
  return values.filter(Boolean).map((v) => JSON.parse(v));
}
