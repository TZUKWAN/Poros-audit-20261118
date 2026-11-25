# Agent AI IDE 实施与验收

日期：2026-11-26。基线 ad8211c9；本轮把 Poros 的默认 Builder/管理员入口改为 Agent AI IDE。仓库和 PR 保持 PUBLIC，未合并到基线。本文记录源码与本地验收，远端结果以 [PR 当前提交的检查](https://github.com/TZUKWAN/Poros-audit-20261118/pull/1/checks) 为准，旧 HEAD 的绿灯不代表本轮通过。

## 产品与实现

| 方案单元        | 当前实现与文件                                                                      | 实际验证                                                                                   |
| --------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| A1 工程         | src/agent-project/files.ts、contract.ts；src/server/ide/repository.ts；两项增量迁移 | Agent/Skill/MCP 三种真实源码、不可变修订、路径/链接/摘要、owner/org 边界和 CAS             |
| A2 开发链       | ide/engine.ts、isolated-compiler.ts、Docker Engine 传输                             | 真实 DSH 读/改/构建/测试；故意类型错误失败后修复，取消与事件记录                           |
| A3/A4 预览/界面 | web/src/ide、ide/preview.ts                                                         | 左开发右试用，PC/手机同版本，失败保留旧预览，草稿/刷新/权限与私有 iframe                   |
| B1 配置         | ide/settings.ts、connections.ts、复用 integration-*                                 | 开发/运行模型分开；四种集成与外部 MCP/API 保存、真实连接测试、换钥和撤销                   |
| B2 能力         | compiler、assembly、lock、package；能力测试 UI                                      | 标准 Skill/参考/脚本、实际 MCP SDK 握手/发现/校验/调用，固定源码版本，不隐式扩权           |
| B3 案例         | caseSchema、engine.evaluate、轨迹 UI                                                | 正向/边界案例、失败不 PASS；无案例是 NOT_EVALUATED，构建不冒充业务验收                     |
| C1 包           | agent-project/package.ts、ide/delivery.ts                                           | 源码与产物分别摘要、Ed25519、拒绝篡改/已知凭证、不默认带用户材料                           |
| C2 软件运行     | src/runtime、web/src/runtime、build-runtime.mjs                                     | 无 IDE 数据库/无 node_modules 的外部目录实际启动；两个安装的密钥、账号和任务独立           |
| C3 安装         | desktop、build-desktop.mjs、free-engine.ts                                          | 真实双 NSIS 安装/隐藏 Electron/内容更新/卸载隔离；新建免费 WSL Linux Engine 载入镜像并执行 |
| C4 远控         | src/remote、relay、RuntimeSettings                                                  | 真实 workerd/SQLite DO/WS 与公网 Quick Tunnel；配对确认、任务、找回及撤销                  |
| C5 总体         | API、浏览器、安装与网络证据                                                         | 工程与软件交付链实际验证；真实供应商、客户业务样本和实体设备边界见末节                     |

独立运行采用每安装实例的原子本地状态与独立密钥，不要求开发 PostgreSQL/S3。原企业工作台的任务、审批、规则和文件 API 保留；?legacy=1 提供兼容入口。新的 SDK 不向生成代码开放任意宿主盘或 Shell；安装私有目录由运行端管理，外部系统使用受权 MCP/API。

## 验收口径

- 严格类型检查与真实 esbuild 编译分别执行，生产构建在独立非 root/无网络容器中，没有宿主编译回退。
- 运行源码而非静态界面。Model 协议夹具、计算/回显源码测试工程均明确命名；它们证明工程/协议/隔离行为，不能证明真实模型或供应商的业务效果。
- 生成代码没有模型密钥、IDE token 或 Docker socket；模型/工具经受信代理，重新检查配置修订、授权和本次同意。
- 源码、构建、试用和包有固定关联；失败、取消、未验证与成功分别记录。
- 请求摘要/回执号在浏览器持久保存。两条真实故障注入覆盖：服务端接收后丢回执并刷新，独立 App 只有一次任务；IDE 源码已改变后找回同一开发轮次。缓存不保存业务输入或密钥。
- 同一软件可安装于两个独立端；中继通道参与浏览器会话、待确认回执及离线缓存的隔离。同一 Worker 的安装端属于同一可信管理域，不以 URL 路径充当跨客户来源隔离。

## 已运行命令与证据

构建、测试在专属依赖副本和独立 PostgreSQL/S3 项目运行，没有替换旧业务部署；源码与锁文件回同步至本仓库。使用 Node 24.22.3。

| 命令/场景                                                            | 记录                                                                                                            |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| npm run build                                                        | 服务端/UI 类型、Vite、生产静态复制和独立 runtime；真实第三方许可证/SBOM 记录                                    |
| eslint .                                                             | 全源码检查；生成产物与临时审计文件不作为源码检查对象                                                            |
| vitest run tests/api --maxWorkers=1 --pool=threads，gateway 契约环境 | 完整一次 17 文件：98 通过、1 项 Windows 条件用例未在该命令重复；268.61 秒                                       |
| Windows 安装 API 专项（显式启用）                                    | 1 通过：真实生成 NSIS、完整流式下载/摘要、一次性及会话撤销；181.95 秒                                           |
| submission-key + runtime-app 精准回归                                | 2/2 通过：新增回执缓存安全与受影响安装运行；未重复运行无变化的完整套件                                          |
| ide-workflows                                                        | 真实 DSH 源码错误/修复、案例、预览、MCP、草稿、回执丢失恢复；明确的模型协议夹具                                 |
| runtime-workflows                                                    | node_modules 外运行、开发 DB 不可用、实际计算、iframe、390px/PWA、丢回执后仅执行一次                            |
| Windows desktop 专项                                                 | 两套真实 NSIS 静默安装、隐藏 Electron 21/12、同发布者更新 28、卸载 A 后 B 继续可用，保留数据                    |
| 免费环境 POC                                                         | 新独立 Alpine/WSL Engine 初始空镜像，实际载入固定镜像，UID10001/loopback/CapEff0，无开发 key，两个 App 真实执行 |
| run-relay / relay-workflows                                          | 真实本地 Cloudflare workerd + SQLite DO + 出站 WS，设备确认/执行/管理拒绝/重连/撤销                             |
| quick-tunnel-live                                                    | 真实公网 trycloudflare HTTPS、390px Edge、电脑确认、实际 21、管理拒绝和设备撤销；本机使用既有系统代理           |
| root/desktop/relay/compiler npm audit                                | 四套锁定依赖均为 0 已知漏洞                                                                                     |

首次完整 API 命令误用了测试副本的 DSH 环境，旧 gateway 契约用例失败；没有删除断言。已按其规定环境重跑：48 项定向全过，随后完整 98 项全过。真实 DSH 仍由隔离、原端到端和新 IDE 用例实际运行。

安装器的实际 Authenticode 是 NotSigned。测试安装器各约 407 MB；精确字节、哈希、运行版本、内存和启动至首任务时长见 Windows 证据。时长包含环境准备、镜像检查及真实隔离任务，不当作纯启动指标。两个安装产物中实际打包的 runtime.mjs 摘要均与主仓库最终运行端产物一致，已独立读取文件复核。隐藏窗口通过 DOM 事件调用真实界面逻辑；普通鼠标交互在 headless Edge 验证，没有控制用户可见桌面。

本轮修复包括：旧连接 provider CHECK 阻止 IDE 私有绑定；Docker Windows 管道/取消 wait 泄漏；真实隔离编译；下载中文路径 UTF-8；长安装构建路径；PS 模块加载；临时通道就绪与退出清理；不确定回执丢失；同软件多安装的浏览器命名空间。

最终审计还修复了以下实际问题：

- DSH 的 `final` 先于安全收尾，提前关闭附着输入会丢失 `boundary`。改为可信 `runtime.exit` 握手，桥协议为3。长文本原安全断言及完整 ISO-06 均通过。
- 审批通过时，SSE 可能混用旧 BLOCKED 状态与新审批决定。终态现在由同一 RepeatableRead 事务读取，客户端忽略已取消连接的迟到事件。受影响 API 19/19、PC 全流程通过。
- 独立软件重启不恢复已保存本地连接的精确地址授权。新增清空进程授权后重开并实际调用 HTTP 的回归，1/1 通过。
- 工程包的凭证检查同时覆盖案例记录，防止回显的已知密钥随证据导出，包专项 2/2 通过。
- Windows 对新复制 EXE 的 ASAR 完整性写入有间歇性 UNKNOWN 错误。仅此特定错误允许最多两次原样重建，保持完整性校验；其他构建失败直接报告。

经过复核的 JSON、安装产物摘要和真实截图放在 [本轮证据目录](evidence/agent-ide-20261126/)。这些是明确标注的源码/协议验收工程，没有把计算测试当作客户业务 Agent。

## 交付与恢复

- 两份已确认方案文档保留其历史设计。当前 SDK/工程格式为1、运行桥协议为3，固定 MCP SDK1.32.2、Node24.22.3、DSH0.2.2-rc.1、Electron45.5.0、Builder26.18.0。旧桥镜像会明确拒绝，应使用本版 Dockerfile 重建。
- 安装/客户配置/更新与免费环境步骤见 [软件交付](AGENT_APP_DELIVERY.md)。稳定中继部署见 [relay](../relay/README.md)。
- 迁移只增量增加 IDE 表和合法连接命名空间；原业务数据保留。备份数据库/S3、工程/发行目录与加密/发布者密钥。
- 回滚先停新 worker，切回匹配代码/静态/运行镜像，保留增量数据；不自动重放结果不确定的任务。
- 公网测试通道、测试 Worker 和安装专项的临时进程在测试收尾关闭；本轮只处理自己的测试资源，不触碰原有 Linux 发行版、容器或用户数据。自动审批拒绝了测试副本旧静态文件的清理命令（blocked by policy），这些临时文件保留，不能宣称本机绝对零残留。

## 尚无通过证据的外部条件

1. 用户此前指定的 127.0.0.1:8317/v1 最新探测仍拒绝连接，没有获得上游响应。真实 Gemini 生成与语义 Judge 的供应商效果未验收，不能从协议夹具推断成功。
2. 没有新的 Kdocs/IMA/TinyFish 合法账号完成真实业务联调；配置和失败状态是真实实现，业务效果仍未验收。
3. 没有实体蜂窝手机/iOS 主屏幕/原生 APK 或 IPA 验收；本版手机客户端为 PWA。
4. 稳定 Worker 已本地真实运行，尚未部署到用户 Cloudflare 账号；临时公网通道已实际验证。
5. 免费自动环境在 WSL2 已启用主机的新独立发行版实测；未启用 WSL 的干净 Windows 路径未实测，可能需要管理员和重启；实测内核 swap 限额不可用。

这些条件保留为未验收，不标成业务 PASS，也不声称绝对“零风险”。工程实现和上述可复现结果与外部验收分别交付。
