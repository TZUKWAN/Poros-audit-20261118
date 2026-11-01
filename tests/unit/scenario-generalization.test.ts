import { describe, expect, it } from "vitest";
import { runGeneralization } from "@/scenario/generalization";
import type { BuildContext } from "@/orchestrator/context";
import type { Capability } from "@/federation/types";
import type { DistilledScenario } from "@/distill/distill";

const capability = { id: "cap-1", name: "echo", source: { name: "test", tier: "curated" }, trust: { score: 1 }, requiresAuth: false } as unknown as Capability;
const distilled: DistilledScenario = { slotDefs: [{ name: "path", type: "path", sourceNodeId: "n1", examples: ["/a", "/b"] }], branches: [], acceptanceTemplates: [], signature: { keywords: ["echo"], embedding: [1], embedVia: "bag-of-words" }, buildId: "b1", pinnedVersion: 1 };

function context(): BuildContext {
  return {
    id: "b1", requirement: "处理 /a", phase: "distilling", intent: null, dag: null, candidates: [{ nodeId: "n1", query: "echo", candidates: [capability] }], selections: [{ nodeId: "n1", capabilityId: capability.id, rationale: "test" }], assembly: { nodes: [{ nodeId: "n1", capabilityId: capability.id }], edges: [] }, acceptance: [], trace: [], approvals: [], outcome: null, finalizeChoice: null, runtimeContext: null, planner: null, distilled: null, pendingGate: null,
  } as unknown as BuildContext;
}

describe("场景泛化换参验收", () => {
  it("至少执行两组槽位样本，并返回尝试记录", async () => {
    const inputs: Record<string, string>[] = [];
    const result = await runGeneralization({ ctx: context(), distilled, capabilities: new Map([[capability.id, capability]]), invoke: async (_cap, _node, values) => { inputs.push(values); return { ok: true, output: values }; } });
    expect(result.passed).toBe(true);
    expect("attempts" in result ? result.attempts.length : 0).toBe(2);
    expect(inputs.map((item) => item.path)).toEqual(["/a", "/b"]);
  });

  it("没有槽位时明确标记 skipped，而不是伪造样本", async () => {
    const result = await runGeneralization({ ctx: context(), distilled: { ...distilled, slotDefs: [] }, capabilities: new Map(), invoke: async () => ({ ok: true }) });
    expect(result).toMatchObject({ passed: true, skipped: true });
  });
});
