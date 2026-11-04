import { z } from "zod";
import { ScenarioError, ScenarioErrorCode } from "@/core/errors.js";
import type { Store } from "@/core/store.js";
import type { BuildContext } from "@/orchestrator/context.js";
import { cosineSimilarity, intentSignature, type DistilledScenario, type IntentSignature, type SlotDef } from "@/distill/distill.js";
import { ScenarioDefinitionSchema, type ScenarioDefinition } from "./definition.js";
import { emptyLedger, ensureLedger as ensureLedgerOf, ScenarioLedgerSchema, type ScenarioLedger } from "./ledger.js";
import { confidence } from "./confidence.js";

/**
 * 6.2 场景库：持久化 + 命中三档 + 填槽执行 + 漂移检测 + 治理指标。
 */

export const ScenarioRecordSchema = z.object({
  /** Workspace/project folder ownership. Null keeps legacy globally reusable scenes visible. */
  workspaceId: z.string().min(1).nullable().default(null),
  projectId: z.string().min(1).nullable().default(null),
  id: z.string().min(1),
  name: z.string().min(1),
  goal: z.string(),
  pinnedVersion: z.number().int().min(1),
  distilled: z.object({
    slotDefs: z.array(z.any()),
    branches: z.array(z.any()),
    acceptanceTemplates: z.array(z.any()),
    signature: z.object({ keywords: z.array(z.string()), embedding: z.array(z.number()), embedVia: z.string() }),
    /** 原始需求（LLM 改写 goal 前）的签名——复用匹配的原文兜底信号（老记录缺省） */
    sourceSignature: z.object({ keywords: z.array(z.string()), embedding: z.array(z.number()), embedVia: z.string() }).optional(),
    buildId: z.string(),
    pinnedVersion: z.number(),
  }),
  /** 能力选型快照（漂移检测逐能力探活的对象） */
  capabilityIds: z.array(z.string()),
  definition: ScenarioDefinitionSchema.optional(),
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
  status: z.enum(["active", "archived", "deleted"]).default("active"),
  tags: z.array(z.string().max(40)).default([]),
  /** SceneFlow 领域归属：core 通用 / ares 竞赛 / metis 学术（迁移自领域仓的记录带上原域标记） */
  domain: z.enum(["core", "ares", "metis"]).default("core"),
  /** 分寸账本（§3）：约束/先例/统计；老记录缺省，读时折算补齐，启动迁移落盘 */
  ledger: ScenarioLedgerSchema.optional(),
  versionHistory: z.array(z.object({ version: z.number().int().min(1), capabilityIds: z.array(z.string()), createdAt: z.string(), reason: z.string().default("updated") })).default([]),
  createdAt: z.string(),
});
// Keep the public record input backwards-compatible with pre-scope callers:
// persisted parses always materialize null, while hand-authored legacy
// records may omit the new ownership fields. Same for domain (default "core").
export type ScenarioRecord = Omit<z.infer<typeof ScenarioRecordSchema>, "workspaceId" | "projectId" | "domain"> & { workspaceId?: string | null; projectId?: string | null; domain?: "core" | "ares" | "metis" };
export type ScenarioScope = { workspaceId?: string | null; projectId?: string | null };

/** A legacy null-scoped scenario remains globally reusable; scoped scenarios never leak to another workspace/project. */
export function scenarioMatchesScope(scenario: Pick<ScenarioRecord, "workspaceId" | "projectId">, scope: ScenarioScope = {}): boolean {
  const workspaceId = scope.workspaceId ?? null;
  const projectId = scope.projectId ?? null;
  if ((scenario.workspaceId ?? null) !== null && scenario.workspaceId !== workspaceId) return false;
  if ((scenario.projectId ?? null) !== null && scenario.projectId !== projectId) return false;
  return true;
}

/**
 * Turn a free-form request into a short, human-readable scenario title.
 *
 * Scenario ids are intentionally opaque and are useful for storage, but they
 * should never leak into the navigation or completion copy. Keep this helper
 * deterministic so the same request is easy to recognise after a restart and
 * add a small suffix when a workspace already has the same title.
 */
