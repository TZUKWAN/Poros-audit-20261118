import { z } from "zod";
import { ScenarioError, ScenarioErrorCode } from "@/core/errors.js";
import type { FederatedResult } from "@/federation/search.js";
import { probeRemote } from "@/federation/search.js";
import type { Capability } from "@/federation/types.js";
import type { DigestProducts } from "@/federation/skill-digest.js";
import type { BuildContext, Dag, Intent, RuntimeContext } from "./context.js";
import { BuildAwaitingUserError } from "./state-machine.js";
import { topoSort, parallelGroups } from "./dag.js";
import { canonicalName } from "@/federation/types.js";
import { routeDomain, profileOf } from "@/domains/profile.js";

/**
 * 2.3 阶段处理器。所有外部依赖（LLM/检索器/探活器/执行/蒸馏）可注入 —— 测试用桩，
 * 生产装配在 runner.ts。每个处理器只改 ctx，不做状态迁移（状态机负责）。
 */

export interface HandlerDeps {
  llm?: {
    /** 意图解析：返回结构化意图；抛错或畸形 → 调用方降级模板 */
    parseIntent(requirement: string, context?: RuntimeContext | null, clarificationAnswers?: Record<string, string>): Promise<unknown>;
    planTasks(intent: Intent, context?: RuntimeContext | null, clarificationAnswers?: Record<string, string>): Promise<unknown>;
    readonly lastFallbackReason?: string | null;
  };
  search: (query: string, limit?: number) => Promise<FederatedResult>;
  /** 技能矿流水线（2.3.3）：检索→克隆→提炼→注入→删除；注入产物写 ctx.skillNotes */
  skillMine?: (intent: Intent) => Promise<DigestProducts[]>;
  probe?: (cap: Capability) => Promise<{ available: boolean; latencyMs: number; message?: string }>;
  execute?: (ctx: BuildContext) => Promise<void>;
  distill?: (ctx: BuildContext) => Promise<void>;
}

// ── 2.3.1 parsing：意图解析（LLM + zod 校验；失败降级模板填空）──
export async function handleParsing(ctx: BuildContext, deps: HandlerDeps): Promise<void> {
  const requested = deps.llm ? "llm" : "template";
  ctx.planner = { requested, actual: requested, fallbackReason: null, attempts: 0 };
  if (deps.llm) {
    try {
      ctx.planner.attempts += 1;
      const raw = await deps.llm.parseIntent(ctx.requirement, ctx.runtimeContext, ctx.clarificationAnswers);
      const parsed = IntentSchema4.safeParse(raw);
      if (parsed.success) {
        if (parsed.data.clarification) {
          throw new BuildAwaitingUserError({ phase: "parsing", ...parsed.data.clarification });
        }
        ctx.intent = parsed.data;
        ctx.planner.actual = "llm";
        ctx.planner.fallbackReason = deps.llm.lastFallbackReason ?? null;
        return;
      }
      ctx.planner.actual = "template";
      ctx.planner.fallbackReason = "模型返回结构未通过 schema 校验";
    } catch (error) {
      if (error instanceof BuildAwaitingUserError) throw error;
      ctx.planner.actual = "template";
      ctx.planner.fallbackReason = error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240);
    }
  }
  ctx.intent = templateIntent(ctx.requirement);
}

const IntentSchema4 = z.object({
  goal: z.string().default(""),
  domain: z.string().default("general"),
  slots: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
  keywords: z.array(z.string()).default([]),
  via: z.enum(["llm", "template"]).default("llm"),
  clarification: z.object({
    question: z.string().min(1),
    inputs: z.array(z.object({ name: z.string().min(1), type: z.enum(["string", "path", "url", "number"]).default("string"), description: z.string().default("") })).min(1),
  }).optional(),
}).superRefine((value, refinement) => {
  if (!value.clarification && value.goal.trim().length === 0) {
    refinement.addIssue({ code: z.ZodIssueCode.custom, path: ["goal"], message: "goal is required unless clarification is present" });
  }
});

