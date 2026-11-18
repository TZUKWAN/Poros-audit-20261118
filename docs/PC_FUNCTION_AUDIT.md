# Poros PC 端功能真实性审计

审计基线 `5e045f1999569ff41fda1cf7727fef072b75a754`。PR #1 执行前 HEAD 与本地一致。范围为 React PC 页面、后端、Prisma、独立 DSH 执行、供应商连接和发布链路。现有数据库和宿主 DSH 配置不用于本轮测试。

## 基线矩阵

A 为已有完整链路，B 为真实但流程欠缺，C 为后端已有而 PC 缺失，D 为只有呈现，E 为模拟或夹具，F 为外部实测条件未满足。分类是基线结论。整改后的验收结果以 PC 验收矩阵为准。表中的测试路径说明现有断言覆盖的范围，运行结果单独记录。

| PC 入口和操作 | API → 服务与数据 → 结果和反馈 | 基线 | 缺口与验证路径 |
| --- | --- | --- | --- |
| 登录、角色、退出 | `App.tsx`、`api.ts` → `/api/auth/login`, `/me`, `/logout` → `auth.ts`、`user_credentials`、`Membership`、`AuthSession` → 会话撤销与 UI 返回登录 | A | `tests/api/hardening.test.ts` 检查撤权。PC 验收需覆盖登录、退出和角色菜单。 |
| Agent 目录和基础信息 | `views/agents.tsx` → `/api/agents`、创建、草稿 PATCH → `AgentDefinition` → 目录/配置 | B | P0 手工创建缺入口，名称、部门和说明缺结构化编辑。使用独立账号和双角色浏览器操作验证。 |
| NL 草稿 | 创建对话框 → `/api/agents/drafts` → `MockGateway.draftAgent` 或 `CompatibleGateway.draftAgent` → `nlSource` / `draftConfig` | E / F | P0 模板返回 `nlGenerated=true`，历史徽章只认 `nlSource`。检查开发模板、真实模型响应、实测 503 的分别处理。 |
| Agent Persona、输出、模型、工具 | JSON 编辑 → 草稿、授权 → `releases.ts` → `runner.ts`、DSH 配置 | B / D | P0 Persona 进入运行，部门筛选规则。`outputKind` 未生成文档，`modelPolicy` 未参与路由，`config.tools` 与实际授权无关，授权说明未冻结。检查后续运行请求和产物，而非只读 JSON。 |
| Tool/Model 授权与撤销 | Builder → `/grants` → `AgentGrant` → release manifest → `dsh-runtime.ts`、bootstrap 工具策略 | B | P0 已有冻结、任务同意、审批。删除草稿授权不会撤回已发布能力。P1 逐个核对工具注册和真实执行。 |
| 草稿测试 | Builder → `/test-runs` → `Task`、`Run`、`RunEvent` → `RunEvents` | B / E | P0 需展示具体模型、授权结果、输出、耗时。API mock 合同与真实 DSH 工具需要分别取证。 |
| 发布、审批、版本回滚 | Builder / 审批 → `/publish`、`/approvals/:id/decision`、`/rollback` → `AgentVersion`、`ApprovalRequest` | B | P0 冻结版本和独立审批真实。前端限定小于当前版本并猜测提示。在浏览器回滚到非相邻已审批版本并核对服务端。 |
| 项目、成员、账号、Agent 关联 | `Project`、`ProjectMember`、`Membership` 已存在。CLI 种账号。任务和文件后端校验项目 ID | C | P0 缺 PC 管理和项目任务入口。补齐真实组织/项目角色、分配、跨组织与撤权测试。 |
| 文件上传与下载 | `/api/files` 与一次性票据 → `storage.ts`、S3、`FileObject` | C | P0 `acceptance.test.ts` 验证 S3 往返与票据限制。缺 PC 文件操作、解析、任务输入和来源使用记录。 |
| 工作台任务与状态 | `views/workspace.tsx` → `/api/tasks`、取消、重试 → `worker.ts`、`Task`、`Run` | B | P0 持久队列、审批、取消与重试存在。缺项目、文件选择、运行历史、错误分类、结果采纳和导出。 |
| 工作台 SSE | `RunEvents` → `/api/tasks/:id/events` → `RunEvent` → JSON 事件 | B | P0 已支持游标。每客户端 100 ms 重查全量事件，且语义化证据不足。验证重连无缺漏和可读时间线。 |
| 规则候选、修订、审批、停用 | `views/governance.tsx` → `/api/judgments`、`/approvals` → `judgment.ts`、`JudgmentRule`、`JudgmentApplication` | B | P0 前端漏传来源 Run，依赖手工 ID、原始审批 JSON。检查来源、冲突、独立审批、停用后真实运行。 |
| Judgment 评估 | `runner.ts` 注入 → 确定性判断或 `semantic-judge.ts` → `JudgmentApplication`、SSE | B / F | P0 本地机械规则可验，模型裁决实测需要真实可用凭证。检测 `UNCHECKED`、注入与评估两类留痕。 |
| 模型连接、状态和故障 | `views/integrations.tsx` → `/api/settings/integrations/model/test` → `integration-providers.ts` → 真实流式生成探测 → `IntegrationConnection` | B / F | P0 既有生产拒绝 mock/stub。执行中真实模型信息不齐，开发 DSH stub 可被标记 `SUCCEEDED`。Gemini 前次实测 503 / `VALIDATION_REQUIRED`，需要复验并保留失败状态。 |
| Kdocs、IMA、TinyFish 设置、测试和调用 | 设置 → `/api/settings/integrations` → 加密个人连接 → `integration-providers.ts` | B / F | P1 设置页真实协议调用。缺 Agent 装载和调用记录，供应商实测需合法凭证。用协议夹具测权限、协议和撤销与真实供应商实测分开记录。 |
| Skill、MCP、Knowledge | `GrantKind` 有枚举，`validateGrant` 拒绝未实现绑定 | C | P1 需要能管理、冻结、装载和执行的明确范围。证明能力执行与撤销，没有注册能力时返回可见失败。 |
| 部署/隔离 | `deploy/docker-compose.yml`、`dsh-runtime.ts`、`model-proxy.ts` → 临时容器、内网、令牌、清理 | B | P1 `host-gateway` 路由和模型代理绑定需要实测。`tests/isolation`、`run-e2e.mjs` 的既有测试使用自有隔离环境。不得探测用户宿主服务。 |
| 导航、错误、恢复 | `App.tsx` Tabs，`ui.tsx` 和各页面 → 真实操作和反馈 | B | P2 统一项目、运行、能力、治理及设置。桌面 1920×1080、1366×768 审核真实控制项和关键流程。 |

