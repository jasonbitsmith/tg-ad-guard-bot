import { getKeywords, setKeywords, getLogs } from "./kv.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export async function handleAdminRequest(request, env, pathname) {
  if (pathname === "/admin" || pathname === "/admin/") {
    return new Response(ADMIN_PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  if (pathname.startsWith("/admin/api/")) {
    if (!env.ADMIN_PASSWORD) {
      return json({ error: "服务端未配置 ADMIN_PASSWORD" }, 500);
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
    if (!word || typeof word !== "string") return json({ error: "缺少 word" }, 400);
    const keywords = await getKeywords(env);
    if (!keywords.includes(word)) {
      keywords.push(word);
      await setKeywords(env, keywords);
    }
    return json({ keywords });
  }

  if (pathname === "/admin/api/keywords/remove" && request.method === "POST") {
    const { word } = await request.json().catch(() => ({}));
    if (!word || typeof word !== "string") return json({ error: "缺少 word" }, 400);
    const keywords = (await getKeywords(env)).filter((w) => w !== word);
    await setKeywords(env, keywords);
    return json({ keywords });
  }

  return json({ error: "not found" }, 404);
}

const ADMIN_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>广告拦截机器人后台</title>
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
    <h2>请输入管理密码</h2>
    <input id="pw" type="password" placeholder="ADMIN_PASSWORD" autofocus>
    <div class="err" id="loginErr"></div>
    <button onclick="doLogin()" style="width:100%">登录</button>
  </div>

  <div class="wrap" id="app">
    <h1>广告拦截机器人后台</h1>
    <div class="sub">拦截记录 &amp; 关键词管理</div>

    <div class="tabs">
      <div class="tab active" data-tab="logs" onclick="switchTab('logs')">拦截记录</div>
      <div class="tab" data-tab="keywords" onclick="switchTab('keywords')">关键词管理</div>
    </div>

    <div class="panel active" id="panel-logs">
      <div class="toolbar">
        <div class="meta" id="logsCount"></div>
        <div class="right"><button class="secondary" onclick="loadLogs()">刷新</button></div>
      </div>
      <div id="logsList"></div>
    </div>

    <div class="panel" id="panel-keywords">
      <div class="kw-add">
        <input id="newWord" type="text" placeholder="输入新关键词，回车添加" onkeydown="if(event.key==='Enter')addWord()">
        <button onclick="addWord()">添加</button>
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
    if (res.status === 401) throw new Error("密码错误");
    if (!res.ok) throw new Error("请求失败 (" + res.status + ")");
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
    document.getElementById("logsCount").textContent = "共 " + data.logs.length + " 条记录（最近30天）";
    if (data.logs.length === 0) {
      list.innerHTML = '<div class="empty">还没有拦截记录</div>';
      return;
    }
    list.innerHTML = data.logs.map(l => \`
      <div class="card">
        <div class="row">
          <div class="meta">\${fmtTime(l.ts)} · \${escapeHtml(l.chatTitle || l.chatId)} · \${escapeHtml(l.userName)}</div>
          <span class="action-tag">\${escapeHtml(l.action)}</span>
        </div>
        <div class="text">\${escapeHtml(l.text) || "(无文本)"}</div>
        <div class="reasons">\${(l.reasons || []).map(escapeHtml).join(" ・ ")}</div>
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
      el.innerHTML = '<div class="empty">关键词库为空</div>';
      return;
    }
    el.innerHTML = keywords.map(w => \`
      <div class="kw-chip">
        <span>\${escapeHtml(w)}</span>
        <button data-w="\${escapeHtml(w)}" onclick="removeWord(this.dataset.w)">×</button>
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

  // 自动用已保存的密码尝试登录
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
</script>
</body>
</html>
`;
