# Poros 个人连接和手机访问

手机、平板和桌面使用同一个工作台。用户从「我的任务」重开后台运行和事件记录，从「设置」维护自己的连接。浏览器可把 HTTPS 页面安装到主屏幕，Android 和 iPhone 复用相同的 PWA。

## 个人服务连接

| 设置 | 用户提供 | 真实测试和用途 |
| --- | --- | --- |
| 大模型 API | OpenAI 兼容 Base URL、模型 ID、API Key | 向 Chat Completions 发流式请求并核对随机验证串。Builder 可冻结准确的端点和模型，真实 DSH、生成草稿和语义 Judge 可使用该连接 |
| Kdocs 金山文档 | WPS 365 用户访问令牌，授权 `delegated:kso.mcp_yundoc.readwrite` | 通过官方云文档 MCP 调用搜索工具，工作台提供文档搜索 |
| IMA | Agent 开放接口的 Client ID 和 API Key | 调用 `search_knowledge_base`，可按关键词查找知识库，留空列出可见知识库 |
| TinyFish | TinyFish API Key | 测试各执行一次 TinySearch 和 TinyFetch，提供公开网页查询及内容读取，使用服务商账号的额度 |

打开「设置」，保存相应服务并点击「测试连接」。换钥需要重新测试。当前实现的 Kdocs 接收 WPS 365 用户授权令牌。个人金山文档 Skill Token 属于另一套凭证。文档／知识库／网页操作在设置页由用户发起。

在 Agent Builder 将类型切换为 `MODEL` 并选择「个人模型」，填写授权范围，申请发布并由独立审阅者批准。使用该 Agent 的成员需要各自验证同一个端点和模型。排队任务固定当前成员的连接修订，更改或撤销后需要重新提交。生成、DSH 和 Judge 使用同一个准入模型。批准的旧 DeepSeek 版本保留原模型绑定。

密钥使用 AES-256-GCM 加密，绑定组织、用户、连接和修订。生产启用设置时配置独立的 `POROS_SETTINGS_KEY`，使用随机 32 字节的十六进制表示，备份时与数据库分开保管。模型请求默认只允许经校验的公开 HTTPS，禁止重定向。需要本机代理时，管理员在 `POROS_LOCAL_MODEL_BASES` 加入确切的环回 Base URL。`127.0.0.1` 指 Poros 服务所在的电脑。

## 在 Windows 上启用私网入口

准备 PowerShell 7、Node 24、Docker Compose、Tailscale。无法签发 Tailscale HTTPS 证书的账户需要本机 OpenSSL。

```powershell
npm ci
npm run build
npm run runtime:build
./deploy/start-mobile.ps1 -NodePath node -ModelBase 'http://127.0.0.1:8317/v1'
./deploy/start-tailnet-access.ps1 -NodePath node
```

前者启动独立的 `poros-mobile` PostgreSQL、SeaweedFS 和 Poros 进程，使用新卷、环回端口、随机数据库和存储口令，并创建首位管理员。启动时会输出本机初始登录文件的路径。主机保持在线、Docker 与 Poros 进程运行时，加入口令所属私网的手机可访问。运行脚本前使用 `npm run build` 更新产物，使用 `-RestartApp` 重启现有 Poros 移动部署。

后者通过现有 Tailscale 私网发布单独端口。账户可签发证书时使用 Tailscale HTTPS。否则提供 WireGuard 私网中的 8788 浏览器入口、公开 CA 证书下载链接和 8443 HTTPS 安装入口。脚本将一次性签发密钥移除，按真实入口 IP 验证证书，保留其他端口的 Serve 配置。公开互联网访问需要另行部署域名、TLS 和访问策略。

1. 手机连接同一 Tailscale 私网。在脚本输出的浏览器地址登录即可使用。
2. 私有 HTTPS 证书方案需先安装脚本提供的 CA 证书。核对下载文件 SHA-256。iPhone 在「设置 → 通用 → 关于本机 → 证书信任设置」打开对 Poros CA 的信任。Android 使用系统的「加密与凭据 → 安装 CA 证书」，具体菜单随系统版本变化。 [Apple 证书说明](https://support.apple.com/en-us/102390) [Android 证书说明](https://support.google.com/pixelphone/answer/2844832)
3. 在系统浏览器打开 HTTPS。iPhone 的 Safari 通过「分享 → 添加到主屏幕」安装，Android Chrome 使用「安装应用」或「添加到主屏幕」。线上使用仍需登录。 [PWA 安装说明](https://web.dev/learn/pwa/installation)

管理员可以在 Poros 主机上为其他人创建账号。从密码管理器用标准输入提供至少 16 字符的密码。发布和审批角色应交给不同成员。

```powershell
$porosEnv = Join-Path $env:LOCALAPPDATA 'Poros/mobile/deployment.env'
$memberPassword | node "--env-file=$porosEnv" scripts/provision-member.mjs --organization poros --email reviewer@example.org --role REVIEWER
```

## 复用与验收

dsh-mobile 采用真实移动客户端、连接恢复和私网接入。Poros 复用私网拓扑与恢复思路，并沿用本项目已有的认证、审批、SSE 和 React 页面。手机交付的是 PWA，适合直接通过浏览器安装。参考提交 `953e4ab` 的仓库许可为 MIT。Tailscale 个人套餐有免费额度，组织套餐及服务商 API 额度由各平台规定。 [dsh-mobile](https://github.com/Clarklevis1995/dsh-mobile/tree/953e4abb77ade064736f2f69d3c3d138bddb88d5) [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve) [Tailscale 套餐](https://tailscale.com/pricing)

Kdocs、IMA 和 TinyFish 的成功验收需要持有者自己的有效凭证。协议回归使用明确标记的夹具。模型目录能看到 ID 时，仍要由流式生成测试独立验证。 [WPS 365 云文档 MCP](https://open.wps.cn/documents/app-integration-dev/mcp-server/tools/mcp_kso-yundoc) [IMA Agent 开放接口](https://ima.qq.com/agent-interface) [TinySearch](https://docs.tinyfish.ai/tinysearch) [TinyFetch](https://docs.tinyfish.ai/tinyfetch)

本轮实际通过 63 项 API 测试、五组隔离和端到端回归。ISO-06 的自定义模型测试使用真实 DSH 和真实工具，模型响应来自显式协议夹具。无头浏览器以 390px 验证任务恢复、四项设置、PWA 和离线页，并确认浏览器缓存没有 API 数据。独立生产部署通过现有 Tailscale 转发的 HTTPS 和登录实测。指定 Gemini 模型已出现在真实目录中，实际流式请求返回 HTTP 503 与 `VALIDATION_REQUIRED`，成功生成待上游账号完成验证。没有以协议回归替代真实供应商或实体手机安装验收。
