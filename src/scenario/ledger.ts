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
  /** 两角色模型：条款层级——scenario 场景私有 / team 团队资产（git 同步） */
  layer: z.enum(["scenario", "team"]).default("scenario"),
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
  /** 两角色模型：条款反事实归因（key = constraint id；holdout 轮不归因，见 recordRunOutcome） */
  attribution: z
    .record(
      z.string(),
      z.object({
        /** 注入且回合干净收尾的次数 */
        helped: z.number().int().min(0).default(0),
        /** 注入且被打回/纠正的次数 */
        hurt: z.number().int().min(0).default(0),
        /** 该条款处于对照组、未注入的运行数（反事实基线样本） */
        heldoutRuns: z.number().int().min(0).default(0),
        /** 对照组运行中成功收尾的次数（净增益基线分母来源） */
        holdoutAccepted: z.number().int().min(0).default(0),
      }),
    )
    .default({}),
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
    attribution: {},
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
    attribution: {},
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

/**
 * 去掉语篇纠正前缀（"不对，""不行，"），人的原话即条款（§4）。
 * ⚠ 刻意**不剥语义否定**（"不要 X""别 X"）——那些是指令的一部分，
 * 剥掉会导致 "不要使用爬虫" → "使用爬虫"（语义反转，实机发现 P1）。
 */
