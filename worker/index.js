import { api } from "./telegram.js";
import { checkMessage } from "./filters.js";
import {
  getKeywords,
  setKeywords,
  recordJoin,
  minutesSinceJoin,
  addWarning,
  resetWarnings,
  addLog,
  bumpRepeat,
  resetRepeat,
} from "./kv.js";
import { handleAdminRequest } from "./admin.js";

export default {
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
    const adminIds = (env.ADMIN_IDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    try {
      await handleUpdate(update, { env, tg, adminIds, ctx });
    } catch (e) {
      console.error("handleUpdate error:", e);
    }

    return new Response("OK");
  },
};

async function isChatAdmin(tg, chatId, userId) {
  try {
    const member = await tg("getChatMember", { chat_id: chatId, user_id: userId });
    return !!member && ["administrator", "creator"].includes(member.status);
  } catch {
    return false;
  }
}

async function handleUpdate(update, hctx) {
  const { env, tg, adminIds, ctx } = hctx;
  // 广告号常见套路：先发一条无害消息，过审后再编辑成广告，绕过只监听 message 的机器人
  const msg = update.message || update.edited_message;
  if (!msg || msg.chat.type === "private") return;

  const chatId = msg.chat.id;

  if (Array.isArray(msg.new_chat_members)) {
    for (const member of msg.new_chat_members) {
      if (!member.is_bot) await recordJoin(env, chatId, member.id);
    }
    return;
  }

  if (!msg.from || msg.from.is_bot) return;
  const userId = msg.from.id;
  const text = msg.text || msg.caption || "";

  const isPrivileged = adminIds.includes(String(userId)) || (await isChatAdmin(tg, chatId, userId));

  if (text.startsWith("/")) {
    const handled = await handleCommand({ text, msg, tg, env, isPrivileged });
    if (handled) return;
  }

  if (isPrivileged) return;

  const displayName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ");
  const joinMinutes = await minutesSinceJoin(env, chatId, userId);
  const isNewMember = joinMinutes <= Number(env.NEW_MEMBER_GUARD_MINUTES || 10);
  const keywords = await getKeywords(env);

  const { isSpam, reasons } = checkMessage({
    text,
    displayName,
    isNewMember,
    enableProfileHeuristic: (env.ENABLE_PROFILE_HEURISTIC || "true") === "true",
    keywords,
  });

  // 同一用户短时间内反复刷同一条内容（比如招募"跑分/收米"这类黑话），
  // 即使关键词没命中也当广告处理
  const repeatThreshold = Number(env.FLOOD_REPEAT_THRESHOLD || 3);
  const repeatCount = await bumpRepeat(env, chatId, userId, text);
  const isFlood = repeatCount >= repeatThreshold;

  if (isSpam || isFlood) {
    const finalReasons = isFlood ? [...reasons, `重复刷屏消息(相同内容已发 ${repeatCount} 次)`] : reasons;
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
      reasons: finalReasons,
    });
    await resetRepeat(env, chatId, userId);
  }
}

// 群里发一条处理通知；NOTIFY_GROUP=false 时完全不发，
// NOTIFY_AUTO_DELETE_SECONDS>0 时发出后自动撤回，避免刷屏
async function announce(tg, env, ctx, chatId, text) {
  if ((env.NOTIFY_GROUP || "true") === "false") return;

  const sent = await tg("sendMessage", { chat_id: chatId, text });
  const deleteAfter = Number(env.NOTIFY_AUTO_DELETE_SECONDS ?? 8);

  if (deleteAfter > 0 && sent && sent.message_id && ctx) {
    ctx.waitUntil(
      (async () => {
        await new Promise((r) => setTimeout(r, deleteAfter * 1000));
        try {
          await tg("deleteMessage", { chat_id: chatId, message_id: sent.message_id });
        } catch {}
      })()
    );
  }
}

