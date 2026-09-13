# 手机号登录

手机号通过 CloudBase 官方 Web SDK 3.9.3 的 `signInWithOtp` 发码，使用返回的 `data.verifyOtp` 校验。中国大陆手机号；CloudBase 环境须位于上海并开启短信登录。登录页按需加载 SDK，支持验证码倒计时及服务错误提示。

## 站点配置

- 在 CloudBase 身份认证 → 登录方式中开启短信验证码登录，选择云开发内置短信通道。
- 在环境安全域名中允许 `petrival.clear-oasis-2741.chatgpt.site`。
- 具体入口为「环境配置 → 安全来源 → 安全域名 → 添加域名」，填写上面的完整主机名（不带 `https://`、路径或末尾斜杠），保存后约 1–2 分钟生效。短信开关与安全来源是两个配置项。
- Sites 运行环境变量设置 `CLOUDBASE_ENV_ID`，重新部署后生效。不需要把腾讯云管理员密钥放进网站。
- 当前选择环境：`xiaotangyuan-d2g249l4be819a63c`（用户确认上海、个人版）。2026-09-13 用户确认已开启短信登录；真实短信收取与首次登录仍待本人在网站完成。

## 身份与存档

默认游客直接游玩，不主动弹登录框、不自动发送短信。页面提醒游客身份依赖当前浏览器；登录框提供“暂不登录，继续玩”。游客进度同样写入 D1，但清除 Cookie、游客身份过期或换设备后可能无法找回。绑定手机号后通过账号恢复存档；登录不能代替数据库备份，也不承诺永久零丢失。

Worker 将 SDK access token 发送到该环境的 `/auth/v1/user/me` 验证，检查有效用户及手机号。客户端自报用户 ID 不作为凭据。D1 中只保存环境与用户 ID、脱敏手机号、随机站点会话令牌的 SHA-256；不保存手机号原文、验证码或 CloudBase access token。

站点 Cookie 为 HttpOnly、SameSite=Lax，HTTPS 下使用 Secure，有效期 30 天。退出使当前站点会话失效。其他设备的会话不受影响。SDK 自身使用浏览器 session 存储，其旧会话不会自动重新登录网站；打开登录框后若仍有 SDK 会话，可以手动点击“继续刚才已验证的登录”，由服务器重新验证该凭证。账号绑定失败后可使用原凭证重试，无需重复校验已用过的短信验证码。

首次绑定迁移当前游客或 Sites 账号宠物的所有权，保持宠物 ID、积分、小院、聊天和对局数据。若手机账号已有另一只宠物，返回冲突供用户选择，不合并积分、不覆盖存档。已登录的手机账号不会因切换手机号而迁移自己的宠物。更改手机号、关闭窗口会丢弃当前验证码证明；身份切换后刷新整个页面。

## 验证范围

自动检查覆盖后端身份校验、拒绝伪造凭据/跨站请求、会话过期/退出、存档迁移、已有存档冲突、会话容量失败原子性，以及前端 OTP 回调和显式存档选择。测试身份及验证码均为本地模拟，不代表真实短信验收。

用户环境真实认证接口此前已以无效测试 token 只读探测，返回明确的 token 格式校验错误，确认接口可达。未向任何测试号码发短信。环境管理员已表示开启短信登录，安全域名是否生效及真实收码仍需本人在网站输入手机号与验证码完成端到端验收。

官方参考：[Web v3 认证](https://docs.cloudbase.net/api-reference/webv3/authentication)、[获取当前用户](https://docs.cloudbase.net/http-api/auth/user-me)、[短信登录](https://docs.cloudbase.net/authentication-v2/method/sms-login)。

## 2026-09-13 真实发码故障定位

用户明确授权重试一次后，在生产页面点击获取验证码。浏览器捕获到认证 `/auth/v1/verification` 预检返回 403，`PreflightMissingAllowOriginHeader`；短信 POST 被浏览器拦截。另以不含手机号的 OPTIONS 请求复核：`Origin: https://petrival.clear-oasis-2741.chatgpt.site` 返回 403、没有允许来源；`Origin: http://localhost` 返回 204、`Access-Control-Allow-Origin: http://localhost`。因此当前阻塞是游戏域名的跨域授权，不是验证码输入错误。待环境管理员添加上述安全域名后，先复核 OPTIONS，再由用户完成收码及登录验收，不自动继续发短信。

页面对网络/CORS错误提供安全来源配置指引，同时保留网络故障可能性，不把所有网络错误一概判成白名单问题。未保存用户手机号或验证码。

配置参考：[CloudBase 安全来源](https://docs.cloudbase.net/envconfig/security/intro)。

## 账号资料拒绝诊断

域名放行后，线上 `/api/auth/cloudbase` 曾返回 401；旧版将账号状态、用户编号、手机号格式及匿名账号四类原因混为“请使用已验证的中国大陆手机号登录”。改为显示 `PROFILE_STATUS`、`PROFILE_SUBJECT`、`PROFILE_PHONE`、`PROFILE_ANONYMOUS` 分类，并仅记录字段类型/格式、是否嵌套及布尔标志。不会记录完整资料、手机号、用户编号、验证码或 access token。保持原身份检查规则，未在缺少真实数据证据时放宽校验；具体根因待部署后的下一次账号绑定请求确认。
