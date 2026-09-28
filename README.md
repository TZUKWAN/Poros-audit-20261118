# pi-scenario — 场景Agent系统（基于 Pi 的自构建 Agent）

一句话需求 → **五道闸门** 决策 → 自动装配能力（MCP/CLI/远程/技能）→ 集群执行 → 三层验收 → **蒸馏固化为可复用场景**；下次相似需求命中即秒级复用，能力漂移自动换型修复。

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

```ts
import { PanelServer } from "./src/panel/server.js";
const panel = new PanelServer({ orchestrator, library, controller, memoryRoot });
const port = await panel.start(3000);   // http://127.0.0.1:3000 三栏面板 + WS
```

## 五道闸门

| # | 闸门 | 决策 | 驳回回退 |
|---|---|---|---|
| 1 | 意图确认 | 批准/逐项编辑槽位/驳回 | 重解析 |
| 2 | 任务清单 | 批准/增删节点/改依赖（环即时提示） | 重规划 |
| 3 | 能力选型 | 单选/换批/自定义（候选卡片含来源徽章/trust/风险标） | 重检索 |
| 4 | 装配与验收 | 批准/改验收标准（流水线图+胶水标注） | 重装配 |
| 5 | 固化评审 | pin（入库）/ rerun / discard | — |

决策协议：`{gate, action: approve|reject, targetPhase?, comment?}`——TUI、Web 面板、虚拟用户驱动器三方共用同一 zod schema。

## 架构（模块 → 复用来源）

| 模块 | 说明 | 复用 |
|---|---|---|
| core/ | 错误/日志/原子存储/typed 事件总线 | pi event-bus 模式移植 |
| federation/ | 8 源联邦检索 + trust 评分 + 技能矿提炼 | mcp.so/modelcontextprotocol/ModelScope/Cline/Awesome/skills.sh/SkillsMP/腾讯SkillHub |
| orchestrator/ | 8 状态机 + 五闸门挂起/断点续跑 | —（含 45+ pi 扩展示例参照） |
| gates/ | 闸门框架 + 视图（TUI/Web 共用渲染）+ 虚拟用户 | @earendil-works/pi-tui |
| execution/ | 集群调度/安装器/调用器/修复回路/GoalLoop/reactor 桥 | pi-subagents 契约、pi-mcp-adapter、pi-agent-loop 语义、pi-reactor |
| acceptance/ | 三层验收（组件/任务+LLM judge/泛化） | — |
| distill/ scenario/ | 升维四变换 + 场景库（命中三档/漂移/治理） | — |
| memory/ | 会话/场景/知识三层 + BM25 检索 | context-mode ContentStore |
| panel/ | HTTP+WS 三栏面板 | @earendil-works/pi-web-ui 数据形态 |

完整设计见 [ARCHITECTURE.md](./ARCHITECTURE.md)；自主决策留痕见 [DECISIONS.md](./DECISIONS.md)。

## 测试

```bash
npm test            # 330+ 测试（单测/集成/e2e；唯一可跳过类=标记 smoke 的外网用例）
npm run coverage    # 覆盖率报告
npm run bundle      # 重建 pi 包内核
```

## 复用致谢

- [earendil-works/pi](https://github.com/earendil-works/pi)（MIT）— 事件总线模式、TUI 组件、扩展机制、auth-storage 原子写模式
- pi 生态包：pi-subagents / pi-mcp-adapter / pi-agent-loop / pi-loop-designer / pi-reactor / rpiv-todo / pi-hermes-memory（MIT）、context-mode（Elastic-2.0）
- MCP 目录源：mcp.so、modelcontextprotocol/servers、ModelScope、Cline Marketplace、punkpeye/awesome-mcp-servers；技能源：skills.sh、SkillsMP、腾讯 SkillHub
- 技能经验 fixture：anthropics/skills

## 已知限制

见 [CHANGELOG.md](./CHANGELOG.md) 附录。
