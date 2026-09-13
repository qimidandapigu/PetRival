# 手机号登录

手机号通过 CloudBase 官方 Web SDK 3.9.3 的 `signInWithOtp` 发码，使用返回的 `data.verifyOtp` 校验。中国大陆手机号；CloudBase 环境须位于上海并开启短信登录。登录页按需加载 SDK，支持验证码倒计时及服务错误提示。

## 站点配置

- 在 CloudBase 身份认证 → 登录方式中开启短信验证码登录，选择云开发内置短信通道。
- 在环境安全域名中允许 `petrival.clear-oasis-2741.chatgpt.site`。
- Sites 运行环境变量设置 `CLOUDBASE_ENV_ID`，重新部署后生效。不需要把腾讯云管理员密钥放进网站。
- 当前选择环境：`xiaotangyuan-d2g249l4be819a63c`（用户确认上海、个人版）。用户最后确认短信登录尚未开启，真实短信收取与首次登录待本人在网站完成。

## 身份与存档

Worker 将 SDK access token 发送到该环境的 `/auth/v1/user/me` 验证，检查有效用户及手机号。客户端自报用户 ID 不作为凭据。D1 中只保存环境与用户 ID、脱敏手机号、随机站点会话令牌的 SHA-256；不保存手机号原文、验证码或 CloudBase access token。

站点 Cookie 为 HttpOnly、SameSite=Lax，HTTPS 下使用 Secure，有效期 30 天。退出使当前站点会话失效。其他设备的会话不受影响。SDK 自身使用浏览器 session 存储，其旧会话不会自动重新登录网站。

首次绑定迁移当前游客或 Sites 账号宠物的所有权，保持宠物 ID、积分、小院、聊天和对局数据。若手机账号已有另一只宠物，返回冲突供用户选择，不合并积分、不覆盖存档。已登录的手机账号不会因切换手机号而迁移自己的宠物。更改手机号、关闭窗口会丢弃当前验证码证明；身份切换后刷新整个页面。

## 验证范围

自动检查覆盖后端身份校验、拒绝伪造凭据/跨站请求、会话过期/退出、存档迁移、已有存档冲突、会话容量失败原子性，以及前端 OTP 回调和显式存档选择。测试身份及验证码均为本地模拟，不代表真实短信验收。

用户环境真实认证接口已以无效测试 token 只读探测，返回明确的 token 格式校验错误，确认接口可达。未向任何测试号码发短信。上线后需环境管理员开启短信登录、配置安全域名，再由本人输入自己的手机号与验证码完成端到端验收。

官方参考：[Web v3 认证](https://docs.cloudbase.net/api-reference/webv3/authentication)、[获取当前用户](https://docs.cloudbase.net/http-api/auth/user-me)、[短信登录](https://docs.cloudbase.net/authentication-v2/method/sms-login)。
