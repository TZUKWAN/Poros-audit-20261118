import { z } from "zod";
import type { BuildContext, ExecutionStep } from "@/orchestrator/context.js";

/**
 * 阶段六 6.1 蒸馏器：升维四变换。
 *  ① 槽位化：扫描执行轨迹具体参数 → SlotDef
 *  ② 分支化：回退/修复记录 → 变体分支
 *  ③ 验收泛化：具体值 → 槽位表达式
 *  ④ 意图签名：嵌入向量（注入式；缺省词袋近似）+ 关键词集
 */

export const SlotDefSchema = z.object({
  name: z.string(),
  type: z.enum(["string", "number", "path", "url"]),
  sourceNodeId: z.string(),
  examples: z.array(z.string()).min(1),
});
export type SlotDef = z.infer<typeof SlotDefSchema>;

export interface VariantBranch {
  /** 触发分支的失败形态（修复记录中的错误签名） */
  trigger: string;
  /** 分支动作：换型后的能力 */
  fallbackCapabilityId: string;
  nodeId: string;
}

export interface AcceptanceTemplate {
  layer: "component" | "task" | "generalization";
  /** 槽位表达式（原具体值已被 {{slot}} 替换） */
  expression: string;
}

export interface IntentSignature {
  keywords: string[];
  /** 嵌入向量（注入式生成；缺省为词袋 hash 向量） */
  embedding: number[];
  embedVia: "injected" | "bag-of-words";
}

export interface DistilledScenario {
  slotDefs: SlotDef[];
  branches: VariantBranch[];
  acceptanceTemplates: AcceptanceTemplate[];
  signature: IntentSignature;
  /** 固化来源 */
  buildId: string;
  pinnedVersion: number;
}

// ── ① 槽位化 ──

const SLOT_VALUE_RE = /^[^\s"]{2,120}$/;

/**
 * 从执行轨迹参数中抽槽位：同一参数位出现 ≥1 次、值为标量即成槽；
 * 名称取参数键；示例值取全部观测值（≤3）。
 */
export function slotize(trace: ExecutionStep[]): SlotDef[] {
  const byKey = new Map<string, { sourceNodeId: string; values: Set<string> }>();
  for (const step of trace) {
    if (step.status !== "success" || !step.params) continue;
    for (const [key, value] of Object.entries(step.params)) {
      if (typeof value !== "string" || !SLOT_VALUE_RE.test(value)) continue;
      const entry = byKey.get(key) ?? { sourceNodeId: step.nodeId, values: new Set<string>() };
      entry.values.add(value);
      byKey.set(key, entry);
    }
  }
  const slots: SlotDef[] = [];
  for (const [name, entry] of byKey) {
    slots.push({
      name,
      type: classifyType([...entry.values][0] ?? ""),
      sourceNodeId: entry.sourceNodeId,
      examples: [...entry.values].slice(0, 3),
    });
  }
  return slots;
}

function classifyType(value: string): SlotDef["type"] {
  if (/^https?:\/\//.test(value)) return "url";
  if (value.startsWith("/") || /^[a-zA-Z]:\\/.test(value)) return "path";
  if (/^-?\d+(\.\d+)?$/.test(value)) return "number";
  return "string";
}

// ── ② 分支化 ──

/** 修复/回退记录 → 变体分支（1 次换型 → 1 条分支） */
export function branchize(ctx: BuildContext): VariantBranch[] {
  const branches: VariantBranch[] = [];
  const seen = new Set<string>();
  for (const acc of ctx.acceptance) {
    const detail = acc.detail as { attempts?: Array<{ failedCapabilityId: string; switchedTo?: string }> };
    for (const attempt of detail.attempts ?? []) {
      if (!attempt.switchedTo || attempt.switchedTo === attempt.failedCapabilityId) continue;
      const key = `${attempt.failedCapabilityId}->${attempt.switchedTo}`;
      if (seen.has(key)) continue;
      seen.add(key);
      branches.push({
        trigger: `capability-failed:${attempt.failedCapabilityId}`,
        fallbackCapabilityId: attempt.switchedTo,
        nodeId: findNodeForCapability(ctx, attempt.failedCapabilityId),
      });
    }
  }
  return branches;
}

function findNodeForCapability(ctx: BuildContext, capabilityId: string): string {
  const sel = ctx.selections.find((s) => s.capabilityId === capabilityId);
  return sel?.nodeId ?? "unknown";
}

// ── ③ 验收泛化 ──

/** 具体验收值 → 槽位表达式：{{slot}} 替换（改写后不含原值） */
export function generalizeAcceptance(ctx: BuildContext, slots: SlotDef[]): AcceptanceTemplate[] {
  const templates: AcceptanceTemplate[] = [];
  const valuesToSlots = new Map<string, string>();
  for (const s of slots) {
    for (const ex of s.examples) valuesToSlots.set(ex, s.name);
  }
  for (const acc of ctx.acceptance) {
    let detail = JSON.stringify(acc.detail);
    for (const [value, slot] of valuesToSlots) {
      detail = detail.split(JSON.stringify(value)).join(JSON.stringify(`{{${slot}}}`));
      detail = detail.split(value).join(`{{${slot}}}`);
    }
    templates.push({ layer: acc.layer, expression: detail.slice(0, 400) });
  }
  return templates;
}

// ── ④ 意图签名 ──

export interface Embedder {
  embed(text: string): Promise<number[]>;
}

/** 词袋 hash 嵌入（确定性、无网络）：64 维，token hash 取模累加 */
export function bagOfWordsEmbed(text: string, dims = 64): number[] {
  const vec = new Array<number>(dims).fill(0);
  const tokens = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0);
  for (const token of tokens) {
    let h = 2166136261;
    for (let i = 0; i < token.length; i++) {
      h ^= token.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const idx = Math.abs(h) % dims;
    vec[idx] = (vec[idx] ?? 0) + 1;
  }
  const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0)) || 1;
  return vec.map((v) => v / norm);
}

export async function intentSignature(goal: string, keywords: string[], embedder?: Embedder): Promise<IntentSignature> {
  if (embedder) {
    return { keywords, embedding: await embedder.embed(`${goal} ${keywords.join(" ")}`), embedVia: "injected" };
  }
  return { keywords, embedding: bagOfWordsEmbed(`${goal} ${keywords.join(" ")}`), embedVia: "bag-of-words" };
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/** 完整蒸馏：Build Context + 报告 → DistilledScenario */
export async function distill(ctx: BuildContext, embedder?: Embedder): Promise<DistilledScenario> {
  const slotDefs = slotize(ctx.trace as ExecutionStep[]);
  const branches = branchize(ctx);
  const acceptanceTemplates = generalizeAcceptance(ctx, slotDefs);
  const signature = await intentSignature(ctx.intent?.goal ?? ctx.requirement, ctx.intent?.keywords ?? [], embedder);
  return {
    slotDefs,
    branches,
    acceptanceTemplates,
    signature,
    buildId: ctx.id,
    pinnedVersion: 1,
  };
}
