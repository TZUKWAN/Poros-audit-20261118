import { z } from "zod";
import { ScenarioError, ScenarioErrorCode } from "@/core/errors.js";
import { GateDecisionSchema } from "@/orchestrator/state-machine.js";
import type { GateDecision } from "@/orchestrator/state-machine.js";
import type { ApprovalRecord } from "@/orchestrator/context.js";

export { GateDecisionSchema };
export type { GateDecision };

/**
 * 3.1 闸门框架：五闸门注册表 + 决策协议 + 决策记录器。
 * TUI/Web/虚拟用户三方共用同一协议与记录格式（approvals[] → Memory）。
 */

export const GATE_NAMES = {
  1: "意图确认",
  2: "任务清单",
  3: "能力选型",
  4: "装配与验收",
  5: "固化评审",
} as const;

export type GateId = 1 | 2 | 3 | 4 | 5;

export interface GateDefinition {
  id: GateId;
  name: string;
  /** 该闸门允许的驳回回退目标（人工可选项，虚拟用户脚本亦从此取默认） */
  defaultRejectTarget: "parsing" | "planning" | "retrieving" | "assembling" | "verifying" | "executing" | "distilling";
  /** 决策提示语（TUI/Web 共用） */
  prompt: string;
}

export const GATES: Record<GateId, GateDefinition> = {
  1: { id: 1, name: GATE_NAMES[1], defaultRejectTarget: "parsing", prompt: "确认意图与槽位；可逐项编辑后批准" },
  2: { id: 2, name: GATE_NAMES[2], defaultRejectTarget: "planning", prompt: "审阅任务清单；可增删节点/改依赖（环即时提示）" },
  3: { id: 3, name: GATE_NAMES[3], defaultRejectTarget: "retrieving", prompt: "能力选型：单选/换批/自定义" },
  4: { id: 4, name: GATE_NAMES[4], defaultRejectTarget: "assembling", prompt: "审阅装配图与三层验收清单" },
  5: { id: 5, name: GATE_NAMES[5], defaultRejectTarget: "planning", prompt: "固化评审：升维前后对照 + 泛化结果，三选一" },
};

/** 闸门5 三选一（固化评审的专属决策动作） */
export const FinalizeChoiceSchema = z.object({
  choice: z.enum(["pin", "rerun", "discard"]),
});
export type FinalizeChoice = z.infer<typeof FinalizeChoiceSchema>;

/** 决策记录器：approvals[] 已由状态机写入；此处补 Memory 写入接口（阶段七接真实现） */
export interface DecisionMemory {
  recordApproval(buildId: string, record: ApprovalRecord): Promise<void>;
}

/** 桩 Memory：阶段七替换为三层 Memory 实现 */
export class StubDecisionMemory implements DecisionMemory {
  readonly records: Array<{ buildId: string; record: ApprovalRecord }> = [];
  async recordApproval(buildId: string, record: ApprovalRecord): Promise<void> {
    this.records.push({ buildId, record });
  }
}

export function validateDecision(raw: unknown): GateDecision {
  const parsed = GateDecisionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ScenarioError({
      code: ScenarioErrorCode.VALIDATION,
      message: "GateDecision 协议校验失败",
      phase: "infra",
      context: { issues: parsed.error.issues.slice(0, 3) },
    });
  }
  return parsed.data;
}
