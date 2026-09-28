import { createOrchestrator, attachVirtualUser } from "@/orchestrator/runner.js";
import { memoryBuildStore } from "@/orchestrator/build-store.js";
import { handleExecutingReal } from "@/execution/wire-executing.js";
import { CapabilityInvoker } from "@/execution/capability-runtime.js";
import { federatedSearchFactory } from "@/federation/factory.js";

/**
 * 内核统一入口（pi 包加载的表面）：暴露最小 API 给 pi 扩展薄层。
 * pi 运行时内由其 TS 加载器加载 extension.ts，再经此入口驱动完整内核。
 */

export interface RunScenarioOptions {
  requirement: string;
  buildId?: string;
  /** 无人值守（虚拟用户全程批准）；人工模式经闸门回调注入决策 */
  autoApprove?: boolean;
  /** 闸门回调：返回 GateDecision（人工 UI/远程面板接入点） */
  onGate?: (request: unknown) => Promise<{ gate: number; action: "approve" | "reject"; targetPhase?: string; comment?: string }>;
}

export async function runScenario(options: RunScenarioOptions): Promise<unknown> {
  const search = await federatedSearchFactory();
  const invoker = new CapabilityInvoker();
  const deps = {
    handlerDeps: {
      search: (q: string, limit?: number) => search(q, limit),
      execute: (ctx: Parameters<typeof handleExecutingReal>[0]) =>
        handleExecutingReal(ctx, { invoke: (cap, action, inputs) => invoker.invoke(cap, action, inputs) }),
    },
    store: memoryBuildStore(),
  };
  const orchestrator = createOrchestrator(deps);
  if (options.autoApprove !== false && !options.onGate) {
    const { VirtualUser } = await import("@/gates/virtual-user.js");
    attachVirtualUser(orchestrator, new VirtualUser({ kind: "approve-all" }));
  }
  orchestrator.start(options.requirement, options.buildId);
  const final = await orchestrator.run();
  return { id: final.id, phase: final.phase, selections: final.selections, approvals: final.approvals.length };
}
