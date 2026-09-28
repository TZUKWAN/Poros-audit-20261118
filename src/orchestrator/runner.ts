import { Orchestrator, type GateDecision, type OrchestratorDeps, type WorkState } from "./state-machine.js";
import {
  handleAssembling,
  handleDistilling,
  handleExecuting,
  handleParsing,
  handlePlanning,
  handleRetrieving,
  handleVerifying,
  type HandlerDeps,
} from "./handlers.js";
import type { BuildContext } from "./context.js";
import type { BuildStore } from "./build-store.js";
import type { EventBus } from "@/core/events.js";
import type { VirtualUser } from "../../tests/virtual-user/driver.js";

/**
 * 编排运行器：装配 状态机 + 阶段处理器 + 断点持久化 + （可选）虚拟用户驱动。
 * TUI/Web 面板后续接入同一 runOrchestrator，只是决策源不同（真人 vs 虚拟用户）。
 */

export interface RunnerOptions {
  handlerDeps: HandlerDeps;
  store: BuildStore;
  events?: EventBus<Record<string, unknown>>;
  now?: () => Date;
}

export function createOrchestrator(options: RunnerOptions, restored?: BuildContext): Orchestrator {
  const deps: OrchestratorDeps = {
    handlers: {
      parsing: (ctx) => handleParsing(ctx, options.handlerDeps),
      planning: (ctx) => handlePlanning(ctx, options.handlerDeps),
      retrieving: (ctx) => handleRetrieving(ctx, options.handlerDeps),
      assembling: (ctx) => handleAssembling(ctx, options.handlerDeps),
      verifying: (ctx) => handleVerifying(ctx, options.handlerDeps),
      executing: (ctx) => handleExecuting(ctx, options.handlerDeps),
      distilling: (ctx) => handleDistilling(ctx, options.handlerDeps),
    },
    persist: (ctx) => options.store.save(ctx),
    events: options.events,
    now: options.now,
  };
  return restored ? Orchestrator.restore(restored, deps) : new Orchestrator(deps);
}

/**
 * 把虚拟用户接到编排器：gate:pending → 策略决策 → decide()。
 * 返回退订函数（真实人工 UI 接入时替换此适配层即可）。
 */
export function attachVirtualUser(orchestrator: Orchestrator, user: VirtualUser): () => void {
  return orchestrator.on("gate:pending", ({ request }) => {
    const decision: GateDecision = user.decide(request.gate, request.payload);
    void orchestrator.decide(decision).catch(() => {
      // 决策非法（如 reject 目标非法）：记录后不再重试——由测试断言捕获
    });
  });
}

export type { WorkState };
