import { z } from "zod";
import { PhaseSchema } from "@/core/errors.js";
import type { Capability } from "@/federation/types.js";

/** ── 2.1.1 BuildContext：一次场景构建的全部状态（可序列化、可断点恢复） ── */

export const IntentSchema = z.object({
  goal: z.string().min(1),
  domain: z.string().default("general"),
  slots: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
  keywords: z.array(z.string()).default([]),
  /** 解析来源：llm | template（降级标记） */
  via: z.enum(["llm", "template"]).default("template"),
});
export type Intent = z.infer<typeof IntentSchema>;

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
  action: z.enum(["approve", "reject"]),
  targetPhase: PhaseSchema.optional(),
  comment: z.string().optional(),
  decidedBy: z.enum(["human", "virtual-user"]),
  decidedAt: z.string(),
});
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;

export interface CandidateSet {
  nodeId: string;
  query: string;
  candidates: Capability[];
}

export interface AcceptanceRecord {
  layer: "component" | "task" | "generalization";
  nodeId?: string;
  passed: boolean;
  detail: Record<string, unknown>;
  at: string;
}

export interface ExecutionStep {
  nodeId: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "success" | "failed" | "skipped";
  output?: unknown;
  error?: string;
  /** 具体参数（蒸馏槽位化原料） */
  params?: Record<string, unknown>;
}

export const BuildContextSchema = z.object({
  id: z.string().min(1),
  phase: PhaseSchema,
  /** 闸门挂起时记录：哪个闸门在等决策 */
  pendingGate: z.number().int().min(1).max(5).nullable().default(null),
  requirement: z.string().min(1),
  intent: IntentSchema.nullable().default(null),
  dag: DagSchema.nullable().default(null),
  candidates: z.array(z.any()).default([]),
  selections: z.array(SelectionSchema).default([]),
  assembly: z.any().nullable().default(null),
  acceptance: z.array(z.any()).default([]),
  trace: z.array(z.any()).default([]),
  approvals: z.array(ApprovalRecordSchema).default([]),
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

export function newBuildContext(id: string, requirement: string, now = new Date().toISOString()): BuildContext {
  return {
    id,
    phase: "parsing",
    pendingGate: null,
    requirement,
    intent: null,
    dag: null,
    candidates: [],
    selections: [],
    assembly: null,
    acceptance: [],
    trace: [],
    approvals: [],
    skillNotes: [],
    createdAt: now,
    updatedAt: now,
  };
}
