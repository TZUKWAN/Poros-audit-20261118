# 独立 Agent 软件与手机远控

## 从 IDE 交付

1. 在工程中完成真实构建。需要业务保证时，先添加并运行相应案例；“构建通过”与“案例通过”有不同含义。
2. 设置 → 当前工程 → 复用与交付：导出签名工程包。默认拒绝自动带出 materials/；含用户材料需检查后明确勾选。
3. Windows 构建端先运行 `npm --prefix desktop ci`（固定 Electron/Builder 依赖），然后可在同一区域生成 Windows 安装包。构建后台继续，结果留在工程记录；下载链接短期且仅用一次，复核账号/组织/会话权限。
4. 安装端配置自己的模型/业务账号、技能和工具权限。开发者的密钥、IDE 令牌与数据库不随包交付。运行外部工具时还须同意本次调用；手机仅获得配对时授予的范围。
5. 客户端“设置 → 更新软件”导入同 AppID、同发布者签名的工程包；旧包可回退。新增权限要检查且不会自动获权。NSIS 外壳版本和 Agent 内容版本分别记录；重新安装外壳保留既有 Agent 内容及本地状态，Agent 内容通过此更新入口切换。

第一次信任一个发布者时需核对来源。Ed25519 证明包内容完整性；它与 Windows Authenticode 是不同的机制。本轮真实安装器的 Authenticode 结果为 NotSigned，没有购买或伪造签名证书。

## 命令行交付

```sh
npm run app:build
node .app-runtime/runtime.mjs --package path/to/agent.poros.json --data path/to/installation

# Windows 构建器，完整安装包实际包含固定的隔离运行镜像
npm --prefix desktop ci
node scripts/build-desktop.mjs --package path/to/agent.poros.json --out .desktop-build
```

首次运行端输出的 ownerUrl 含 90 秒一次性本地启动码，不应写入公开报告。已有安装可只传 `--data`。运行端仅监听环回，远程入口经过受限转发。运行端产物包含第三方许可证记录及 CycloneDX 清单，排除旧原型 legacy.html。

## Windows 运行环境

客户安装器内置 Electron/Node、界面、已签名工程包和按镜像 ID 固定的运行组件。无需开发 IDE、Node 安装或开发数据库。存在兼容 Linux Engine 时可复用；没有可用环境时提供免费的 Alpine Linux + Linux Engine 准备流程。

已实测的免费路径为 Windows x64、WSL2 已启用：

- 官方固定 Alpine 3.24.4 小根文件系统，锁定 SHA-256；从官方仓库取得组件，apk 验证签名，不使用 allow-untrusted。
- 每用户独立 PorosRuntime 发行版；不修改已有发行版或全局 .wslconfig，不执行全局 shutdown。禁用 Windows 自动挂载和互通。
- Engine 只用 guest Unix socket，经随机私有 Windows pipe 访问；不开放未认证 TCP Docker 端口。多个 App 共享运行引擎和镜像，数据与密钥按安装实例分开。
- 每次程序运行限制 1 CPU、512 MiB、64 PID、只读根、cap-drop、无外部网络。实测 WSL 内核未提供独立 swap 限额，该事实保留在证据中。
- 未在“WSL 尚未启用”的干净 Windows 上完成安装验收；启用 WSL 可能需要管理员和重启。本程序不擅自更改这些系统功能。
- Docker Desktop 的企业许可另有条件；上述免费路径直接使用 Linux Engine，不将 Docker Desktop 说成普遍免费。

本轮测试安装器约 407 MB；证据记录精确字节、摘要和启动至首个实际任务的时长。此时长包含环境准备、镜像检查、容器启动与任务执行，不是纯冷启动指标。共享引擎与主机资源不等于无限并发或完全独占硬件。

默认数据位于当前用户 LocalAppData/PorosApps/AppID，独立保存密钥、加密连接、任务及固定回执。卸载保留数据；手动删除安装数据目录会删除该 App 的历史和凭证。删除共享 PorosRuntime 会影响仍依赖它的所有 Agent，应在明确不再需要时另行处理。

## 手机连接

1. 电脑软件设置 → 远程访问 → 开启临时免费访问，等待“已连接”；或连接自己的稳定中继。
2. 生成配对邀请，选择手机允许的工具，复制手机配对链接。
3. 手机打开链接、填写名称并申请；电脑端确认后才能运行。
4. 电脑端随时撤销设备；后续请求被拒绝，进行中的受权任务会停止。手机无模型密钥和安装端设置管理权。
5. 手机 PWA 可添加到主屏幕；这里交付的是 PWA，不是原生 APK/IPA，也不包含 Windows 桌面的远程屏幕控制。

Quick Tunnel 无需账号/域名，但地址重启会变、无可用性保证、最多 200 个在途请求且不支持 SSE。此客户端使用 HTTP 任务回执和轮询。地址变化需要在新来源重新配对；旧任务仍在电脑端，不自动重放。稳定 Worker 中继保留频道地址，断线后可找回原任务。

HTTPS/TLS 保护传输；中继不是端到端加密，托管服务会处理传输内容。模型/业务连接密钥保留在安装端，手机使用可撤销的设备会话。

## 真实验收范围

本轮已实际执行两个源码测试工程的 Windows 安装、隐藏 Electron 运行、真实隔离计算、同发布者更新，以及卸载一个后另一个继续可用。独立运行产物已复制到 node_modules 外，在开发数据库不可用时运行。

也已通过真实公网 trycloudflare.com 的手机尺寸无头浏览器完成配对、电脑确认、隔离任务和撤销；本机浏览器公网测试使用现有系统代理。没有实体蜂窝手机、iOS 主屏幕安装或原生应用商店验收记录。稳定 Worker 的真实本地 workerd 验收通过，当前没有将它部署到用户 Cloudflare 账号。

安装/网络/协议测试使用明确的源码与模型协议夹具。用户的 127.0.0.1:8317 当前拒绝连接，真实模型业务产出、Kdocs/IMA/TinyFish 新账号的业务联调未通过，不能从这些工程测试推断已完成。
