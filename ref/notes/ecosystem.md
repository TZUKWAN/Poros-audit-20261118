# 生态包笔记（P.2.4）

> 8 包全部安装成功。注意：pi 系扩展包多数以 TS 源码或"面向 pi ExtensionAPI 的扩展"形态发布，消费方式逐包标注。license 均为 MIT（context-mode 为 Elastic-2.0，允许商用、需保留许可声明）。

## 1. pi-subagents@0.73.1（MIT）— 子Agent集群（阶段四 4.1）
- **形态**：编译 JS + d.ts，默认导出 `registerSubagentExtension(pi: ExtensionAPI): void`；另暴露 16 个子路径 API（`pi-subagents/delegation`、`/agents`、`/inspectors`、`/control-channel`、`/preflight`、`/background-work`、`/capability-ceiling` 等）。
- **配置**：随 pi 扩展注册启用；委派由 LLM 经其注册的工具发起，程序化控制走子路径 API。
- **集成点**：并行 DAG 节点 → 分组 worker 委派；`/preflight` 做执行前约束检查；`/inspectors` 订阅 worker 状态（集群监控事件源）。
- **最小示例**：
  ```ts
  import registerSubagents from "pi-subagents";
  import { delegation } from "pi-subagents/delegation";
  // 在 pi 扩展入口： registerSubagents(pi);
  ```

## 2. pi-mcp-adapter@3.2.0（MIT）— MCP 接入（阶段四 4.2.2）
- **形态**：入口 "." 为 TS 源码（供 pi 扩展加载器）；**dist/ 全量编译产物**，可用子路径：`./types`（dist/types.js）、`./config`、`./metadata-cache`、`./oauth`、`./host-managed`。核心运行时 `dist/server-manager.js`（ServerManager：`connect(name, definition, signal) → ServerConnection{status: connected|closed|needs-auth}`，工具刷新 ToolRefreshResult）。
- **配置**：MCP 配置 JSON（全局/项目路径经 `getPiGlobalConfigPath/getProjectConfigPath`）。
- **集成点**：CapabilityRuntime.invoke 对 MCP 类能力 → ServerManager.connect + 调用；config 子路径读写服务器条目。
- **最小示例**：
  ```ts
  import { loadMcpConfig } from "pi-mcp-adapter/config";      // 编译产物
  import type { McpConfig, ServerEntry } from "pi-mcp-adapter/types";
  ```

## 3. pi-agent-loop@0.1.1（MIT）— 循环/目标模式（阶段四 4.3.1）
- **形态**：TS 源码小包（index.ts 180 行 / state.ts 173 / tool.ts 157）。三模式：`/loop goal`（LLM 判定达成）、`/loop passes N`、`/loop pipeline s1|s2|s3`；`loop_control` 工具供 LLM 报告进度/完成；Ctrl+Shift+X 中止。
- **配置**：作为 pi 扩展注册；loop 参数来自命令行。
- **集成点**：目标模式引擎；vendored 复制进 `src/vendor/pi-agent-loop/`（改 import 到本项目 ExtensionAPI 形态，保留 MIT 头），逐轮放行 hook 挂在轮间。
- **最小示例**：`/loop goal "达成X" --max-rounds 5`（运行时形态）；vendored 后 `createLoopState(mode, params)`。

## 4. pi-loop-designer@0.1.0（MIT）— 循环设计器
- **形态**：extensions/ + prompts/ + skills/ 资源包（无编译 JS）。
- **集成点**：其 prompt/skill 资源作为"设计循环"的提示词素材，服务于目标模式参数预演；按数据文件复用（不进运行时依赖图）。

## 5. pi-reactor@0.2.3（MIT）— 长驻触发（阶段四 4.3.3）
- **形态**：独立守护进程，`bin: pi-reactor → dist/cli.js`。命令：`webhook [--port 8787]`、`trigger add <id> --schedule <cron> --agent <a> --task <t>`、`trigger ls|rm`、`resume`。架构 `sources(cron·webhook·CLI) → daemon(queue·gates·spawn pi) → sinks`。
- **配置**：CLI 管理 trigger；无侵入。
- **集成点**：目标模式 cron/webhook 触发 → spawn 本项目 CLI（触发后注销用 `trigger rm`）。
- **最小示例**：`npx pi-reactor trigger add demo --schedule "* * * * *" --agent scenario --task "..."`。

## 6. context-mode@1.0.169（Elastic-2.0）— Memory 检索（阶段七 7.4）
- **形态**：编译 JS（build/）+ CLI（cli.bundle.mjs）。默认导出插件工厂 `createContextModePlugin`，另有 `systemHasRoutingInstructions`、`ROUTING_MARKERS`；内部含 db-base（SQLite）、executor、fetch-cache 等。
- **配置**：插件形态适配器（opencode/openclaw 等）；存储为其 db 层。
- **集成点**：知识 Memory 检索（SQLite+BM25）；写 5 条→检索命中用例（7.4.b）直接走其 db API。
- **最小示例**：
  ```ts
  import { ContextModePlugin } from "context-mode"; // 工厂 + 路由标记
  ```

## 7. pi-hermes-memory@0.9.9（MIT）— 记忆扩展参考
- **形态**：TS 源码扩展（src/index.ts 入口；config/paths/project/handlers 等模块）。
- **集成点**：**模式参考与 vendored 候选**：其 memory 文件树组织（7.5 数据接口）、secret 扫描（R2.3 安全审查）借鉴其设计；运行时加载经 pi 扩展加载器。

## 8. rpiv-todo@1.1.0（MIT）— 任务清单持久化与 overlay
- **形态**：TS 源码扩展（index.ts 54 / todo.ts 888 / todo-overlay.ts 221）。
- **集成点**：闸门2 任务清单的 overlay 交互参照 + BuildContext.tasks 的落盘格式参照；vendored 复制其 overlay 组件改造为 DAG 列表编辑器（3.2.2）。

## 消费方式决策（对应 DECISIONS D5）
| 包 | 消费方式 |
|---|---|
| pi-subagents、context-mode、pi-mcp-adapter(子路径)、pi-web-ui、pi-ai、pi-agent-core、pi-tui | npm 直接 import（编译产物） |
| pi-agent-loop、rpiv-todo | vendored 复制（MIT 保留头，改 import） |
| pi-loop-designer | 数据资源复用 |
| pi-reactor | 子进程 CLI 集成 |
| pi-hermes-memory | 设计参考 + 运行时经 pi 加载器 |
