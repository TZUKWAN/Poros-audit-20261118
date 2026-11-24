# Poros Enterprise

企业 Agent 的构建、发布、执行和判断规则治理平台。运行时使用容器内的 **DSH 0.2.2-rc.1**。仓库和审查 PR 公开可读。根项目仍声明 UNLICENSED，第三方组件沿用各自的许可证。

## 当前行为

- React 19 / Radix / Tailwind / Vite：组织登录、连续工作会话、Builder、执行实时事件、独立审批、规则修订、个人集成设置及可安装的手机 Web App。
- 发布申请冻结 Persona、配置、Model Policy、精确授权及版本/来源；独立审阅者批准后生效。版本单调递增，回滚只换指针。缺少历史授权快照的旧版本须重新发布审批，不虚构迁移授权。
- 任务提交立即返回 202 和 ID，PostgreSQL Worker 后台执行；支持事件 ID/重连补发、幂等、取消、超时、显式限次重试和共享并发限额。敏感工具须本次同意和独立审批。
- 每任务独立临时 DSH 容器，无用户卷/宿主挂载/Docker socket；非 root、只读根、资源配额。工具执行前默认拒绝，事后再审计。模型供应商密钥留在 API 宿主。
- Judgment：显式反馈、真实作用域/来源、人工审批、机械冲突检测、不可变修订与逐次证据。FAIL/UNCHECKED/PASS 分离；开发 mock 输出为 UNVERIFIED。
- 可撤销认证、登录/上传限流、原子一次性下载票据；SeaweedFS S3 拒绝匿名访问。
- 成员可保存、测试和断开大模型 API、Kdocs、IMA、TinyFish。模型端点和型号随 Agent 版本审批，发起人的凭证按任务修订固定。手机端可从「最近工作」恢复同一会话和事件流。

## PC 工作流程

从「Agent 目录」选择已发布助手并使用，或从项目及文件直接开始。项目是可选的；新工作必须明确选择助手。要求、材料和个人连接在当前工作内准备，发送后自动保存在「最近工作」，刷新或重新登录可打开原地址继续。

同一工作内的后续要求会收到此前实际请求、结果和有权使用的文件。每条请求单独冻结版本、连接和授权；前一条尚未结束时依次排队。「修改此结果」生成关联原产物的新修订；失败「重试」保留同一请求并新增运行尝试；「评价这次结果」记录本次意见；「建议今后遵循」才申请长期规则，独立审批后生效。测试模型输出仍为 UNVERIFIED。

构建者在「编辑与测试」配置草稿、授权能力、运行草稿测试，再申请独立审批。未保存输入按账号和助手暂存，保存发生冲突时保留输入并显示差异。发布前复核展示的草稿和授权，已审批版本支持回滚。组织管理员可在「设置」管理账号，在「项目空间」分配项目角色和维护资料；成员可从「审批与规则」查看自己的申请，审阅者直接处理有资格的审批。

「能力中心」列出 DSH Tool、可版本化的 Skill、项目文件 Knowledge、Kdocs MCP、IMA 及 TinyFish。外部查询按发起人自己的已验证连接执行，敏感能力仍需任务同意和独立审批。任务容器禁用网络，模型和受管能力经受限的 Docker 附着通道访问。

支持提取 UTF-8 文本、Markdown、CSV、JSON、文本层 PDF、DOCX 正文及 XLSX 单元格。已提取的文本按额度进入任务，来源编号和摘要留痕。图片和 PPTX 支持存储及下载。

## 启动

Node **24.22.3**（`.node-version`），Docker / Compose v2。API 默认只监听 `127.0.0.1:8787`。

```sh
cp .env.example .env
# 编辑本部署自己的数据库、JWT、S3 配置，不提交真实凭证
npm ci
npm run db:up
npx prisma migrate deploy
npm run runtime:build
npm run build
npm run db:seed       # 仅开发，生产拒绝种子
npm start
```

构建包含服务端、UI 和 `dist/src/server/public`。生产使用 `npm run start:prod`；配置不全、mock/stub、开发默认口令或开发成员均拒绝启动。详见 [DEPLOYMENT](docs/DEPLOYMENT.md)。

手机访问复用 Poros 登录、API 和审批。Windows 可启动独立部署并发布私网入口。见 [手机与个人集成](docs/MOBILE_AND_CONNECTIONS.md)。

## 验证与证据

```sh
npm run build
npm run lint
npm run test:api
npm run test:isolation
npm run e2e
npm run e2e:pc
npm audit --audit-level=low
npm run sbom
```

测试使用独立临时数据库、真实 PostgreSQL/S3/DSH/工具及无头浏览器。模型与第三方响应夹具用于验证协议和边界。真实服务的结果以本人的连接测试为准。

交付：[审计修复报告](AUDIT_FIX_REPORT.md)、[测试证据](TEST_EVIDENCE.md)、[安全复核](SECURITY_REVIEW.md)、[功能迁移矩阵](docs/FEATURE_MIGRATION_MATRIX.md)、[已定事项](docs/DECISIONS.md)、[第三方/SBOM](docs/THIRD_PARTY.md)。旧 Pi 文档是历史资料，不能作为当前部署说明。

PC 专项证据见 [功能真实性审计](docs/PC_FUNCTION_AUDIT.md)、[产品验收矩阵](docs/PC_PRODUCT_ACCEPTANCE.md) 和 [整改报告](docs/PC_REMEDIATION_REPORT.md)。

连续工作方案与契约见 [交互研究](docs/PC_INTERACTION_RESEARCH.md) 和 [交互实施与验证](docs/PC_INTERACTION_IMPLEMENTATION.md)。升级时应用增量迁移，历史任务和运行保留并回填会话。
