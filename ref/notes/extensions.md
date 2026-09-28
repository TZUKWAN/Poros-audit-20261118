# 笔记 2/5：扩展加载与 ExtensionAPI 形态

来源：`ref/pi/packages/coding-agent/src/core/extensions/{types.ts(1972行), loader.ts(799行)}`

## ExtensionAPI 核心 surface（types.ts:1365）
```ts
export interface ExtensionAPI {
  // 1. 事件订阅（45+ 种事件，on(event, handler) => 退订函数）
  on(event: "agent_start", handler: ExtensionHandler<AgentStartEvent>): () => void;
  on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): () => void;
  on(event: "session_before_compact", ...): () => void;
  on(event: "input", handler: ExtensionHandler<InputEvent, InputEventResult>): () => void;
  // handler 签名：ExtensionHandler<E, R = void> = (event, ctx) => Promise<R> | R

  // 2. 工具注册
  registerTool<TParams extends TSchema, TDetails, TState>(tool: ToolDefinition<TParams, TDetails, TState>): void;

  // 3. 命令/快捷键/flag 注册
  registerCommand(name: string, options: Omit<RegisteredCommand, "name"|"sourceInfo">): void;
  registerShortcut(shortcut: KeyId, options: { description?: string; handler: (ctx) => Promise<void>|void }): void;

  // 4. UI（ctx 上）
  // ctx.ui.setEditorComponent((tui, theme, keybindings) => Component)
  // ctx.setWidget(key: string, content: string[] | undefined, options?: ExtensionWidgetOptions): void
}
```

## 关键事件（闸门/TUI/执行干预复用点）
| 事件 | 用途 |
|---|---|
| `input` / `input_transform` | 拦截用户输入（闸门命令 `/gate approve` 解析） |
| `tool_call` / `tool_result` | 工具级权限审批（闸门执行期干预） |
| `turn_start` / `turn_end` | 逐轮放行 hook 挂点（目标模式） |
| `agent_start` / `agent_end` | 集群监控事件源 |
| `session_before_compact` | Memory 写入时机 |

## 加载器（loader.ts）要点
- 扩展 = 单 .ts/.js 文件或目录（含 index.ts）；pi 自带 TS 运行时剥离加载器（node_modules 下不支持 type stripping → TS 源码生态包必须由 pi 扩展加载器加载或 vendored 编译）。
- 扩展导出形如 `export default function (pi: ExtensionAPI) { ... }`。
- 上下文对象 `ctx: ExtensionContext`（types.ts:1888 注释列出 ctx.* actions：sendUserMessage / setWidget / ui.showOverlay 等）。
- **生态包消费结论**：pi-mcp-adapter / pi-hermes-memory / pi-agent-loop / rpiv-todo 的 main 均指向 .ts 源码 → 运行时经 pi 扩展加载器加载；作为普通 npm 库复用时：有 dist 子路径的用子路径（mcp-adapter/types、/config、/metadata-cache），小型的 vendored 复制（MIT，保留版权头，改 import 指向 @earendil-works/*）。

## auth-storage.ts 模式（本任务清单指定复用）
- 506 行：JSON 文件存储 + 原子写入 + 权限校验 + 迁移逻辑；本项目 `core/store.ts` 照此模式（tmp+rename 原子写）。
