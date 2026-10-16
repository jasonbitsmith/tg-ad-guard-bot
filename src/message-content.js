// Bot API RichMessage contains authored content only. Never walk reply/user
// metadata: names, quoted replies and guest callers are not message evidence.
export function moderationMessage(message) {
  return withPollOrChecklist(withContactCard(richMessage(message)));
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