export function stripNegationPrefix(text: string): string {
  let out = text.trim();
  // 语篇纠正标记：只表示"你做错了"（剥掉后语义不变），不含"不要/别"（剥掉后意思反转）
  for (;;) {
    const next = out.replace(/^(?:不对|不行|不是|不好|错了|搞错|不是(?:这样|我要的|这个意思))[\s，,。.!！?？、]*/u, "").trim();
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

/**
 * 重新激活退役条款（生命周期面板「重新激活」按钮）：active 恢复 true，清掉退役留痕。
 * 只允许救回「仍可工作」的退役——被 supersede（被新条款取代）的不救，否则新旧条款同时注入。
 */
export function reactivateConstraint(ledger: ScenarioLedger, id: string): ScenarioLedger {
  return {
    ...ledger,
    constraints: ledger.constraints.map((c) => (c.id === id && c.supersededBy === null ? { ...c, active: true } : c)),
  };
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

/** gateStats 合并（recordRunOutcome 与构建收尾共用） */
export function applyGateEvents(ledger: ScenarioLedger, gateEvents: GateEventSummary, at: string = new Date().toISOString()): ScenarioLedger {
  const gateStats = { ...ledger.gateStats };
  for (const [gate, ev] of Object.entries(gateEvents)) {
    const prev = gateStats[gate] ?? { passes: 0, rejects: 0, edits: 0, lastEventAt: at };
    gateStats[gate] = {
      passes: prev.passes + (ev.passes ?? 0),
      rejects: prev.rejects + (ev.rejects ?? 0),
      edits: prev.edits + (ev.edits ?? 0),
      lastEventAt: at,
    };
  }
  return { ...ledger, gateStats };
}

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
  /** 两角色模型：本 run 实际注入的 active 条款 id（归因对象） */
  injectedConstraints?: string[];
  /** 两角色模型：本 run 是否为 15% 确定性对照组（advisory 被抽走、不归因） */
  holdout?: boolean;
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
  // holdout 轮是对照实验（条款被刻意抽走），不计 accepted/rejected/corrected/连胜——保持基线纯净。
  // 但 runs 仍然递增（运行确实发生了），确保 runs 与实际执行次数一致。
  if (!params.holdout) {
    if (!suspected) {
      if (params.outcome === "rejected") runStats.rejected += 1;
      else if (params.outcome === "corrected") runStats.corrected += 1;
      else if (acceptedSemantics && params.attended) runStats.accepted += 1;
    }
    if (negative || suspected) runStats.consecutiveClean = 0;
    else if (acceptedSemantics && params.attended) runStats.consecutiveClean += 1;
  }

  const gateStats = applyGateEvents(ledger, params.gateEvents ?? {}, at).gateStats;

  // inputPatterns 事件源（confidence 衰减计数 + 路由 digest 命中都读它）：
  // 有人值守 → 三种结果都记；无人值守 → 只记失败自证；suspected/holdout 不记。
  const inputPatterns = [...ledger.inputPatterns];
  const recordEvent = !suspected && !params.holdout && (params.attended || params.outcome === "rejected");
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

  // 两角色模型：条款反事实归因（§两角色 3.2）。
  // 规则：干净收尾 → 注入条款 helped++；打回/纠正 → hurt++；holdout 轮 → 不归因只计 heldoutRuns；
  // suspected 不归因（两边不可信）；无人值守不归因（没人看的成功不构成验证）。
  // 团队层条款（id 不在本场景 constraints 里）不落场景账本归因——它们的生命周期在
  // team-ledger.json，写进来只会积累永不消费的孤儿键。
  const knownIds = new Set(ledger.constraints.map((c) => c.id));
  const injectable = params.injectedConstraints?.filter((cid) => knownIds.has(cid)) ?? [];
  const attribution = { ...ledger.attribution };
  const attributable = !suspected && params.attended && !params.holdout;
  if (attributable && injectable.length) {
    for (const cid of injectable) {
      const entry = attribution[cid] ?? { helped: 0, hurt: 0, heldoutRuns: 0, holdoutAccepted: 0 };
      if (negative) entry.hurt += 1;
      else entry.helped += 1;
      attribution[cid] = entry;
    }
  }
  if (params.holdout && injectable.length) {
    // holdout 轮基线要「有人看的干净收尾」，与 helped 的口径对齐（attended + acceptedSemantics）
    const holdoutSuccess = params.attended && acceptedSemantics && !suspected;
    for (const cid of injectable) {
      const entry = attribution[cid] ?? { helped: 0, hurt: 0, heldoutRuns: 0, holdoutAccepted: 0 };
      entry.heldoutRuns += 1;
      if (holdoutSuccess) entry.holdoutAccepted += 1;
      attribution[cid] = entry;
    }
  }

  return { ...ledger, version: 1, runStats, gateStats, inputPatterns, interventions, constraints, attribution };
}

/** 自检可用条款：confirmedAt≠null 且 active 且未被 supersede（§10） */
export function activeConstraints(ledger: ScenarioLedger): Constraint[] {
  return ledger.constraints.filter((c) => c.confirmedAt !== null && c.active && c.supersededBy === null);
}

/** pendingConfirm 队列（闸门5 签约面数据源） */
export function pendingConstraints(ledger: ScenarioLedger): Constraint[] {
  return ledger.constraints.filter((c) => c.confirmedAt === null && c.active && c.supersededBy === null);
}

// ---------------------------------------------------------------------------
// 两角色模型（docs/两角色模型优化方案.md §3）：生命周期自动化 + 归因读取
// ---------------------------------------------------------------------------

/** 自动转正阈值：helped 达到该数且 hurt == 0（run 比回合重，取 2） */
export const AUTO_PROMOTE_HELPED = 2;
/** 自动退役阈值：hurt 达到该数（文件保留，召回跳过） */
export const AUTO_RETIRE_HURT = 2;

export type LifecycleChange = {
  id: string;
  action: "promote" | "retire";
  clause: string;
  reason: string;
};

/**
 * 生命周期自动评估（结算事务尾部调用；journal 由调用方落）。
 * 转正路径作用于 pendingConfirm（confirmedAt=null 的 advisory，helped≥2 → 自动签约）——
 * 闸5 人工签约仍是主路径，这里回填「用户忘了签但反复被验证」的条款。
 * 退役路径作用于 confirmed advisory（hurt≥2）；must_contain/must_not_contain 是标准，不自动退役。
 */
export function evaluateLifecycle(ledger: ScenarioLedger): { ledger: ScenarioLedger; changes: LifecycleChange[] } {
  const changes: LifecycleChange[] = [];
  const constraints = ledger.constraints.map((c) => {
    if (c.kind !== "advisory" || !c.active || c.supersededBy !== null) return c;
    const entry = ledger.attribution[c.id];
    if (!entry) return c;
    if (c.confirmedAt !== null) {
      // 已生效条款：只自动退役
      if (entry.hurt >= AUTO_RETIRE_HURT) {
        changes.push({ id: c.id, action: "retire", clause: c.clause, reason: `hurt=${entry.hurt} ≥ ${AUTO_RETIRE_HURT}` });
        return { ...c, active: false, supersededBy: "auto-retired" };
      }
      return c;
    }
    // pendingConfirm：反复被验证 → 自动转正
    if (entry.helped >= AUTO_PROMOTE_HELPED && entry.hurt === 0) {
      changes.push({ id: c.id, action: "promote", clause: c.clause, reason: `helped=${entry.helped}，hurt=0（自动签约）` });
      return { ...c, confirmedAt: new Date().toISOString() };
    }
    return c;
  });
  return { ledger: { ...ledger, constraints }, changes };
}

/** 单条款净增益：注入轮成功率 − 同条款 holdout 轮基线；任一路样本不足返回 null */
export function netGain(ledger: ScenarioLedger, id: string): number | null {
  const entry = ledger.attribution[id];
  if (!entry) return null;
  const injected = entry.helped + entry.hurt;
  if (injected < 1 || entry.heldoutRuns === 0) return null;
  return entry.helped / injected - entry.holdoutAccepted / entry.heldoutRuns;
}

// ---------------------------------------------------------------------------
// 防退化守卫（两角色模型 §3.5，灵感：MeowCode guard.ts 的 lossy update 检测）
// ---------------------------------------------------------------------------

/** 提取命令长参数（--flag），用于「缩短丢参」判断 */
function extractCommandFlags(text: string): string[] {
  const flags = new Set<string>();
  for (const match of text.matchAll(/--[A-Za-z][\w-]*/g)) {
    flags.add(match[0].toLowerCase());
  }
  return [...flags].sort();
}

/** 关键 token：命令 flag + 日期格式 + 字段名样式（UPPER_SNAKE / kebab / YYYY-MM-DD） */
function extractCriticalTokens(text: string): Set<string> {
  const tokens: Set<string> = new Set(extractCommandFlags(text));
  for (const m of text.matchAll(/\b[A-Z][A-Z_]{2,}\b/g)) tokens.add(m[0]);
  for (const m of text.matchAll(/\bYYYY[-_]MM[-_]DD\b|\b\d{4}-\d{2}-\d{2}\b/gi)) tokens.add(m[0].toUpperCase());
  for (const m of text.matchAll(/\b[a-z]{2,}(-[a-z]{2,}){2,}\b/g)) tokens.add(m[0]);
  return tokens;
}

/**
 * 防退化检测：同类条款更新时，新子句更短且丢了关键 token
 * （原 `pnpm publish --tag latest` 被"精炼"成 `pnpm publish` —— 表面更精炼，实际废了）。
 * 约束条款丢限定词永远是退化，不看长度比例（与技能场景的 60% 阈值不同）。
 * 返回 true = 拒绝并入，保留旧条款。
 */
export function looksLikeLossyUpdate(previous: string, next: string): boolean {
  const before = previous.trim();
  const after = next.trim();
  if (!before || !after) return false;
  if (after.length >= before.length) return false;
  const beforeTokens = extractCriticalTokens(before);
  if (!beforeTokens.size) return false;
  const afterTokens = extractCriticalTokens(after);
  return [...beforeTokens].some((token) => !afterTokens.has(token));
}

/**
 * 带防退化守卫的条款合并：找最相似的现有 active 条款（bigram Jaccard ≥0.6），
 * 若新文本相对它构成退化（更短且丢关键 token）→ 拒绝并入，保留旧条款。
 */
export function mergeConstraintGuarded(ledger: ScenarioLedger, input: ProposeInput): { ledger: ScenarioLedger; accepted: boolean } {
  const norm = (v: string) => v.toLowerCase().replace(/\s+/g, "");
  const incoming = norm(input.clause);
  let mostSimilar: Constraint | undefined;
  let bestScore = 0;
  for (const c of ledger.constraints) {
    if (!c.active || c.supersededBy !== null) continue;
    const a = norm(c.clause);
    const b = incoming;
    if (!a || !b) continue;
    const grams = (t: string): Set<string> => { const out = new Set<string>(); for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2)); return out; };
    const ga = grams(a); const gb = grams(b);
    let inter = 0; for (const g of ga) if (gb.has(g)) inter += 1;
    const score = ga.size + gb.size > 0 ? inter / (ga.size + gb.size - inter) : 0;
    if (score >= 0.6 && score > bestScore) { bestScore = score; mostSimilar = c; }
  }
  if (mostSimilar && looksLikeLossyUpdate(mostSimilar.clause, input.clause)) {
    return { ledger, accepted: false };
  }
  const proposed = proposeConstraint(ledger, input);
  if (!proposed) return { ledger, accepted: false };
  return { ledger: proposed.ledger, accepted: true };
}

