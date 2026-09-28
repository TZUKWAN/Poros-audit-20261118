# 笔记 1/5：Pi 事件总线模式（event-bus）

来源：`ref/pi/packages/coding-agent/src/core/event-bus.ts`（全文 33 行，MIT）

## 可直接照用的实现

```ts
import { EventEmitter } from "node:events";

export interface EventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}
export interface EventBusController extends EventBus {
  clear(): void;
}

export function createEventBus(): EventBusController {
  const emitter = new EventEmitter();
  return {
    emit: (channel, data) => emitter.emit(channel, data),
    on: (channel, handler) => {
      const safeHandler = async (data: unknown) => {
        try { await handler(data); }
        catch (err) { console.error(`Event handler error (${channel}):`, err); }
      };
      emitter.on(channel, safeHandler);
      return () => emitter.off(channel, safeHandler);
    },
    clear: () => emitter.removeAllListeners(),
  };
}
```

## 模式要点（本项目 0.2.4 移植时保留的语义）
1. **on 返回退订函数**（`() => void`），不暴露 emitter 本体。
2. **订阅者异常被吞并打日志**——单个坏订阅者不阻塞其他订阅者（0.2.4.b 用例直接对应）。
3. handler 支持 `await`（async handler 顺序触发，EventEmitter 的 emit 是同步派发，safeHandler 内部 await）。
4. `clear()` 用于会话级生命周期清理。
5. channel 为 string（本项目升级为 typed events + 通配订阅：用 `Map<channel, Set<handler>>` 或 EventEmitter 天然无通配 → 需自实现 `*`/前缀匹配层）。

## 本项目适配点（阶段零 0.2.4）
- typed events：`EventBus<TEvents extends Record<string, unknown>>` 泛型化，`on<K extends keyof TEvents>(ch: K, h: (d: TEvents[K]) => void)`。
- 通配订阅：`on("*", h)` 捕获全部事件（自实现，EventEmitter 不支持模式匹配）。
- 状态机挂接：`state.enter/exit` 时 `emit("state:enter", {from, to, ts})`。
