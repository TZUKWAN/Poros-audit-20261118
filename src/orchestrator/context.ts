import { z } from "zod";
import { PhaseSchema } from "@/core/errors.js";
import { CapabilitySchema, type Capability } from "@/federation/types.js";

/** ── 2.1.1 BuildContext：一次场景构建的全部状态（可序列化、可断点恢复） ── */

export const IntentSchema = z.object({
  goal: z.string().min(1),
  domain: z.string().default("general"),
  slots: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
  keywords: z.array(z.string()).default([]),
  /** 解析来源：llm | template（降级标记） */
  via: z.enum(["llm", "template"]).default("template"),
  /** 模型发现目标含义或执行输入不足时提出的真实澄清请求。 */
  clarification: z.object({
    question: z.string().min(1),
    inputs: z.array(z.object({
      name: z.string().min(1),
      type: z.enum(["string", "path", "url", "number"]).default("string"),
      description: z.string().default(""),
    })).min(1),
  }).optional(),
});
export type Intent = z.infer<typeof IntentSchema>;

/**
 * A model-originated clarification is persisted in BuildContext. Keeping the
 * request structured means the UI can render fields and the resume path can
 * validate the answer without guessing from prose.
 */
export const BuildClarificationSchema = z.object({
  phase: z.enum(["parsing", "planning"]),
  question: z.string().min(1),
  inputs: z.array(z.object({
    name: z.string().min(1),
    type: z.enum(["string", "path", "url", "number"]).default("string"),
    description: z.string().default(""),
  })).min(1),
  source: z.literal("model"),
  createdAt: z.string(),
});
export type BuildClarification = z.infer<typeof BuildClarificationSchema>;


export const TaskNodeSchema: z.ZodType<TaskNode> = z.lazy(() =>
  z.object({
    id: z.string(),
    title: z.string(),
    deps: z.array(z.string()).default([]),
    expectedOutput: z.string().default(""),
  }),
);
export interface TaskNode {
  id: string;
  title: string;
  deps: string[];
  expectedOutput: string;
}

export const DagSchema = z.object({
  nodes: z.array(TaskNodeSchema).min(1),
});
export type Dag = z.infer<typeof DagSchema>;

export const SelectionSchema = z.object({
  nodeId: z.string(),
  capabilityId: z.string(),
  /** 是否闸门3后人工/虚拟用户换批而来 */
  overridden: z.boolean().default(false),
});
export type Selection = z.infer<typeof SelectionSchema>;

export const AcceptanceRecordSchema = z.object({
  layer: z.enum(["component", "task", "generalization"]),
  nodeId: z.string().optional(),
  passed: z.boolean(),
  detail: z.record(z.string(), z.unknown()).default({}),
  at: z.string(),
});
export type AcceptanceRecord = z.infer<typeof AcceptanceRecordSchema>;

export interface PipelineEdge {
  from: string;
  to: string;
  /** 接口粗对齐结果（2.3.4）：ok | glue-needed */
  alignment: "ok" | "glue-needed";
  reason?: string;
}

export interface AssemblyGraph {
  nodes: Array<{ nodeId: string; capabilityId: string; glueNeeded: boolean }>;
  edges: PipelineEdge[];
}

export const ApprovalRecordSchema = z.object({
  gate: z.number().int().min(1).max(5),
  action: z.enum(["approve", "reject", "edit"]),
  targetPhase: PhaseSchema.optional(),
  comment: z.string().optional(),
  edit: z.unknown().optional(),
  choice: z.enum(["pin", "rerun", "discard"]).optional(),
  decidedBy: z.enum(["human", "virtual-user"]),
  decidedAt: z.string(),
});
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;

export interface CandidateSet {
  nodeId: string;
  query: string;
  candidates: Capability[];
}

export const CandidateSetSchema = z.object({
  nodeId: z.string(),
  query: z.string(),
  candidates: z.array(CapabilitySchema),
});

export interface ExecutionStep {
  nodeId: string;
  capabilityId?: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "success" | "failed" | "skipped" | "delegated" | "planned";
  output?: unknown;
  error?: string;
  /** 具体参数（蒸馏槽位化原料） */
  params?: Record<string, unknown>;
}

