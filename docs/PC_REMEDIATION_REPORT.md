# Poros PC 整改报告

审计从 PR #1 的 `5e045f1999569ff41fda1cf7727fef072b75a754` 开始，交付修复保留在原审查分支。[公开 PR #1](https://github.com/TZUKWAN/Poros-audit-20261118/pull/1)。

## 工作流程

- **Builder。** `web/src/views/agents.tsx` 提供手工创建、实际模型请求及明确区分的开发测试模板。基础信息、Persona、模型策略、输出策略和能力按表单编辑，保留高级 JSON 与保存差异。运行只从精确授权决定工具集，旧 JSON 的 `tools` 字段退出配置入口。名称进入 Persona、部门决定规则范围。Markdown 策略既改变模型指令，也生成可下载产物。模型策略校验组织端点与个人型号的授权一致性。
- **项目与账号。** `routes/projects.ts` 和 `task-access.ts` 负责组织账号、角色、项目创建编辑归档、成员和 Agent 分配。项目成员有管理员、协作和只读权限。建立关联后的 Agent 只在所关联项目执行。归档及移除保留历史，服务端验证参与组织和当前项目角色。
- **文件与来源。** `routes/files.ts` 使用实际 S3 对象和 Prisma 元数据，支持分类、预览、授权下载、移除和使用记录。`file-text.ts` 在有时限和内存限制的工作线程提取正文。任务输入需与任务同项目，个人文件由任务发起人选择。`FileUse` 记录来源、摘要、字符数和截断。文件移除停止新增读取，并保留已有历史证据。
- **任务执行与采纳。** `views/run-details.tsx` 组织模型、工具、授权、失败、产物、历史和 Judgment。执行失败记录分类和可操作提示，测试模型产生的结果保持 UNVERIFIED。采纳仅关联已经验收的完成运行。取消、审批和结果写入使用条件更新，撤回保留独立状态。
- **结果纠正。** `/api/tasks/:id/runs/:runId/corrections` 由服务端绑定运行、任务和版本。机械规则有结构化字段和确定性验证，冲突在申请及批准时检查。原始输出随规则证据保存，历史规则列表只返回安全的证据摘要。语义裁决显示实际模型和证据引用，缺失或失败保持 UNCHECKED。

## 能力与安全

- 能力中心提供 DSH 工具、注册 Skill 指令和项目文件知识版本。已发布版本冻结来源、版本和范围。停用或撤权后，旧版本保持审计可读，运行权限终止。
- Kdocs 使用 WPS 365 MCP 云文档搜索和正文读取。IMA 提供知识库列表与指定知识库的正文片段搜索。TinyFish 承担公开网页搜索和抓取。运行前固定发起人的连接修订，调用前后复核权限并记录供应商、输入、返回来源和故障。[WPS 云文档工具](https://open.wps.cn/documents/app-integration-dev/mcp-server/tools/mcp_kso-yundoc) · [IMA 开放接口](https://ima.qq.com/agent-interface) · [TinyFish 文档](https://docs.tinyfish.ai/)。
- 每任务容器使用独立工作目录、非 root、只读根及 `--network none`。模型和指定能力访问经 Docker 附着帧传送到宿主代理，模型代理只监听环回。容器拿到当前运行令牌，供应商凭证留在 API。每次工具执行前校验实时权限，SSE 查询按游标分批，活动连接仅拉取新事件。
- 两笔 Prisma 迁移新增项目状态、项目角色、任务附件与使用记录、能力版本、撤销记录和来源证据。迁移和真实 DSH 验收在隔离环境执行。部署时同时升级 API 与固定版本运行镜像。[部署说明](DEPLOYMENT.md)。

## 验收分界

- 用户提供的 Gemini 在本轮真实生成请求返回 HTTP 403 / `VALIDATION_REQUIRED`，此前收到 503 / `VALIDATION_REQUIRED`。该通道的实际草稿生成、任务生成和语义评估待上游完成验证。Kdocs、IMA、TinyFish 已接入授权工具并做了协议测试，仍待真实凭证。[PC 验收矩阵](PC_PRODUCT_ACCEPTANCE.md)。
- MCP 当前准入 WPS 365 云文档的指定只读工具。能力中心的 Skill 执行的是版本化的指令加载，Knowledge 执行的是获授权项目文件的正文读取。任意 MCP 地址、外部 Skill 可执行程序、扫描 PDF 的 OCR 和复杂表格计算超出当前执行范围。读取 Excel 的公式缓存值或公式文本，保留截断和格式限制提示。
- 测试覆盖常规并发执行、取消、超时、租约异常、数据库失败和增量 SSE。极大规模的长连接压力基准未在本轮运行。

## 交付与复现

在本部署的环境中执行 `npm ci`、`npx prisma migrate deploy`、`npm run runtime:build`、`npm run build` 后启动。验收以独立数据环境运行，详见 [PC 功能矩阵](PC_FUNCTION_AUDIT.md) 和 [CI 检查](https://github.com/TZUKWAN/Poros-audit-20261118/pull/1/checks)。截图、关键运行标识、真实模型响应分类和本地日志保留在本次工作区的 `.audit/evidence/pc/` 与相邻的 PC 日志文件。
