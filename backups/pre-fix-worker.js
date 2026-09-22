var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker/telegram.js
function api(token) {
  const base = `https://api.telegram.org/bot${token}`;
  return async (method, params = {}) => {
    const res = await fetch(`${base}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params)
    });
    const data = await res.json();
    if (!data.ok) {
      console.error(`Telegram API error [${method}]:`, data.description);
    }
    return data.result;
  };
}
__name(api, "api");

// worker/filters.js
var DEFAULT_KEYWORDS = [
  "\u65E5\u7ED3",
  "\u6025\u62DB",
  "\u517C\u804C",
  "\u770B\u6211\u7B80\u4ECB",
  "\u770B\u7B80\u4ECB",
  "\u6709\u4EBA\u5E26",
  "\u62CD\u7167\u91C7\u96C6",
  "\u5237\u5355",
  "\u70B9\u8D5E\u8D5A\u94B1",
  "\u65E0\u9700\u7ECF\u9A8C",
  "\u65E0\u62BC\u91D1",
  "\u514D\u8D39\u9886\u53D6",
  "\u62DB\u8058",
  "\u62DB\u4EE3\u7406",
  "\u62DB\u56E2\u961F",
  "\u52A0v",
  "\u52A0V",
  "\u52A0\u5FAE\u4FE1",
  "\u52A0w",
  "\u63A5\u5355",
  "\u5305\u5403\u4F4F",
  "\u65E5\u5165",
  "\u6708\u5165\u8FC7\u4E07",
  "\u62A2\u7EA2\u5305",
  "\u7A33\u8D5A",
  "\u83E0\u83DC",
  "\u535A\u5F69",
  "\u5F69\u7968",
  "\u516D\u5408\u5F69",
  "\u7A7A\u6295",
  "USDT",
  "\u642D\u5EFA\u56E2\u961F",
  "\u4EE3\u6536\u4EE3\u4ED8",
  "\u8DD1\u5206",
  "\u6D17\u94B1",
  "\u6536\u7C73",
  "\u66FF\u6211\u6536\u7C73",
  "\u786E\u5B9E\u8D5A\u94B1",
  "\u78BA\u5BE6\u8CFA\u9322",
  "\u558A\u5355",
  "\u558A\u55AE",
  "\u8001\u5E08\u5E26\u5355",
  "\u8001\u5E2B\u5E36\u55AE",
  "\u8DDF\u4ED6\u505A\u5355",
  "\u8DDF\u4ED6\u505A\u55AE",
  "\u500D\u6536\u76CA"
];
var EMOJI_REGEX = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu;
var URL_REGEX = /(https?:\/\/|t\.me\/|telegram\.me\/|www\.)\S+/i;
var INVITE_LINK_REGEX = /(t\.me|telegram\.me)\/(joinchat\/|\+)\S+/i;
var CONTACT_REGEX = /(加[vVwW微]|微信[:：]?\s*\w+|QQ[:：]?\s*\d+|电报[:：]?\s*@?\w+)/;
var BRACKET_AD_REGEX = /[【\[][^】\]]{0,20}[】\]]/;
var STRICT_BRACKET_AD_REGEX = /[【\[][^】\]]*[*＊][^】\]]*[】\]]/;
var GAIN_PERCENT_REGEX = /[+＋]?\d{2,4}(\.\d+)?\s*%/;
var MULTIPLIER_WORD_REGEX = /\d+\s*倍/g;
var INVISIBLE_REGEX = /[​‌‍⁠﻿­]/g;
var OBFUSCATION_DOT_REGEX = /[·•・∙‧]/g;
function clean(s) {
  return (s || "").replace(INVISIBLE_REGEX, "").replace(OBFUSCATION_DOT_REGEX, "");
}
__name(clean, "clean");
function emojiDensity(text) {
  if (!text)
    return 0;
  const emojiCount2 = (text.match(EMOJI_REGEX) || []).length;
  return emojiCount2 / Math.max(text.length, 1);
}
__name(emojiDensity, "emojiDensity");
function emojiCount(text) {
  return (text.match(EMOJI_REGEX) || []).length;
}
__name(emojiCount, "emojiCount");
function checkMessage({
  text,
  displayName,
  isNewMember,
  enableProfileHeuristic,
  keywords,
  isForwardedFromChannel
}) {
  const reasons = [];
  const body = clean(text);
  const name = clean(displayName);
  const hitKeywords = keywords.filter((w) => body.includes(w));
  if (hitKeywords.length > 0) {
    reasons.push(`\u547D\u4E2D\u5173\u952E\u8BCD: ${hitKeywords.join(", ")}`);
  }
  const nameHitKeywords = keywords.filter((w) => name.includes(w));
  if (nameHitKeywords.length > 0) {
    reasons.push(`\u6635\u79F0\u547D\u4E2D\u5173\u952E\u8BCD: ${nameHitKeywords.join(", ")}`);
  }
  const hasUrl = URL_REGEX.test(body);
  const hasContact = CONTACT_REGEX.test(body);
  const hasInviteLink = INVITE_LINK_REGEX.test(body);
  if (hasUrl && (hitKeywords.length > 0 || hasContact)) {
    reasons.push("\u542B\u94FE\u63A5\u4E14\u4F34\u968F\u5E7F\u544A\u7279\u5F81");
  }
  if (hasContact) {
    reasons.push("\u542B\u8054\u7CFB\u65B9\u5F0F(\u52A0V/\u5FAE\u4FE1/QQ\u7B49)");
  }
  if (hasInviteLink) {
    reasons.push("\u542B Telegram \u9080\u8BF7\u94FE\u63A5");
  }
  const density = emojiDensity(body);
  const nameDensity = emojiDensity(name);
  const nameEmojiCount = emojiCount(name);
  const nameHasBracketAd = BRACKET_AD_REGEX.test(name);
  const nameHasStrictBracketAd = STRICT_BRACKET_AD_REGEX.test(name);
  const nameAsteriskCount = (name.match(/[*＊]/g) || []).length;
  if (enableProfileHeuristic) {
    if (nameHasStrictBracketAd || nameAsteriskCount >= 2) {
      reasons.push("\u7591\u4F3C\u5E7F\u544A\u53F7\u753B\u50CF(\u6635\u79F0\u542B\u4EF7\u76EE\u5F0F\u5E7F\u544A\u6807\u8BB0)");
    } else if ((nameHasBracketAd || nameEmojiCount >= 3) && (hitKeywords.length > 0 || density > 0.15)) {
      reasons.push("\u7591\u4F3C\u5E7F\u544A\u53F7\u753B\u50CF(\u6635\u79F0\u62EC\u53F7/\u8868\u60C5 + \u62DB\u8058\u7C7B\u6587\u6848)");
    }
  }
  if (isForwardedFromChannel) {
    const multiplierCount = (body.match(MULTIPLIER_WORD_REGEX) || []).length;
    if (GAIN_PERCENT_REGEX.test(body) || multiplierCount >= 2) {
      reasons.push("\u8F6C\u53D1\u81EA\u9891\u9053\u4E14\u542B\u6DA8\u5E45/\u500D\u6570\u8BDD\u672F(\u7591\u4F3C\u4EA4\u6613\u6240\u8FD4\u5229\u5E7F\u544A)");
    }
  }
  if (isNewMember && body.length >= 8) {
    if (density > 0.2) {
      reasons.push("\u65B0\u6210\u5458\u6D88\u606F\u8868\u60C5\u7B26\u53F7\u5BC6\u5EA6\u8FC7\u9AD8");
    }
    if (hasUrl && body.length < 60) {
      reasons.push("\u65B0\u6210\u5458\u53D1\u9001\u77ED\u6587\u672C+\u94FE\u63A5\uFF0C\u7591\u4F3C\u5E7F\u544A");
    }
  }
  return { isSpam: reasons.length > 0, reasons };
}
__name(checkMessage, "checkMessage");

// worker/kv.js
var DAY = 60 * 60 * 24;
async function getKeywords(env) {
  const raw = await env.BOT_KV.get("keywords");
  return raw ? JSON.parse(raw) : DEFAULT_KEYWORDS;
}
__name(getKeywords, "getKeywords");
async function setKeywords(env, list) {
  await env.BOT_KV.put("keywords", JSON.stringify(list));
}
__name(setKeywords, "setKeywords");
async function recordJoin(env, chatId, userId) {
  await env.BOT_KV.put(`join:${chatId}:${userId}`, String(Date.now()), {
    expirationTtl: DAY
  });
}
__name(recordJoin, "recordJoin");
async function minutesSinceJoin(env, chatId, userId) {
  const v = await env.BOT_KV.get(`join:${chatId}:${userId}`);
  if (!v)
    return Infinity;
  return (Date.now() - Number(v)) / 6e4;
}
__name(minutesSinceJoin, "minutesSinceJoin");
async function addWarning(env, chatId, userId) {
  const key = `warn:${chatId}:${userId}`;
  const raw = await env.BOT_KV.get(key);
  const count = raw ? Number(raw) + 1 : 1;
  await env.BOT_KV.put(key, String(count), { expirationTtl: DAY });
  return count;
}
__name(addWarning, "addWarning");
async function resetWarnings(env, chatId, userId) {
  await env.BOT_KV.delete(`warn:${chatId}:${userId}`);
}
__name(resetWarnings, "resetWarnings");
var FLOOD_WINDOW = 60 * 30;
function normalizeText(text) {
  return (text || "").trim().replace(/\s+/g, " ").toLowerCase();
}
__name(normalizeText, "normalizeText");
async function bumpRepeat(env, chatId, userId, text) {
  const key = `flood:${chatId}:${userId}`;
  const norm = normalizeText(text);
  if (!norm)
    return 0;
  const raw = await env.BOT_KV.get(key);
  const prev = raw ? JSON.parse(raw) : null;
  const data = prev && prev.text === norm ? { text: norm, count: prev.count + 1 } : { text: norm, count: 1 };
  await env.BOT_KV.put(key, JSON.stringify(data), { expirationTtl: FLOOD_WINDOW });
  return data.count;
}
__name(bumpRepeat, "bumpRepeat");
async function resetRepeat(env, chatId, userId) {
  await env.BOT_KV.delete(`flood:${chatId}:${userId}`);
}
__name(resetRepeat, "resetRepeat");
var LOG_TTL = DAY * 30;
async function addLog(env, entry) {
  const key = `log:${String(Date.now()).padStart(13, "0")}:${crypto.randomUUID().slice(0, 8)}`;
  await env.BOT_KV.put(key, JSON.stringify(entry), { expirationTtl: LOG_TTL });
}
__name(addLog, "addLog");
async function getLogs(env, limit = 100) {
  const keys = [];
  let cursor;
  do {
    const page = await env.BOT_KV.list({ prefix: "log:", cursor });
    keys.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete ? void 0 : page.cursor;
  } while (cursor);
  const latestKeys = keys.slice(-limit).reverse();
  const values = await Promise.all(latestKeys.map((k) => env.BOT_KV.get(k)));
  return values.filter(Boolean).map((v) => JSON.parse(v));
}
__name(getLogs, "getLogs");

// worker/admin.js
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
__name(json, "json");
async function handleAdminRequest(request, env, pathname) {
  if (pathname === "/admin" || pathname === "/admin/") {
    return new Response(ADMIN_PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  if (pathname.startsWith("/admin/api/")) {
    if (!env.ADMIN_PASSWORD) {
      return json({ error: "\u670D\u52A1\u7AEF\u672A\u914D\u7F6E ADMIN_PASSWORD" }, 500);
    }
    const auth = request.headers.get("Authorization") || "";
    const token = auth.replace(/^Bearer\s+/i, "");
    if (token !== env.ADMIN_PASSWORD) {
      return json({ error: "unauthorized" }, 401);
    }
    return handleApi(request, env, pathname);
  }
  return new Response("Not found", { status: 404 });
}
__name(handleAdminRequest, "handleAdminRequest");
async function handleApi(request, env, pathname) {
  if (pathname === "/admin/api/logs" && request.method === "GET") {
    const logs = await getLogs(env, 200);
    return json({ logs });
  }
  if (pathname === "/admin/api/keywords" && request.method === "GET") {
    const keywords = await getKeywords(env);
    return json({ keywords });
  }
  if (pathname === "/admin/api/keywords/add" && request.method === "POST") {
    const { word } = await request.json().catch(() => ({}));
    if (!word || typeof word !== "string")
      return json({ error: "\u7F3A\u5C11 word" }, 400);
    const keywords = await getKeywords(env);
    if (!keywords.includes(word)) {
      keywords.push(word);
      await setKeywords(env, keywords);
    }
    return json({ keywords });
  }
  if (pathname === "/admin/api/keywords/remove" && request.method === "POST") {
    const { word } = await request.json().catch(() => ({}));
    if (!word || typeof word !== "string")
      return json({ error: "\u7F3A\u5C11 word" }, 400);
    const keywords = (await getKeywords(env)).filter((w) => w !== word);
    await setKeywords(env, keywords);
    return json({ keywords });
  }
  return json({ error: "not found" }, 404);
}
__name(handleApi, "handleApi");
var ADMIN_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>\u5E7F\u544A\u62E6\u622A\u673A\u5668\u4EBA\u540E\u53F0</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0f1115;
    --panel: #161923;
    --border: #262b3a;
    --text: #e6e8ef;
    --muted: #8b90a3;
    --accent: #5b8cff;
    --danger: #ff5c6c;
    --ok: #3ecf8e;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    padding: 24px 16px 60px;
  }
  .wrap { max-width: 900px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: var(--muted); font-size: 13px; margin-bottom: 24px; }

  #login {
    max-width: 320px;
    margin: 80px auto;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 24px;
  }
  #login h2 { margin-top: 0; font-size: 16px; }
  input[type=password], input[type=text] {
    width: 100%;
    padding: 10px 12px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: #0d0f15;
    color: var(--text);
    font-size: 14px;
    margin-bottom: 10px;
  }
  button {
    background: var(--accent);
    color: white;
    border: none;
    border-radius: 8px;
    padding: 9px 16px;
    font-size: 14px;
    cursor: pointer;
  }
  button.secondary {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text);
  }
  button.danger { background: var(--danger); }
  .err { color: var(--danger); font-size: 13px; min-height: 18px; margin: 4px 0; }

  #app { display: none; }
  .tabs { display: flex; gap: 8px; margin-bottom: 16px; border-bottom: 1px solid var(--border); }
  .tab {
    padding: 10px 4px; cursor: pointer; color: var(--muted); font-size: 14px;
    border-bottom: 2px solid transparent; margin-right: 12px;
  }
  .tab.active { color: var(--text); border-bottom-color: var(--accent); }
  .panel { display: none; }
  .panel.active { display: block; }

  .card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px 16px;
    margin-bottom: 10px;
  }
  .row { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
  .meta { color: var(--muted); font-size: 12px; }
  .text { margin: 6px 0; font-size: 14px; word-break: break-word; }
  .reasons { color: var(--muted); font-size: 12px; }
  .action-tag {
    display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 999px;
    background: rgba(255,92,108,0.15); color: var(--danger); white-space: nowrap;
  }

  .kw-add { display: flex; gap: 8px; margin-bottom: 16px; }
  .kw-add input { margin-bottom: 0; flex: 1; }
  .kw-list { display: flex; flex-wrap: wrap; gap: 8px; }
  .kw-chip {
    display: flex; align-items: center; gap: 6px;
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 999px; padding: 6px 6px 6px 12px; font-size: 13px;
  }
  .kw-chip button {
    background: transparent; color: var(--muted); border: none; padding: 2px 8px;
    border-radius: 999px; font-size: 13px; line-height: 1;
  }
  .kw-chip button:hover { background: rgba(255,92,108,0.15); color: var(--danger); }

  .empty { color: var(--muted); font-size: 13px; padding: 20px 0; text-align: center; }
  .toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
  .toolbar .right { display: flex; gap: 8px; }
</style>
</head>
<body>
  <div id="login">
    <h2>\u8BF7\u8F93\u5165\u7BA1\u7406\u5BC6\u7801</h2>
    <input id="pw" type="password" placeholder="ADMIN_PASSWORD" autofocus>
    <div class="err" id="loginErr"></div>
    <button onclick="doLogin()" style="width:100%">\u767B\u5F55</button>
  </div>

  <div class="wrap" id="app">
    <h1>\u5E7F\u544A\u62E6\u622A\u673A\u5668\u4EBA\u540E\u53F0</h1>
    <div class="sub">\u62E6\u622A\u8BB0\u5F55 &amp; \u5173\u952E\u8BCD\u7BA1\u7406</div>

    <div class="tabs">
      <div class="tab active" data-tab="logs" onclick="switchTab('logs')">\u62E6\u622A\u8BB0\u5F55</div>
      <div class="tab" data-tab="keywords" onclick="switchTab('keywords')">\u5173\u952E\u8BCD\u7BA1\u7406</div>
    </div>

    <div class="panel active" id="panel-logs">
      <div class="toolbar">
        <div class="meta" id="logsCount"></div>
        <div class="right"><button class="secondary" onclick="loadLogs()">\u5237\u65B0</button></div>
      </div>
      <div id="logsList"></div>
    </div>

    <div class="panel" id="panel-keywords">
      <div class="kw-add">
        <input id="newWord" type="text" placeholder="\u8F93\u5165\u65B0\u5173\u952E\u8BCD\uFF0C\u56DE\u8F66\u6DFB\u52A0" onkeydown="if(event.key==='Enter')addWord()">
        <button onclick="addWord()">\u6DFB\u52A0</button>
      </div>
      <div class="kw-list" id="kwList"></div>
    </div>
  </div>

<script>
  const PW_KEY = "tg_ad_guard_admin_pw";

  function getPw() {
    try { return localStorage.getItem(PW_KEY) || ""; } catch { return ""; }
  }
  function setPw(v) {
    try { localStorage.setItem(PW_KEY, v); } catch {}
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + getPw(),
        ...(opts.headers || {}),
      },
    });
    if (res.status === 401) throw new Error("\u5BC6\u7801\u9519\u8BEF");
    if (!res.ok) throw new Error("\u8BF7\u6C42\u5931\u8D25 (" + res.status + ")");
    return res.json();
  }

  async function doLogin() {
    const pw = document.getElementById("pw").value.trim();
    if (!pw) return;
    setPw(pw);
    document.getElementById("loginErr").textContent = "";
    try {
      await loadKeywords();
      await loadLogs();
      document.getElementById("login").style.display = "none";
      document.getElementById("app").style.display = "block";
    } catch (e) {
      document.getElementById("loginErr").textContent = e.message;
    }
  }

  function switchTab(name) {
    document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === name));
    document.querySelectorAll(".panel").forEach(p => p.classList.toggle("active", p.id === "panel-" + name));
  }

  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function fmtTime(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleString("zh-CN", { hour12: false });
    } catch { return iso; }
  }

  async function loadLogs() {
    const data = await api("/admin/api/logs");
    const list = document.getElementById("logsList");
    document.getElementById("logsCount").textContent = "\u5171 " + data.logs.length + " \u6761\u8BB0\u5F55\uFF08\u6700\u8FD130\u5929\uFF09";
    if (data.logs.length === 0) {
      list.innerHTML = '<div class="empty">\u8FD8\u6CA1\u6709\u62E6\u622A\u8BB0\u5F55</div>';
      return;
    }
    list.innerHTML = data.logs.map(l => \`
      <div class="card">
        <div class="row">
          <div class="meta">\${fmtTime(l.ts)} \xB7 \${escapeHtml(l.chatTitle || l.chatId)} \xB7 \${escapeHtml(l.userName)}</div>
          <span class="action-tag">\${escapeHtml(l.action)}</span>
        </div>
        <div class="text">\${escapeHtml(l.text) || "(\u65E0\u6587\u672C)"}</div>
        <div class="reasons">\${(l.reasons || []).map(escapeHtml).join(" \u30FB ")}</div>
      </div>
    \`).join("");
  }

  async function loadKeywords() {
    const data = await api("/admin/api/keywords");
    renderKeywords(data.keywords);
  }

  function renderKeywords(keywords) {
    const el = document.getElementById("kwList");
    if (!keywords.length) {
      el.innerHTML = '<div class="empty">\u5173\u952E\u8BCD\u5E93\u4E3A\u7A7A</div>';
      return;
    }
    el.innerHTML = keywords.map(w => \`
      <div class="kw-chip">
        <span>\${escapeHtml(w)}</span>
        <button data-w="\${escapeHtml(w)}" onclick="removeWord(this.dataset.w)">\xD7</button>
      </div>
    \`).join("");
  }

  async function addWord() {
    const input = document.getElementById("newWord");
    const word = input.value.trim();
    if (!word) return;
    const data = await api("/admin/api/keywords/add", { method: "POST", body: JSON.stringify({ word }) });
    input.value = "";
    renderKeywords(data.keywords);
  }

  async function removeWord(word) {
    const data = await api("/admin/api/keywords/remove", { method: "POST", body: JSON.stringify({ word }) });
    renderKeywords(data.keywords);
  }

  // \u81EA\u52A8\u7528\u5DF2\u4FDD\u5B58\u7684\u5BC6\u7801\u5C1D\u8BD5\u767B\u5F55
  (async () => {
    if (getPw()) {
      try {
        await loadKeywords();
        await loadLogs();
        document.getElementById("login").style.display = "none";
        document.getElementById("app").style.display = "block";
      } catch {}
    }
  })();
<\/script>
</body>
</html>
`;

// worker/index.js
var worker_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      return handleAdminRequest(request, env, url.pathname);
    }
    if (request.method !== "POST" || url.pathname !== `/webhook/${env.WEBHOOK_SECRET}`) {
      return new Response("Not found", { status: 404 });
    }
    if (env.WEBHOOK_VERIFY_TOKEN) {
      const header = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (header !== env.WEBHOOK_VERIFY_TOKEN) {
        return new Response("Forbidden", { status: 403 });
      }
    }
    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }
    const tg = api(env.BOT_TOKEN);
    const adminIds = (env.ADMIN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
    try {
      await handleUpdate(update, { env, tg, adminIds, ctx });
    } catch (e) {
      console.error("handleUpdate error:", e);
      try {
        const msg = update.message || update.edited_message;
        await addLog(env, {
          ts: (/* @__PURE__ */ new Date()).toISOString(),
          chatId: msg?.chat?.id ?? null,
          chatTitle: msg?.chat?.title || "",
          userId: msg?.from?.id ?? null,
          userName: msg?.from?.first_name || msg?.from?.username || "",
          text: (msg?.text || msg?.caption || "").slice(0, 300),
          reasons: [`\u5904\u7406\u51FA\u9519: ${e?.message || String(e)}`],
          action: "error"
        });
      } catch (logErr) {
        console.error("\u8BB0\u5F55\u9519\u8BEF\u65E5\u5FD7\u4E5F\u5931\u8D25\u4E86:", logErr);
      }
    }
    return new Response("OK");
  }
};
async function isChatAdmin(tg, chatId, userId) {
  try {
    const member = await tg("getChatMember", { chat_id: chatId, user_id: userId });
    return !!member && ["administrator", "creator"].includes(member.status);
  } catch {
    return false;
  }
}
__name(isChatAdmin, "isChatAdmin");
async function handleUpdate(update, hctx) {
  const { env, tg, adminIds, ctx } = hctx;
  const msg = update.message || update.edited_message;
  if (!msg || msg.chat.type === "private")
    return;
  const chatId = msg.chat.id;
  if (Array.isArray(msg.new_chat_members)) {
    for (const member of msg.new_chat_members) {
      if (!member.is_bot)
        await recordJoin(env, chatId, member.id);
    }
    return;
  }
  if (!msg.from || msg.from.is_bot)
    return;
  const userId = msg.from.id;
  const text = msg.text || msg.caption || "";
  const isPrivileged = adminIds.includes(String(userId)) || await isChatAdmin(tg, chatId, userId);
  if (text.startsWith("/")) {
    const handled = await handleCommand({ text, msg, tg, env, ctx, isPrivileged });
    if (handled)
      return;
  }
  if (isPrivileged)
    return;
  const displayName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ");
  const joinMinutes = await minutesSinceJoin(env, chatId, userId);
  const isNewMember = joinMinutes <= Number(env.NEW_MEMBER_GUARD_MINUTES || 10);
  const keywords = await getKeywords(env);
  const isForwardedFromChannel = msg.forward_origin?.type === "channel" || msg.forward_from_chat?.type === "channel";
  const { isSpam, reasons } = checkMessage({
    text,
    displayName,
    isNewMember,
    enableProfileHeuristic: (env.ENABLE_PROFILE_HEURISTIC || "true") === "true",
    keywords,
    isForwardedFromChannel
  });
  const repeatThreshold = Number(env.FLOOD_REPEAT_THRESHOLD || 3);
  const repeatCount = await bumpRepeat(env, chatId, userId, text);
  const isFlood = repeatCount >= repeatThreshold;
  if (isSpam || isFlood) {
    const finalReasons = isFlood ? [...reasons, `\u91CD\u590D\u5237\u5C4F\u6D88\u606F(\u76F8\u540C\u5185\u5BB9\u5DF2\u53D1 ${repeatCount} \u6B21)`] : reasons;
    await punish({
      tg,
      env,
      ctx,
      chatId,
      chatTitle: msg.chat.title || "",
      userId,
      messageId: msg.message_id,
      name: displayName || msg.from.username || String(userId),
      text,
      reasons: finalReasons
    });
    await resetRepeat(env, chatId, userId);
  }
}
__name(handleUpdate, "handleUpdate");
async function announce(tg, env, ctx, chatId, text) {
  if ((env.NOTIFY_GROUP || "true") === "false")
    return;
  const sent = await tg("sendMessage", { chat_id: chatId, text });
  const deleteAfter = Number(env.NOTIFY_AUTO_DELETE_SECONDS ?? 8);
  if (deleteAfter > 0 && sent && sent.message_id && ctx) {
    ctx.waitUntil(
      (async () => {
        await new Promise((r) => setTimeout(r, deleteAfter * 1e3));
        try {
          await tg("deleteMessage", { chat_id: chatId, message_id: sent.message_id });
        } catch {
        }
      })()
    );
  }
}
__name(announce, "announce");
async function punish({ tg, env, ctx, chatId, chatTitle, userId, messageId, name, text, reasons }) {
  try {
    await tg("deleteMessage", { chat_id: chatId, message_id: messageId });
  } catch (e) {
    console.warn("\u5220\u9664\u6D88\u606F\u5931\u8D25:", e.message);
  }
  const action = env.ACTION || "warn";
  const escalateAction = env.ESCALATE_ACTION || "kick";
  const warnThreshold = Number(env.WARN_THRESHOLD || 3);
  const log = /* @__PURE__ */ __name((takenAction) => addLog(env, {
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    chatId,
    chatTitle,
    userId,
    userName: name,
    text: (text || "").slice(0, 300),
    reasons,
    action: takenAction
  }), "log");
  if (action === "kick") {
    await tg("banChatMember", { chat_id: chatId, user_id: userId });
    await tg("unbanChatMember", { chat_id: chatId, user_id: userId });
    await announce(tg, env, ctx, chatId, `\u{1F6AB} \u5DF2\u5C06 ${name} \u79FB\u51FA\u7FA4\u804A\uFF08\u7591\u4F3C\u5E7F\u544A\uFF09
\u539F\u56E0: ${reasons.join("; ")}`);
    await log("kick");
    return;
  }
  if (action === "ban") {
    await tg("banChatMember", { chat_id: chatId, user_id: userId });
    await announce(tg, env, ctx, chatId, `\u26D4 \u5DF2\u5C01\u7981 ${name}\uFF08\u7591\u4F3C\u5E7F\u544A\uFF09
\u539F\u56E0: ${reasons.join("; ")}`);
    await log("ban");
    return;
  }
  const count = await addWarning(env, chatId, userId);
  if (count >= warnThreshold) {
    if (escalateAction === "ban") {
      await tg("banChatMember", { chat_id: chatId, user_id: userId });
      await announce(tg, env, ctx, chatId, `\u26D4 ${name} \u5DF2\u8FBE\u5230 ${warnThreshold} \u6B21\u8B66\u544A\uFF0C\u5C01\u7981\u5904\u7406
\u539F\u56E0: ${reasons.join("; ")}`);
      await log("ban (escalated)");
    } else {
      await tg("banChatMember", { chat_id: chatId, user_id: userId });
      await tg("unbanChatMember", { chat_id: chatId, user_id: userId });
      await announce(tg, env, ctx, chatId, `\u{1F6AB} ${name} \u5DF2\u8FBE\u5230 ${warnThreshold} \u6B21\u8B66\u544A\uFF0C\u79FB\u51FA\u7FA4\u804A
\u539F\u56E0: ${reasons.join("; ")}`);
      await log("kick (escalated)");
    }
    await resetWarnings(env, chatId, userId);
  } else {
    await announce(
      tg,
      env,
      ctx,
      chatId,
      `\u26A0\uFE0F \u68C0\u6D4B\u5230\u5E7F\u544A\u6D88\u606F\u5DF2\u5220\u9664\uFF0C\u5DF2\u8B66\u544A ${name}\uFF08${count}/${warnThreshold}\uFF09
\u539F\u56E0: ${reasons.join("; ")}`
    );
    await log(`warn (${count}/${warnThreshold})`);
  }
}
__name(punish, "punish");
async function handleCommand({ text, msg, tg, env, ctx, isPrivileged }) {
  const chatId = msg.chat.id;
  const [cmdRaw, ...rest] = text.trim().split(/\s+/);
  const cmd = cmdRaw.split("@")[0];
  const arg = rest.join(" ").trim();
  if (cmd === "/start") {
    await tg("sendMessage", { chat_id: chatId, text: "\u5E7F\u544A\u62E6\u622A\u673A\u5668\u4EBA\u5DF2\u542F\u52A8\u3002\u8BF7\u786E\u4FDD\u6211\u5728\u7FA4\u91CC\u62E5\u6709\u3010\u5220\u9664\u6D88\u606F\u3011\u3010\u5C01\u7981\u6210\u5458\u3011\u7BA1\u7406\u5458\u6743\u9650\u3002" });
    return true;
  }
  if (!isPrivileged)
    return false;
  if (cmd === "/addword") {
    if (!arg) {
      await tg("sendMessage", { chat_id: chatId, text: "\u7528\u6CD5: /addword \u5173\u952E\u8BCD" });
      return true;
    }
    const keywords = await getKeywords(env);
    if (!keywords.includes(arg)) {
      keywords.push(arg);
      await setKeywords(env, keywords);
    }
    await tg("sendMessage", { chat_id: chatId, text: `\u5DF2\u6DFB\u52A0\u5173\u952E\u8BCD: ${arg}` });
    return true;
  }
  if (cmd === "/removeword") {
    if (!arg) {
      await tg("sendMessage", { chat_id: chatId, text: "\u7528\u6CD5: /removeword \u5173\u952E\u8BCD" });
      return true;
    }
    const keywords = (await getKeywords(env)).filter((w) => w !== arg);
    await setKeywords(env, keywords);
    await tg("sendMessage", { chat_id: chatId, text: `\u5DF2\u79FB\u9664\u5173\u952E\u8BCD: ${arg}` });
    return true;
  }
  if (cmd === "/listwords") {
    const keywords = await getKeywords(env);
    await tg("sendMessage", { chat_id: chatId, text: `\u5F53\u524D\u5173\u952E\u8BCD\u5E93:
${keywords.join(", ")}` });
    return true;
  }
  if (cmd === "/ban" || cmd === "/kick") {
    const reply = msg.reply_to_message;
    if (!reply) {
      await tg("sendMessage", { chat_id: chatId, text: `\u8BF7\u56DE\u590D\u67D0\u6761\u6D88\u606F\u4F7F\u7528 ${cmd}` });
      return true;
    }
    try {
      await tg("deleteMessage", { chat_id: chatId, message_id: reply.message_id });
    } catch (e) {
      console.warn("\u5220\u9664\u6D88\u606F\u5931\u8D25:", e.message);
    }
    await tg("banChatMember", { chat_id: chatId, user_id: reply.from.id });
    if (cmd === "/kick") {
      await tg("unbanChatMember", { chat_id: chatId, user_id: reply.from.id });
    }
    const name = reply.from.first_name || reply.from.id;
    await announce(tg, env, ctx, chatId, `\u5DF2${cmd === "/ban" ? "\u5C01\u7981" : "\u79FB\u51FA"} ${name}\uFF08\u7BA1\u7406\u5458\u624B\u52A8\u5904\u7406\uFF09`);
    await addLog(env, {
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      chatId,
      chatTitle: msg.chat.title || "",
      userId: reply.from.id,
      userName: name,
      text: (reply.text || reply.caption || "").slice(0, 300),
      reasons: ["\u7BA1\u7406\u5458\u624B\u52A8\u5904\u7406"],
      action: cmd === "/ban" ? "ban (manual)" : "kick (manual)"
    });
    return true;
  }
  return false;
}
__name(handleCommand, "handleCommand");
export {
  worker_default as default
};
//# sourceMappingURL=index.js.map

