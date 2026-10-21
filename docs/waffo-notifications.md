# Waffo 收款成功私聊提醒

仅转发生产环境 `order.completed`、`subscription.payment_succeeded` 到指定所有者私聊。提现、退款、订阅状态、测试交易不提醒；零元验卡不提醒。不修改现有商城订单 Webhook。

## 上线配置

合并 PR 后由 Jason 授权部署到现有 Worker。Cloudflare 中配置：

- `WAFFO_NOTIFY_ENABLED=true`：总开关；未配置默认关闭。
- `WAFFO_STORE_ID`：目标商店的真实 ID，作为 Cloudflare Secret 保存。
- `WAFFO_NOTIFY_USER_ID`：唯一接收人的正数 Telegram ID，须同时属于 `ADMIN_IDS`，作为 Secret 保存。不能配置群或频道。
- `WAFFO_WEBHOOK_PUBLIC_KEY`：可选验签公钥；默认使用锁定的官方 SDK 内置生产公钥。公钥轮换时从 Waffo 后台核对更新。

Waffo → 商店设置 → Webhooks → **生产模式添加** Raw Webhook：

- URL：`https://<机器人域名>/webhooks/waffo`
- 取消全选，仅选 `order.completed`、`subscription.payment_succeeded`。
- 保留原商城 Webhook；不替换它。
- 不选择原生 Telegram 格式，不把机器人的 Token 交给 Waffo。

发送官方测试回调后检查投递结果和 Telegram 私聊。用真实支付确认时由用户自行操作；不要为了验收自动发起扣款。

## 行为与限制

官方 SDK 对原始正文做 RSA-SHA256 验签，校验签名时间窗、生产环境和商店 ID，限制正文为 128KB。只保留提醒需要的订单号、支付号、实收金额与币种，不记录买家邮箱、地址、完整回调。

通知先存入独立 Durable Object `waffo:payments` 的任务队列，再返回 200；持久化失败返回 503 由 Waffo 重试。每个订单／订阅扣款及收件人去重 90 天；同一订阅后续扣款仍可通知。Telegram 失败使用现有最多 6 次、最长一天的重试和 429 退避；耗尽后留失败日志。成功后再次回调不重发。若 Telegram 实际接收但网络响应丢失，仍可能重复，不能承诺端到端恰好一次。

金额优先使用官方 `chargedAmount`，仅兼容旧的 `amount`，不拿标价、订单 total 或自行估算的数字当实收金额；缺失时明确显示官方未提供。支付成功不等于资金已结算或提现到账。

关闭 `WAFFO_NOTIFY_ENABLED` 后停止接收新通知，待发任务执行前也会检查开关和所有者身份。此功能不恢复 DMIT 监控或补货推送，不改变群防、广播、验证、日报。

## 验证

`npm ci && npm run check && npm test`。专项测试生成临时 RSA 密钥，覆盖无效/过期签名、其他商店和测试环境、零元与非支付事件、实收金额、隐私裁剪、并发重复回调、429 重试、成功去重和关闭开关。
