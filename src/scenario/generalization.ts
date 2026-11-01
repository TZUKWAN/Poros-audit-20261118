import { GeneralizationTester, TaskAcceptance, type GeneralizationVerdict } from "@/acceptance/acceptance.js";
import type { Capability } from "@/federation/types.js";
import type { BuildContext } from "@/orchestrator/context.js";
import type { DistilledScenario } from "@/distill/distill.js";

export type GeneralizationResult = GeneralizationVerdict | { passed: true; skipped: true; reason: string; attempts: [] };

/**
 * 对已经执行过一次的构建结果做真实换参验证。
 * 没有槽位时明确记录 skipped，不能把“没有输入可换”伪装成泛化样本通过。
 */
export async function runGeneralization(params: {
  ctx: BuildContext;
  distilled: DistilledScenario;
  capabilities: Map<string, Capability>;
  invoke: (capability: Capability, nodeId: string, inputs: Record<string, string>) => Promise<{ ok: boolean; output?: unknown; error?: string }>;
  variants?: number;
}): Promise<GeneralizationResult> {
  if (params.distilled.slotDefs.length === 0) return { passed: true, skipped: true, reason: "场景没有可替换槽位", attempts: [] };
  if (!params.ctx.assembly || params.ctx.assembly.nodes.length === 0) return { passed: false, attempts: [], failedInputs: {}, };
  const tester = new GeneralizationTester({
    variants: Math.max(2, params.variants ?? 2),
    taskAcceptance: new TaskAcceptance(),
    criteria: [{ id: "all-selected-nodes", description: "每个已选节点都能在换参后完成", needsJudge: false, rule: (output) => Boolean(output && typeof output === "object" && (output as { nodes?: Array<{ ok: boolean }> }).nodes?.every((item) => item.ok)) }],
    run: async (inputs) => {
      const results: Array<{ nodeId: string; ok: boolean; output?: unknown; error?: string }> = [];
      for (const node of params.ctx.assembly!.nodes) {
        const selected = params.ctx.selections.find((item) => item.nodeId === node.nodeId);
        const capability = selected ? params.capabilities.get(selected.capabilityId) : undefined;
        if (!capability) { results.push({ nodeId: node.nodeId, ok: false, error: "selected capability is missing" }); continue; }
        try {
          const result = await params.invoke(capability, node.nodeId, inputs);
          results.push({ nodeId: node.nodeId, ...result });
          if (!result.ok) return { ok: false, output: { nodes: results }, error: result.error ?? `node ${node.nodeId} failed` };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          results.push({ nodeId: node.nodeId, ok: false, error: message });
          return { ok: false, output: { nodes: results }, error: message };
        }
      }
      return { ok: true, output: { nodes: results } };
    },
  });
  return await tester.check(params.distilled.slotDefs.map((slot) => ({ name: slot.name, examples: slot.examples })));
}