export type RevisionProposal = ProposeInput & { /** added 块的稳定子串（两次命中升级 must_contain 的 pattern） */ upgradePattern?: string };

/**
 * 产出编辑修正事务（§7 Edit-to-Accept）：
 *  - 反应窗内（runId 未结算）→ 走 recordRunOutcome 的 corrected 完整事务（编辑优先于沉默）；
 *  - 沉默已入账（interventions 已有该 runId 且 correctionsGiven=0）→ 撤销错误自动接受：
 *    accepted--、corrected++、断连胜、interventions 行 correctionsGiven++；
 *  - 同 runId 多次编辑 → 只合并提案（条款去重），corrected 只计 1 次（首次纠正时的分支已锁死）；
 *  - added 类条款与既有 advisory 同义 → 机械升级 must_contain（§4 两次命中规则）。
 */
export function applyOutputCorrection(ledger: ScenarioLedger, params: { runId: string; digest?: string; at?: string; proposals: RevisionProposal[]; injectedConstraints?: string[] }): ScenarioLedger {
  const at = params.at ?? new Date().toISOString();
  let next = ledger;
  const ivRow = next.interventions.find((i) => i.runId === params.runId);
  if (!ivRow) {
    next = recordRunOutcome(next, {
      runId: params.runId,
      attended: true,
      outcome: "corrected",
      digest: params.digest,
      at,
      interventions: { gatesAnswered: 0, questionsAnswered: 0, correctionsGiven: 1 },
      injectedConstraints: params.injectedConstraints,
    });
  } else if (ivRow.correctionsGiven === 0) {
    // 沉默 accepted 已入账 → 修正为 corrected（撤销错误的自动接受）
    const runStats = { ...next.runStats };
    if (runStats.accepted > 0) runStats.accepted -= 1;
    runStats.corrected += 1;
    runStats.consecutiveClean = 0;
    const interventions = next.interventions.map((i) =>
      i.runId === params.runId ? { ...i, correctionsGiven: i.correctionsGiven + 1, total: i.total + 1 } : i,
    );
    // 归因同步翻转：结算时按 accepted 给注入条款记了 helped，用户亲手改产出说明那不算帮到 → helped-- hurt++
    const attribution = { ...next.attribution };
    for (const cid of params.injectedConstraints ?? []) {
      const entry = attribution[cid];
      if (!entry || entry.helped <= 0) continue;
      attribution[cid] = { ...entry, helped: entry.helped - 1, hurt: entry.hurt + 1 };
    }
    next = { ...next, runStats, interventions, attribution };
  }
  for (const proposal of params.proposals) {
    // §4 机械升级：added 块命中既有 advisory → 升级 must_contain（pattern=稳定子串），不再新增
    const upgradePattern = proposal.upgradePattern;
    if (upgradePattern) {
      const key = clauseKey(proposal.clause);
      const existing = next.constraints.find((c) => c.kind === "advisory" && c.active && c.supersededBy === null && clauseKey(c.clause) === key);
      if (existing) {
        next = upgradeToMustContain(next, existing.id, upgradePattern);
        continue;
      }
    }
    const { upgradePattern: _ignored, ...input } = proposal;
    const proposed = proposeConstraint(next, input);
    if (proposed) next = proposed.ledger;
  }
  return next;
}