## 整改路线与验收门槛

1. 模型和 Builder 覆盖 `model-gateway.ts`、`releases.ts`、`runner.ts`、`routes/index.ts`、`views/agents.tsx`。分别核对模板和实际请求、发布与执行的配置一致、服务端版本号和结果留痕。
2. 项目和文件以增量 Prisma 迁移与独立路由复用 `auth.ts`、`storage.ts` 和现有队列。验证账号和项目角色、归档、文件实际解析、隔离读取与持久记载。存量数据不做破坏性改写。
3. 运行和治理复用持久事件和判断应用。以 Run 绑定原始结果、版本和纠正，管理语义时间线、状态、来源、审阅和重连。独立审批和不可变版本继续作为服务端约束。
4. 能力和连接器以明确名称、来源、范围及版本注册。已授权个人连接在执行时校验，运行环境采用受控通道。供应商缺凭证的用例标为阻塞。
5. 最终在新的 PostgreSQL、S3 与 DSH 实例中运行构建、静态检查、API、隔离及桌面 E2E，整理 PC-01 至 PC-16 的证据。交付另外两份报告、截图、日志和 PR 提交。发布前核查凭证、内部地址及截图内容，更新现有 PR 分支。

## 关键检查点

| 风险 | 定位与验证 |
| --- | --- |
| 草稿误标真实模型 | `routes/index.ts`、`model-gateway.ts`。验证手工、TEMPLATE、MODEL、缺连接和上游验证失败分别持久化或拒绝。 |
| 回滚提示与实际版本不符 | `views/agents.tsx`。PC-07 批准 v1/v3、拒绝 v2，从 v3 选择 v1，比较响应和数据库指针。 |
| 冻结 JSON 经过 PostgreSQL 后键顺序变化 | `releases.ts`、审批路由。草稿运行从请求快照到数据库审批做端到端回归，排序后的摘要保持一致。 |
| 真实工具名与配置不一致 | `capability-catalog.ts`、`poros-tool-policy.mjs`。从固定 DSH 发行包确认本地注册名，ISO-06 握手、调用、无授权拒绝、权限撤销和目录隔离。 |
| 请求通道可访问不相关的宿主服务 | `dsh-runtime.ts`、`model-proxy.ts`、`poros-bridge.mjs`。容器 inspect 核查无网络和宿主别名，再验证实际模型传输。保留长 Unicode 字节校验和超时清理。 |
| 个人连接只在设置页运行 | `capabilities.ts`、`integration-providers.ts`。执行层读取当前任务冻结的连接修订，验证具体供应商工具和请求参数。真实账号验收见 PC-12。 |
| 规则只注入，未实际评估 | `runner.ts`、`judgment.ts`、`semantic-judge.ts`。对比注入事件、独立裁决及持久化的 PASS/FAIL/UNCHECKED。 |

整改后的验收由 [PC 产品验收](PC_PRODUCT_ACCEPTANCE.md) 和 [整改报告](PC_REMEDIATION_REPORT.md) 记录。基线矩阵保留发现时的分类。
