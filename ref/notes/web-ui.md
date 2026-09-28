# 笔记 5/5：pi-web-ui Web 面板复用点

来源：npm 包 `@earendil-works/pi-web-ui@0.75.3`（dist/ 编译产物 JS+d.ts，直接 import 可用；主入口 `dist/index.js` + `dist/app.css`）

## 定位
"Reusable web UI components for AI chat interfaces powered by @earendil-works/pi-ai"。浏览器端组件库（非服务端），面板服务（阶段八 8.1 HTTP+WS）由本项目自建，前端页面复用本包组件。

## 导出面（index.d.ts）
```ts
export { ChatPanel } from "./ChatPanel.js";                    // 完整聊天面板（组合件）
export { AgentInterface } from "./components/AgentInterface.js"; // Agent 交互界面
export { MessageList, MessageEditor, Messages, StreamingMessageContainer } from "...";
export { getMessageRenderer, registerMessageRenderer, renderMessage } from "./components/message-renderer-registry.js";
// ↑ 自定义渲染器注册点：DAG 节点消息 / 闸门卡片 / 集群事件 用自定义 renderer 注入
export { ExpandableSection, Input, ConsoleBlock, AttachmentTile } from "...";
export { ToolMessage, UserMessage, AssistantMessage, AbortedMessage } from "./components/Messages.js";
export type { Agent, AgentMessage, AgentState, ThinkingLevel } from "@earendil-works/pi-agent-core";
```

## 子目录
- `components/`：AgentInterface、MessageList、MessageEditor、message-renderer-registry、SandboxedIframe 等
- `dialogs/`：对话弹窗基件
- `prompts/`、`storage/`、`tools/`、`utils/`：支撑件

## 本项目集成方式（阶段八）
1. 三栏布局为自有页面；中栏流水线/集群区用自定义 DOM（非聊天流）。
2. 对话栏复用 MessageEditor + MessageList + renderMessage 管线。
3. 闸门 Web 视图（8.4）：注册自定义 messageRenderer 渲染 GateCard（approve/reject 按钮 → WS 发 GateDecision），与 TUI 决策协议同一 zod schema。
4. 状态推送：面板服务维护全量快照 + 增量事件（复用本项目事件总线），断线重连后先发快照再补增量（8.1.b 用例）。
5. 构建：页面用 esbuild/vite 打包，`app.css` 直接引入。
