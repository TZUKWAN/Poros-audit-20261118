import { z } from "zod";
import { ScenarioError, ScenarioErrorCode } from "@/core/errors.js";
import type { Store } from "@/core/store.js";
import type { BuildContext } from "@/orchestrator/context.js";
import { cosineSimilarity, type DistilledScenario, type IntentSignature, type SlotDef } from "@/distill/distill.js";

/**
 * 6.2 场景库：持久化 + 命中三档 + 填槽执行 + 漂移检测 + 治理指标。
 */

export const ScenarioRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  goal: z.string(),
  pinnedVersion: z.number().int().min(1),
  distilled: z.object({
    slotDefs: z.array(z.any()),
    branches: z.array(z.any()),
    acceptanceTemplates: z.array(z.any()),
    signature: z.object({ keywords: z.array(z.string()), embedding: z.array(z.number()), embedVia: z.string() }),
    buildId: z.string(),
    pinnedVersion: z.number(),
  }),
  /** 能力选型快照（漂移检测逐能力探活的对象） */
  capabilityIds: z.array(z.string()),
  source: z.string().default("built"),
  approvals: z.array(z.any()).default([]),
  stats: z.object({
    uses: z.number().int().min(0).default(0),
    successes: z.number().int().min(0).default(0),
    lastUsedAt: z.string().nullable().default(null),
    driftCount: z.number().int().min(0).default(0),
  }),
  /** 低成功率标"降级" */
  degraded: z.boolean().default(false),
  createdAt: z.string(),
});
export type ScenarioRecord = z.infer<typeof ScenarioRecordSchema>;

export interface ScenarioStoreDeps {
  store: Store<ScenarioRecord>;
  now?: () => Date;
}

export class ScenarioLibrary {
  private matchThresholds: { hit: number; partial: number };

  /**
   * 阈值标定（6.2.2.b）：默认按 bag-of-words 嵌入器标定（hit 0.7 / partial 0.3）；
   * 注入真实 embedding 模型时建议 hit 0.82 / partial 0.55。
   */
  constructor(
    private deps: ScenarioStoreDeps,
    thresholds?: { hit: number; partial: number },
  ) {
    this.matchThresholds = thresholds ?? { hit: 0.7, partial: 0.3 };
  }

  async save(record: ScenarioRecord): Promise<void> {
    const parsed = ScenarioRecordSchema.safeParse(record);
    if (!parsed.success) {
      throw new ScenarioError({
        code: ScenarioErrorCode.VALIDATION,
        message: "scenario record invalid",
        phase: "distilling",
        context: { issues: parsed.error.issues.slice(0, 3) },
      });
    }
    await this.deps.store.set(record.id, record);
  }

  async get(id: string): Promise<ScenarioRecord | undefined> {
    return await this.deps.store.get(id);
  }

  async list(): Promise<ScenarioRecord[]> {
    return await this.deps.store.entries().then((entries) => entries.map(([, v]) => v));
  }

  /** 6.2.2 命中三档：hit（≥0.82）复用 / partial（≥0.55）派生 / miss 从零构建 */
  async match(signature: IntentSignature): Promise<{ tier: "hit" | "partial" | "miss"; scenario?: ScenarioRecord; score: number }> {
    let best: { scenario: ScenarioRecord; score: number } | undefined;
    for (const scenario of await this.list()) {
      const score = this.scoreMatch(signature, scenario.distilled.signature as unknown as IntentSignature);
      if (!best || score > best.score) best = { scenario, score };
    }
    if (!best) return { tier: "miss", score: 0 };
    if (best.score >= this.matchThresholds.hit) return { tier: "hit", scenario: best.scenario, score: best.score };
    if (best.score >= this.matchThresholds.partial) return { tier: "partial", scenario: best.scenario, score: best.score };
    return { tier: "miss", score: best.score };
  }

  private scoreMatch(a: IntentSignature, b: IntentSignature): number {
    const cosine = cosineSimilarity(a.embedding, b.embedding);
    const kwOverlap = jaccard(a.keywords, b.keywords);
    return 0.7 * cosine + 0.3 * kwOverlap;
  }