export function scenarioNameFromRequirement(requirement: string, existingNames: string[] = []): string {
  const cleaned = requirement
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^\s*(?:请帮我|帮我|请|需要|我要|我想(?:要)?|麻烦)\s*/i, "")
    .replace(/^[：:、,，。.!！?？\-—\s]+|[：:、,，。.!！?？\-—\s]+$/g, "")
    .trim();
  const firstSentence = cleaned.split(/[。！？!?；;]+/u)[0]?.trim() ?? "";
  const base = (firstSentence || cleaned || "未命名场景").slice(0, 36).trim() || "未命名场景";
  const used = new Set(existingNames.map((name) => name.trim()).filter(Boolean));
  if (!used.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const suffix = `（${index}）`;
    const candidate = `${base.slice(0, Math.max(1, 36 - suffix.length)).trim()}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base.slice(0, 30)}（${Date.now()}）`;
}

/** Normalize names written by pre-panel builds while preserving custom labels. */
export function migratedScenarioName(currentName: string, goal: string, existingNames: string[] = []): string {
  const rawName = currentName.trim();
  const requestShaped = rawName === goal.trim()
    || /^(?:请帮我|帮我|请|需要|我要|我想(?:要)?|麻烦)\s*/u.test(rawName);
  const preferred = requestShaped ? scenarioNameFromRequirement(goal || rawName) : rawName;
  return existingNames.some((name) => name.trim() === preferred)
    ? scenarioNameFromRequirement(goal || preferred, existingNames)
    : preferred;
}

export interface ScenarioStoreDeps {
  store: Store<ScenarioRecord>;
  now?: () => Date;
}

