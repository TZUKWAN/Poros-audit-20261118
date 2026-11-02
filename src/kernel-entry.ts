import path from "node:path";
import { createOrchestrator, attachVirtualUser } from "@/orchestrator/runner.js";
import { memoryBuildStore } from "@/orchestrator/build-store.js";
import { jsonStore, scenarioDataRoot } from "@/core/store.js";
import { handleExecutingReal } from "@/execution/wire-executing.js";
import { CapabilityInvoker } from "@/execution/capability-runtime.js";
import { federatedSearchFactory } from "@/federation/factory.js";
import { distill } from "@/distill/distill.js";
import { intentSignature } from "@/distill/distill.js";
import { createConfiguredPlanner } from "@/orchestrator/planner.js";
import { IntentSchema, type BuildContext } from "@/orchestrator/context.js";
import type { GateDecision, GateRequest } from "@/orchestrator/state-machine.js";
import { ScenarioLibrary, ScenarioRecordSchema, recordFromDistilled, scenarioNameFromRequirement } from "@/scenario/library.js";
import { tryReuseScenario } from "@/scenario/reuse.js";
import { runGeneralization } from "@/scenario/generalization.js";
import type { Capability } from "@/federation/types.js";

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
  onGate?: (request: GateRequest) => Promise<GateDecision>;
  /** 默认保存通过闸门5 pin 的场景；测试/临时调用可关闭。 */
  persistScenario?: boolean;
  /**
   * 只构建并保存场景定义，不调用远程、git、CLI 或 npx 能力。
   * 这是 `/scenario:build` 的默认语义；传 false 才会运行真实执行链。
   */
  constructionOnly?: boolean;
  library?: ScenarioLibrary;
}

export interface ScenarioRunResult {
  id: string;
  phase: string;
  outcome: BuildContext["outcome"];
  selections: BuildContext["selections"];
  approvals: number;
  acceptance: BuildContext["acceptance"];
  trace: BuildContext["trace"];
  distilled: unknown;
  artifacts: { scenarioId?: string };
  /** constructionOnly runs are explicit definitions awaiting a real work run. */
  verification: "untested" | "verified" | "failed";
  constructionOnly: boolean;
}

