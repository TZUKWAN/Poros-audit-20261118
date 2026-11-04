import { describe, expect, it } from "vitest";
import { resolveRoute } from "@/panel/route";
import { runSelfCheck, checkMechanical, repairPrompt } from "@/panel/selfcheck";
import { templateA, templateB, templateC } from "@/panel/prompts";
import { emptyLedger, recordRunOutcome, type Constraint, type ScenarioLedger } from "@/scenario/ledger";

function ledgerWith(runs: number, clean: number, digests: Array<{ digest: string; outcome: "accepted" | "rejected" | "corrected" }>): ScenarioLedger {
  let ledger = emptyLedger();
  ledger = { ...ledger, runStats: { runs, accepted: runs, rejected: 0, corrected: 0, consecutiveClean: clean } };
  ledger = {
    ...ledger,
    inputPatterns: digests.map((d, index) => ({ digest: d.digest, at: new Date(Date.now() - index * 1000).toISOString(), outcome: d.outcome })),
  };
  return ledger;
}

const c = (id: string, kind: Constraint["kind"], clause: string, pattern: string | null = null): Constraint => ({
  id,
  clause,
  scope: "output",
  kind,
  pattern,
  origin: { type: "reject", text: clause, at: "2026-11-05T00:00:00.000Z", runId: "r0" },
  confirmedAt: "2026-11-05T01:00:00.000Z",
  hits: 0,
  active: true,
  supersededBy: null,
});

describe("§6 双路路由 resolveRoute", () => {
  it("tier=replay 且 digest 命中 → 重放；未命中 → 重规划", () => {
    const ledger = ledgerWith(6, 4, [{ digest: "d1", outcome: "accepted" }]);
    const hit = resolveRoute(ledger, { digest: "d1" });
    expect(hit.mode).toBe("replay");
    expect(hit.tier).toBe("replay");
    const miss = resolveRoute(ledger, { digest: "d-other" });
    expect(miss.mode).toBe("replan");
    expect(miss.reason).toContain("digest");
  });

  it("degraded 场景强制重规划（禁重放）", () => {
    const ledger = ledgerWith(6, 4, [{ digest: "d1", outcome: "accepted" }]);
    const decision = resolveRoute(ledger, { degraded: true, digest: "d1" });
    expect(decision.mode).toBe("replan");
    expect(decision.reason).toContain("degraded");
  });

  it("强制体检：同 digest 每 10 次重放强制 1 次重规划", () => {
    const ledger = ledgerWith(20, 6, Array.from({ length: 10 }, () => ({ digest: "d1", outcome: "accepted" as const })));
    const decision = resolveRoute(ledger, { digest: "d1" });
    expect(decision.mode).toBe("replan");
    expect(decision.healthCheck).toBe(true);
    // 11 次 → 不触发
    const plus11 = ledgerWith(21, 6, Array.from({ length: 11 }, () => ({ digest: "d1", outcome: "accepted" as const })));
    expect(resolveRoute(plus11, { digest: "d1" }).mode).toBe("replay");
  });

  it("tier 不足 → 重规划；重放不豁免自检只豁免规划（route 不涉自检字段）", () => {
    const ledger = ledgerWith(2, 1, [{ digest: "d1", outcome: "accepted" }]);
    expect(resolveRoute(ledger, { digest: "d1" }).mode).toBe("replan");
  });

  it("rejected 事件 → 断连胜后 tier 降档", () => {
    let ledger = ledgerWith(6, 4, []);
    ledger = recordRunOutcome(ledger, { runId: "rx", attended: true, outcome: "rejected" });
    expect(resolveRoute(ledger, { digest: "d1" }).tier).toBe("full");
  });
});

