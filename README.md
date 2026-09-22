# TG 群管理机器人修正版

线上 Worker：`tg-ad-guard-bot`。后台自定义域名：`https://bot.jasonselect.com/admin`。

## 本次部署验证

2026-09-22 已部署 v2.0.1。该补丁从旧版拦截记录恢复了 6 个已知群到后台下拉菜单；Cloudflare 的 `guard-v2` 存储迁移和原有密钥绑定均保留。

- 23 项本地测试全部通过，包含真实 workerd/SQLite Durable Object 环境下的模拟 Telegram 集成测试。
- Wrangler dry-run 构建通过，已生成包含密钥名称的运行时类型。
- 线上 `/health` 返回 v2.0.0；后台 HTML/JS 返回 200，带 no-store 和 nosniff。
- 未登录读取后台返回 401；无效 Webhook 路径返回 404。
- 空密码登录返回 401，验证了线上 Durable Object 会话存储初始化和密码拒绝逻辑。
- 没有在真实群里发送测试消息或执行测试处罚；端到端 Telegram 收发与真实群权限由后台“运行自检”和群内 `/status` 提供后续检查。

## 默认行为

- 低风险仅记录；中风险（评分 4–6）删消息并计一次警告。
- 高风险（评分 >= 7）或达到 3 次警告，在超级群临时禁言 10 分钟。
- 不自动永久封禁。普通群不支持临时禁言，降级为删消息、计警告。
- 不覆盖管理员设置的已有用户限制；管理员、所有者和白名单用户不参与自动处罚。
- 警告在最近一次违规 24 小时后过期；刷屏窗口为 60 秒，相同内容 3 次或总消息 8 条触发处理。
- 词库按群独立。首次使用时复制原 KV 词库，之后本群修改不会影响其他群。
- 保留群内自动通知关闭的习惯，处理结果在后台查询；管理员主动发出的命令会得到回复。
- 不回溯封禁名单，不自动解除既有封禁，不恢复已删除消息。

## 管理指令

`/help` 查看说明；`/status` 检查策略及机器人权限。

`/addword 词`、`/removeword 词`、`/listwords` 只修改或查看本群词库。

以下指令回复用户消息，或附带数字用户 ID：

- `/warnings`：查看警告与白名单状态。
- `/clearwarn`：清除警告和刷屏计数。
- `/allow`、`/unallow`：加入、移出本群白名单。
- `/unmute`：按群默认权限解除限制。
- `/unban`：允许被封用户重新加入；不会踢出已在群的用户。
- `/ban`、`/kick`：管理员手动封禁、移出。要求操作者是机器人所有者、群主或具有限制成员权限的管理员。这些操作仍可能删除用户历史消息。

后台沿用原 `ADMIN_PASSWORD`，改为 8 小时 HttpOnly/Secure/SameSite 会话。退出会使会话失效，修改密码也会使旧会话失效。每 IP 15 分钟最多 10 次登录尝试。打开新版后台会清除旧版保存在 localStorage 中的密码。

## 可靠性与保留时间

每个群一个 SQLite Durable Object。Webhook 必须通过路径和 Telegram 请求头验证，事件持久化后才返回成功。重复 update_id 保留 7 天去重。临时错误与 Telegram 429 最多尝试 6 次，尊重 retry_after。处理步骤分别记录完成状态，重试不重复计警告；失败保留实际已完成的步骤。

Telegram 与 Cloudflare 之间没有分布式事务：在 Telegram 已完成操作、但本地还没保存结果的极短崩溃窗口，外部操作仍可能重复；自动处理使用重复安全的删除、固定截止时间禁言，无法宣称严格 exactly-once。管理员命令回复在这种窗口也可能重复发送。

任务用持久化 alarm 调度，正常情况下约 200ms 后开始。失败重试可能延迟，后台显示 pending/failed。失败任务不会无止境重试，需要管理员查看原因后手动处理。

新版记录保留 30 天，SQL 分页查询。旧 KV 日志仍可通过后台“旧版记录”查看，沿用其原有 TTL；没有删除或全量搬迁历史数据。正常任务结束后清除原始消息载荷，日志仅保留最多 300 字消息摘要。

## 开发与验证

```
npm ci
npm run check
npm test
npm run types
```

集成测试使用 Miniflare/workerd 和模拟 Telegram 接口，不向真实群发送消息。测试入口仅存在于测试包装器中，不进入生产构建。

所需密钥：`BOT_TOKEN`、`ADMIN_IDS`、`ADMIN_PASSWORD`、`WEBHOOK_SECRET`、`WEBHOOK_VERIFY_TOKEN`。不要写入代码或版本库。

`src/filters.js` 的 `DEFAULT_POLICY` 是新群策略默认值，已经初始化的群使用自身保存的配置。旧 ACTION 等环境变量仅为兼容保留；v2 处罚逻辑以群策略为准，不会因旧 ACTION=ban 恢复自动永久封禁。

## 备份与回滚

`backups/pre-fix-worker.js` 是修改前线上代码；`backups/pre-fix-settings.json` 保存原配置和部署版本信息，不包含密钥值。

此次增加了 Durable Object 类迁移，不应直接假设可以通过旧版本 ID 一键回滚。回退旧业务代码时必须保留 `GuardState` 类及绑定，停止其 alarm 任务，保留已写入的数据，并保留现有密钥；`backups/rollback-worker.js` 已提供这种回退构建。回退上传不包含新增或删除类的迁移。优先修复后向前部署，避免恢复旧版误封策略。

本次未新增入群验证码、AI/OCR、摘要或定时群公告；这些属于后续扩展，不影响本轮修正。