export function templateIntent(requirement: string): Intent {
  const words = requirement
    .toLowerCase()
    .split(/[\s，。,.;；!？?]+/)
    .filter((w) => w.length >= 2)
    .slice(0, 8);
  return {
    goal: requirement,
    domain: "general",
    slots: [],
    keywords: words,
    via: "template",
  };
}

// ── 2.3.2 planning：DAG 生成 + 拓扑/环校验 ──
export async function handlePlanning(ctx: BuildContext, deps: HandlerDeps): Promise<void> {
  if (!ctx.intent) {
    throw new ScenarioError({ code: ScenarioErrorCode.CONTEXT_CORRUPT, message: "planning without intent", phase: "planning" });
  }
  let dag: Dag | null = null;
  if (deps.llm) {
    try {
      if (!ctx.planner) ctx.planner = { requested: "llm", actual: "llm", fallbackReason: null, attempts: 0 };
      ctx.planner.attempts += 1;
      const raw = await deps.llm.planTasks(ctx.intent, ctx.runtimeContext, ctx.clarificationAnswers);
      const parsed = DagSchema2.safeParse(raw);
      if (parsed.success) {
        if (parsed.data.clarification) {
          throw new BuildAwaitingUserError({ phase: "planning", ...parsed.data.clarification });
        }
        topoSort(parsed.data); // 环/未知依赖校验
        dag = parsed.data;
        ctx.planner.actual = "llm";
        ctx.planner.fallbackReason = deps.llm.lastFallbackReason ?? null;
      }
    } catch (err) {
      if (err instanceof BuildAwaitingUserError) throw err;
      if (err instanceof ScenarioError && err.code === ScenarioErrorCode.VALIDATION) throw err; // 环被拒直接上抛
      if (ctx.planner) { ctx.planner.actual = "template"; ctx.planner.fallbackReason = err instanceof Error ? err.message.slice(0, 240) : String(err).slice(0, 240); }
    }
  }
  if (!dag) { dag = templateDag(ctx.intent); if (ctx.planner) { ctx.planner.actual = "template"; ctx.planner.fallbackReason ??= "规划模型未返回可用 DAG"; } }
  ctx.dag = dag;
}

const DagSchema2 = z.object({
  nodes: z.array(
    z.object({
      id: z.string().min(1),
      title: z.string().min(1),
      deps: z.array(z.string()).default([]),
      expectedOutput: z.string().default(""),
    }),
  ).default([]),
  clarification: z.object({
    question: z.string().min(1),
    inputs: z.array(z.object({ name: z.string().min(1), type: z.enum(["string", "path", "url", "number"]).default("string"), description: z.string().default("") })).min(1),
  }).optional(),
}).superRefine((value, refinement) => {
  if (!value.clarification && value.nodes.length === 0) {
    refinement.addIssue({ code: z.ZodIssueCode.custom, path: ["nodes"], message: "nodes must contain at least one task unless clarification is present" });
  }
});

export function templateDag(intent: Intent): Dag {
  // SceneFlow 领域路由：需求文本带竞赛/学术信号时落对应领域 DAG 模板，
  // 否则通用 3 节点。LLM planTasks 失败降级到这里，同样自动落域。
  const domain = routeDomain(`${intent.domain ?? ""} ${intent.goal}`);
  if (domain !== "core") {
    const profile = profileOf(domain);
    if (profile) return profile.templateDag(intent);
  }
  return {
    nodes: [
      { id: "n1", title: `为「${intent.goal.slice(0, 30)}」检索能力`, deps: [], expectedOutput: "候选能力列表" },
      { id: "n2", title: "装配并执行主流程", deps: ["n1"], expectedOutput: "执行结果" },
      { id: "n3", title: "验收与产出", deps: ["n2"], expectedOutput: "验收报告" },
    ],
  };
}

