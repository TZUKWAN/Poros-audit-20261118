import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { jsonStore } from "@/core/store";
import { ScenarioLibrary, ScenarioRecordSchema, type ScenarioRecord } from "@/scenario/library";
import {
  confirmConstraints,
  emptyLedger,
  ensureLedger,
  isSubstantiveComment,
  migrateLedgers,
  migratedLedger,
  pendingConstraints,
  activeConstraints,
  proposeConstraint,
  recordRunOutcome,
  stripNegationPrefix,
  type ScenarioLedger,
} from "@/scenario/ledger";
import { confidence, tierOf, tierOfLedger, countEvents, decay } from "@/scenario/confidence";
import { inputDigest, normalizeSlotValue } from "@/scenario/digest";

function baseRecord(stats: Partial<ScenarioRecord["stats"]> = {}): ScenarioRecord {
  return ScenarioRecordSchema.parse({
    id: "s1",
    name: "周报",
    goal: "每周整理销售数据并生成周报",
    pinnedVersion: 1,
    distilled: { slotDefs: [], branches: [], acceptanceTemplates: [], signature: { keywords: ["报告"], embedding: [1, 0], embedVia: "bag-of-words" }, buildId: "b1", pinnedVersion: 1 },
    capabilityIds: [],
    source: "test",
    approvals: [],
    stats: { uses: 0, successes: 0, lastUsedAt: null, driftCount: 0, ...stats },
    degraded: false,
    status: "active",
    tags: [],
    versionHistory: [],
    createdAt: "2026-10-03T00:00:00.000Z",
  });
}

function makeLibrary(dir: string, file = "scenarios.json"): ScenarioLibrary {
  return new ScenarioLibrary({ store: jsonStore({ filePath: path.join(dir, file), schema: ScenarioRecordSchema }) });
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "ledger-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const ORIGIN = { type: "reject" as const, text: "别用爬虫，读本地文件", at: "2026-11-05T00:00:00.000Z", runId: "run-1" };

describe("分寸账本 §3 数据模型与迁移", () => {
  it("迁移折算：consecutiveClean = min(success,1)，runs/accepted/rejected 与 stats 同源", () => {
    const ledger = migratedLedger(baseRecord({ uses: 5, successes: 5 }));
    expect(ledger.runStats).toEqual({ runs: 5, accepted: 5, rejected: 0, corrected: 0, consecutiveClean: 1 });
    const mixed = migratedLedger(baseRecord({ uses: 6, successes: 4 }));
    expect(mixed.runStats).toEqual({ runs: 6, accepted: 4, rejected: 2, corrected: 0, consecutiveClean: 1 });
    const zero = migratedLedger(baseRecord({ uses: 3, successes: 0 }));
    expect(zero.runStats.consecutiveClean).toBe(0);
    expect(zero.runStats.rejected).toBe(3);
  });

  it("迁移幂等×3：跑三次结果一致，已有账本不重算", async () => {
    await withTempDir(async (dir) => {
      const library = makeLibrary(dir);
      await library.save(baseRecord({ uses: 4, successes: 4 }));
      const first = await migrateLedgers(library);
      expect(first.migrated).toBe(1);
      const snapshot = (await library.get("s1"))?.ledger;
      expect(snapshot?.runStats.consecutiveClean).toBe(1);
      for (let i = 0; i < 2; i += 1) {
        const again = await migrateLedgers(library);
        expect(again.migrated).toBe(0);
        expect(again.skipped).toBe(1);
      }
      expect((await library.get("s1"))?.ledger).toEqual(snapshot);
    });
  });

  it("老记录行为不变：无账本场景 match/save/archive 照常，ensureLedger 折算补齐", async () => {
    await withTempDir(async (dir) => {
      const library = makeLibrary(dir);
      await library.save(baseRecord({ uses: 2, successes: 2 }));
      const hit = await library.match({ keywords: ["报告"], embedding: [1, 0], embedVia: "bag-of-words" });
      expect(hit.tier).toBe("hit");
      // 落盘文件里没有 ledger 字段（可选），ensureLedger 折算补齐
      const record = (await library.get("s1"))!;
      expect(record.ledger).toBeUndefined();
      expect(ensureLedger(record).runStats.consecutiveClean).toBe(1);
      expect(ensureLedger(baseRecord())).toEqual(emptyLedger());
    });
  });

  it("并发 20 次 updateLedger 无丢更新", async () => {
    await withTempDir(async (dir) => {
      const library = makeLibrary(dir);
      await library.save(baseRecord());
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          library.updateLedger("s1", (ledger) => ({
            ...ledger,
            runStats: { ...ledger.runStats, runs: ledger.runStats.runs + 1, consecutiveClean: ledger.runStats.consecutiveClean + (i % 2) },
          })),
        ),
      );
      const ledger = (await library.get("s1"))?.ledger;
      expect(ledger?.runStats.runs).toBe(20);
      expect(ledger?.runStats.consecutiveClean).toBe(10);
    });
  });

  it("updateLedger 对不存在场景抛 NOT_FOUND", async () => {
    await withTempDir(async (dir) => {
      const library = makeLibrary(dir);
      await expect(library.updateLedger("ghost", (l) => l)).rejects.toThrow(/not found/);
    });
  });
});

