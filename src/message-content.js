// Bot API RichMessage contains authored content only. Never walk reply/user
// metadata: names, quoted replies and guest callers are not message evidence.
export function moderationMessage(message) {
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
