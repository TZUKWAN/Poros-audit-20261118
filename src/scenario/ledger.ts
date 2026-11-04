import { z } from "zod";
import type { ScenarioLibrary, ScenarioRecord } from "./library.js";

/**
 * 分寸账本（docs/分寸账本改造方案.md §3/§4）：约束/先例/统计是唯一复利资产，计划降级为缓存。
 * 铁律：只结晶不发明——每条约束必须带人的信号出处；本模块是纯函数核心，
 * 所有落盘必须经 library.updateLedger 的原子读改写通道。
 */

export const ConstraintOriginSchema = z.object({
  type: z.enum(["reject", "gate-edit", "feedback", "guide", "artifact-edit"]),
  /** 人的原话或 diff 摘要，永远保留 */
  text: z.string(),
  at: z.string(),
  runId: z.string().nullable(),
});

export const ConstraintSchema = z.object({
  /** "c-" + 8 位随机后缀 */
  id: z.string(),
  /** 人可读条款："行动项必须带负责人和截止日" */
  clause: z.string().min(1).max(300),
  scope: z.enum(["goal", "step", "capability", "acceptance", "output"]),
  kind: z.enum(["advisory", "must_contain", "must_not_contain"]),
  /** kind≠advisory 时的可执行判据（子串/正则源文本） */
  pattern: z.string().nullable(),
  origin: ConstraintOriginSchema,
  /** null = pendingConfirm，闸门5签约后填 */
  confirmedAt: z.string().nullable(),
  /** 自检拦下它的次数 */
  hits: z.number().int().min(0).default(0),
  active: z.boolean().default(true),
  /** 冲突裁决后指向胜者（"expired" = 30 天未确认过期） */
  supersededBy: z.string().nullable().default(null),
});

export const GateStatSchema = z.object({
  passes: z.number().int().min(0),
  rejects: z.number().int().min(0),
  edits: z.number().int().min(0),
  lastEventAt: z.string(),
});

export const ScenarioLedgerSchema = z.object({
  version: z.literal(1),
  constraints: z.array(ConstraintSchema).max(200),
  runStats: z.object({
    runs: z.number().int().min(0),
    /** 👍 或沉默超时 */
    accepted: z.number().int().min(0),
    /** 👎 或 retry */
    rejected: z.number().int().min(0),
    /** guide/产出编辑 */
    corrected: z.number().int().min(0),
    /** 连续 accepted 且零干预（仅有人值守运行推进） */
    consecutiveClean: z.number().int().min(0),
  }),
  /** key: 闸门号 "1".."5" */
  gateStats: z.record(z.string(), GateStatSchema),
  inputPatterns: z
    .array(
      z.object({
        digest: z.string(),
        at: z.string(),
        outcome: z.enum(["accepted", "rejected", "corrected"]),
      }),
    )
    .max(50),
  interventions: z
    .array(
      z.object({
        runId: z.string(),
        at: z.string(),
        /** 全开闸门数（抽查态展开也计） */
        gatesAnswered: z.number().int(),
        questionsAnswered: z.number().int(),
        correctionsGiven: z.number().int(),
        total: z.number().int(),
      }),
    )
    .max(200),
});

export type ConstraintOrigin = z.infer<typeof ConstraintOriginSchema>;
export type Constraint = z.infer<typeof ConstraintSchema>;
export type ScenarioLedger = z.infer<typeof ScenarioLedgerSchema>;
export type RunOutcome = "accepted" | "rejected" | "corrected";
export type GateNumber = "1" | "2" | "3" | "4" | "5";

export type ProposeInput = {
  clause: string;
  scope: Constraint["scope"];
  kind?: Constraint["kind"];
  pattern?: string | null;
  origin: ConstraintOrigin;
};

/** 8 位随机 id 后缀（crypto 随机，无外部依赖） */
function shortId(): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