describe("§4 条款生成与质量门槛", () => {
  it("reject 废话（不对/不行/重做）不生成提案；短评不生成", () => {
    expect(isSubstantiveComment("不对")).toBe(false);
    expect(isSubstantiveComment("不行！")).toBe(false);
    expect(isSubstantiveComment("重做重做重做")).toBe(false);
    expect(isSubstantiveComment("再改改")).toBe(false);
    expect(isSubstantiveComment("好")).toBe(false);
    expect(isSubstantiveComment("行动项必须带负责人和截止日")).toBe(true);
    expect(isSubstantiveComment("不要爬虫，用文件读取")).toBe(true);
    expect(isSubstantiveComment("！。，")).toBe(false);
  });

  it("reject 原话即条款（去否定前缀），生成 pendingConfirm", () => {
    const ledger = emptyLedger();
    const result = proposeConstraint(ledger, { clause: stripNegationPrefix("不对，行动项必须带负责人和截止日"), scope: "output", origin: ORIGIN });
    expect(result).not.toBeNull();
    expect(result!.constraint.clause).toBe("行动项必须带负责人和截止日");
    expect(result!.constraint.confirmedAt).toBeNull();
    expect(pendingConstraints(result!.ledger)).toHaveLength(1);
    expect(activeConstraints(result!.ledger)).toHaveLength(0);
  });

  it("同条款去重（全半角/空白归一）", () => {
    let ledger = emptyLedger();
    const first = proposeConstraint(ledger, { clause: "日期用YYYY-MM-DD", scope: "output", origin: ORIGIN });
    ledger = first!.ledger;
    const dup = proposeConstraint(ledger, { clause: "日期用ＹＹＹＹ-ＭＭ-ＤＤ ", scope: "output", origin: ORIGIN });
    expect(dup).toBeNull();
    expect(ledger.constraints).toHaveLength(1);
  });

  it("闸门5 签约填 confirmedAt 后进入自检可用集", () => {
    let ledger = emptyLedger();
    const proposed = proposeConstraint(ledger, { clause: "验收必须包含泛化测试", scope: "acceptance", origin: ORIGIN });
    ledger = proposed!.ledger;
    const id = proposed!.constraint.id;
    ledger = confirmConstraints(ledger, [id], "2026-11-05T01:00:00.000Z");
    expect(ledger.constraints[0]!.confirmedAt).toBe("2026-11-05T01:00:00.000Z");
    expect(activeConstraints(ledger).map((c) => c.id)).toEqual([id]);
    expect(pendingConstraints(ledger)).toHaveLength(0);
  });

  it("200 条封顶后拒绝新提案", () => {
    let ledger = emptyLedger();
    for (let i = 0; i < 200; i += 1) {
      const r = proposeConstraint(ledger, { clause: `条款编号第${i}条内容足够长`, scope: "output", origin: ORIGIN });
      ledger = r!.ledger;
    }
    expect(proposeConstraint(ledger, { clause: "再多的条款也不收了", scope: "output", origin: ORIGIN })).toBeNull();
  });
});

