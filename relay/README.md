# Poros 免费额度中继

同一 Worker 服务多个独立 Agent：每个安装端只建立出站 WebSocket，手机经 /c/频道/ 访问。SQLite Durable Object 使用休眠 WebSocket API，空闲时不靠常驻轮询保持运行。仅转发手机任务、会话、配对和静态资源，不开放安装端设置、bootstrap、凭证、更新或设备管理接口。

## 自己部署

需要自己的 Cloudflare 账号，选择 Workers Free；此仓库不带开发者的账号或中继密钥。

```sh
npm ci --ignore-scripts
# Wrangler 登录自己的账号
npx wrangler login
# 生成 32 随机字节的 base64url 管理密钥，保持私密
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
npx wrangler secret put HOST_KEY
npx wrangler deploy
```

在软件设置填写刚部署的 HTTPS 根地址和同一 HOST_KEY。管理密钥仅用于允许安装端占用此中继；每个安装端还有独立的随机 host secret，频道为其 SHA-256。它们不是手机的运行权限，手机仍要电脑确认和设备会话。密钥加密保存在安装端，不进入 URL 或工程包。切换中继地址要重新填写该地址的管理密钥。

wrangler.jsonc 采用 new_sqlite_classes，兼容日期为已支持的 2026-11-25。未启用观测日志，不保存业务内容；仍应按托管服务的数据处理边界使用。

## 免费边界

2026-11-26 查阅的 Cloudflare 官方文档：Workers Free 每账号每天 100,000 次请求、每请求 10 ms CPU；SQLite DO Free 另有 100,000 请求/日及持续时间和存储限额，免费额度超限会失败。所有 App 共享账号额度，本程序不调用付费升级接口。实际用量在 Cloudflare Dashboard 的 Worker/DO 指标中核查，不以本地请求计数冒充账号结算量。

通道采用有界二进制帧，不对资源做 Base64 编解码；每请求最多 512 KiB，响应最多 2 MiB，32 个在途中继请求，20 秒响应截止。断线只恢复连接和读取已有记录；新建任务由安装端的幂等回执约束，不盲目重放。

## 验证

仓库根目录运行 `npm run e2e:relay`。它启动真实本地 workerd/SQLite DO，实际连接两个 App 与浏览器，验证配对、执行、管理边界、重连和撤销，然后只清理自己的进程与临时目录。没有 Cloudflare 账号即可运行，但这不是已经完成云端部署的声明。

官方资料：[WebSocket 休眠](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)、[DO 定价](https://developers.cloudflare.com/durable-objects/platform/pricing/)、[Workers 限额](https://developers.cloudflare.com/workers/platform/limits/)、[临时通道](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)。

中继管理密钥授予的是可信安装端权限。一个 Worker 只服务同一可信安装所有者的多个 App；不同客户或不互信的安装端使用各自的 Worker/域名和密钥，不把路径当作跨客户的浏览器来源隔离。生成的 Agent 界面仍在不透明沙箱 iframe 中，不能读取父页面会话。
