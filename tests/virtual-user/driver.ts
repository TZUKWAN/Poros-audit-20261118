import type { GateDecision } from "@/orchestrator/state-machine.js";

/**
 * 2.2 虚拟用户驱动器 —— 按策略脚本产出 GateDecision，供全部测试与 e2e 使用
 * （协议 D 条：产品内五道闸门由虚拟用户代为决策；真实人工交互代码照常实现，测试不依赖真人）。
 */

export type VirtualUserStrategy =
  | { kind: "approve-all" }
  | { kind: "reject"; gate: 1 | 2 | 3 | 4 | 5; times: number; targetPhase: "parsing" | "planning" | "retrieving" | "assembling" | "verifying" | "executing" | "distilling"; comment?: string }
  | { kind: "edit-gate1"; slotName: string; slotValue: string }
  | { kind: "edit-gate3"; pickIndex: number; nodeId?: string }
  | { kind: "reject-cycle"; cycles: number; gate: 1 | 2 | 3 | 4 | 5; targetPhase: "parsing" | "planning" | "retrieving" | "assembling" | "verifying" | "executing" | "distilling" };

export interface VirtualUserState {
  gateSeen: Record<number, number>;
  totalDecisions: number;
  editsApplied: number;
}

export class VirtualUser {
  readonly state: VirtualUserState = { gateSeen: {}, totalDecisions: 0, editsApplied: 0 };

  constructor(private strategy: VirtualUserStrategy) {}

  /** 依据策略对挂起的闸门产出决策（纯函数式，不触碰编排器内部） */
  decide(gate: 1 | 2 | 3 | 4 | 5, payload: unknown): GateDecision {
    this.state.totalDecisions++;
    this.state.gateSeen[gate] = (this.state.gateSeen[gate] ?? 0) + 1;
    const seen = this.state.gateSeen[gate];
    const strategy = this.strategy;

    switch (strategy.kind) {
      case "approve-all":
        return { gate, action: "approve" };

      case "reject": {
        if (gate === strategy.gate && seen <= strategy.times) {
          return {
            gate,
            action: "reject",
            targetPhase: strategy.targetPhase,
            comment: strategy.comment ?? `virtual-user scripted rejection #${seen}`,
          };
        }
        return { gate, action: "approve" };
      }

      case "reject-cycle": {
        // 连续驳回 N 轮后放行（R3.1 压力路径）
        if (gate === strategy.gate && seen <= strategy.cycles) {
          return { gate, action: "reject", targetPhase: strategy.targetPhase, comment: `cycle ${seen}` };
        }
        return { gate, action: "approve" };
      }

      case "edit-gate1": {
        // 闸门1：改槽位后批准
        if (gate === 1) {
          this.state.editsApplied++;
          const intent = payload as { slots?: Array<{ name: string; value: string }> } | null;
          if (intent && Array.isArray(intent.slots)) {
            const slot = intent.slots.find((s) => s.name === strategy.slotName);
            if (slot) slot.value = strategy.slotValue;
          }
          return { gate: 1, action: "approve", comment: `edited slot ${strategy.slotName}` };
        }
        return { gate, action: "approve" };
      }

      case "edit-gate3": {
        // 闸门3：换候选（把指定节点的选中候选改为第 pickIndex 个）
        if (gate === 3) {
          this.state.editsApplied++;
          const sets = payload as Array<{ nodeId: string; candidates: Array<{ id: string }> }>;
          const set = strategy.nodeId ? sets.find((s) => s.nodeId === strategy.nodeId) : sets[0];
          const picked = set?.candidates[strategy.pickIndex];
          return {
            gate: 3,
            action: "approve",
            comment: picked ? `switched ${set?.nodeId} → ${picked.id}` : "edit requested but candidate missing",
          };
        }
        return { gate, action: "approve" };
      }
    }
  }
}

/** 便捷：全程批准驱动器 */
export function approveAllUser(): VirtualUser {
  return new VirtualUser({ kind: "approve-all" });
}