describe("§5 置信度引擎", () => {
  it("consecutiveClean=4 无近期事件 → replay", () => {
    const ledger = emptyLedger();
    ledger.runStats.consecutiveClean = 4;
    expect(confidence(ledger)).toBe(4);
    expect(tierOfLedger(ledger)).toBe("replay");
  });

  it("一次👎 → 断连胜且 tier 不高于 spot", () => {
    const ledger = emptyLedger();
    ledger.runStats.consecutiveClean = 5;
    const now = new Date("2026-11-05T00:00:00.000Z");
    const hit = recordRunOutcome(ledger, { runId: "r1", attended: true, outcome: "rejected", at: "2026-11-05T00:00:00.000Z", now: now.toISOString() });
    expect(hit.runStats.consecutiveClean).toBe(0);
    expect(hit.runStats.rejected).toBe(1);
    expect(tierOf(confidence(hit, now))).toBe("full");
  });

  it("14 天衰减后老 reject 压分显著减小（30 天外不计）", () => {
    const ledger = emptyLedger();
    ledger.runStats.consecutiveClean = 3;
    const now = new Date("2026-11-05T00:00:00.000Z");
    const withOld = { ...ledger, inputPatterns: [{ digest: "d", at: "2026-10-22T00:00:00.000Z", outcome: "rejected" as const }] };
    const withFresh = { ...ledger, inputPatterns: [{ digest: "d", at: "2026-11-05T00:00:00.000Z", outcome: "rejected" as const }] };
    const cOld = confidence(withOld, now);
    const cFresh = confidence(withFresh, now);
    expect(decay("2026-10-22T00:00:00.000Z", now)).toBeCloseTo(Math.exp(-1), 5);
    expect(cOld).toBeGreaterThan(cFresh);
    expect(cOld).toBeGreaterThan(2.5); // 老打回几乎不压分 → 仍 replay 边缘
    expect(countEvents({ inputPatterns: [{ digest: "d", at: "2026-09-01T00:00:00.000Z", outcome: "rejected" }] }, ["rejected"], now)).toBe(0);
  });

  it("corrected 半价压分", () => {
    const ledger = emptyLedger();
    const now = new Date("2026-11-05T00:00:00.000Z");
    const withCorr = { ...ledger, inputPatterns: [{ digest: "d", at: now.toISOString(), outcome: "corrected" as const }] };
    expect(confidence(withCorr, now)).toBeCloseTo(-0.5, 5);
  });
});

describe("§6 digest", () => {
  it("全角 → 半角归一", () => {
    expect(normalizeSlotValue("ＡＢＣ ｄｅｆ")).toBe("abc def");
    expect(inputDigest("", { path: "ＤＡＴＡ" })).toBe(inputDigest("", { path: "data" }));
  });

  it("slots 键排序稳定：插入顺序不同 digest 相同", () => {
    expect(inputDigest("", { a: "1", b: "2" })).toBe(inputDigest("", { b: "2", a: "1" }));
  });

  it("槽位名/数量/值漂移不影响 digest（LLM 解析不稳定，digest 只锚定原文）", () => {
    expect(inputDigest("需求", { feedback_content: "x" })).toBe(inputDigest("需求", { feedback: "y", content_type: "z" }));
    expect(inputDigest("需求", { a: "1" })).toBe(inputDigest("需求", {}));
  });
  it("同需求恒定、异需求不同、全角标点归一", () => {
    expect(inputDigest("同一份需求文本", {})).toBe(inputDigest("同一份需求文本", {}));
    expect(inputDigest("需求甲", {})).not.toBe(inputDigest("需求乙", {}));
    expect(inputDigest("需求Ａ！", {})).toBe(inputDigest("需求a", {}));
  });

  it("原文措辞不同 → 不同 digest（参数区分由原文承担）", () => {
    expect(inputDigest("整理A报告", {})).not.toBe(inputDigest("整理B报告", {}));
  });
});

