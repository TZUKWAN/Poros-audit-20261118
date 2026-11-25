# Poros Agent AI IDE

用左侧对话开发 Agent，在右侧直接试用它的真实界面。主界面保留工程、开发对话、PC/手机预览和一个设置入口；代码与执行记录按需展开。

Agent、标准 Skill 和 MCP 服务共用这套开发环境。AI 读写实际源码，运行严格类型检查和隔离构建，用失败诊断修复；成功版本才进入预览。开发模型必须由用户配置并完成连接测试，没有可用连接时保留输入并打开设置。

## 当前能力

- **开发与试用**：工程文件、不可变源码修订、并发修改检查、持续开发记录、停止、构建和明确案例验收。构建失败保留上次成功预览并显示版本。
- **技能与 MCP**：创建/编辑标准 SKILL.md、资料与 TypeScript 脚本；开发真实 MCP tools 服务，发现、校验及调用工具；导入/导出签名能力包，固定源码与版本，新增能力不自动授权。
- **统一配置**：开发模型与 Agent 运行模型分开；大模型 API、Kdocs、IMA、TinyFish、外部 MCP 和业务 API 均有用户配置入口。保存、连接测试与实际业务验收分别记录，凭证留在受信运行端。
- **独立软件**：导出签名工程包；Windows 构建端可在工程设置中生成具名 NSIS 安装器。客户软件有自己的密钥、数据、连接和任务，不依赖开发平台数据库。
- **手机远控**：电脑运行 Agent，手机 PWA 发起/停止任务和查看结果。两分钟配对邀请、电脑确认、每设备授权及撤销。免账号 Quick Tunnel 提供临时免费地址；自己的 Cloudflare Worker + SQLite Durable Object 提供稳定中继。
- **运行边界**：生成代码在无宿主卷、非 root、只读、无网络的独立容器中编译/运行。外部调用通过凭证代理和明确授权；预览 iframe 取不到 IDE 登录态。
- **回执恢复**：请求号和输入摘要在浏览器持久保存；网关错误、丢回执和刷新后找回原操作，避免重复任务。案例通过只代表记录的案例；未知用量/价格与未验证业务保持明确状态。

代码、验收范围与实测限制见 [AI IDE 实施交付](docs/AGENT_IDE_DELIVERY.md)。仓库和审查 PR 为 PUBLIC；根项目保留 UNLICENSED，第三方许可证随独立产物附带。

## 开发启动

需要 Node 24.22.3 和兼容 API 1.47 的 Linux Engine。PostgreSQL/S3 使用本部署的独立配置。

```sh
cp .env.example .env
# 填写本部署的数据库、JWT、S3 与设置加密密钥
npm ci
npm run db:up
npx prisma migrate deploy
npm run runtime:build
npm run compiler:build
npm run build
npm run db:seed       # 仅开发
npm start
```

默认环回地址为 `http://127.0.0.1:8787`。Builder/管理员默认进入 IDE；原企业工作台可从 `?legacy=1` 访问，原业务 API 与历史数据保留。生产、持久目录、迁移与回滚见 [部署说明](docs/DEPLOYMENT.md)。

Windows 安装器、客户配置与免费远控的完整步骤见 [独立软件交付](docs/AGENT_APP_DELIVERY.md)；稳定中继部署见 [relay](relay/README.md)。客户软件内置 Node；自动免费环境路径已在启用 WSL2 的 Windows x64 上实测，不要求客户安装开发数据库。

## 兼容的企业工作流程

从「Agent 目录」选择已发布助手并使用，或从项目及文件直接开始。项目是可选的；新工作必须明确选择助手。要求、材料和个人连接在当前工作内准备，发送后自动保存在「最近工作」，刷新或重新登录可打开原地址继续。

同一工作内的后续要求会收到此前实际请求、结果和有权使用的文件。每条请求单独冻结版本、连接和授权；前一条尚未结束时依次排队。「修改此结果」生成关联原产物的新修订；失败「重试」保留同一请求并新增运行尝试；「评价这次结果」记录本次意见；「建议今后遵循」才申请长期规则，独立审批后生效。测试模型输出仍为 UNVERIFIED。

构建者在「编辑与测试」配置草稿、授权能力、运行草稿测试，再申请独立审批。未保存输入按账号和助手暂存，保存发生冲突时保留输入并显示差异。发布前复核展示的草稿和授权，已审批版本支持回滚。组织管理员可在「设置」管理账号，在「项目空间」分配项目角色和维护资料；成员可从「审批与规则」查看自己的申请，审阅者直接处理有资格的审批。

「能力中心」列出 DSH Tool、可版本化的 Skill、项目文件 Knowledge、Kdocs MCP、IMA 及 TinyFish。外部查询按发起人自己的已验证连接执行，敏感能力仍需任务同意和独立审批。任务容器禁用网络，模型和受管能力经受限的 Docker 附着通道访问。

支持提取 UTF-8 文本、Markdown、CSV、JSON、文本层 PDF、DOCX 正文及 XLSX 单元格。已提取的文本按额度进入任务，来源编号和摘要留痕。图片和 PPTX 支持存储及下载。

兼容工作台使用上述同一部署；旧手机流程见 [历史工作台手机与个人集成](docs/MOBILE_AND_CONNECTIONS.md)，独立 Agent 的配对方式以 [软件交付说明](docs/AGENT_APP_DELIVERY.md) 为准。

## 验证与证据

```sh
npm run build
npm run lint
npm run test:api
npm run test:isolation
npm run e2e
npm run e2e:pc
npm run e2e:ide
npm run e2e:app
npm --prefix relay ci --ignore-scripts
npm run e2e:relay
npm audit --audit-level=low
npm run sbom
```

测试使用独立临时数据库、真实 PostgreSQL/S3/DSH/工具及无头浏览器。模型与第三方响应夹具用于验证协议和边界。真实服务的结果以本人的连接测试为准。

当前轮证据见 [AI IDE 实施交付](docs/AGENT_IDE_DELIVERY.md)。此前企业底座报告保留其当时的时间、HEAD 和验收范围：[审计修复报告](AUDIT_FIX_REPORT.md)、[测试证据](TEST_EVIDENCE.md)、[安全复核](SECURITY_REVIEW.md)、[功能迁移矩阵](docs/FEATURE_MIGRATION_MATRIX.md)、[已定事项](docs/DECISIONS.md)、[第三方/SBOM](docs/THIRD_PARTY.md)。旧 Pi 文档是历史资料，不能作为当前部署说明。

PC 专项证据见 [功能真实性审计](docs/PC_FUNCTION_AUDIT.md)、[产品验收矩阵](docs/PC_PRODUCT_ACCEPTANCE.md) 和 [整改报告](docs/PC_REMEDIATION_REPORT.md)。

连续工作方案与契约见 [交互研究](docs/PC_INTERACTION_RESEARCH.md) 和 [交互实施与验证](docs/PC_INTERACTION_IMPLEMENTATION.md)。升级时应用增量迁移，历史任务和运行保留并回填会话。