export class ScenarioLibrary {
  private matchThresholds: { hit: number; partial: number };
  // R5+ 收尾：save 是读-改-写（previous → versionHistory → set），store 只串行化
  // 单次写不串行化这对操作——并发同 id save（如定时任务 bump stats 与 checkDrift
  // bump version 相撞）会互相覆盖。按 id 串行排队消除竞态。
  private readonly saveQueues = new Map<string, Promise<void>>();

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
    const previous = this.saveQueues.get(record.id) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => this.saveInner(record));
    this.saveQueues.set(record.id, operation);
    try {
      await operation;
    } finally {
      if (this.saveQueues.get(record.id) === operation) this.saveQueues.delete(record.id);
    }
  }

  private async saveInner(record: ScenarioRecord): Promise<void> {
    const parsed = ScenarioRecordSchema.safeParse(record);
    if (!parsed.success) {
      throw new ScenarioError({
        code: ScenarioErrorCode.VALIDATION,
        message: "scenario record invalid",
        phase: "distilling",
        context: { issues: parsed.error.issues.slice(0, 3) },
      });
    }
    const previous = await this.deps.store.get(record.id);
    const next = parsed.data;
    if (previous && next.pinnedVersion > previous.pinnedVersion) {
      next.versionHistory = [...previous.versionHistory, { version: previous.pinnedVersion, capabilityIds: previous.capabilityIds, createdAt: previous.createdAt, reason: "superseded" }].slice(-20); // R5+ 收尾：封顶防无限增长
    }
    await this.deps.store.set(record.id, next);
  }

  async get(id: string): Promise<ScenarioRecord | undefined> {
    const value = await this.deps.store.get(id);
    return value ? ScenarioRecordSchema.parse(value) : undefined;
  }

  async list(): Promise<ScenarioRecord[]> {
    return await this.deps.store.entries().then((entries) => entries.map(([, v]) => ScenarioRecordSchema.parse(v)));
  }

  /**
   * 分寸账本唯一写入通道（§3）：store 锁外再按 id 串行排队（与 save 共用队列），
   * read→fn→validate→write 原子；禁止任何调用方直接改 record.ledger。
   * 老记录无账本时以折算账本为基底（migratedLedger）。
   */
  async updateLedger(id: string, fn: (ledger: ScenarioLedger) => ScenarioLedger): Promise<void> {
    const previous = this.saveQueues.get(id) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      const record = await this.get(id);
      if (!record) {
        throw new ScenarioError({ code: ScenarioErrorCode.NOT_FOUND, message: `scenario ${id} not found`, phase: "executing" });
      }
      const next = ScenarioLedgerSchema.parse(fn(ensureLedgerOf(record)));
      await this.saveInner({ ...record, ledger: next });
    });
    this.saveQueues.set(id, operation);
    try {
      await operation;
    } finally {
      if (this.saveQueues.get(id) === operation) this.saveQueues.delete(id);
    }
  }

  async archive(id: string): Promise<boolean> {
    const scenario = await this.get(id);
    if (!scenario) return false;
    await this.save({ ...scenario, status: "archived" });
    return true;
  }

  async restore(id: string): Promise<boolean> {
    const scenario = await this.get(id);
    if (!scenario) return false;
    await this.save({ ...scenario, status: "active" });
    return true;
  }

  async delete(id: string): Promise<boolean> {
    const scenario = await this.get(id);
    if (!scenario) return false;
    await this.save({ ...scenario, status: "deleted" });
    return true;
  }

  /**
   * 6.2.2 命中三档：词袋签名阈值为 hit=0.7 / partial=0.3。
   * requirementHint（原始需求文本）兜底：LLM 每次解析的关键词/改写目标会漂移，
   * 同一文本的原始字面相似度是最稳的复用信号（0.9×token Jaccard，同一需求 ≈0.9 ≥ hit）。
   */
  async match(signature: IntentSignature, scope?: ScenarioScope, requirementHint?: string): Promise<{ tier: "hit" | "partial" | "miss"; scenario?: ScenarioRecord; score: number; degraded?: boolean }> {
    let best: { scenario: ScenarioRecord; score: number; degraded: boolean } | undefined;
    let hintSig: IntentSignature | undefined;
    // 治理语义：degraded 场景仍参与匹配并可达 hit——工作模式是用户显式请求，
    // 拦截它会让降级场景永远无法再次执行（成功率永远无法回升，死锁）。
    // 自动化路径（定时任务）在调用侧依据 degraded 标记自行拒绝。
    for (const scenario of await this.list()) {
      if (scope && !scenarioMatchesScope(scenario, scope)) continue;
      if (scenario.status !== "active") continue;
      const base = this.scoreMatch(signature, scenario.distilled.signature as unknown as IntentSignature);
      let hintScore = 0;
      if (requirementHint) {
        hintScore = 0.9 * jaccardTokens(requirementHint, scenario.goal);
        const sourceSig = scenario.distilled.sourceSignature as IntentSignature | undefined;
        if (sourceSig && !hintSig) hintSig = await intentSignature(requirementHint, []);
        if (sourceSig) hintScore = Math.max(hintScore, 0.9 * cosineSimilarity(hintSig!.embedding, sourceSig.embedding));
      }
      const score = Math.max(base, hintScore);
      const rank = scope?.projectId && scenario.projectId === scope.projectId ? 2 : scope?.workspaceId && scenario.workspaceId === scope.workspaceId ? 1 : 0;
      const bestRank = best ? (scope?.projectId && best.scenario.projectId === scope.projectId ? 2 : scope?.workspaceId && best.scenario.workspaceId === scope.workspaceId ? 1 : 0) : -1;
      if (!best || rank > bestRank || (rank === bestRank && score > best.score)) best = { scenario, score, degraded: Boolean(scenario.degraded) };
    }
    if (!best) return { tier: "miss", score: 0 };
    if (best.score >= this.matchThresholds.hit) return { tier: "hit", scenario: best.scenario, score: best.score, degraded: best.degraded };
    if (best.score >= this.matchThresholds.partial) return { tier: "partial", scenario: best.scenario, score: best.score, degraded: best.degraded };
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
    let result: { ok: boolean };
    try {
      result = await runner(scenario, slots);
    } catch {
      result = { ok: false };
    }
    const now = (this.deps.now ?? (() => new Date()))().toISOString();
    scenario.stats.uses += 1;
    if (result.ok) scenario.stats.successes += 1;
    scenario.stats.lastUsedAt = now;
    this.applyGovernance(scenario);
    await this.save(scenario);
    return { ok: result.ok, scenario };
  }

  /** Persist the independently verified execution state on the definition. */
  async updateExecutionValidation(scenarioId: string, validation: ScenarioDefinition["validation"]["execution"], lastRunId: string | null, definition?: ScenarioDefinition): Promise<ScenarioRecord> {
    const scenario = await this.get(scenarioId);
    if (!scenario) throw new ScenarioError({ code: ScenarioErrorCode.NOT_FOUND, message: `scenario ${scenarioId} not found`, phase: "verifying" });
    const current = definition ?? scenario.definition;
    if (!current) return scenario;
    const nextDefinition = ScenarioDefinitionSchema.parse({ ...current, validation: { ...current.validation, definition: "passed", execution: validation, lastRunId } });
    scenario.definition = nextDefinition;
    await this.save(scenario);
    return scenario;
  }

  /**
   * 6.2.5 治理（P7 统一降级）：旧成功率规则保留为底线（老记录行为不变），
   * 分寸账本置信度为负（近期打回/纠正压过连胜）同样判降级——干预曲线取代裸成功率。
   */
  private applyGovernance(scenario: ScenarioRecord): void {
    if (scenario.stats.uses < 2) return;
    const rateRule = scenario.stats.successes / scenario.stats.uses < 0.5;
    const ledgerRule = confidence(ensureLedgerOf(scenario)) < 0;
    scenario.degraded = rateRule || ledgerRule;
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
    let newFailures = 0;
    for (const capabilityId of scenario.capabilityIds) {
      const alive = await probe(capabilityId);
      if (alive) continue;
      scenario.stats.driftCount += 1;
      newFailures += 1;
      const to = replacement ? await replacement(capabilityId) : undefined;
      if (to) {
        scenario.capabilityIds = scenario.capabilityIds.map((c) => (c === capabilityId ? to : c));
        switched.push({ from: capabilityId, to });
      }
    }
    // 版本只在本轮确有新失效（换型或留痕）时递增——历史 driftCount 不得触发虚增（R2 审查修复）
    const drifted = switched.length > 0 || newFailures > 0;
    if (drifted) {
      scenario.pinnedVersion += 1;
      await this.save(scenario);
    }
    return { drifted, switched, newVersion: scenario.pinnedVersion };
  }
}