// ── 2.3.3 retrieving：每节点联邦检索 top5 + 技能矿流水线 ──
export async function handleRetrieving(ctx: BuildContext, deps: HandlerDeps): Promise<void> {
  if (!ctx.dag || !ctx.intent) {
    throw new ScenarioError({ code: ScenarioErrorCode.CONTEXT_CORRUPT, message: "retrieving without dag/intent", phase: "retrieving" });
  }
  const candidateSets: Array<{ nodeId: string; query: string; candidates: Capability[] }> = [];
  for (const node of ctx.dag.nodes) {
    const query = [node.title, ...ctx.intent.keywords.slice(0, 3)].join(" ");
    const result = await deps.search(query, 5);
    candidateSets.push({ nodeId: node.id, query, candidates: result.capabilities });
  }
  ctx.candidates = candidateSets;

  // 技能矿：检索→克隆→提炼→注入→删除（产物供 planning/assembling/验收消费）
  if (deps.skillMine) {
    const products = await deps.skillMine(ctx.intent);
    for (const p of products) {
      ctx.skillNotes.push({
        skillId: p.skillId,
        sourceUrl: p.sourceUrl,
        injectedInto: [
          ...(p.processFragments.length > 0 ? (["planning"] as const) : []),
          ...(p.capabilityLeads.length > 0 ? (["assembling"] as const) : []),
          ...(p.acceptancePoints.length > 0 ? (["acceptance"] as const) : []),
        ],
        digestedAt: new Date().toISOString(),
      });
    }
  }
}

// ── 2.3.4 assembling：选型 → 流水线图 + 接口粗对齐 ──
export async function handleAssembling(ctx: BuildContext, _deps: HandlerDeps): Promise<void> {
  if (!ctx.dag) {
    throw new ScenarioError({ code: ScenarioErrorCode.CONTEXT_CORRUPT, message: "assembling without dag", phase: "assembling" });
  }
  const sets = ctx.candidates as Array<{ nodeId: string; candidates: Capability[] }>;
  // Keep only selections that still belong to the current DAG and candidate
  // sets. A planning/retrieving rerun can change node ids or remove a
  // capability; carrying the old array forward makes the scheduler silently
  // skip newly planned nodes.
  const selections = ctx.selections.filter((selection) => {
    const node = ctx.dag?.nodes.some((candidate) => candidate.id === selection.nodeId);
    const set = sets.find((candidate) => candidate.nodeId === selection.nodeId);
    return Boolean(node && set?.candidates.some((candidate) => candidate.id === selection.capabilityId));
  });
  const nodes: Array<{ nodeId: string; capabilityId: string; glueNeeded: boolean }> = [];
  for (const node of ctx.dag.nodes) {
    const existing = selections.find((s) => s.nodeId === node.id);
    const set = sets.find((s) => s.nodeId === node.id);
    const pick = existing?.capabilityId ?? set?.candidates[0]?.id;
    if (!pick) {
      throw new ScenarioError({
        code: ScenarioErrorCode.NOT_FOUND,
        message: `no candidates for node ${node.id}`,
        phase: "assembling",
      });
    }
    nodes.push({ nodeId: node.id, capabilityId: pick, glueNeeded: false });
  }
  // 保存选型（闸门3 编辑后 overridden 标记由闸门层写入）。Always
  // normalize to the current DAG so a changed plan cannot leave stale or
  // missing selections behind.
  ctx.selections = nodes.map((n) => {
    const existing = selections.find((selection) => selection.nodeId === n.nodeId);
    return existing ?? { nodeId: n.nodeId, capabilityId: n.capabilityId, overridden: false };
  });
  // 接口粗对齐：上游 outputs vs 下游 inputs（用能力 tags/description 的关键词重叠近似；
  // 不匹配 → glue-needed 标注，供闸门4 展示与执行期生成胶水步骤）
  const edges = [];
  for (const node of ctx.dag.nodes) {
    for (const dep of node.deps) {
      const upstream = nodes.find((n) => n.nodeId === dep);
      const downstream = nodes.find((n) => n.nodeId === node.id);
      const upCap = findCap(sets, upstream?.capabilityId);
      const downCap = findCap(sets, downstream?.capabilityId);
      const alignment = alignInterfaces(upCap, downCap);
      edges.push({ from: dep, to: node.id, alignment: alignment.alignment, reason: alignment.reason });
      if (alignment.alignment === "glue-needed" && downstream) downstream.glueNeeded = true;
    }
  }
  ctx.assembly = { nodes, edges };
}