export async function runScenario(options: RunScenarioOptions): Promise<ScenarioRunResult> {
  const { search } = await federatedSearchFactory();
  const invoker = new CapabilityInvoker();
  const planner = createConfiguredPlanner();
  const library = options.library ?? new ScenarioLibrary({ store: jsonStore({ filePath: path.join(scenarioDataRoot(), "scenarios.json"), schema: ScenarioRecordSchema }) });
  try {
    const parsed = IntentSchema.safeParse(await planner.parseIntent(options.requirement));
    if (parsed.success) {
      const match = await library.match(await intentSignature(parsed.data.goal, parsed.data.keywords));
      if (!options.constructionOnly && match.tier === "hit" && match.scenario) {
        const reused = await tryReuseScenario({ library, scenario: match.scenario, requirement: options.requirement, intent: parsed.data, search, invoker });
        if (reused.handled) {
          const id = `reuse-${Date.now()}`;
          return {
            id,
            phase: "done",
            outcome: reused.ok ? "completed" : "failed",
            selections: [],
            approvals: 0,
            acceptance: [{ layer: "task", passed: reused.ok, detail: { mode: "scenario-reuse", scenarioId: match.scenario.id, score: match.score }, at: new Date().toISOString() }],
            trace: [],
            distilled: match.scenario.distilled,
            artifacts: { scenarioId: match.scenario.id },
            verification: reused.ok ? "verified" : "failed",
            constructionOnly: false,
          };
        }
      }
    }
  } catch {
    // 匹配链路失败时继续完整构建，不牺牲主流程可用性。
  }
  const deps = {
    handlerDeps: {
      llm: planner,
      search: (q: string, limit?: number) => search(q, limit),
      execute: options.constructionOnly
        ? async (ctx: Parameters<typeof handleExecutingReal>[0]) => {
            if (!ctx.assembly) throw new Error("executing without assembly");
            for (const node of ctx.assembly.nodes) {
              ctx.trace.push({
                nodeId: node.nodeId,
                capabilityId: node.capabilityId,
                startedAt: new Date().toISOString(),
                finishedAt: new Date().toISOString(),
                status: "planned",
                output: { mode: "construction", verified: false, message: "仅完成场景定义映射，尚未调用外部能力。" },
              });
            }
            ctx.acceptance.push({
              layer: "task",
              passed: true,
              detail: { mode: "construction", verified: false, nodes: ctx.assembly.nodes.length },
              at: new Date().toISOString(),
            });
          }
        : (ctx: Parameters<typeof handleExecutingReal>[0]) => handleExecutingReal(ctx, { invoke: (cap, action, inputs) => invoker.invoke(cap, action, inputs) }),
      probe: options.constructionOnly
        ? async () => ({ available: true, latencyMs: 0, message: "construction-only: external probe deferred" })
        : (cap: Parameters<typeof invoker.probe>[0]) => invoker.probe(cap),
      distill: async (ctx: BuildContext) => {
        ctx.distilled = await distill(ctx);
        const taskPassed = ctx.acceptance.filter((record) => record.layer === "task").every((record) => record.passed);
        const capabilities = new Map<string, Capability>();
        for (const set of (ctx.candidates as Array<{ candidates?: Capability[] }> | undefined) ?? []) for (const capability of set.candidates ?? []) capabilities.set(capability.id, capability);
        const generalization = options.constructionOnly
          ? { passed: true, constructionOnly: true, verified: false, attempts: [] }
          : taskPassed ? await runGeneralization({
          ctx,
          distilled: ctx.distilled as Awaited<ReturnType<typeof distill>>,
          capabilities,
          invoke: async (capability, _nodeId, inputs) => {
            const action = capability.name.replace(/\s+/g, "-").toLowerCase();
            const result = await invoker.invoke(capability, action, inputs);
            return { ok: result.ok && result.mode !== "context" && result.mode !== "delegated", output: result.output, error: result.error ?? (result.mode === "delegated" ? "宿主委托未在当前进程完成" : undefined) };
          },
          variants: 2,
          }) : { passed: false, attempts: [], failedInputs: {}, };
        ctx.acceptance.push({
          layer: "generalization",
          passed: taskPassed && generalization.passed,
          detail: { source: options.constructionOnly ? "construction" : "runtime", verified: !options.constructionOnly, slotCount: (ctx.distilled as Awaited<ReturnType<typeof distill>>).slotDefs.length, generalization },
          at: new Date().toISOString(),
        });
      },
    },
    store: memoryBuildStore(),
  };
  const orchestrator = createOrchestrator(deps);
  if (options.onGate) {
    orchestrator.on("gate:pending", ({ request }) => {
      void options.onGate!(request).then((decision) => orchestrator.decide(decision)).catch(() => orchestrator.abort());
    });
  } else if (options.autoApprove !== false) {
    const { VirtualUser } = await import("@/gates/virtual-user.js");
    attachVirtualUser(orchestrator, new VirtualUser({ kind: "approve-all" }));
  } else {
    throw new Error("manual mode requires onGate callback");
  }
  orchestrator.start(options.requirement, options.buildId, null, options.constructionOnly ? "construction" : "run");
  const final = await orchestrator.run();
  let scenarioId: string | undefined;
  if (options.persistScenario !== false && final.outcome === "completed" && final.finalizeChoice === "pin") {
    const distilled = final.distilled ? (final.distilled as Awaited<ReturnType<typeof distill>>) : await distill(final);
    scenarioId = `sc-${final.id}`;
    const existingNames = (await library.list()).map((scenario) => scenario.name);
    await library.save(
      recordFromDistilled({
        id: scenarioId,
        name: scenarioNameFromRequirement(options.requirement, existingNames),
        ctx: final,
        distilled,
        capabilityIds: [...new Set(final.selections.map((selection) => selection.capabilityId))],
      }),
    );
  }
  return {
    id: final.id,
    phase: final.phase,
    outcome: final.outcome,
    selections: final.selections,
    approvals: final.approvals.length,
    acceptance: final.acceptance,
    trace: final.trace,
    distilled: final.distilled,
    artifacts: { scenarioId },
    verification: options.constructionOnly ? "untested" : final.outcome === "completed" ? "verified" : "failed",
    constructionOnly: options.constructionOnly === true,
  };
}
