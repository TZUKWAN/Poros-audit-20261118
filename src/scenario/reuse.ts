import type { Capability } from "@/federation/types.js";
import type { CapabilityInvoker } from "@/execution/capability-runtime.js";
import type { Intent } from "@/orchestrator/context.js";
import type { ScenarioLibrary, ScenarioRecord } from "./library.js";

export interface ScenarioReuseParams {
  library: ScenarioLibrary;
  scenario: ScenarioRecord;
  requirement: string;
  intent: Intent;
  search: (query: string, limit?: number) => Promise<{ capabilities: Capability[] }>;
  invoker: CapabilityInvoker;
  timeoutMs?: number;
  checkpoint?: () => Promise<void>;
  signal?: AbortSignal;
}

/** 复用前重新检索、漂移检查、填槽并执行；任何条件不满足都回退到完整构建。 */
export async function tryReuseScenario(params: ScenarioReuseParams): Promise<{ handled: boolean; ok: boolean; error?: string }> {
  const timeoutMs = params.timeoutMs ?? 6_000;
  const candidates = await params.search(params.requirement, Math.max(10, params.scenario.capabilityIds.length * 2));
  const byId = new Map(candidates.capabilities.map((capability) => [capability.id, capability]));
  if (params.scenario.capabilityIds.length === 0 || params.scenario.capabilityIds.some((id) => !byId.has(id))) {
    return { handled: false, ok: false };
  }
  const drift = await params.library.checkDrift(
    params.scenario.id,
    async (id) => {
      const capability = byId.get(id);
      if (!capability) return false;
      return (await params.invoker.probe(capability, { timeoutMs })).available;
    },
  );
  if (drift.drifted) return { handled: false, ok: false };
  const slots = Object.fromEntries(params.intent.slots.map((slot) => [slot.name, slot.value]));
  const result = await params.library.execute(params.scenario.id, slots, async (record) => {
    for (const capabilityId of record.capabilityIds) {
      await params.checkpoint?.();
      const capability = byId.get(capabilityId);
      if (!capability) return { ok: false };
      const invoked = await params.invoker.invoke(capability, capability.name.replace(/\s+/g, "-").toLowerCase(), { requirement: params.requirement, ...slots }, { timeoutMs, signal: params.signal });
      if (!invoked.ok || invoked.mode !== "executed") return { ok: false };
    }
    return { ok: true };
  });
  if (!result.ok) {
    return { handled: false, ok: false, error: "复用场景的真实能力调用未通过，已回退完整构建" };
  }
  return { handled: true, ok: true };
}
