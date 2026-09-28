# 笔记 3/5：agent 包（@earendil-works/pi-agent-core）工具调用循环与状态管理

来源：`ref/pi/packages/agent/src/{agent-loop.ts, types.ts, agent.ts}`（npm 包 0.87.1，直接依赖）

## 循环入口（agent-loop.ts）
```ts
export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

export function agentLoop(...): ...          // 核心循环生成器
export function agentLoopContinue(...)       // 续跑已有会话
export async function runAgentLoop(...)      // 一次性跑完
export async function runAgentLoopContinue(...)
```

## 工具定义（types.ts）
```ts
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> {
  execute: (toolCallId, params, signal?, onUpdate?, ctx?) => Promise<AgentToolResult<TDetails>>;
  // concurrency: "sequential" | "parallel"（单消息内多工具调用策略）
}
export interface AgentToolResult<T = JsonValue | undefined> { /* output + details */ }
```

## 并发模型（types.ts:40-46 注释）
- `"sequential"`：每个工具调用 prepared→executed→finalized 依次完成。
- `"parallel"`：顺序 preflight，允许的工具并发执行。
- `beforeToolCall` 钩子：参数校验后、执行前调用（**权限审批挂点**，阶段四 4.2.3 复用）。
- `afterToolCall`：返回 `AfterToolCallResult` 可覆盖执行结果（结果回流改写点）。

## 本项目集成点（阶段四）
1. 子Agent worker = 一个 `runAgentLoop` 实例，工具集 = 能力运行时暴露的 invoke 工具；事件经 `AgentEventSink` 桥接到本项目事件总线（`cluster:worker:{started|done|failed}`）。
2. 递归深度=1：worker 的工具清单里不提供"构建场景"工具（4.1.2 拒绝路径）。
3. 循环终止：LLM 无 tool call 即 settle（`agent_settled` 事件语义）。
4. `beforeToolCall` 返回拒绝 = pi-hooks 审批事件实现路径。

## 与 pi-ai 的关系
- pi-ai 提供 `complete`/`stream` 文本生成与结构化输出（zod schema → tool-call 强制模式），供意图解析（2.3.1）与 LLM judge（5.2）使用；降级路径 = 捕获异常后走模板填空。