describe("§10 自检 runSelfCheck", () => {
  it("must_contain 命中 → 不调 judge；空约束直接交付", async () => {
    let judgeCalls = 0;
    const result = await runSelfCheck({
      constraints: [c("c1", "must_contain", "必须包含负责人", "负责人")],
      output: "本报告负责人是张三，截止日周五。",
      judge: async () => {
        judgeCalls += 1;
        return "[]";
      },
    });
    expect(result.violations).toEqual([]);
    expect(result.suspected).toBe(false);
    expect(judgeCalls).toBe(0);
    const empty = await runSelfCheck({ constraints: [], output: "x" });
    expect(empty.checked).toBe(0);
  });

  it("mechanical 违规 → 修复 1 次复检通过", async () => {
    let judgeCalls = 0;
    const result = await runSelfCheck({
      constraints: [c("c1", "must_contain", "必须包含负责人", "负责人")],
      output: "本报告没有这个字段。",
      judge: async () => {
        judgeCalls += 1;
        return "[]";
      },
      repair: async () => "修订后：负责人是张三。",
    });
    expect(result.violations).toEqual([]);
    expect(result.suspected).toBe(false);
    expect(result.repairedOutput).toBe("修订后：负责人是张三。");
    expect(judgeCalls).toBe(0);
  });

  it("judge 违规 → 修复后复检只检违规项；仍违规 → suspected（不断连胜不写 accepted）", async () => {
    const verdicts = new Map<string, boolean>([
      ["c1", false],
      ["c2", true],
    ]);
    const judge = async (_system: string, input: string): Promise<string> => {
      const ids = [...input.matchAll(/\[(c\d+)\]/g)].map((m) => m[1]!);
      return JSON.stringify(ids.map((id) => ({ id, pass: verdicts.get(id) ?? false, reason: "字面未见" })));
    };
    const result = await runSelfCheck({
      constraints: [c("c1", "advisory", "语气要正式"), c("c2", "advisory", "要带数据来源")],
      output: "随便写写。",
      judge,
    });
    expect(result.suspected).toBe(true);
    expect(result.violations.map((v) => v.id)).toEqual(["c1"]);
  });

  it("修复后仍违规 → suspected + repairedOutput；模型调用 ≤2", async () => {
    let calls = 0;
    const judge = async (): Promise<string> => {
      calls += 1;
      return JSON.stringify([{ id: "c1", pass: false, reason: "仍未满足" }]);
    };
    const result = await runSelfCheck({
      constraints: [c("c1", "advisory", "要正式语气")],
      output: "草稿。",
      judge,
      repair: async () => "改了但还是不对。",
    });
    expect(result.suspected).toBe(true);
    expect(result.violations).toHaveLength(1);
    expect(result.modelCalls).toBe(2);
    expect(calls).toBe(2);
  });

  it("无 judge → 只跑机械项（advisory 不判）", async () => {
    const result = await runSelfCheck({
      constraints: [c("c1", "advisory", "要正式语气"), c("c2", "must_not_contain", "不要出现爬虫", "爬虫")],
      output: "正式的产出。",
    });
    expect(result.violations).toEqual([]);
    expect(result.checked).toBe(2);
    const bad = await runSelfCheck({
      constraints: [c("c2", "must_not_contain", "不要出现爬虫", "爬虫")],
      output: "用了爬虫抓取。",
    });
    expect(bad.violations).toHaveLength(1);
    expect(bad.suspected).toBe(true);
  });

  it("checkMechanical 正则判据 + must_not_contain 无 pattern 回落子串", () => {
    expect(checkMechanical(c("x", "must_contain", "日期格式", "\\d{4}-\\d{2}-\\d{2}"), "日期 2026-11-05").pass).toBe(true);
    expect(checkMechanical(c("x", "must_contain", "日期格式", "\\d{4}-\\d{2}-\\d{2}"), "没有日期").pass).toBe(false);
    expect(checkMechanical(c("x", "must_not_contain", "不要爬虫部分", null), "用了爬虫").pass).toBe(false);
    expect(checkMechanical(c("x", "must_not_contain", "不要爬虫部分", null), "干净的产出").pass).toBe(true);
  });

  it("repairPrompt 注入违规条款与原产出", () => {
    const prompt = repairPrompt([{ id: "c1", clause: "带负责人", reason: "未找到" }], "原产出文本");
    expect(prompt).toContain("[c1] 带负责人");
    expect(prompt).toContain("原产出文本");
  });
});

describe("§11 模板三件套", () => {
  it("模板 A：编号+编号标注规则", () => {
    const text = templateA([c("c-x1", "advisory", "行动项必须带负责人和截止日"), c("c-x2", "advisory", "使用文件读取")]);
    expect(text).toContain("【该场景已积累的工作约束——必须全部满足】");
    expect(text).toContain("1. [c-x1] 行动项必须带负责人和截止日");
    expect(text).toContain("禁止静默违反");
    expect(templateA([])).toBe("");
  });

  it("模板 B：最近 2 条 accepted，空 → 空", () => {
    const text = templateB([
      { digest: "aaaabbbbccccdddd", at: "2026-11-04T00:00:00.000Z", outcome: "accepted" },
      { digest: "ddddeeeeffffgggg", at: "2026-11-05T00:00:00.000Z", outcome: "accepted" },
      { digest: "hhhhiiii", at: "2026-11-03T00:00:00.000Z", outcome: "rejected" },
    ]);
    expect(text).toContain("历史被接受的运行记录");
    expect(text).toContain("aaaabbbb");
    expect(text).not.toContain("hhhhiiii");
    expect(templateB([{ digest: "x", at: "2026-11-01T00:00:00.000Z", outcome: "rejected" }])).toBe("");
  });

  it("模板 C：逐条 JSON 判定，从严", () => {
    const { system, input } = templateC([{ id: "c1", clause: "要简短" }], "产出正文");
    expect(system).toContain("验收检查员");
    expect(system).toContain('"pass":true/false');
    expect(system).toContain("无法确认满足即 false");
    expect(input).toContain("[c1] 要简短");
    expect(input).toContain("产出正文");
  });
});
