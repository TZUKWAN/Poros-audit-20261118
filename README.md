# pi-scenario — 场景Agent系统（基于 Pi 的自构建 Agent）

一句话需求 → 自动生成并校验**可复用场景定义** → 场景库固化；工作模式加载场景后优先尝试真实能力调用，并在能力不可复用时进入带证据约束的模型工作步骤。内部编排阶段用于校验和追踪，普通用户不需要学习或逐个操作闸门。

```
┌─────────────────────────── pi-scenario 内核 ───────────────────────────┐
│  解析 →【闸1】→ 规划 →【闸2】→ 检索(8源联邦+技能矿) →【闸3】            │
│      → 装配 → 探活 →【闸4】→ 集群执行 → 任务验收 → 蒸馏 →【闸5】→ 入库 │
│  复用：新需求 → 意图签名匹配 → 命中(填槽直跑)/部分(派生)/未命中(全流程) │
│  漂移：复用前探活失败 → 局部换型 → 版本+1 → 知识 Memory 记经验          │
└─────────────────────────────────────────────────────────────────────────┘
```

## 安装

```bash
npm install          # 依赖（Node ≥ 20）
npm run bundle       # 打包内核到 pi-package/dist/kernel.js
pi install ./pi-package   # 注册为 Pi 扩展（pi 实机加载）
pi list              # 应看到 pi-scenario-package
```

## 使用

### Pi 实机（交互命令）

| 命令 | 说明 |
|---|---|
| `/scenario:build <一句话需求>` | 自主模式：五闸门由虚拟用户驱动，跑完构建并固化 |
| `/scenario:status` | 内核装配自检 |

### 库方式（编程接口）

```ts
import { runScenario } from "./pi-package/dist/kernel.js";
const result = await runScenario({ requirement: "整理 /data 下的数据并生成报告" });
// 自动模式（虚拟用户批准五闸门）；人工模式传 onGate 回调接收闸门提案
```

### Web 面板

直接运行 `npm run panel` 会启动本地面板 `http://127.0.0.1:4320`；可用 `PANEL_PORT` 覆盖面板端口。需要自托管同步服务时，同时设置 `SYNC_PORT`（通常为 `4321`）和 `SYNC_TOKEN`。

```ts
import { PanelServer } from "./src/panel/server.js";
const panel = new PanelServer({ orchestrator, library, controller, memoryRoot });
const port = await panel.start(3000);   // http://127.0.0.1:3000 场景工作台 + WS
```

面板有两种模式：

- **工作模式**：输入要完成的工作，系统优先匹配已固化场景，检查能力漂移后尝试真实 MCP/远程/npx 能力调用；能力不可复用时明确转入模型工作步骤并保留未验证证据，不会伪报外部工具已执行；没有可用场景时明确提示切换到场景构建。
- **场景构建模式**：输入想反复完成的工作，系统自动整理目标、输入、步骤、产出和验收，校验通过后直接写入场景库；真实外部工具不在构建阶段被伪装成已执行，首次工作运行会单独记录执行验证状态。
- **构建中的澄清**：当已接入的模型明确返回结构化 `clarification`（问题和字段）时，构建会持久化为 `waiting-user`，不降级成模板或猜测。用户通过聊天卡片补充后，原构建从请求所在阶段继续；刷新或进程恢复也会保留问题，直到收到明确答案。

工作台的中间区域是用户与编排器的聊天信息流，左侧集中显示当前项目和历史对话，场景库通过管理入口打开，右侧是当前运行检查台。新建对话时选择要使用的场景；场景库中的“用于新对话”会打开同一选择流程。每段历史对话会记录创建时的项目上下文，切回或重启面板后恢复到原项目；重试和分支只允许作用于当前对话的运行。闸门卡默认展示可读摘要，原始 JSON 收在高级编辑区。

工作台前端还提供项目与项目指令、文件上传/预览/删除、产物列表、Memory 四层管理、全局搜索、Provider 配置、连接器权限与探活、任务调度、运行中心、审计记录、场景归档/导入/导出等入口。交互动作由 WebSocket action 统一处理；大工作区导入使用专用 HTTP 入口，刷新或断线后从快照和事件 revision 恢复。

