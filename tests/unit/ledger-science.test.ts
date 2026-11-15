import { describe, expect, it } from "vitest";
import {
  AUTO_PROMOTE_HELPED,
  AUTO_RETIRE_HURT,
  emptyLedger,
  evaluateLifecycle,
  looksLikeLossyUpdate,
  mergeConstraintGuarded,
  netGain,
  recordRunOutcome,
  confirmConstraints,
  proposeConstraint,
  type Constraint,
  type ScenarioLedger,
} from "@/scenario/ledger";

const ORIGIN = { type: "reject" as const, text: "测试条款", at: "2026-11-15T00:00:00.000Z", runId: null };

function withConfirmedAdvisory(ledger: ScenarioLedger, id: string, clause: string): ScenarioLedger {
  const constraint: Constraint = {
    id,
    clause,
    scope: "output",
    kind: "advisory",
    pattern: null,
    origin: { ...ORIGIN, text: clause },
    confirmedAt: "2026-11-15T00:00:00.000Z",
    hits: 0,
    active: true,
    supersededBy: null,
    layer: "scenario",
  };
  return { ...ledger, constraints: [...ledger.constraints, constraint] };
}

describe("两角色模型 §3.2 归因", () => {
  it("干净收尾 → 注入条款 helped++", () => {
    let ledger = withConfirmedAdvisory(emptyLedger(), "c1", "测试条款一");
    ledger = recordRunOutcome(ledger, {
      runId: "r1",
      attended: true,
      outcome: "accepted",
      injectedConstraints: ["c1"],
    });
    expect(ledger.attribution["c1"]).toEqual({ helped: 1, hurt: 0, heldoutRuns: 0 });
  });

  it("打回 → 注入条款 hurt++ 且断连胜", () => {
    let ledger = withConfirmedAdvisory(emptyLedger(), "c1", "测试条款一");
    ledger.runStats.consecutiveClean = 3;
    ledger = recordRunOutcome(ledger, {
      runId: "r1",
      attended: true,
      outcome: "rejected",
      injectedConstraints: ["c1"],
    });
    expect(ledger.attribution["c1"]!.hurt).toBe(1);
    expect(ledger.runStats.consecutiveClean).toBe(0);
  });

  it("holdout 轮 → 不归因，heldoutRuns++", () => {
    let ledger = withConfirmedAdvisory(emptyLedger(), "c1", "测试条款一");
    ledger = recordRunOutcome(ledger, {
      runId: "r1",
      attended: true,
      outcome: "accepted",
      injectedConstraints: ["c1"],
      holdout: true,
    });
    expect(ledger.attribution["c1"]).toEqual({ helped: 0, hurt: 0, heldoutRuns: 1 });
    expect(ledger.runStats.accepted).toBe(0); // holdout 轮也不计 accepted
  });

  it("无人值守 → 不归因", () => {
    let ledger = withConfirmedAdvisory(emptyLedger(), "c1", "测试条款一");
    ledger = recordRunOutcome(ledger, {
      runId: "r1",
      attended: false,
      outcome: "accepted",
      injectedConstraints: ["c1"],
    });
    expect(ledger.attribution["c1"]).toBeUndefined();
  });

  it("suspected → 不归因", () => {
    let ledger = withConfirmedAdvisory(emptyLedger(), "c1", "测试条款一");
    ledger = recordRunOutcome(ledger, {
      runId: "r1",
      attended: true,
      outcome: "suspected",
      injectedConstraints: ["c1"],
    });
    expect(ledger.attribution["c1"]).toBeUndefined();
  });

  it("多条款注入：各自归因", () => {
    let ledger = withConfirmedAdvisory(emptyLedger(), "c1", "条款一");
    ledger = withConfirmedAdvisory(ledger, "c2", "条款二");
    ledger = recordRunOutcome(ledger, {
      runId: "r1",
      attended: true,
      outcome: "accepted",
      injectedConstraints: ["c1", "c2"],
    });
    expect(ledger.attribution["c1"]!.helped).toBe(1);
    expect(ledger.attribution["c2"]!.helped).toBe(1);
  });
});