/** 原文 token Jaccard（match 的字面兜底信号） */
function jaccardTokens(a: string, b: string): number {
  const tokens = (t: string): Set<string> => new Set(
    t.toLowerCase().replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).match(/[\p{L}\p{N}]+/gu) ?? [],
  );
  const sa = tokens(a);
  const sb = tokens(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter += 1;
  return inter / (sa.size + sb.size - inter);
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
  workspaceId?: string | null;
  projectId?: string | null;
  now?: Date;
  /** 原始需求签名（LLM 改写 goal 前的字面），复用匹配的原文兜底 */
  sourceSignature?: { keywords: string[]; embedding: number[]; embedVia: string };
}): ScenarioRecord {
  return {
    workspaceId: params.workspaceId ?? null,
    projectId: params.projectId ?? null,
    id: params.id,
    name: params.name,
    goal: params.ctx.intent?.goal ?? params.ctx.requirement,
    pinnedVersion: params.distilled.pinnedVersion,
    distilled: {
      slotDefs: params.distilled.slotDefs,
      branches: params.distilled.branches,
      acceptanceTemplates: params.distilled.acceptanceTemplates,
      signature: params.distilled.signature,
      ...(params.sourceSignature ? { sourceSignature: params.sourceSignature } : {}),
      buildId: params.distilled.buildId,
      pinnedVersion: params.distilled.pinnedVersion,
    },
    capabilityIds: [...new Set(params.capabilityIds)],
    source: "built",
    approvals: params.ctx.approvals,
    ledger: emptyLedger(),
    stats: { uses: 0, successes: 0, lastUsedAt: null, driftCount: 0 },
    degraded: false,
    status: "active",
    tags: [],
    versionHistory: [],
    createdAt: (params.now ?? new Date()).toISOString(),
  };
}

export type { SlotDef };