Provider 可单独保存加密 Secret；运行设置支持默认/规划/Fallback 模型、温度、最大输出 Token 和项目级 Provider。连接器会显示来源、信任状态、信任分数与最近探活证据。场景详情支持版本历史、能力差异对比和多样例泛化测试。

工作区导出包可在另一台设备上导入；导入时对同名项目和场景生成冲突副本并保留本地数据，项目文件会写入当前项目工作区。同名文件、空文件、非法条目和不随包恢复的路径/凭据绑定实体都会明确提示；导出包通过 `POST /api/workspace/import` 导入，单包上限为 50MB。`src/product/sync.ts` 提供确定性的同步冲突计划，为后续云端传输保留统一合并契约。

如需自托管同步端点，可在启动面板前设置 `SYNC_PORT` 和 `SYNC_TOKEN`；启动器会同时提供带 Bearer 鉴权的 `/workspaces/:workspaceId` pull/push 服务，设置页的同步预览/应用会使用该端点。

常用命令：`/help`、`/search <关键词>`、`/scenario list|inspect|test|version`、`/memory remember|list|search|forget`、`/files list|add`、`/run pause|resume|retry|stop`、`/rename <标题>`、`/export`、`/export workspace`、`/settings`、`/connect`。后台任务支持 `once`、`every 1h`、`every 30m` 和每日 `HH:mm` 计划；上下文中心可保存本地文件、剪贴板、终端和浏览器文本，并在运行前冻结引用。

历史对话会保存到 `~/.pi/scenario/panel-sessions.json`，设置会保存到 `~/.pi/scenario/panel-settings.json`。面板提供 `GET /api/sessions`、`GET /api/settings`、`PUT /api/settings`、`GET /api/snapshot`、`GET /api/events?after=<revision>` 和 `GET /api/audit`；返回设置时 API Key 只返回脱敏值，磁盘上的 Key 使用本机身份派生的 AES-256-GCM 加密。设置页面修改后会影响后续新运行，当前运行中禁止切换模型或端点。

## 内部构建阶段

| # | 闸门 | 决策 | 驳回回退 |
|---|---|---|---|
| 1 | 意图确认 | 批准/逐项编辑槽位/驳回 | 重解析 |
| 2 | 任务清单 | 批准/增删节点/改依赖（环即时提示） | 重规划 |
| 3 | 能力选型 | 单选/换批/自定义（候选卡片含来源徽章/trust/风险标） | 重检索 |
| 4 | 装配与验收 | 批准/改验收标准（流水线图+胶水标注） | 重装配 |
| 5 | 固化评审 | pin（入库）/ rerun / discard | — |

内部仍保留 `{gate, action, edit?, targetPhase?, comment?, choice?}` 决策协议，供兼容 CLI、恢复和审计使用；普通 Web 构建默认自动处理，不把这套协议暴露给用户。

如果设置 `OPENROUTER_API_KEY`，解析与规划会调用 `OPENROUTER_BASE_URL`（默认 `https://openrouter.ai/api/v1`）上的 `OPENROUTER_MODEL`（默认 `nvidia/nemotron-3-ultra-550b-a55b:free`）。没有密钥时使用本地确定性规划器，不会假装调用模型。

## 架构（模块 → 复用来源）

| 模块 | 说明 | 复用 |
|---|---|---|
| core/ | 错误/日志/原子存储/typed 事件总线 | pi event-bus 模式移植 |
| federation/ | 8 源联邦检索 + trust 评分 + 技能矿提炼 | mcp.so/modelcontextprotocol/ModelScope/Cline/Awesome/skills.sh/SkillsMP/腾讯SkillHub |
| orchestrator/ | 8 状态机 + 五闸门挂起/断点续跑 | —（含 45+ pi 扩展示例参照） |
| gates/ | 闸门框架 + 视图（TUI/Web 共用渲染）+ 虚拟用户 | @earendil-works/pi-tui |
| execution/ | 集群调度/安装器/调用器/修复回路/GoalLoop/PersistentGoalLoop/reactor 桥 | pi-subagents 契约、pi-mcp-adapter、pi-reactor；GoalLoop 保留 pi-agent-loop 语义参考 |
| acceptance/ | 三层验收（组件/任务+LLM judge/泛化） | — |
| distill/ scenario/ | 升维四变换 + 场景库（命中三档/漂移/治理） | — |
| memory/ | 会话/场景/知识三层 + BM25 检索 | context-mode ContentStore |
| panel/ | HTTP+WS 场景工作台（工作/构建双模式） | @earendil-works/pi-web-ui 数据形态 |

