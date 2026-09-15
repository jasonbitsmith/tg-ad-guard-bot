import "dotenv/config";
import { Telegraf } from "telegraf";
import { checkMessage, addKeyword, removeKeyword, listKeywords } from "./filters.js";
import { recordJoin, minutesSinceJoin, addWarning, resetWarnings } from "./store.js";

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("缺少 BOT_TOKEN，请检查 .env 文件");
  process.exit(1);
}

const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);

const ACTION = process.env.ACTION || "warn"; // warn | kick | ban
const WARN_THRESHOLD = Number(process.env.WARN_THRESHOLD || 3);
const ESCALATE_ACTION = process.env.ESCALATE_ACTION || "kick"; // kick | ban
const NEW_MEMBER_GUARD_MINUTES = Number(process.env.NEW_MEMBER_GUARD_MINUTES || 10);
const ENABLE_PROFILE_HEURISTIC = (process.env.ENABLE_PROFILE_HEURISTIC || "true") === "true";

const bot = new Telegraf(BOT_TOKEN);

function isAdmin(userId) {
  return ADMIN_IDS.includes(userId);
}

async function isChatAdmin(ctx, userId) {
  try {
    const member = await ctx.telegram.getChatMember(ctx.chat.id, userId);
    return ["administrator", "creator"].includes(member.status);
  } catch {
    return false;
  }
}

// 记录新成员加入时间
bot.on("new_chat_members", (ctx) => {
  for (const member of ctx.message.new_chat_members) {
    if (member.is_bot) continue;
    recordJoin(ctx.chat.id, member.id);
  }
});

async function handlePunish(ctx, userId, reasons) {
  const chatId = ctx.chat.id;

  try {
    await ctx.deleteMessage();
  } catch (e) {
    console.warn("删除消息失败:", e.message);
  }

  const name = ctx.from.first_name || ctx.from.username || String(userId);

  if (ACTION === "kick") {
    await ctx.banChatMember(userId);
    await ctx.unbanChatMember(userId); // 解除封禁以便可再次加入 = 效果等同踢出
    await ctx.reply(`🚫 已将 ${name} 移出群聊（疑似广告）\n原因: ${reasons.join("; ")}`);
    return;
  }

  if (ACTION === "ban") {
    await ctx.banChatMember(userId);
    await ctx.reply(`⛔ 已封禁 ${name}（疑似广告）\n原因: ${reasons.join("; ")}`);
    return;
  }

  // warn 模式
  const count = addWarning(chatId, userId);
  if (count >= WARN_THRESHOLD) {
    if (ESCALATE_ACTION === "ban") {
      await ctx.banChatMember(userId);
      await ctx.reply(`⛔ ${name} 已达到 ${WARN_THRESHOLD} 次警告，封禁处理\n原因: ${reasons.join("; ")}`);
    } else {
      await ctx.banChatMember(userId);
      await ctx.unbanChatMember(userId);
      await ctx.reply(`🚫 ${name} 已达到 ${WARN_THRESHOLD} 次警告，移出群聊\n原因: ${reasons.join("; ")}`);
    }
    resetWarnings(chatId, userId);
  } else {
    await ctx.reply(
      `⚠️ 检测到广告消息已删除，已警告 ${name}（${count}/${WARN_THRESHOLD}）\n原因: ${reasons.join("; ")}`
    );
  }
}

bot.on("message", async (ctx, next) => {
  try {
    const msg = ctx.message;
    if (!msg || !msg.from || msg.from.is_bot) return next();
    if (ctx.chat.type === "private") return next();

    const userId = msg.from.id;

    // 管理员/群管理员消息不检测
    if (isAdmin(userId) || (await isChatAdmin(ctx, userId))) return next();

    const text = msg.text || msg.caption || "";
    const displayName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ");
    const joinMinutes = minutesSinceJoin(ctx.chat.id, userId);
    const isNewMember = joinMinutes <= NEW_MEMBER_GUARD_MINUTES;

    const { isSpam, reasons } = checkMessage({
      text,
      displayName,
      isNewMember,
      enableProfileHeuristic: ENABLE_PROFILE_HEURISTIC,
      keywords: listKeywords(),
    });

    if (isSpam) {
      await handlePunish(ctx, userId, reasons);
      return;
    }

    return next();
  } catch (e) {
    console.error("处理消息出错:", e);
    return next();
  }
});

// ---- 管理员命令 ----

bot.command("addword", async (ctx) => {
  if (!isAdmin(ctx.from.id) && !(await isChatAdmin(ctx, ctx.from.id))) return;
  const word = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!word) return ctx.reply("用法: /addword 关键词");
  addKeyword(word);
  ctx.reply(`已添加关键词: ${word}`);
});

bot.command("removeword", async (ctx) => {
  if (!isAdmin(ctx.from.id) && !(await isChatAdmin(ctx, ctx.from.id))) return;
  const word = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!word) return ctx.reply("用法: /removeword 关键词");
  removeKeyword(word);
  ctx.reply(`已移除关键词: ${word}`);
});

bot.command("listwords", async (ctx) => {
  if (!isAdmin(ctx.from.id) && !(await isChatAdmin(ctx, ctx.from.id))) return;
  ctx.reply(`当前关键词库:\n${listKeywords().join(", ")}`);
});

bot.command("ban", async (ctx) => {
  if (!isAdmin(ctx.from.id) && !(await isChatAdmin(ctx, ctx.from.id))) return;
  const reply = ctx.message.reply_to_message;
  if (!reply) return ctx.reply("请回复某条消息使用 /ban");
  await ctx.banChatMember(reply.from.id);
  ctx.reply(`已封禁 ${reply.from.first_name || reply.from.id}`);
});

bot.command("kick", async (ctx) => {
  if (!isAdmin(ctx.from.id) && !(await isChatAdmin(ctx, ctx.from.id))) return;
  const reply = ctx.message.reply_to_message;
  if (!reply) return ctx.reply("请回复某条消息使用 /kick");
  await ctx.banChatMember(reply.from.id);
  await ctx.unbanChatMember(reply.from.id);
  ctx.reply(`已移出 ${reply.from.first_name || reply.from.id}`);
});

bot.command("start", (ctx) => {
  ctx.reply("广告拦截机器人已启动。请确保我在群里拥有【删除消息】【封禁成员】管理员权限。");
});

bot.launch().then(() => {
  console.log("Bot started.");
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
