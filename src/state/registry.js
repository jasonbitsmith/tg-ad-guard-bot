// Global registry of groups plus the Bookscape publishing hooks.
// Methods are copied onto GuardState.prototype in ../state.js.
import { draftPost, inspectPost, previewPost, publishPost } from '../bookscape.js';

export class RegistryMethods {
  async register(chat) {
    this.sql.exec('INSERT INTO chats VALUES (?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title WHERE title != excluded.title', String(chat.id), String(chat.title || chat.id));
  }
  listChats() { return this.sql.exec('SELECT * FROM chats ORDER BY title COLLATE NOCASE LIMIT 1000').toArray(); }

  bookscapeDraft(body) { return draftPost(this, body); }
  bookscapeInspect(id) { return inspectPost(this, id); }
  bookscapePreview(id) { return previewPost(this, id); }
  bookscapePublish(body) { return publishPost(this, body); }
}
