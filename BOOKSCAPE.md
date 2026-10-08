# BookScape 发布

沿用 Cloudflare Worker `tg-ad-guard-bot`（@JasonworksAI_bot）。本次核实的部署不使用 /opt/inbox-bot 或 systemd。目标固定为 @Book_Scape。

## 使用

本机 `.bookscape-key` 是独立发布凭据（文件权限 600，已加入忽略列表），不是 Bot Token。Cloudflare 保存对应 BOOKSCAPE_PUBLISH_KEY；原 BOT_TOKEN 不读取、不导出。

在本项目目录执行：

```sh
node scripts/bookscape.mjs status
node scripts/bookscape.mjs draft /绝对路径/bookscape.html
node scripts/bookscape.mjs draft /绝对路径/bookscape.html --image /绝对路径/cover.jpg --caption '📘 《书名》'
node scripts/bookscape.mjs draft /绝对路径/bookscape.html --single --image /绝对路径/cover.jpg --caption 'unused'
node scripts/bookscape.mjs preview 草稿ID
node scripts/bookscape.mjs publish 草稿ID 摘要
node scripts/bookscape.mjs receipt 草稿ID
node scripts/bookscape.mjs edit 消息ID /绝对路径/bookscape.html
```

`draft` 返回草稿 ID 和摘要，不发消息。可附带一张 JPEG/PNG 配图及简短标题。添加 `--single` 后，完整正文作为图片 caption，配图与内容只产生一条 Telegram 消息，去除 HTML 标签后的文字不得超过 1024 字符。普通图文布局则先发送配图、再发送正文。`preview` 发送到 ADMIN_IDS 中第一个有效的现有所有者私聊，该用户需先对机器人发送 /start。预览成功后只保留 Telegram `file_id`，不再保存原始图片字节。检查预览后，publish 使用同一 ID 和摘要发布到频道。纯文本可添加 `--plain`。

BookScape 图书帖固定在正文最底部保留以下落款：

```text
📮 @Book_Scape ｜ 📘 @EvanCreates
📢 x.com/evanwritesx
```

## 防护与结果

- 独立高强度发布凭据；旧后台密码不能调用发布入口。
- 固定机器人身份、频道用户名；首次成功权限检查后的实际发布会固定频道数字 ID，后续变化拒绝发布。
- 每次正式发布检查 can_post_messages；未完成私聊预览、摘要不一致都拒绝发送。
- 正文摘要唯一，同内容重复草稿和并发发送共用一份持久化回执。已成功的草稿只返回原结果。
- 网络失败或 Telegram 5xx 可能已经送达，标记 unknown 并禁止重发；请人工核对频道。进程在发送期间中断会保留 sending，同样禁止自动重发。
- Telegram 明确拒绝（400、403、429）后可修正权限或等待限流结束，再显式重试原草稿；正文不能更改，改正文需新草稿。
- 草稿 24 小时内有效；过期正文在下次访问时清除。成功发布立即清除正文，保留去重回执；unknown/sending 保留内容供核对。没有严格 exactly-once 的跨系统保证，因此优先阻止不确定重试。
- BookScape 使用独立 Durable Object 实例；群管理和 DMIT 定时功能沿用原实现。

## 接口

基础地址为 `https://YOUR_WORKER_DOMAIN/bookscape/api/`（替换为自己的部署域名），Authorization: Bearer 发布凭据。
GET status、receipt?id=ID；POST draft {text,format}、preview {id}、publish {id,confirmHash}、edit {messageId,text,format}。
不支持通过参数更换频道或私聊接收人。不在 URL、日志或命令参数中传递密钥。

## 部署

原配置和部署方式不变；先运行 npm run check、npm test。BOOKSCAPE_PUBLISH_KEY 通过 Wrangler secret put 的标准输入写入，勿粘贴在对话或提交到 Git。保留现有 Cloudflare secrets、KV、Durable Object 迁移和计划任务。
