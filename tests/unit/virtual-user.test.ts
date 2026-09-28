import { describe, expect, it } from "vitest";
import { VirtualUser, approveAllUser } from "../virtual-user/driver";
import { GateDecisionSchema } from "@/orchestrator/state-machine";

describe("2.2.1.b 虚拟用户驱动器（三策略产出合法决策）", () => {
  it("approve-all：全部闸门产出 approve 且协议合法", () => {
    const user = approveAllUser();
    for (const g of [1, 2, 3, 4, 5] as const) {
      const d = user.decide(g, {});
      expect(GateDecisionSchema.safeParse(d).success).toBe(true);
      expect(d.action).toBe("approve");
    }
    expect(user.state.totalDecisions).toBe(5);
  });

  it("reject 策略：指定闸门驳回 N 次后放行", () => {
    const user = new VirtualUser({ kind: "reject", gate: 3, times: 2, targetPhase: "retrieving" });
    const d1 = user.decide(3, {});
    const d2 = user.decide(3, {});
    const d3 = user.decide(3, {});
    expect(d1.action).toBe("reject");
    expect(d1.targetPhase).toBe("retrieving");
    expect(d2.action).toBe("reject");
    expect(d3.action).toBe("approve"); // 第 3 次放行
    // 其他闸门不受影响
    expect(user.decide(1, {}).action).toBe("approve");
    expect(user.decide(5, {}).action).toBe("approve");
  });

  it("edit-gate1 策略：改槽位值后批准（编辑被真实应用）", () => {
    const user = new VirtualUser({ kind: "edit-gate1", slotName: "city", slotValue: "深圳" });
    const payload = { goal: "查天气", slots: [{ name: "city", value: "北京" }] };
    const d = user.decide(1, payload);
    expect(d.action).toBe("approve");
    expect((payload.slots ?? [])[0]?.value).toBe("深圳"); // 原对象被编辑
    expect(user.state.editsApplied).toBe(1);
  });

  it("edit-gate3 策略：换候选（第 pickIndex 个）后批准", () => {
    const user = new VirtualUser({ kind: "edit-gate3", pickIndex: 1, nodeId: "n1" });
    const payload = [
      { nodeId: "n1", candidates: [{ id: "a:fs" }, { id: "b:fs2" }] },
      { nodeId: "n2", candidates: [{ id: "c:x" }] },
    ];
    const d = user.decide(3, payload);
    expect(d.action).toBe("approve");
    expect(d.comment).toContain("b:fs2");
  });

  it("reject-cycle：连续驳回 N 轮后每轮都放行（压力路径用）", () => {
    const user = new VirtualUser({ kind: "reject-cycle", cycles: 5, gate: 4, targetPhase: "verifying" });
    const decisions = Array.from({ length: 7 }, () => user.decide(4, {}));
    expect(decisions.slice(0, 5).every((d) => d.action === "reject")).toBe(true);
    expect(decisions[5]?.action).toBe("approve");
    expect(decisions[6]?.action).toBe("approve");
  });
});