export const ExecutionStepSchema = z.object({
  nodeId: z.string(),
  capabilityId: z.string().optional(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  status: z.enum(["running", "success", "failed", "skipped", "delegated", "planned"]),
  output: z.unknown().optional(),
  error: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});

export const FinalizeChoiceSchema = z.enum(["pin", "rerun", "discard"]);
export type FinalizeChoice = z.infer<typeof FinalizeChoiceSchema>;

/** 运行时上下文快照：在开始运行时冻结项目指令、文件摘要、Memory 引用和 Provider 能力，保证刷新/重试不会漂移。 */
export const RuntimeContextSchema = z.object({
  projectId: z.string().nullable().default(null),
  projectInstructions: z.string().default(""),
  files: z.array(z.object({ id: z.string(), name: z.string(), path: z.string(), mediaType: z.string(), size: z.number().int().nonnegative(), content: z.string().optional() })).default([]),
  memories: z.array(z.object({ id: z.string(), name: z.string(), scope: z.string(), content: z.string(), sourceType: z.string(), sourceId: z.string().nullable() })).default([]),
  connectors: z.array(z.object({ id: z.string(), name: z.string(), kind: z.string(), permissionScopes: z.array(z.string()), status: z.string() })).default([]),
  desktopContexts: z.array(z.object({ id: z.string(), kind: z.string(), origin: z.string(), label: z.string(), content: z.string() })).default([]),
  provider: z.object({ id: z.string().nullable(), baseUrl: z.string(), model: z.string(), timeoutMs: z.number().int().positive() }).nullable().default(null),
});
export type RuntimeContext = z.infer<typeof RuntimeContextSchema>;

export const PlannerRunSchema = z.object({ requested: z.enum(["llm", "template"]), actual: z.enum(["llm", "template"]), fallbackReason: z.string().nullable().default(null), attempts: z.number().int().nonnegative().default(0) });
export type PlannerRun = z.infer<typeof PlannerRunSchema>;

export const BuildContextSchema = z.object({
  id: z.string().min(1),
  phase: PhaseSchema,
  /** 闸门挂起时记录：哪个闸门在等决策 */
  pendingGate: z.number().int().min(1).max(5).nullable().default(null),
  requirement: z.string().min(1),
  /** User answers accumulated across resumable model clarifications. */
  clarificationAnswers: z.record(z.string(), z.string()).default({}),
  /** Non-terminal build suspension waiting for an explicit user answer. */
  awaitingUser: BuildClarificationSchema.nullable().default(null),
  /** construction = definition mapping only; run = external execution requested */
  executionMode: z.enum(["run", "construction"]).default("run"),
  runtimeContext: RuntimeContextSchema.nullable().default(null),
  planner: PlannerRunSchema.nullable().default(null),
  intent: IntentSchema.nullable().default(null),
  dag: DagSchema.nullable().default(null),
  candidates: z.array(CandidateSetSchema).default([]),
  selections: z.array(SelectionSchema).default([]),
  assembly: z
    .object({
      nodes: z.array(z.object({ nodeId: z.string(), capabilityId: z.string(), glueNeeded: z.boolean() })),
      edges: z.array(z.object({ from: z.string(), to: z.string(), alignment: z.enum(["ok", "glue-needed"]), reason: z.string().optional() })),
    })
    .nullable()
    .default(null),
  acceptance: z.array(AcceptanceRecordSchema).default([]),
  trace: z.array(ExecutionStepSchema).default([]),
  approvals: z.array(ApprovalRecordSchema).default([]),
  finalizeChoice: FinalizeChoiceSchema.nullable().default(null),
  outcome: z.enum(["running", "completed", "failed", "discarded"]).default("running"),
  distilled: z.unknown().nullable().default(null),
  /** 技能矿产物注入记录（2.3.3） */
  skillNotes: z
    .array(
      z.object({
        skillId: z.string(),
        sourceUrl: z.string(),
        injectedInto: z.array(z.enum(["planning", "assembling", "acceptance"])),
        digestedAt: z.string(),
      }),
    )
    .default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type BuildContext = z.infer<typeof BuildContextSchema>;

export function newBuildContext(id: string, requirement: string, now = new Date().toISOString(), runtimeContext: RuntimeContext | null = null, executionMode: "run" | "construction" = "run"): BuildContext {
  return {
    id,
    phase: "parsing",
    pendingGate: null,
    requirement,
    clarificationAnswers: {},
    awaitingUser: null,
    executionMode,
    runtimeContext,
    planner: null,
    intent: null,
    dag: null,
    candidates: [],
    selections: [],
    assembly: null,
    acceptance: [],
    trace: [],
    approvals: [],
    finalizeChoice: null,
    outcome: "running",
    distilled: null,
    skillNotes: [],
    createdAt: now,
    updatedAt: now,
  };
}