describe("§9 无人值守规则", () => {
  it("定时跑成功：runs++ 但 accepted/consecutiveClean 不动、不入 inputPatterns", () => {
    const ledger = emptyLedger();
    ledger.runStats.consecutiveClean = 2;
    const next = recordRunOutcome(ledger, { runId: "night-1", attended: false, outcome: "unattended-success" });
    expect(next.runStats.runs).toBe(1);
    expect(next.runStats.accepted).toBe(0);
    expect(next.runStats.consecutiveClean).toBe(2);
    expect(next.inputPatterns).toHaveLength(0);
  });

  it("定时跑失败（失败自证）：rejected++、断连胜、入事件", () => {
    const ledger = emptyLedger();
    ledger.runStats.consecutiveClean = 2;
    const next = recordRunOutcome(ledger, { runId: "night-2", attended: false, outcome: "rejected" });
    expect(next.runStats.rejected).toBe(1);
    expect(next.runStats.consecutiveClean).toBe(0);
    expect(next.inputPatterns.map((e) => e.outcome)).toEqual(["rejected"]);
  });

  it("有人值守沉默超时 → 弱 accepted 并推连胜", () => {
    const ledger = emptyLedger();
    const next = recordRunOutcome(ledger, { runId: "r1", attended: true, outcome: "silent-accepted", digest: "abc" });
    expect(next.runStats.accepted).toBe(1);
    expect(next.runStats.consecutiveClean).toBe(1);
    expect(next.inputPatterns).toEqual([{ digest: "abc", at: next.inputPatterns[0]!.at, outcome: "accepted" }]);
  });

  it("suspected（自检仍违规）：断连胜但三个计数都不动", () => {
    const ledger = emptyLedger();
    ledger.runStats.consecutiveClean = 3;
    const next = recordRunOutcome(ledger, { runId: "r2", attended: true, outcome: "suspected" });
    expect(next.runStats.consecutiveClean).toBe(0);
    expect(next.runStats.accepted).toBe(0);
    expect(next.runStats.rejected).toBe(0);
    expect(next.runStats.corrected).toBe(0);
    expect(next.inputPatterns).toHaveLength(0);
  });

  it("runId 粒度幂等：同一 run 收尾两次只计一次", () => {
    let ledger = emptyLedger();
    ledger = recordRunOutcome(ledger, { runId: "r1", attended: true, outcome: "accepted" });
    const again = recordRunOutcome(ledger, { runId: "r1", attended: true, outcome: "rejected" });
    expect(again).toBe(ledger);
    expect(again.runStats.runs).toBe(1);
  });

  it("gateEvents 聚合进 gateStats，interventions 记录北极星曲线数据", () => {
    const ledger = emptyLedger();
    const next = recordRunOutcome(ledger, {
      runId: "r1",
      attended: true,
      outcome: "rejected",
      gateEvents: { "3": { rejects: 1 }, "4": { edits: 1, passes: 1 } },
      interventions: { gatesAnswered: 2, questionsAnswered: 1, correctionsGiven: 1 },
    });
    expect(next.gateStats["3"]).toMatchObject({ rejects: 1 });
    expect(next.gateStats["4"]).toMatchObject({ edits: 1, passes: 1 });
    expect(next.interventions[0]).toMatchObject({ runId: "r1", total: 4 });
  });

  it("pendingConfirm 30 天未确认自动过期", () => {
    let ledger = emptyLedger();
    const proposed = proposeConstraint(ledger, { clause: "过期条款测试用例内容", scope: "output", origin: { ...ORIGIN, at: "2026-09-01T00:00:00.000Z" } });
    ledger = proposed!.ledger;
    const next = recordRunOutcome(ledger, { runId: "r1", attended: true, outcome: "accepted", now: "2026-11-05T00:00:00.000Z" });
    expect(next.constraints[0]!.supersededBy).toBe("expired");
    expect(next.constraints[0]!.active).toBe(false);
  });
});

describe("账本 schema 不变量", () => {
  it("emptyLedger 通过 ScenarioLedgerSchema 校验且 round-trip 稳定", () => {
    const ledger: ScenarioLedger = emptyLedger();
    expect(ledger.version).toBe(1);
    expect(ledger.constraints).toEqual([]);
    const round = recordRunOutcome(ledger, { runId: "r", attended: true, outcome: "accepted" });
    expect(round.runStats.runs).toBe(1);
  });
});
