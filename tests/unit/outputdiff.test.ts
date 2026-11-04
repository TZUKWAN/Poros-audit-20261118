import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { computeOutputDiff, blocksToProposals } from "@/panel/outputdiff";
import { applyOutputCorrection, activeConstraints, emptyLedger, type ScenarioLedger } from "@/scenario/ledger";

const ORIGIN = { type: "artifact-edit" as const, text: "edit", at: "2026-11-05T00:00:00.000Z", runId: "run-e2a" };

describe("§7 outputdiff 行级 LCS", () => {
  it("无改动 → 空块", () => {
    expect(computeOutputDiff("同一份文本\n第二行", "同一份文本\n第二行")).toEqual([]);
  });

  it("reworded：相邻删+增 → 表述应为「…」", () => {
    const blocks = computeOutputDiff("## 摘要\n旧句子在这里\n## 数据", "## 摘要\n新句子在这里\n## 数据");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.kind).toBe("reworded");
    expect(blocks[0]!.anchor).toBe("## 摘要");
    expect(blocks[0]!.before).toBe("旧句子在这里");
    expect(blocks[0]!.after).toBe("新句子在这里");
  });

  it("removed → must_not_contain 候选；added → must_contain 候选", () => {
    const removed = computeOutputDiff("## 报告\n要删掉的段落\n保留行", "## 报告\n保留行");
    expect(removed[0]!.kind).toBe("removed");
    const added = computeOutputDiff("## 报告\n保留行", "## 报告\n保留行\n新增的结论段");
    expect(added[0]!.kind).toBe("added");
    const proposals = blocksToProposals([...removed, ...added]);
    expect(proposals.some((p) => p.kind === "must_not_contain" && p.clause.includes("不要"))).toBe(true);
    expect(proposals.some((p) => p.kind === "must_contain")).toBe(true);
  });

  it("format 等价（标点/加粗/空白）→ format 块，不进提案（不与内容条款混）", () => {
    const blocks = computeOutputDiff("## 标题\n重要: 内容一", "## 标题\n**重要**：内容一");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.kind).toBe("format");
    expect(blocksToProposals(blocks)).toEqual([]);
  });

  it("片段截断 ≤200 字、锚 ≤40 字", () => {
    const longLine = "长".repeat(500);
    const blocks = computeOutputDiff(`## 节\n${longLine}`, "## 节\n短句");
    expect(blocks[0]!.before!.length).toBeLessThanOrEqual(200);
    const longAnchor = "标".repeat(80);
    const blocks2 = computeOutputDiff(`${longAnchor}\n旧行`, `${longAnchor}\n新行`);
    expect(blocks2[0]!.anchor.length).toBeLessThanOrEqual(40);
  });

  it("每 run 最多 5 块入提案", () => {
    const original = Array.from({ length: 10 }, (_, i) => `行${i}旧内容`).join("\n");
    const revised = Array.from({ length: 10 }, (_, i) => `行${i}新内容`).join("\n");
    const blocks = computeOutputDiff(original, revised);
    expect(blocksToProposals(blocks).length).toBeLessThanOrEqual(5);
  });
});

describe("§7 applyOutputCorrection 修正事务", () => {
  const proposals = (clause: string) => [{ clause, scope: "output" as const, kind: "advisory" as const, pattern: null, origin: ORIGIN }];

  it("反应窗内编辑（runId 未结算）→ 完整 corrected 事务 + 提案", () => {
    const ledger = emptyLedger();
    const next = applyOutputCorrection(ledger, { runId: "r1", digest: "d1", proposals: proposals("日期用YYYY-MM-DD") });
    expect(next.runStats.corrected).toBe(1);
    expect(next.runStats.consecutiveClean).toBe(0);
    expect(next.interventions[0]!.correctionsGiven).toBe(1);
    expect(next.inputPatterns.map((e) => e.outcome)).toEqual(["corrected"]);
    expect(next.constraints.map((c) => c.clause)).toEqual(["日期用YYYY-MM-DD"]);
  });

  it("沉默 accepted 已入账 → 撤销改记 corrected（accepted--/corrected++/断连胜）", () => {
    let ledger: ScenarioLedger = emptyLedger();
    ledger = {
      ...ledger,
      runStats: { runs: 1, accepted: 1, rejected: 0, corrected: 0, consecutiveClean: 1 },
      interventions: [{ runId: "r1", at: "2026-11-05T00:00:00.000Z", gatesAnswered: 0, questionsAnswered: 0, correctionsGiven: 0, total: 0 }],
    };
    const next = applyOutputCorrection(ledger, { runId: "r1", proposals: proposals("输出要带汇总行") });
    expect(next.runStats.accepted).toBe(0);
    expect(next.runStats.corrected).toBe(1);
    expect(next.runStats.consecutiveClean).toBe(0);
    expect(next.interventions[0]!.correctionsGiven).toBe(1);
  });

  it("同 runId 多次编辑 → corrected 只计 1 次，提案合并去重", () => {
    const ledger = emptyLedger();
    let next = applyOutputCorrection(ledger, { runId: "r1", proposals: proposals("日期用YYYY-MM-DD") });
    const snapshot = next.runStats;
    next = applyOutputCorrection(next, { runId: "r1", proposals: proposals("日期用YYYY-MM-DD") });
    expect(next.runStats).toEqual(snapshot);
    expect(next.constraints).toHaveLength(1);
    // 不同条款仍可新增
    next = applyOutputCorrection(next, { runId: "r1", proposals: proposals("表格要带边框说明") });
    expect(next.constraints).toHaveLength(2);
  });

  it("added 块两次命中 → advisory 机械升级 must_contain（§4）", () => {
    const ledger = emptyLedger();
    const first = applyOutputCorrection(ledger, { runId: "r1", proposals: [{ ...proposals("汇总行之后应包含「数据来源」")[0]!, upgradePattern: "数据来源" }] });
    expect(first.constraints[0]!.kind).toBe("advisory");
    // 第二次（同义条款 + 稳定子串）→ 升级
    const second = applyOutputCorrection(first, { runId: "r2", proposals: [{ ...proposals("汇总行之后应包含「数据来源」")[0]!, upgradePattern: "数据来源" }] });
    expect(second.constraints).toHaveLength(1);
    expect(second.constraints[0]!.kind).toBe("must_contain");
    expect(second.constraints[0]!.pattern).toBe("数据来源");
  });

  it("guide 之后再编辑：corrected 不重复计（correctionsGiven 已 >0）", () => {
    let ledger: ScenarioLedger = emptyLedger();
    ledger = {
      ...ledger,
      runStats: { runs: 1, accepted: 0, rejected: 0, corrected: 1, consecutiveClean: 0 },
      interventions: [{ runId: "r1", at: "2026-11-05T00:00:00.000Z", gatesAnswered: 0, questionsAnswered: 0, correctionsGiven: 1, total: 1 }],
    };
    const next = applyOutputCorrection(ledger, { runId: "r1", proposals: proposals("再加一列环比") });
    expect(next.runStats.corrected).toBe(1);
    expect(next.constraints.map((c) => c.clause)).toEqual(["再加一列环比"]);
  });
});
