import { EventEmitter } from "node:events";

/**
 * typed 事件总线 —— 移植自 pi coding-agent event-bus.ts（MIT），扩展：
 *  1. typed channels：事件表 TEvents 限定 channel 名与载荷类型；
 *  2. 通配订阅：onAny 捕获全部事件（审计/面板快照用）；
 *  3. 订阅者异常隔离：单个 handler 抛错不影响其他订阅者（pi 语义保留）。
 */
export type EventHandler<T> = (data: T) => void | Promise<void>;
export type Unsubscribe = () => void;

export const WILDCARD = "*";

export interface EventBus<TEvents extends Record<string, unknown>> {
  emit<K extends keyof TEvents & string>(channel: K, data: TEvents[K]): void;
  on<K extends keyof TEvents & string>(channel: K, handler: EventHandler<TEvents[K]>): Unsubscribe;
  /** 订阅全部事件（含未来新增 channel），回调收到 [channel, data] */
  onAny(handler: EventHandler<[string, unknown]>): Unsubscribe;
  once<K extends keyof TEvents & string>(channel: K, handler: EventHandler<TEvents[K]>): Unsubscribe;
  waitFor<K extends keyof TEvents & string>(channel: K, predicate?: (data: TEvents[K]) => boolean, timeoutMs?: number): Promise<TEvents[K]>;
  listenerCount(channel?: string): number;
  clear(): void;
}

export function createEventBus<TEvents extends Record<string, unknown>>(): EventBus<TEvents> {
  const emitter = new EventEmitter();
  // EventEmitter 默认 >10 监听器告警；总线场景（面板+审计+状态机）常超限
  emitter.setMaxListeners(0);

  function wrap<K extends keyof TEvents & string>(
    channel: K,
    handler: EventHandler<TEvents[K]>,
  ): (data: unknown) => void {
    return (data: unknown) => {
      void (async () => {
        try {
          await handler(data as TEvents[K]);
        } catch (err) {
          // pi 语义：订阅者异常只记录不传播，单个坏订阅者不影响其他订阅者
          process.stderr.write(`event handler error (${channel}): ${err instanceof Error ? err.message : String(err)}\n`);
        }
      })();
    };
  }

  return {
    emit: (channel, data) => {
      emitter.emit(channel, data);
      emitter.emit(WILDCARD, [channel, data]);
    },
    on: (channel, handler) => {
      const safe = wrap(channel, handler);
      emitter.on(channel, safe);
      return () => emitter.off(channel, safe);
    },
    onAny: (handler) => {
      const safe = wrap(WILDCARD, handler as EventHandler<unknown>);
      emitter.on(WILDCARD, safe);
      return () => emitter.off(WILDCARD, safe);
    },
    once: (channel, handler) => {
      const safe = wrap(channel, handler);
      emitter.once(channel, safe);
      return () => emitter.off(channel, safe);
    },
    waitFor: <K extends keyof TEvents & string>(
      channel: K,
      predicate?: (data: TEvents[K]) => boolean,
      timeoutMs?: number,
    ): Promise<TEvents[K]> =>
      new Promise<TEvents[K]>((resolve, reject) => {
        let off: Unsubscribe = () => {};
        const timer =
          timeoutMs !== undefined
            ? setTimeout(() => {
                off();
                reject(new Error(`waitFor(${String(channel)}) timed out after ${timeoutMs}ms`));
              }, timeoutMs)
            : undefined;
        const cleanup = () => {
          off();
          if (timer) clearTimeout(timer);
        };
        const handler = (data: TEvents[K]) => {
          try {
            if (predicate && !predicate(data)) return; // 不满足则继续等待
          } catch (err) {
            cleanup();
            reject(err instanceof Error ? err : new Error(String(err)));
            return;
          }
          cleanup();
          resolve(data);
        };
        emitter.on(channel, handler as (data: unknown) => void);
        off = () => emitter.off(channel, handler as (data: unknown) => void);
      }),
    listenerCount: (channel) =>
      channel === undefined ? emitter.eventNames().reduce((n, e) => n + emitter.listenerCount(e), 0) : emitter.listenerCount(channel),
    clear: () => emitter.removeAllListeners(),
  };
}
