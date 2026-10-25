// Bot API RichMessage contains authored content only. Never walk reply/user
// metadata: names, quoted replies and guest callers are not message evidence.
export function moderationMessage(message) {
  return withButtonsAndVenue(withPollOrChecklist(withContactCard(richMessage(message))));
}

// Messages sent through an inline bot carry their pitch and link on buttons
// under the message, and a shared place has its words in the venue title and
// address. Neither is in text, so both were never read. Expose them as text
// and keep button links, the same way as checklists and contact cards.
function withButtonsAndVenue(message) {
  const rows = message?.reply_markup?.inline_keyboard, venue = message?.venue;
  if (!Array.isArray(rows) && !venue) return message;
  const lines = [], links = [];
  for (const row of (Array.isArray(rows) ? rows : []).slice(0, 20)) for (const button of (Array.isArray(row) ? row : []).slice(0, 8)) {
    if (typeof button?.text === 'string' && button.text) lines.push(button.text.slice(0, 200));
    const url = button?.url || button?.login_url?.url;
    if (typeof url === 'string' && links.length < 50) links.push({ type: 'text_link', url: url.slice(0, 2048) });
  }
  if (venue) lines.push(['地点：' + String(venue.title || '').slice(0, 200), String(venue.address || '').slice(0, 300)].filter(Boolean).join(' '));
  if (!lines.length && !links.length) return message;
  const base = message.text || message.caption || '';
  return { ...message, text: [base, ...lines].filter(Boolean).join('\n'), entities: [...(message.entities || message.caption_entities || []), ...links] };
}

// Polls and checklists carry their words in their own fields, not in text.
// The checklist ad ("假币…" title, a t.me/+ invite as the last task) was never
// read. Expose title, question, options and tasks as text, and keep hidden links.
function withPollOrChecklist(message) {
  const list = message?.checklist, poll = message?.poll;
  if (!list && !poll) return message;
  const lines = [], links = [];
  const add = (value, entities) => {
    if (typeof value === 'string' && value) lines.push(value.slice(0, 500));
    for (const e of Array.isArray(entities) ? entities : []) if (e?.type === 'text_link' && typeof e.url === 'string' && links.length < 50) links.push({ type: 'text_link', url: e.url.slice(0, 2048) });
  };
  if (list) {
    add(list.title, list.title_entities);
    for (const task of (Array.isArray(list.tasks) ? list.tasks : []).slice(0, 50)) add(task?.text, task?.text_entities);
  }
  if (poll) {
    add(poll.question, poll.question_entities);
    for (const option of (Array.isArray(poll.options) ? poll.options : []).slice(0, 20)) add(option?.text, option?.text_entities);
    add(poll.explanation, poll.explanation_entities);
  }
  const base = message.text || message.caption || '';
  return { ...message, text: [base, ...lines].filter(Boolean).join('\n'), entities: [...(message.entities || message.caption_entities || []), ...links] };
}

// A shared contact card has no text at all: the ad is the card's name (for
// example "点我头像 - 币圈+美股") plus a phone number. Expose them as text so
// keywords, logs and AI review see what the member actually posted.
function withContactCard(message) {
  const card = message?.contact;
  if (!card) return message;
  const name = [card.first_name, card.last_name].filter(Boolean).join(' ').slice(0, 200);
  const phone = String(card.phone_number || '').slice(0, 40);
  const line = ['名片：' + (name || '（无名字）'), phone].filter(Boolean).join(' ');
  return { ...message, text: [message.text || message.caption || '', line].filter(Boolean).join('\n') };
}

