# TG 广告拦截机器人

自动检测并清理 Telegram 群里的招聘/刷单类广告消息（关键词 + 表情轰炸昵称 + 链接/联系方式组合识别），支持警告计数、自动踢出/封禁。

## 当前运行方式：Cloudflare Workers（正式使用这个）

代码在 `worker/` 目录，部署地址：`https://tg-ad-guard-bot.bjgylm.workers.dev`，通过 Telegram Webhook 接收消息，7x24 在线，不依赖本地电脑。

- 状态/密钥/KV 数据都在 Cloudflare 上，改配置用：
  ```bash
  cd ~/tg-ad-guard-bot
  npx wrangler secret put BOT_TOKEN      # 改 token
  npx wrangler deploy                    # 改完 worker/*.js 后重新部署
  npx wrangler tail                      # 实时看日志
  ```
- `wrangler.toml` 里的 `[vars]` 可以改 `ACTION` / `WARN_THRESHOLD` / `ESCALATE_ACTION` 等策略参数，改完 `npx wrangler deploy` 生效。
- 关键词库存在 KV 里，用群内 `/addword` `/removeword` `/listwords` 管理，不用改代码重新部署。
- `worker/.secrets.local`（未提交）记录了 webhook 路径密钥和后台密码，仅用于排查问题，不要泄露。

### 管理后台

网址：`https://tg-ad-guard-bot.bjgylm.workers.dev/admin`

用 `ADMIN_PASSWORD` 密码登录（密码在 `worker/.secrets.local` 里，改密码用 `npx wrangler secret put ADMIN_PASSWORD`）。可以看最近 30 天的拦截记录（时间/群/用户/消息内容/命中原因/处理动作），也能直接加减关键词，不用记 `/addword` 命令。密码存在浏览器 localStorage 里，只登录一次。

## 旧版：本地 Node.js 轮询版（已停用，仅作参考/备用）

`src/` 目录是最初的本地长轮询版本，已经停止运行（launchd 配置已移除）。如果 Cloudflare 出问题需要临时切回本地版，步骤如下：

### 1. 申请机器人

1. Telegram 搜索 `@BotFather`，发送 `/newbot`，按提示起名字，拿到 `BOT_TOKEN`。
2. 把机器人拉进你的群，**设置为管理员**，至少勾选：
   - 删除消息 (Delete messages)
   - 封禁用户 (Ban users)
3. 用 `@userinfobot` 查你自己的 Telegram 数字 ID，填进 `.env` 的 `ADMIN_IDS`。

### 2. 安装运行

```bash
cd tg-ad-guard-bot
npm install
cp .env.example .env
```

编辑 `.env`，填入 `BOT_TOKEN` 和 `ADMIN_IDS`，按需调整 `ACTION` / `WARN_THRESHOLD` 等参数。

本地测试运行：

```bash
npm start
```

### 3. 长期挂机（推荐用 pm2）

```bash
npm install -g pm2
pm2 start src/bot.js --name tg-ad-guard
pm2 save
pm2 startup   # 按提示设置开机自启
```

### 4. 识别规则说明

在 `src/filters.js` / `src/words.json` 中：

- **关键词库**：`words.json` 里的 `keywords`，命中即视为广告特征之一。
- **联系方式**：加V/微信号/QQ号/电报号 等模式。
- **链接**：http(s) / t.me / telegram.me / www 开头的内容，配合关键词或联系方式判定。
- **广告号画像**：昵称表情符号密度高，或昵称带【】广告括号（比如截图里的"手机【拍照*一百*-张】"），配合招聘类文案判定。
- **新成员保护期**：`NEW_MEMBER_GUARD_MINUTES` 分钟内，表情轰炸或"短文本+链接"直接判定为广告（新号进群秒发广告的情况）。

### 5. 管理员命令（群内发送，或私聊机器人）

- `/addword 关键词` — 添加关键词
- `/removeword 关键词` — 移除关键词
- `/listwords` — 查看当前关键词库
- 回复某条消息发送 `/ban` — 封禁该用户
- 回复某条消息发送 `/kick` — 移出该用户（可再加群）

### 6. 处理策略（.env 配置）

- `ACTION=warn`：删消息 + 记警告，达到 `WARN_THRESHOLD` 次后按 `ESCALATE_ACTION`（kick/ban）处理
- `ACTION=kick`：命中即直接删消息 + 移出群聊
- `ACTION=ban`：命中即直接删消息 + 永久封禁

## 注意事项

- 机器人只能删除/处理**非管理员**发的消息，群管理员的消息不会被检测。
- 关键词库、误判规则建议先跑几天观察日志（控制台输出）再逐步调严，避免误伤正常用户。
- `data.json` 保存警告计数和入群时间，不要提交到 git（已在 .gitignore 里排除）。