面板默认不会自动启动 `pi-reactor` 守护进程；`reactor-bridge` 与本地 webhook 仍需显式装配。面板已经接入 `PersistentGoalLoop`：新建对话时选择一个已固化场景并勾选“将下一条需求作为长程场景运行”，即可创建绑定 workspace/project/session/scenario 的持久化长程记录，按 1–50 轮运行，并在检查台暂停、继续或停止。每轮会写入检查点和产物，进程重启后运行中的记录会安全恢复为可继续的暂停状态。面板里的后台任务仍是独立调度器：`once`、`every`、每日 `HH:mm` 和 `event:*` 会分别启动独立工作运行，不会冒充同一个长程会话。

运行中可在输入框发送引导，普通场景会在下一个步骤生效，长程场景会在下一轮生效；当前 Provider 请求不会被强行篡改。场景构建阶段仍只验证流程定义，不执行外部工具；启用的远程 MCP 连接器会在构建检索时读取 `tools/list` 并作为项目能力候选。CLI/git 能力只有在声明 `hostExecution` 合约且宿主注入命令 allow-list、项目/工作区根目录和（可选）安装目录后才会执行；命令通过 `shell:false` 启动，输入只能绑定为显式 argv 参数，并受超时和输出大小上限约束。缺少该合约或宿主策略时仍返回 delegated，系统不会把交接说明伪报成执行成功。

工作模式还提供三个受边界保护的内置项目工具：列出已索引文件、读取项目内文本、写入项目内文本。写入必须先在工作区权限面板开启 `write`，路径始终限制在当前绑定的真实项目目录内；模型不能通过这些工具执行任意 shell 命令。

### CLI/Git 宿主执行策略

面板启动器默认关闭 CLI/Git 宿主执行。要显式开启，必须由受信任的宿主进程在启动前注入 `SCENARIO_HOST_ALLOWED_COMMANDS`，例如 `safe-tool,another-tool`；命令名只能是可执行文件 basename，不能包含路径、shell 片段或通配符。项目工作目录来自当前项目的真实绑定目录，工作区和安装目录可分别通过 `SCENARIO_HOST_WORKSPACE_ROOT`、`SCENARIO_HOST_INSTALL_ROOT` 注入，且必须是绝对路径。`SCENARIO_HOST_MAX_TIMEOUT_MS`（100–120000）和 `SCENARIO_HOST_MAX_OUTPUT_BYTES`（1024–1000000）可进一步收紧上限。未配置 allow-list、路径不是绝对路径或任一值非法时，策略整体保持关闭，面板快照的 `hostExecution.error` 会显示原因。

环境变量只提供宿主策略，不能把目录条目或模型输入变成命令。能力目录仍须携带显式 `hostExecution` 合约（静态 argv、声明式输入 flag、project/workspace/install 作用域）；调用器始终使用 `shell:false`、根目录约束、超时/输出上限和权限门控。当前生产启动器没有默认命令 allow-list，因此普通安装不会执行任意 CLI/Git，仍会返回 `delegated` 并把原因写入执行结果。

完整设计见 [ARCHITECTURE.md](./ARCHITECTURE.md)；自主决策留痕见 [DECISIONS.md](./DECISIONS.md)。

## 测试

```bash
npm test            # 单测/集成/e2e；外网 smoke 用例按 fixture/环境执行
npm run coverage    # 覆盖率报告
npm run bundle      # 重建 pi 包内核
```

## 复用致谢

- [earendil-works/pi](https://github.com/earendil-works/pi)（MIT）— 事件总线模式、TUI 组件、扩展机制、auth-storage 原子写模式
- 实际运行时生态包：pi-subagents / pi-mcp-adapter / pi-reactor（MIT）、context-mode（Elastic-2.0）。GoalLoop 等模块只复用过往 Pi 语义参考，未作为运行时依赖安装。
- MCP 目录源：mcp.so、modelcontextprotocol/servers、ModelScope、Cline Marketplace、punkpeye/awesome-mcp-servers；技能源：skills.sh、SkillsMP、腾讯 SkillHub
- 技能经验 fixture：anthropics/skills

## 已知限制

见 [CHANGELOG.md](./CHANGELOG.md) 附录。
