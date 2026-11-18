# Poros PC 产品验收

在独立 PostgreSQL 17、认证 SeaweedFS 3.85、真实 DSH 0.2.2-rc.1 容器和构建产物上验收。浏览器使用 Chromium 系无头模式，视口 1920×1080 和 1366×768。账号、文档和模型协议数据来自本次测试。浏览器动作执行实际 API，检查器另查数据库、工具输出和响应体。

```sh
npm run build
npm run lint
npm run test:api
npm run test:isolation
npm run e2e:pc
npm audit --audit-level=low
```

`tests/e2e/pc-workflows.mjs` 写入 `.audit/evidence/pc/browser.log` 和桌面截图。可用 `POROS_PC_EVIDENCE` 指定路径。日志以 PC 编号关联任务、运行、规则或项目记录。CI 的 `e2e-real-dsh` job 执行相同浏览器脚本。[PR #1 检查](https://github.com/TZUKWAN/Poros-audit-20261118/pull/1/checks)。

| 编号 | 输入与期望 | 实测与持久证据 | 结论 |
| --- | --- | --- | --- |
| PC-01 登录与角色 | 创建组织测试账号，分别以管理员、审阅者和成员登录，再退出及停用会话 | 浏览器走实际认证，普通成员访问管理 API 得 403。退出及停用后，旧 JWT 的 `/me` 为 401。数据库核对 `Membership.disabledAt` | PASS |
| PC-02 项目管理 | 新建项目、保存编辑、调整只读与协作角色 | 浏览器更新项目说明、项目角色。只读成员上传得 403，跨项目和跨组织访问得 403。截图 `01-project-members-1920.png` | PASS |
| PC-03 Agent 创建 | 分别检查手工创建、测试模板、真实模型入口 | 手工来源保存为 `MANUAL`。API 验证模板为 `TEMPLATE`，以 HTTP 夹具验证模型草稿的传输、结构和 `MODEL` 来源。浏览器在连接未验证时禁用真实生成。用户指定模型的实际请求拒绝 | PASS（手工与协议）／BLOCKED（实际模型生成） |
| PC-04 Agent 配置 | 发布 Persona 与 Markdown，切换版本后运行 | 比较冻结配置，按 v1 发送 Persona。模型夹具看到了该内容。真实 S3 产物字节与运行输出一致，产物下载可用 | PASS（配置进入执行） |
| PC-05 能力授权 | 同意后执行 bash，无同意或授权时拒绝 | 容器真实写出已验证标记，未同意请求得 403。隔离套件检查工具调用、动态撤销和网络边界 | PASS（平台授权与本地工具） |
| PC-06 草稿测试 | 以当前草稿调用真实 DSH，展示执行结果和通道 | 浏览器提交并独立批准，`Run.modelId=poros-stub`，显示耗时、工具、结果和 UNVERIFIED。`Task.agentVersionId=null` | PASS（DSH 草稿闭环） |
| PC-07 发布审批 | 创建 3 份冻结版本，拒绝 v2，批准 v1/v3，从 v3 直接回滚 v1 | 浏览器显示实际 v1。数据库验证 v2 保持未批准、快照中保存原 Persona 与范围说明。独立审批和不可变触发器另有 API 证据。截图 `02-builder-and-versions-1920.png` | PASS |
| PC-08 文件处理 | 分别上传文本层 PDF、DOCX、XLSX 和 Markdown，读取并导出 | 四种正文在浏览器预览，Excel 包含真实工作表名与单元格。三个选中文件进入模型请求，`FileUse` 有来源号、字数及 SHA-256。下载字节一致。截图 `03-files-1920.png`、`04-run-with-files-1366.png` | PASS（实际读取和传输） |
| PC-09 执行 | 队列、SSE、取消、失败重试和查看历史 | 浏览器真实接收 DSH 流，取消后 `Task=CANCELLED`。损坏 PDF 的两次尝试分别保存 `FILE_READ_FAILED` 和历史记录。API 断线上从 `Last-Event-ID` 补发 | PASS |
| PC-10 纠正 | 在当前运行输出旁提交纠正 | 候选记录保存真实 task、run、Agent v1、原始输出和反馈。浏览器不输入对象 ID。截图 `05-correction-1366.png` | PASS |
| PC-11 Judgment | 批准机械规则并运行，检查注入与裁决，验证语义异常 | 新运行的 `JudgmentApplication` 对已批准规则持久化 PASS。模型仍标记 UNVERIFIED。API 检查语义失败和缺裁决返回 UNCHECKED、冲突和版本约束 | PASS（确定性规则与语义边界）／BLOCKED（真实 Judge） |
| PC-12 外部连接 | 核对能力注册、连接验证、授权后调用、断开后拒绝 | 浏览器注册有项目范围的 Skill 和 Knowledge。工具协议夹具覆盖 WPS 搜索与读取、IMA 查询及 TinyFish 搜索抓取，并检查个人连接替换或撤销。截图 `07-capabilities-1920.png` | PASS（注册与协议）／BLOCKED（Kdocs、IMA、TinyFish 真实账号） |
| PC-13 模型故障 | 上游 401、403、429、503、超时和认证验证要求 | HTTP 夹具覆盖五类。浏览器展示 401、凭证替换、验证和断开。实际 Gemini 流式生成返回 403 与 `VALIDATION_REQUIRED`。截图 `06-model-error-1366.png` | PASS（故障处理） |
| PC-14 持久化 | 服务重启后重新打开相同运行 | 从原浏览器重新加载，确认同一 Task、Run 和文件标记，实际数据库未重置 | PASS |
| PC-15 权限安全 | 普通用户越权、不同组织、撤销及归档 | 跨组织 404，未授权项目和撤销后旧会话 403。管理员归档后仍可读历史，审计有移除记录。ISO 检查容器和宿主边界 | PASS |
| PC-16 全流程 | PC 登录、配置、真实任务工具、文件、发布、审批、纠错 | 三个角色浏览器贯通同一组实际项目、版本、运行和候选记录。工具和存储均实测，模型通道是明确的协议夹具 | PASS（工作流程）／BLOCKED（真实模型产出验收） |

## 实际服务验收条件

- Gemini 本轮发出真实流式生成请求并收到 HTTP 403，响应包含 `VALIDATION_REQUIRED`。先前实测 HTTP 503 也返回相同原因。账号完成上游验证后，使用「设置 → 大模型 API → 测试连接」复跑生成探测。
- Kdocs 使用用户授权的 WPS 365 令牌，IMA 使用授权的 Client ID 和 API Key，TinyFish 使用拥有 Search 和 Fetch 额度的 API Key。各服务按任务发起人的连接验收。验证状态、请求格式和失败分支已有协议证据，真实账号验收仍待各服务凭证。
- 语义裁决需要已准入且可实际生成响应的同一模型。当前 Gemini 的账号状态使实际语义 Judge 验收受阻。