/** 新场景的空账本（recordFromDistilled 用） */
export function emptyLedger(): ScenarioLedger {
  return {
    version: 1,
    constraints: [],
    runStats: { runs: 0, accepted: 0, rejected: 0, corrected: 0, consecutiveClean: 0 },
    gateStats: {},
    inputPatterns: [],
    interventions: [],
  };
}

/**
 * 老记录迁移（§3）：consecutiveClean 折算 = min(successCount, 1)——
 * 老成功次数无干预记录，不可信，宁可保守。
 */
export function migratedLedger(record: Pick<ScenarioRecord, "stats">): ScenarioLedger {
  const uses = record.stats?.uses ?? 0;
  const successes = record.stats?.successes ?? 0;
  return {
    version: 1,
    constraints: [],
    runStats: {
      runs: uses,
      accepted: successes,
      rejected: Math.max(0, uses - successes),
      corrected: 0,
      consecutiveClean: Math.min(successes, 1),
    },
    gateStats: {},
    inputPatterns: [],
    interventions: [],
  };
}

/** 幂等读取：已有账本原样返回，老记录折算补齐（不落盘，落盘走 migrateLedgers） */
export function ensureLedger(record: Pick<ScenarioRecord, "stats" | "ledger">): ScenarioLedger {
  if (record.ledger) return ScenarioLedgerSchema.parse(record.ledger);
  return migratedLedger(record);
}

/**
 * 启动迁移（§3，幂等）：给存量场景补齐账本并落盘。跑多次结果一致——
 * 已有 ledger 的记录原样跳过。老记录行为不变（549 测试绿是底线）。
 */
export async function migrateLedgers(library: ScenarioLibrary): Promise<{ migrated: number; skipped: number }> {
  let migrated = 0;
  let skipped = 0;
  for (const record of await library.list()) {
    if (record.ledger) {
      skipped += 1;
      continue;
    }
    const ledger = migratedLedger(record);
    await library.updateLedger(record.id, () => ledger);
    migrated += 1;
  }
  return { migrated, skipped };
}

/** 否定/语气词表（§4 质量门槛）：整句只是这些词的拼接 → 只记事件，不生成提案 */
const JUNK_WORDS = [
  "不对", "不行", "不好", "不满意", "不ok", "不行啊",
  "重做", "重新", "重新做", "重来", "再来", "再来一次", "再想想", "再改改", "再改",
  "错误", "错了", "改一下", "改",
  "不", "别", "啊", "嗯", "哦", "好", "好的", "ok", "okay", "no", "yes", "ng",
];

/** §4 质量门槛：去标点后 <4 字，或整句是否定/语气词的拼接 → 无实质内容 */
export function isSubstantiveComment(text: string): boolean {
  const stripped = text
    .toLowerCase()
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[\s\p{P}\p{S}]+/gu, "");
  if (stripped.length < 4) return false;
  let rest = stripped;
  for (let i = 0; i < 8 && rest.length > 0; i += 1) {
    const hit = JUNK_WORDS.find((w) => rest.startsWith(w));
    if (!hit) return true;
    rest = rest.slice(hit.length);
  }
  return rest.length === 0 ? false : true;
}

/** 去掉"不对/不行/重新"类否定前缀，人的原话即条款（§4） */
export function stripNegationPrefix(text: string): string {
  let out = text.trim();
  for (;;) {
    const next = out.replace(/^(?:不对|不行|不要|不是|不好|重新|重来|再来|再|别|请)[\s，,。.!！?？、]*/u, "").trim();
    if (next === out || next.length === 0) break;
    out = next;
  }
  return out || text.trim();
}

/**
 * 生成 pendingConfirm 提案（§4：scope/kind 由调用方按信号类型机械分类，这里做质量门槛/去重/封顶）。
 * 返回 null = 未生成（质量不达标 / 重复 / 已满 200）。
 */