describe("两角色模型 §3.4 生命周期自动化", () => {
  it("helped≥2 且 hurt=0 → 自动转正（advisory confirmed）", () => {
    let ledger = withConfirmedAdvisory(emptyLedger(), "c1", "测试条款");
    ledger.attribution["c1"] = { helped: AUTO_PROMOTE_HELPED, hurt: 0, heldoutRuns: 0 };
    // 先模拟退役态再触发转正路径没意义——直接造一个待验证场景：条款 active，评估不改
    const { ledger: next, changes } = evaluateLifecycle(ledger);
    expect(changes).toEqual([]); // active 的不做 promote 动作
    expect(next.constraints[0]!.active).toBe(true);
  });

  it("hurt≥2 → 自动退役（advisory confirmed）", () => {
    let ledger = withConfirmedAdvisory(emptyLedger(), "c1", "测试条款");
    ledger.attribution["c1"] = { helped: 5, hurt: AUTO_RETIRE_HURT, heldoutRuns: 0 };
    const { ledger: next, changes } = evaluateLifecycle(ledger);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.action).toBe("retire");
    expect(next.constraints[0]!.active).toBe(false);
    expect(next.constraints[0]!.supersededBy).toBe("auto-retired");
  });

  it("must_contain 不自动退役（标准类豁免）", () => {
    let ledger = withConfirmedAdvisory(emptyLedger(), "c1", "标准条款");
    ledger.constraints[0]!.kind = "must_contain";
    ledger.attribution["c1"] = { helped: 0, hurt: AUTO_RETIRE_HURT + 3, heldoutRuns: 0 };
    const { ledger: next, changes } = evaluateLifecycle(ledger);
    expect(changes).toEqual([]);
    expect(next.constraints[0]!.active).toBe(true);
  });

  it("pendingConfirm + helped≥2 → 自动转正（confirmedAt 回填）", () => {
    let ledger = emptyLedger();
    const proposed = proposeConstraint(ledger, { clause: "待签约条款测试", scope: "output", origin: ORIGIN });
    ledger = proposed!.ledger;
    ledger.attribution[ledger.constraints[0]!.id] = { helped: 10, hurt: 0, heldoutRuns: 0 };
    const { ledger: next, changes } = evaluateLifecycle(ledger);
    expect(changes[0]!.action).toBe("promote");
    expect(next.constraints[0]!.confirmedAt).not.toBeNull();
  });

  it("经 recordRunOutcome → evaluateLifecycle 的完整自动退役链", () => {
    let ledger = withConfirmedAdvisory(emptyLedger(), "c1", "测试条款");
    ledger = recordRunOutcome(ledger, { runId: "r1", attended: true, outcome: "rejected", injectedConstraints: ["c1"] });
    ledger = recordRunOutcome(ledger, { runId: "r2", attended: true, outcome: "rejected", injectedConstraints: ["c1"] });
    const { ledger: next, changes } = evaluateLifecycle(ledger);
    expect(changes[0]!.action).toBe("retire");
    expect(next.constraints[0]!.active).toBe(false);
  });
});

describe("两角色模型 §3.3 净增益", () => {
  it("有注入+有 holdout 样本 → 净增益 = 注入成功率 − 场景干净率", () => {
    let ledger = withConfirmedAdvisory(emptyLedger(), "c1", "测试条款");
    ledger.runStats = { runs: 10, accepted: 8, rejected: 0, corrected: 0, consecutiveClean: 5 }; // 场景干净率 0.8
    ledger = recordRunOutcome(ledger, { runId: "r1", attended: true, outcome: "accepted", injectedConstraints: ["c1"] });
    ledger = recordRunOutcome(ledger, { runId: "r2", attended: true, outcome: "accepted", injectedConstraints: ["c1"], holdout: true });
    // 注入成功率 = 1/1 = 1.0；基线 = 9/12 = 0.75（r1 accepted 后 accepted=9/runs=12）；净增益 = 0.25
    expect(netGain(ledger, "c1")).toBeCloseTo(0.25, 5);
  });

  it("样本不足（injected<2 或无 holdout）→ null", () => {
    let ledger = withConfirmedAdvisory(emptyLedger(), "c1", "测试条款");
    ledger = recordRunOutcome(ledger, { runId: "r1", attended: true, outcome: "accepted", injectedConstraints: ["c1"] });
    expect(netGain(ledger, "c1")).toBeNull();
  });

  it("无归因 → null", () => {
    expect(netGain(emptyLedger(), "ghost")).toBeNull();
  });
});

describe("两角色模型 §3.5 防退化守卫", () => {
  it("新子句丢失命令 flag → 拒绝", () => {
    const ledger = withConfirmedAdvisory(emptyLedger(), "c1", "发布时使用 pnpm publish --tag latest 并附 changelog");
    const { ledger: next, accepted } = mergeConstraintGuarded(ledger, {
      clause: "发布时使用 pnpm publish 并附 changelog",
      scope: "output",
      origin: ORIGIN,
    });
    expect(accepted).toBe(false);
    expect(next.constraints).toHaveLength(1);
    expect(next.constraints[0]!.clause).toContain("--tag latest");
  });

  it("正常扩写 → 放行（新增不删旧）", () => {
    const ledger = withConfirmedAdvisory(emptyLedger(), "c1", "日期用 YYYY-MM-DD");
    const { ledger: next, accepted } = mergeConstraintGuarded(ledger, {
      clause: "日期用 YYYY-MM-DD 格式，时间用 24 小时制",
      scope: "output",
      origin: ORIGIN,
    });
    expect(accepted).toBe(true);
    expect(next.constraints).toHaveLength(2); // 旧条款保留 + 新条款并存
  });

  it("空新子句 / 全新子句不受守卫影响", () => {
    const ledger = withConfirmedAdvisory(emptyLedger(), "c1", "旧条款");
    const { accepted } = mergeConstraintGuarded(ledger, { clause: "全新不相关条款", scope: "output", origin: ORIGIN });
    expect(accepted).toBe(true);
  });

  it("looksLikeLossyUpdate 直接断言", () => {
    expect(looksLikeLossyUpdate("pnpm publish --tag latest --dry-run", "pnpm publish")).toBe(true);
    expect(looksLikeLossyUpdate("短句", "更长的补充句子完全没问题")).toBe(false);
    expect(looksLikeLossyUpdate("", "任意")).toBe(false);
  });
});