async function punish({ tg, env, ctx, chatId, chatTitle, userId, messageId, name, text, reasons }) {
  try {
    await tg("deleteMessage", { chat_id: chatId, message_id: messageId });
  } catch (e) {
    console.warn("删除消息失败:", e.message);
  }

  const action = env.ACTION || "warn";
  const escalateAction = env.ESCALATE_ACTION || "kick";
  const warnThreshold = Number(env.WARN_THRESHOLD || 3);

  const log = (takenAction) =>
    addLog(env, {
      ts: new Date().toISOString(),
      chatId,
      chatTitle,
      userId,
      userName: name,
      text: (text || "").slice(0, 300),
      reasons,
      action: takenAction,
    });

  if (action === "kick") {
    await tg("banChatMember", { chat_id: chatId, user_id: userId });
    await tg("unbanChatMember", { chat_id: chatId, user_id: userId });
    await announce(tg, env, ctx, chatId, `🚫 已将 ${name} 移出群聊（疑似广告）\n原因: ${reasons.join("; ")}`);
    await log("kick");
    return;
  }

  if (action === "ban") {
    await tg("banChatMember", { chat_id: chatId, user_id: userId });
    await announce(tg, env, ctx, chatId, `⛔ 已封禁 ${name}（疑似广告）\n原因: ${reasons.join("; ")}`);
    await log("ban");
    return;
  }

  const count = await addWarning(env, chatId, userId);
  if (count >= warnThreshold) {
    if (escalateAction === "ban") {
      await tg("banChatMember", { chat_id: chatId, user_id: userId });
      await announce(tg, env, ctx, chatId, `⛔ ${name} 已达到 ${warnThreshold} 次警告，封禁处理\n原因: ${reasons.join("; ")}`);
      await log("ban (escalated)");
    } else {
      await tg("banChatMember", { chat_id: chatId, user_id: userId });
      await tg("unbanChatMember", { chat_id: chatId, user_id: userId });
      await announce(tg, env, ctx, chatId, `🚫 ${name} 已达到 ${warnThreshold} 次警告，移出群聊\n原因: ${reasons.join("; ")}`);
      await log("kick (escalated)");
    }
    await resetWarnings(env, chatId, userId);
  } else {
    await announce(
      tg,
      env,
      ctx,
      chatId,
      `⚠️ 检测到广告消息已删除，已警告 ${name}（${count}/${warnThreshold}）\n原因: ${reasons.join("; ")}`
    );
    await log(`warn (${count}/${warnThreshold})`);
  }
}

async function handleCommand({ text, msg, tg, env, isPrivileged }) {
  const chatId = msg.chat.id;
  const [cmdRaw, ...rest] = text.trim().split(/\s+/);
  const cmd = cmdRaw.split("@")[0];
  const arg = rest.join(" ").trim();

  if (cmd === "/start") {
    await tg("sendMessage", { chat_id: chatId, text: "广告拦截机器人已启动。请确保我在群里拥有【删除消息】【封禁成员】管理员权限。" });
    return true;
  }

  if (!isPrivileged) return false;

  if (cmd === "/addword") {
    if (!arg) {
      await tg("sendMessage", { chat_id: chatId, text: "用法: /addword 关键词" });
      return true;
    }
    const keywords = await getKeywords(env);
    if (!keywords.includes(arg)) {
      keywords.push(arg);
      await setKeywords(env, keywords);
    }
    await tg("sendMessage", { chat_id: chatId, text: `已添加关键词: ${arg}` });
    return true;
  }

  if (cmd === "/removeword") {
    if (!arg) {
      await tg("sendMessage", { chat_id: chatId, text: "用法: /removeword 关键词" });
      return true;
    }
    const keywords = (await getKeywords(env)).filter((w) => w !== arg);
    await setKeywords(env, keywords);
    await tg("sendMessage", { chat_id: chatId, text: `已移除关键词: ${arg}` });
    return true;
  }

  if (cmd === "/listwords") {
    const keywords = await getKeywords(env);
    await tg("sendMessage", { chat_id: chatId, text: `当前关键词库:\n${keywords.join(", ")}` });
    return true;
  }

  if (cmd === "/ban" || cmd === "/kick") {
    const reply = msg.reply_to_message;
    if (!reply) {
      await tg("sendMessage", { chat_id: chatId, text: `请回复某条消息使用 ${cmd}` });
      return true;
    }
    await tg("banChatMember", { chat_id: chatId, user_id: reply.from.id });
    if (cmd === "/kick") {
      await tg("unbanChatMember", { chat_id: chatId, user_id: reply.from.id });
    }
    const name = reply.from.first_name || reply.from.id;
    await tg("sendMessage", { chat_id: chatId, text: `已${cmd === "/ban" ? "封禁" : "移出"} ${name}` });
    return true;
  }

  return false;
}