export function proposeConstraint(ledger: ScenarioLedger, input: ProposeInput): { ledger: ScenarioLedger; constraint: Constraint } | null {
  const clause = input.clause.trim().slice(0, 300);
  if (!isSubstantiveComment(clause)) return null;
  if (ledger.constraints.length >= 200) return null;
  const key = clauseKey(clause);
  if (ledger.constraints.some((c) => clauseKey(c.clause) === key && c.active && c.supersededBy === null)) return null;
  const constraint: Constraint = ConstraintSchema.parse({
    id: `c-${shortId()}`,
    clause,
    scope: input.scope,
    kind: input.kind ?? "advisory",
    pattern: input.pattern ?? null,
    origin: input.origin,
    confirmedAt: null,
    hits: 0,
    active: true,
    supersededBy: null,
  });
  return { ledger: { ...ledger, constraints: [...ledger.constraints, constraint] }, constraint };
}

/** 条款去重键：子句归一（全半角/空白折叠） */
function clauseKey(clause: string): string {
  return clause
    .toLowerCase()
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/g, "")
    .slice(0, 120);
}

/** 闸门5 签约：批量填 confirmedAt（§14） */
export function confirmConstraints(ledger: ScenarioLedger, ids: string[], now: string = new Date().toISOString()): ScenarioLedger {
  const set = new Set(ids);
  return {
    ...ledger,
    constraints: ledger.constraints.map((c) => (set.has(c.id) && c.confirmedAt === null ? { ...c, confirmedAt: now } : c)),
  };
}

/** 退役（不删，可溯）：active=false */
export function retireConstraint(ledger: ScenarioLedger, id: string): ScenarioLedger {
  return { ...ledger, constraints: ledger.constraints.map((c) => (c.id === id ? { ...c, active: false } : c)) };
}

/** 冲突裁决：落败方标 supersededBy（§15） */
export function supersedeConstraint(ledger: ScenarioLedger, loserId: string, winnerId: string): ScenarioLedger {
  return { ...ledger, constraints: ledger.constraints.map((c) => (c.id === loserId ? { ...c, supersededBy: winnerId, active: false } : c)) };
}

/** §4 机械升级：同类产出编辑命中 ≥2 次后 advisory → must_contain（pattern=稳定子串） */
export function upgradeToMustContain(ledger: ScenarioLedger, id: string, pattern: string): ScenarioLedger {
  return { ...ledger, constraints: ledger.constraints.map((c) => (c.id === id ? { ...c, kind: "must_contain", pattern: pattern.slice(0, 200) } : c)) };
}

/** 自检拦下 → hits++ */
export function bumpConstraintHits(ledger: ScenarioLedger, id: string): ScenarioLedger {
  return { ...ledger, constraints: ledger.constraints.map((c) => (c.id === id ? { ...c, hits: c.hits + 1 } : c)) };
}

export type GateEventSummary = Partial<Record<GateNumber, { passes?: number; rejects?: number; edits?: number }>>;

export type RunOutcomeParams = {
  runId: string;
  /** 无人值守：runs++ 可记 rejected，沉默绝不记 accepted、不推 consecutiveClean（§9） */
  attended: boolean;
  /** silent-accepted = 沉默超时（弱 accepted，可被编辑/👎撤销后由服务端改记）；suspected = 自检仍违规 */
  outcome: RunOutcome | "silent-accepted" | "unattended-success" | "suspected";
  /** 本 run 的输入 digest（进 inputPatterns 供路由命中） */
  digest?: string;
  at?: string;
  gateEvents?: GateEventSummary;
  /** 介入统计（北极星曲线数据源；无人值守运行传零值） */
  interventions?: { gatesAnswered: number; questionsAnswered: number; correctionsGiven: number };
  /** pendingConfirm 过期清理的基准时刻 */
  now?: string;
};

/**
 * run 收尾事务（§5/§12/§9）：runStats/gateStats/inputPatterns/interventions 一个纯函数内完成。
 * runId 粒度幂等：interventions 已含该 runId → 原样返回（双击 👎 / 收尾重放不重复计）。
 * 规则：
 *  - accepted/silent：仅有人值守时 accepted++、consecutiveClean++；无人值守成功只 runs++（§9）。
 *  - rejected/corrected：计数++、断连胜；无人值守失败"失败自证"同样入账（§9）。
 *  - suspected（自检仍违规）：断连胜但 accepted/rejected/corrected 都不动——两边都不可信（§10）。
 */
