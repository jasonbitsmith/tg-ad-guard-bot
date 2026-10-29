# Jason Select Support 双向客服

独立机器人 @JasonSelectSupportBot，复用现有 Cloudflare Worker 的持久队列，单独使用 `support:inbox` Durable Object，不更换群管/订单机器人 Token 或 Telegram Webhook。

## 使用

- 客户打开机器人，点击开始，直接发送文字、图片、语音、视频或文件。欢迎语说明内容会交给 Jason，提醒不要发送密码或验证码。
- Jason 在客服机器人私聊收到用户说明与复制的原消息。使用 Telegram 的“回复”功能回复说明或内容消息，再发文字/媒体，系统按保存的对应关系发给那一位客户。
- 原消息复制采用 copyMessage，客户不会收到 Jason 个人账号的转发链接。姓名和用户名只作显示，不作为路由依据。
- 成功返回 Telegram 回执后才告诉 Jason“回复已送达”；明确失败不会假报成功。最终失败通过原群管机器人私聊发送运行提醒。
- Jason 回复咨询发 `/block` 可屏蔽该用户的后续和待发客服消息；`/unblock 数字ID` 解除。普通用户无法执行这些管理命令。
- 未回复、未知/过期消息、群/频道消息、消息编辑、机器人发送者均不能触发对其他用户的回复。相册暂逐张转接。

## 配置和上线（本 PR 尚未部署）

审核合并后，只从 main 部署。Cloudflare Worker Secrets：

- `SUPPORT_BOT_TOKEN`：新客服机器人 Token。不要覆盖 BOT_TOKEN、WAFFO_BOT_TOKEN 或商城 Token。
- `SUPPORT_WEBHOOK_SECRET`：至少 32 字节随机值，使用 Telegram secret_token 允许的字符。
- `SUPPORT_OWNER_ID`：Jason 数字用户 ID（正数、必须同时在 ADMIN_IDS 内）。不支持群、频道或任意用户名接收。

新客服机器人 setWebhook 指向 `https://<机器人域名>/support/webhook`，secret_token 使用上述值，allowed_updates 仅 message。先通过 getMe 确认是 JasonSelectSupportBot，getWebhookInfo 确认没有已有其他用途；不使用 drop_pending_updates。只配置新客服机器人，不覆盖群管和订单机器人的 Webhook。

首次让 Jason 点击客服机器人的开始，再由另一个人工测试账号发咨询、由 Jason 回复，核对不会串人；不能把所有者给自己发测试当作两人双向验收。不向真实客户自动发送测试消息。

## 存储与限制

Webhook 校验 Secret，正文最多 128KB，私聊发送者与 chat ID 必须一致。收到更新先持久排队再返回 200。更新去重 30 天；客户消息与所有者消息 ID 对应关系 30 天；队列沿用七天清理。只保存转接所需消息 ID、用户 ID、说明文字；不下载附件或记录原消息正文，附件引用仍由 Telegram 保存。

客户每分钟最多 12 条、每天 100 条；全局每分钟最多 100 条。超额限制每分钟最多提示一次。欢迎、提示也计入额度。原消息被删除、内容禁止复制、客户屏蔽机器人都会导致转接失败；网络超时可能是已发但未拿到回执，重试不能保证恰好一次。

此功能不解除 Telegram 对个人账号的限制，只提供客户主动联系的机器人客服入口。不接入第三方转发服务或 AI 自动回复。

验证：npm ci、npm run check、npm test。覆盖鉴权、私聊身份、多客户路由、重复更新、媒体、429 重试不重发说明、屏蔽取消待发、解除屏蔽、限流及客服 Token 隔离。