  /** 6.2.3 填槽执行：slots 填入 → 执行（runner 注入）→ 更新 stats */
  async execute(scenarioId: string, slots: Record<string, string>, runner: (scenario: ScenarioRecord, slots: Record<string, string>) => Promise<{ ok: boolean }>): Promise<{ ok: boolean; scenario: ScenarioRecord }> {
    const scenario = await this.get(scenarioId);
    if (!scenario) {
      throw new ScenarioError({ code: ScenarioErrorCode.NOT_FOUND, message: `scenario ${scenarioId} not found`, phase: "executing" });
    }
    const result = await runner(scenario, slots);
    const now = (this.deps.now ?? (() => new Date()))().toISOString();
    scenario.stats.uses += 1;
    if (result.ok) scenario.stats.successes += 1;
    scenario.stats.lastUsedAt = now;
    this.applyGovernance(scenario);
    await this.save(scenario);
    return { ok: result.ok, scenario };
  }

  /** 6.2.5 治理：成功率 <50%（≥2 次）标降级 */
  private applyGovernance(scenario: ScenarioRecord): void {
    if (scenario.stats.uses >= 2) {
      scenario.degraded = scenario.stats.successes / scenario.stats.uses < 0.5;
    }
  }

  /** 6.2.4 漂移检测：复用前逐能力探活；失效 → drift → 局部换型（replacement 注入）→ 版本+1 */
  async checkDrift(
    scenarioId: string,
    probe: (capabilityId: string) => Promise<boolean>,
    replacement?: (capabilityId: string) => Promise<string | undefined>,
  ): Promise<{ drifted: boolean; switched: Array<{ from: string; to: string }>; newVersion: number }> {
    const scenario = await this.get(scenarioId);
    if (!scenario) {
      throw new ScenarioError({ code: ScenarioErrorCode.NOT_FOUND, message: `scenario ${scenarioId} not found`, phase: "verifying" });
    }
    const switched: Array<{ from: string; to: string }> = [];
    for (const capabilityId of scenario.capabilityIds) {
      const alive = await probe(capabilityId);
      if (alive) continue;
      scenario.stats.driftCount += 1;
      const to = replacement ? await replacement(capabilityId) : undefined;
      if (to) {
        scenario.capabilityIds = scenario.capabilityIds.map((c) => (c === capabilityId ? to : c));
        switched.push({ from: capabilityId, to });
      }
    }
    const drifted = switched.length > 0 || scenario.stats.driftCount > 0;
    if (drifted) {
      scenario.pinnedVersion += 1;
      await this.save(scenario);
    }
    return { drifted, switched, newVersion: scenario.pinnedVersion };
  }
}

function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a.map((x) => x.toLowerCase()));
  const sb = new Set(b.map((x) => x.toLowerCase()));
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter || 1);
}

/** 便捷：蒸馏产物 + BuildContext → ScenarioRecord */
export function recordFromDistilled(params: {
  id: string;
  name: string;
  ctx: BuildContext;
  distilled: DistilledScenario;
  capabilityIds: string[];
  now?: Date;
}): ScenarioRecord {
  return {
    id: params.id,
    name: params.name,
    goal: params.ctx.intent?.goal ?? params.ctx.requirement,
    pinnedVersion: params.distilled.pinnedVersion,
    distilled: {
      slotDefs: params.distilled.slotDefs,
      branches: params.distilled.branches,
      acceptanceTemplates: params.distilled.acceptanceTemplates,
      signature: params.distilled.signature,
      buildId: params.distilled.buildId,
      pinnedVersion: params.distilled.pinnedVersion,
    },
    capabilityIds: [...new Set(params.capabilityIds)],
    source: "built",
    approvals: params.ctx.approvals,
    stats: { uses: 0, successes: 0, lastUsedAt: null, driftCount: 0 },
    degraded: false,
    createdAt: (params.now ?? new Date()).toISOString(),
  };
}

export type { SlotDef };
