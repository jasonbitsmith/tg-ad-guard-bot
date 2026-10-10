// Constants and helpers shared by GuardState and its method modules.

export const DAY = 86400000;
export const ADMIN_STATUS = ['administrator', 'creator'];
// Groups discovered in the v1 interception history. Telegram has no Bot API
// endpoint that lists every group containing a bot, so these are explicitly
// seeded once into the v2 admin registry during the migration.
export const LEGACY_CHATS = [
  { id: '-1003510391132', title: 'Jason 的全球手机号保号实验室' },
  { id: '-1003941419403', title: 'Jason-AI调教实验室' },
  { id: '-1003590410271', title: 'Jason - VPS 交流互助交流' },
  { id: '-1003336565693', title: 'Jason海外收款互助交流群' },
  { id: '-1003495086337', title: 'Jason - 数字生活指南' },
];
// Placeholder groups that were once seeded by mistake and must be purged.
export const REMOVED_CHATS = ['-100999888777'];
export const HELP = '群管理指令（管理员使用）\n/status 状态及权限检查\n/addword 词、/removeword 词、/listwords（仅本群）\n回复消息或指定用户 ID：\n/warnings、/clearwarn、/allow、/unallow、/unban、/unmute\n/spam 回复广告：删除并封禁，存入待审核样本\n/ban 手动封禁、/kick 移出（会涉及删除历史消息）\n自动策略：广告命中后直接删消息并永久封禁账号，不发送或累计警告。';
export function normalizeKnowledge(items) {
  if (!Array.isArray(items)) return [];
  const used = new Set(), result = [];
  for (const raw of items.slice(0, 50)) {
    const command = String(raw?.command || '').trim().toLowerCase().replace(/^\//, '');
    const title = String(raw?.title || command || '').trim().slice(0, 40);
    const triggers = [...new Set((Array.isArray(raw?.triggers) ? raw.triggers : String(raw?.triggers || '').split(/[,，\n]/)).map(value => String(value).trim()).filter(value => value && value.length <= 80))].slice(0, 12);
    const response = String(raw?.response || '').trim();
    if ((!command && !triggers.length) || !response || response.length > 2500 || (command && !/^[a-z][a-z0-9_]{0,31}$/.test(command)) || (command && used.has(command))) continue;
    if (command) used.add(command);
    result.push({ id: String(raw?.id || crypto.randomUUID()), title: title || triggers[0], command, triggers, response, enabled: raw?.enabled !== false });
  }
  return result;
}
