// Global registry of groups plus the Bookscape publishing hooks.
// Methods are copied onto GuardState.prototype in ../state.js.
import { telegram } from '../telegram.js';
import { draftPost, inspectPost, previewPost, publishPost } from '../bookscape.js';

export class RegistryMethods {
  async register(chat) {
    this.sql.exec('INSERT INTO chats VALUES (?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title WHERE title != excluded.title', String(chat.id), String(chat.title || chat.id));
  }
  unregister(chatId) {
    this.sql.exec('DELETE FROM chats WHERE id=?', String(chatId));
    this.sql.exec('DELETE FROM federation WHERE chat_id=?', String(chatId));
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