export function recordRunOutcome(ledger: ScenarioLedger, params: RunOutcomeParams): ScenarioLedger {
  if (ledger.interventions.some((i) => i.runId === params.runId)) return ledger;
  const at = params.at ?? params.now ?? new Date().toISOString();
  const silent = params.outcome === "silent-accepted";
  const suspected = params.outcome === "suspected";
  const acceptedSemantics = params.outcome === "accepted" || silent || params.outcome === "unattended-success";
  const negative = params.outcome === "rejected" || params.outcome === "corrected";

  const runStats = { ...ledger.runStats, runs: ledger.runStats.runs + 1 };
  if (!suspected) {
    if (params.outcome === "rejected") runStats.rejected += 1;
    else if (params.outcome === "corrected") runStats.corrected += 1;
    else if (acceptedSemantics && params.attended) runStats.accepted += 1;
  }
  if (negative || suspected) runStats.consecutiveClean = 0;
  else if (acceptedSemantics && params.attended) runStats.consecutiveClean += 1;

  const gateStats = { ...ledger.gateStats };
  for (const [gate, ev] of Object.entries(params.gateEvents ?? {})) {
    const prev = gateStats[gate] ?? { passes: 0, rejects: 0, edits: 0, lastEventAt: at };
    gateStats[gate] = {
      passes: prev.passes + (ev.passes ?? 0),
      rejects: prev.rejects + (ev.rejects ?? 0),
      edits: prev.edits + (ev.edits ?? 0),
      lastEventAt: at,
    };
  }

  // inputPatterns 事件源（confidence 衰减计数 + 路由 digest 命中都读它）：
  // 有人值守 → 三种结果都记；无人值守 → 只记失败自证；suspected 不记。
  const inputPatterns = [...ledger.inputPatterns];
  const recordEvent = !suspected && (params.attended || params.outcome === "rejected");
  if (recordEvent) {
    inputPatterns.push({ digest: params.digest ?? "none", at, outcome: silent ? "accepted" : suspected ? "corrected" : (params.outcome as RunOutcome) });
    if (inputPatterns.length > 50) inputPatterns.splice(0, inputPatterns.length - 50);
  }

  const iv = params.interventions ?? { gatesAnswered: 0, questionsAnswered: 0, correctionsGiven: 0 };
  const interventions = [
    ...ledger.interventions,
    {
      runId: params.runId,
      at,
      gatesAnswered: iv.gatesAnswered,
      questionsAnswered: iv.questionsAnswered,
      correctionsGiven: iv.correctionsGiven,
      total: iv.gatesAnswered + iv.questionsAnswered + iv.correctionsGiven,
    },
  ];
  if (interventions.length > 200) interventions.splice(0, interventions.length - 200);

  // pendingConfirm 过期清理（§15）：30 天未确认自动过期（退役留痕，不删）
  const cutoff = Date.parse(at) - 30 * 24 * 3600 * 1000;
  const constraints = ledger.constraints.map((c) =>
    c.confirmedAt === null && Number.isFinite(Date.parse(c.origin.at)) && Date.parse(c.origin.at) < cutoff
      ? { ...c, active: false, supersededBy: "expired" }
      : c,
  );

  return { ...ledger, version: 1, runStats, gateStats, inputPatterns, interventions, constraints };
}

/** 自检可用条款：confirmedAt≠null 且 active 且未被 supersede（§10） */
export function activeConstraints(ledger: ScenarioLedger): Constraint[] {
  return ledger.constraints.filter((c) => c.confirmedAt !== null && c.active && c.supersededBy === null);
}

/** pendingConfirm 队列（闸门5 签约面数据源） */
export function pendingConstraints(ledger: ScenarioLedger): Constraint[] {
  return ledger.constraints.filter((c) => c.confirmedAt === null && c.active && c.supersededBy === null);
}