function findCap(sets: Array<{ nodeId: string; candidates: Capability[] }>, capId?: string): Capability | undefined {
  if (!capId) return undefined;
  for (const s of sets) {
    const hit = s.candidates.find((c) => c.id === capId);
    if (hit) return hit;
  }
  return undefined;
}

export function alignInterfaces(
  upstream: Capability | undefined,
  downstream: Capability | undefined,
): { alignment: "ok" | "glue-needed"; reason?: string } {
  if (!upstream || !downstream) return { alignment: "ok" };
  const upKind = upstream.install.type;
  const downKind = downstream.install.type;
  // 远程→本地 stdio 之类形态差异需要胶水；同类 MCP 工具链直连即可
  const shape = (k: string) => (k === "remote" ? "remote" : "local");
  if (shape(upKind) !== shape(downKind)) {
    return { alignment: "glue-needed", reason: `upstream ${upKind} vs downstream ${downKind} 形态不一致` };
  }
  const overlap = upstream.tags.some((t) => downstream.tags.map((x) => canonicalName(x)).includes(canonicalName(t)));
  if (!overlap && upstream.tags.length > 0 && downstream.tags.length > 0) {
    return { alignment: "glue-needed", reason: "无共享能力域标签" };
  }
  return { alignment: "ok" };
}

// ── 2.3.5 verifying（构建期）：组件级探活编排（远程优先）──
export async function handleVerifying(ctx: BuildContext, deps: HandlerDeps): Promise<void> {
  if (!ctx.assembly) {
    throw new ScenarioError({ code: ScenarioErrorCode.CONTEXT_CORRUPT, message: "verifying without assembly", phase: "verifying" });
  }
  const probe = deps.probe;
  const results: Array<{ capabilityId: string; available: boolean; latencyMs: number; message?: string }> = [];
  const assembly = ctx.assembly as { nodes: Array<{ nodeId: string; capabilityId: string }> };
  const sets = ctx.candidates as Array<{ nodeId: string; candidates: Capability[] }>;
  for (const n of assembly.nodes) {
    const cap = findCap(sets, n.capabilityId);
    if (!cap) continue;
    const r = probe ? await probe(cap) : cap.remoteRun ? await probeRemote(cap) : { available: false, latencyMs: 0, message: "capability probe is not configured" };
    results.push({ capabilityId: cap.id, ...r });
  }
  ctx.acceptance.push({
    layer: "component",
    passed: results.length > 0 && results.every((r) => r.available),
    detail: { probes: results },
    at: new Date().toISOString(),
  });
}

// ── 2.3.6/2.3.7 执行与蒸馏：委托阶段四/六（本阶段桩）──
export async function handleExecuting(ctx: BuildContext, deps: HandlerDeps): Promise<void> {
  if (deps.execute) {
    await deps.execute(ctx);
    return;
  }
  // 未装配执行器时明确失败，不能把开发桩记录成真实成功。
  const assembly = ctx.assembly as { nodes: Array<{ nodeId: string }> } | null;
  for (const n of assembly?.nodes ?? []) {
    ctx.trace.push({
      nodeId: n.nodeId,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      status: "failed",
      error: "execution handler is not configured",
    });
  }
  ctx.acceptance.push({ layer: "task", passed: false, detail: { reason: "execution handler is not configured" }, at: new Date().toISOString() });
}

export async function handleDistilling(ctx: BuildContext, deps: HandlerDeps): Promise<void> {
  if (deps.distill) {
    await deps.distill(ctx);
    return;
  }
  ctx.acceptance.push({
    layer: "generalization",
    passed: false,
    detail: { reason: "distillation handler is not configured" },
    at: new Date().toISOString(),
  });
}

/** 并行分组暴露给执行底座（阶段四使用） */
export function planGroups(ctx: BuildContext): string[][] {
  if (!ctx.dag) return [];
  return parallelGroups(ctx.dag);
}
