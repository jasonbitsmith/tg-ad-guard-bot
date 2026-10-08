# 个人后台访问保护

公开文档只使用示例域名。请在自己的书签或私人运维记录里保存真实后台地址，管理密码和验证码不要写入 Git。

移除入口和禁止搜索引擎索引只能减少暴露，不能替代身份验证。历史提交、部署配置和客户端脚本仍可能暴露域名，不能把域名当作秘密或声称入口已彻底隐藏。

## 管理密码

通过 Cloudflare 控制台修改 Worker 的 `ADMIN_PASSWORD` secret，使用密码管理器生成至少 20 位随机密码。不要把密码作为普通环境变量保存，不要放进命令参数、截图或公开文档。

现有会话与密码摘要绑定，修改密码后旧会话在下次请求时失效，需重新登录。现有登录限流、错误次数限制、Cookie 保护和来源校验继续生效。

## Cloudflare Access

为自己的部署域名创建 Self-hosted Access 应用，仅允许所有者指定邮箱；可使用邮箱一次性验证码。保护 `/admin` 及 `/admin/*`，包括 `/admin/api/*` 和 `/admin/app.js`，不要只保护首页。

不要把整个 Worker 域名一并拦截：Telegram webhook 和独立发布接口有自己的认证方式，不能被 Access 登录页阻断。

如果还启用了 workers.dev、预览地址或其他域名，必须验证它们不能绕过 Access 访问后台。可针对这些入口加等价保护，或在确认 Telegram webhook 和其他调用不依赖它们后关闭备用入口。不要直接关闭未知用途的入口。

配置后用无痕窗口验证：未获准邮箱无法进入后台或直接调用管理 API；获准邮箱可登录和保存设置；Telegram webhook 能正常收取更新。Access 配置在 Cloudflare 中生效，添加本文档不代表线上已启用。

官方参考：[公开应用保护](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)、[邮箱一次性验证码](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)。
