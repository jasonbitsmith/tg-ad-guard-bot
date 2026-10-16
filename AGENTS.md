# 协作规则（Codex 与 Claude 共用）

这个仓库由 Codex 和 Claude 两个助手同时维护。线上只有一个 Worker（`tg-ad-guard-bot`）和一个 Telegram webhook，任何一次部署都会整体覆盖线上代码，所以必须遵守下面的规则。

## 唯一来源

- GitHub 上的 `jasonbitsmith/tg-ad-guard-bot` 的 `main` 分支是唯一可信版本，`main` 永远等于线上正在运行的代码。
- 不要在本地副本或其他目录里长期改代码；开始工作前先 `git fetch origin && git checkout -b <分支> origin/main`。

## 分支

- Codex 只用 `codex/<主题>` 分支，Claude 只用 `claude/<主题>` 分支。
- 不直接推送 `main`，不修改对方前缀的分支。
- 每项改动开一个 PR 到 `main`，由 Jason 审核合并。开 PR 前先合入最新的 `main`，冲突在自己分支上解决。

## 代码结构

- `src/state.js` 只保留 GuardState 的核心（存储、任务队列、alarm），其余方法按功能放在 `src/state/*.js`，改哪个功能就改对应文件。新增方法时加到对应的文件里，同名方法会在启动时报错。

## 版本号

- 每个会上线的 PR 在 `src/index.js` 里把 `VERSION` 加一（修复加第三位，功能加第二位）。
- 两个 PR 同时改了版本号时，后合并的一方在合并前重新取最新 `main` 再加一。

## 提交前检查

```sh
npm ci
npm run check   # wrangler 预演打包，生成 dist/
npm test        # 依赖 dist/，必须在 check 之后跑
```

两条都通过才开 PR。不要跳过或删除测试来让检查通过。

## 部署

- 只从已合并的 `main` 部署：`git checkout main && git pull && npx wrangler deploy`。
- 部署前先访问线上 `/health`，确认线上版本号不高于 `main` 的版本号；如果线上更高，说明有人从别的地方部署过，先停下来告诉 Jason。
- 不要从功能分支部署，也不要部署未合并的代码。
- 只有 Jason 明确要求时才部署。

## 密钥

- 密钥只放在 Cloudflare（`wrangler secret put`），不写进代码、配置、测试或提交信息。
- `.bookscape-key`、`.dev.vars*`、`bookscape-receipts/` 已在 `.gitignore` 中，不要提交。
- 这个仓库是公开的。

## 所有者广播

所有者（`ADMIN_IDS`，现为 Telegram 用户 `5615131413`）在私聊里发送文字、图片、视频、文件，或约 1 秒内到齐的相册时，机器人先给出三个按钮：发送到全部目标、选择具体目标后再确认、取消。确认后每个目标一条持久任务，用 `copyMessage`（相册用 `copyMessages`）发送，并沿用队列里的重试和 429 处理。已经成功的目标不会在重试时再发一次。发完后私聊列出成功和失败原因；「撤回」按保存的 `(目标, message_id)` 删除并回报结果。

非所有者的私聊不进入广播。指令、管理后台入口、申诉和成员找回仍按原流程处理，不会被广播确认挡住。

变量在 `wrangler.jsonc`：

- `BROADCAST_TARGETS`：逗号分隔的 `@用户名` 或负数群 ID，1–20 个，校验方式和 `DMIT_NOTIFY_CHATS` 相同。当前是 `@jason_vps_deal,@wpzyz,@JasonSIMLab,@jason_Telegramx,@Jason_WiseX,@Jason_Prompt`。
- `BROADCAST_TEST_MODE`：`"true"` 时不发给上面的列表，只发给 `5615131413`。现在就是 `"true"`。

上线到真实目标：把 `BROADCAST_TEST_MODE` 改成 `"false"`，合并到 `main`，再从 `main` 部署。不要从功能分支部署，也只有 Jason 明确要求时才部署。