function richMessage(message) {
  if (!message?.rich_message) return message;
  const links = [], parts = [];
  let visited = 0, remaining = 16000;
  function text(node, depth = 0) {
    if (++visited > 4096 || depth > 32 || remaining <= 0) return '';
    if (typeof node === 'string') { const value = node.slice(0, remaining); remaining -= value.length; return value; }
    if (!node || typeof node !== 'object') return '';
    if (Array.isArray(node)) return node.map(item => text(item, depth + 1)).join('');
    if (typeof node.url === 'string' && links.length < 100) links.push({ type: 'text_link', url: node.url.slice(0, 2048) });
    const result = [];
    for (const key of ['text', 'summary', 'caption', 'credit', 'alternative_text', 'expression', 'button']) {
      if (node[key] !== undefined) result.push(text(node[key], depth + 1));
    }
    for (const key of ['blocks', 'items', 'cells', 'buttons']) {
      if (Array.isArray(node[key])) result.push(node[key].map(item => text(item, depth + 1)).join('\n'));
    }
    return result.join('\n');
  }
  for (const block of message.rich_message.blocks || []) parts.push(text(block));
  return { ...message, text: [message.text || message.caption || '', ...parts].filter(Boolean).join('\n'), entities: [...(message.entities || message.caption_entities || []), ...links] };
}

export function isGuestMessage(message) {
  return message?.from?.is_bot === true && !!(message.guest_bot_caller_user || message.guest_bot_caller_chat);
}

// Fields that describe a message (who, where, reply, formatting) rather than
// carry its content.
const METADATA = new Set(['message_id', 'message_thread_id', 'direct_messages_topic', 'from', 'sender_chat', 'sender_boost_count', 'sender_business_bot', 'sender_tag', 'date', 'business_connection_id', 'chat', 'forward_origin', 'forward_from', 'forward_from_chat', 'forward_from_message_id', 'forward_signature', 'forward_sender_name', 'forward_date', 'is_topic_message', 'is_automatic_forward', 'reply_to_message', 'external_reply', 'quote', 'reply_to_story', 'reply_to_checklist_task_id', 'via_bot', 'edit_date', 'has_protected_content', 'is_from_offline', 'is_paid_post', 'media_group_id', 'author_signature', 'paid_star_count', 'entities', 'caption_entities', 'link_preview_options', 'suggested_post_info', 'effect_id', 'show_caption_above_media', 'has_media_spoiler', 'reply_markup', 'guest_bot_caller_user', 'guest_bot_caller_chat']);
// Content the bot reads, or knows to be harmless (media is handled by OCR and
// media guards; service notices come from Telegram itself).
const READABLE = new Set(['text', 'caption', 'rich_message', 'photo', 'video', 'animation', 'document', 'audio', 'voice', 'video_note', 'sticker', 'contact', 'poll', 'checklist', 'venue', 'location', 'dice', 'game', 'story', 'invoice', 'paid_media', 'giveaway', 'giveaway_winners', 'giveaway_created', 'giveaway_completed', 'successful_payment', 'refunded_payment', 'users_shared', 'chat_shared', 'write_access_allowed', 'passport_data', 'proximity_alert_triggered', 'boost_added', 'chat_background_set', 'checklist_tasks_done', 'checklist_tasks_added', 'forum_topic_created', 'forum_topic_edited', 'forum_topic_closed', 'forum_topic_reopened', 'general_forum_topic_hidden', 'general_forum_topic_unhidden', 'video_chat_scheduled', 'video_chat_started', 'video_chat_ended', 'video_chat_participants_invited', 'web_app_data', 'new_chat_members', 'left_chat_member', 'new_chat_title', 'new_chat_photo', 'delete_chat_photo', 'group_chat_created', 'supergroup_chat_created', 'channel_chat_created', 'message_auto_delete_timer_changed', 'migrate_to_chat_id', 'migrate_from_chat_id', 'pinned_message', 'connected_website', 'gift', 'unique_gift', 'paid_message_price_changed', 'direct_message_price_changed']);

// Every missed ad so far was a new kind of message the bot did not read yet
// (contact cards, checklists, buttons). A message with no text and no field
// the bot knows is returned as its unknown field names, so it can be held
// back instead of passing unread.
export function unreadableContent(message) {
  if (!message || typeof message !== 'object' || message.text || message.caption) return [];
  const keys = Object.keys(message).filter(key => !METADATA.has(key));
  if (!keys.length || keys.some(key => READABLE.has(key))) return [];
  return keys.slice(0, 5).map(key => key.slice(0, 40));
}
