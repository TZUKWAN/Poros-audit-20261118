# ARCHITECTURE.md — 场景Agent系统（pi-scenario）架构

> 依据 P.2.5：模块图 + 每模块复用来源标注。v1.0 初稿，随阶段推进修订。

## 系统定位
基于 Pi（earendil-works/pi）生态构建的"自构建 Agent"：把一句话需求经 **五道闸门** 的人类（或虚拟用户）决策，构建成可复用、可漂移修复的 **场景（Scenario）**；执行底座复用 Pi 官方运行时（LLM 循环/子Agent/MCP/TUI/Web）。

## 模块图

```
┌────────────────────────── pi-scenario（Pi 扩展包 + 可独立 CLI） ──────────────────────────┐
│                                                                                          │
│  ┌─ 内核 orchestrator/ ────────────────────────────────────────────────────────────┐    │
│  │ 状态机(8态) BuildContext(zod) 闸门挂起/恢复 断点持久化                            │    │
│  │ 复用: pi event-bus 模式(ref/notes/event-bus) + auth-storage 原子写模式           │    │
│  └──────────────────────────────────────────────────────────────────────────────────┘    │
│      │ 阶段处理器: parsing→planning→retrieving→assembling→verifying→executing→distilling │
│      │   LLM: @earendil-works/pi-ai（意图解析/judge，模板降级）                           │
│      ▼                                                                                   │
│  ┌─ 联邦层 federation/ ────────────────────────────────────────────────────────────┐    │
│  │ Capability 统一模型 + Trust 评分 + 8源适配器扇出(去重/排序/缓存/探活)             │    │
│  │ 源: mcp.so · modelcontextprotocol/servers · ModelScope · Cline · Awesome-MCP     │    │
│  │    · skills.sh · SkillsMP · 腾讯SkillHub(技能=经验矿: 检索→克隆→提炼→删除)        │    │
│  │ 复用: pi-mcp-adapter/dist 子路径(探活与调用)、自研适配器(fixture 驱动)            │    │
│  └──────────────────────────────────────────────────────────────────────────────────┘    │
│      ▼                                                                                   │
│  ┌─ 闸门 gates/ ──────────────────────────────────────────────────────────────────┐     │
│  │ Gate 协议(zod) ×5: 意图确认→任务清单→能力选型→装配验收→固化评审                  │     │
│  │ TUI: @earendil-works/pi-tui (overlay/select-list/editor/box) — 3.2              │     │
│  │ Web: pi-web-ui renderer 注册 + 自有面板服务 — 8.4                               │     │
│  │ 决策: GateDecision(approve|reject{targetPhase,comment}) → approvals[]            │     │
│  │ 测试决策源: tests/virtual-user/driver.ts（策略化 GateDecision）                  │     │
│  └──────────────────────────────────────────────────────────────────────────────────┘    │
│      ▼                                                                                   │
│  ┌─ 执行 execution/ ──────────────────────────────────────────────────────────────┐     │
│  │ 子Agent集群: pi-subagents(delegation/inspectors/preflight 子路径) — 4.1          │     │
│  │ 能力运行时: 安装器(npx/CLI/git/远程) + invoke(MCP→pi-mcp-adapter ServerManager,  │     │
│  │            skill→上下文注入, 远程→HTTP) + 权限(beforeToolCall 审批) — 4.2        │     │
│  │ 循环引擎: vendored pi-agent-loop(goal/passes/pipeline) + 逐轮放行 hook — 4.3     │     │
│  │ 长驻触发: pi-reactor 子进程(cron/webhook → spawn 本项目 CLI) — 4.3.3             │     │
│  └──────────────────────────────────────────────────────────────────────────────────┘    │
│      ▼                                                                                   │
│  ┌─ 验收 acceptance/ ──────────────────────────┐  ┌─ 蒸馏 distill/ + 场景库 scenario/ ┐  │
│  │ 组件级(探活+schema+延迟) 任务级(规则+LLM     │  │ 升维四变换: 槽位化/分支化/验收泛化/ │  │
│  │ judge) 泛化(≥2组换参实测) 报告归因           │  │ 意图签名(嵌入+关键词)              │  │
│  └─────────────────────────────────────────────┘  │ 场景库: 命中三档/填槽执行/漂移修复  │  │
│                                                   │ stats 治理(uses/成功率/降级标)     │  │
│  ┌─ memory/ 三层 ──────────────────────────────┐  └───────────────────────────────────┘  │
│  │ 会话(全轨迹MD) 场景(复用追加) 知识(drift经验) │                                        │
│  │ 检索: context-mode(SQLite+BM25)              │                                        │
│  └──────────────────────────────────────────────┘                                        │
│      ▼                                                                                   │
│  ┌─ panel/ Web 面板 ───────────────────────────────────────────────────────────────┐    │
│  │ HTTP+WS 快照+增量；三栏(DAG/集群/注册表+Memory+场景库)；五闸门 Web 视图            │    │
│  └──────────────────────────────────────────────────────────────────────────────────┘    │
│  ┌─ core/（阶段零骨架）─────────────────────────────────────────────────────────────┐   │
│  │ errors(ScenarioError) log(分级+落盘) store(JSON原子写 ~/.pi/scenario/)            │   │
│  │ events(typed+通配总线, 移植 pi event-bus)                                        │   │
│  └──────────────────────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

## 复用来源标注（每模块）
| 模块 | 复用来源 | 方式 |
|---|---|---|
| core/events | pi coding-agent event-bus.ts | 移植+typed/通配扩展 |
| core/store | pi coding-agent auth-storage.ts 模式 | 照模式自实现 |
| orchestrator/LLM 调用 | @earendil-works/pi-ai | npm 依赖 |
| execution/子Agent | pi-subagents 子路径 API | npm 依赖 |
| execution/MCP | pi-mcp-adapter dist 子路径 | npm 依赖 |
| execution/循环 | pi-agent-loop | vendored（MIT 保留头） |
| execution/长驻触发 | pi-reactor | 子进程 CLI |
| gates/TUI | @earendil-works/pi-tui | npm 依赖 |
| panel/前端 | @earendil-works/pi-web-ui | npm 依赖 |
| memory/检索 | context-mode | npm 依赖 |
| 任务清单格式 | rpiv-todo | vendored 参照 |
| 记忆文件组织 | pi-hermes-memory | 设计参考 |
| 循环提示词素材 | pi-loop-designer | 数据资源 |

## 关键数据流
1. 需求 → parsing(意图+槽位) →【闸门1】→ planning(DAG) →【闸门2】→ retrieving(8源 top5 + 技能矿) → assembling(流水线图) →【闸门3】→ verifying(探活) →【闸门4】→ executing(集群) → 任务级验收 → distilling(升维) →【闸门5】→ Scenario 入库。
2. 复用：新需求 → 意图签名匹配场景库 → 命中(填槽直跑)/部分命中(基底+闸门3局部重选)/未命中(全流程)。
3. 漂移：复用前探活失败 → drift 事件 → 局部换型(trust 次优) → 版本+1 → 知识 Memory 记经验。
