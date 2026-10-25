// Global registry of groups plus the Bookscape publishing hooks.
// Methods are copied onto GuardState.prototype in ../state.js.
import { telegram } from '../telegram.js';
import { draftPost, inspectPost, previewPost, publishPost } from '../bookscape.js';

export class RegistryMethods {
  async register(chat) {
    this.sql.exec('INSERT INTO chats VALUES (?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title WHERE title != excluded.title', String(chat.id), String(chat.title || chat.id));
    this.remove('unregistered:' + String(chat.id));
  }
  // Only an owner can bring the bot into a new group. When anyone else adds
  // it, the bot leaves at once and tells the owner, so strangers' groups never
  // reach this admin, its alerts or its AI/OCR quotas. Groups already listed
  // (promotions, title changes) are untouched. OPEN_GROUPS="true" lets anyone add it.
  async admitGroup(membership) {
    const chat = membership.chat, id = String(chat.id), adder = membership.from || {};
    const listed = this.sql.exec('SELECT id FROM chats WHERE id=?', id).toArray().length > 0;
    if (listed || this.env.OPEN_GROUPS === 'true' || this.owners().includes(String(adder.id))) { await this.register(chat); return { admitted: true }; }
    let left = true;
    try { await telegram(this.env.BOT_TOKEN)('leaveChat', { chat_id: Number(id) }); }
    catch (error) { if (error.retryable) throw error; left = false; }
    this.log({ action: 'group-refused', chatId: id, userId: String(adder.id || ''), outcome: left ? 'success' : 'failed', text: String(chat.title || id).slice(0, 100) });
    const name = [adder.first_name, adder.last_name].filter(Boolean).join(' ') || '未知用户';
    await this.alertOwner('group-refused-' + id, `有人把机器人拉进了一个新群，机器人已${left ? '自动退出' : '尝试退出（未成功，请手动检查）'}\n群：${String(chat.title || id).slice(0, 100)}\n拉进来的人：${name.slice(0, 60)}${adder.username ? ' @' + adder.username : ''}（ID ${adder.id || '未知'}）\n\n只有你本人拉机器人进群才会生效。如果这是你的群，请你自己再把机器人拉进去一次。`).catch(() => {});
    return { admitted: false, left };
  }
  unregister(chatId) {
    this.sql.exec('DELETE FROM chats WHERE id=?', String(chatId));
    this.sql.exec('DELETE FROM federation WHERE chat_id=?', String(chatId));
    this.write('unregistered:' + String(chatId), true);
  }
  // Admin "remove group": the bot leaves the chat, then the group is dropped
  // from the registry. A group the bot already left still gets removed.
  async leaveGroup(chatId) {
    const id = String(chatId);
    if (!this.sql.exec('SELECT id FROM chats WHERE id=?', id).toArray().length) throw new Error('未找到这个群');
    let left = true;
    try { await telegram(this.env.BOT_TOKEN)('leaveChat', { chat_id: Number(id) }); }
    catch (error) { if (error.retryable) throw error; left = false; }
    this.unregister(id);
    this.log({ action: 'group-remove', actorId: 'web-admin', chatId: id, outcome: 'success', text: left ? 'left' : 'already-gone' });
    return { chats: this.listChats() };
  }
  listChats() { return this.sql.exec('SELECT * FROM chats ORDER BY title COLLATE NOCASE LIMIT 1000').toArray(); }

  bookscapeDraft(body) { return draftPost(this, body); }
  bookscapeInspect(id) { return inspectPost(this, id); }
  bookscapePreview(id) { return previewPost(this, id); }
  bookscapePublish(body) { return publishPost(this, body); }
}
