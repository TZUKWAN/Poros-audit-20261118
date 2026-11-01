import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ComponentAcceptance, TaskAcceptance, GeneralizationTester, AcceptanceReporter, type TaskCriterion } from "@/acceptance/acceptance";
import { buildCapability } from "@/federation/adapters/adapter-utils";
import { newBuildContext } from "@/orchestrator/context";
import type { Source } from "@/federation/types";

const src: Source = { id: "modelscope", tier: "curated", name: "t", url: "https://t" };
const cap = buildCapability({
  id: "x:cap",
  name: "cap",
  kind: "mcp-server",
  description: "c",
  source: src,
  install: { type: "remote", url: "http://localhost:1/mcp" },
  tags: [],
});

describe("5.1 组件级验收器（过/schema挂/超时三例）", () => {
  const OutputSchema = z.object({ ok: z.boolean() });

  it("全过：可达 + schema 合法 + 延迟记录", async () => {
    const acc = new ComponentAcceptance({
      probe: async () => ({ available: true, latencyMs: 5 }),
      smokeInvoke: async () => ({ ok: true, output: { ok: true }, latencyMs: 12 }),
      outputSchema: OutputSchema,
    });
    const r = await acc.check(cap);
    expect(r.available).toBe(true);
    expect(r.schemaOk).toBe(true);
    expect(r.latencyMs).toBe(12);
  });

  it("schema 挂：可达但输出不合法", async () => {
    const acc = new ComponentAcceptance({
      probe: async () => ({ available: true, latencyMs: 5 }),
      smokeInvoke: async () => ({ ok: true, output: { wrong: "shape" }, latencyMs: 3 }),
      outputSchema: OutputSchema,
    });
    const r = await acc.check(cap);
    expect(r.available).toBe(true);
    expect(r.schemaOk).toBe(false);
    expect(r.schemaError).toBeTruthy();
  });

  it("冒烟调用失败即使返回形状正确也不能通过", async () => {
    const acc = new ComponentAcceptance({
      probe: async () => ({ available: true, latencyMs: 1 }),
      smokeInvoke: async () => ({ ok: false, output: { ok: true }, error: "tool refused", latencyMs: 2 }),
      outputSchema: OutputSchema,
    });
    const r = await acc.check(cap);
    expect(r.schemaOk).toBe(false);
    expect(r.schemaError).toContain("tool refused");
  });

  it("超时：冒烟挂起被硬顶", async () => {
    const acc = new ComponentAcceptance({
      probe: async () => ({ available: true, latencyMs: 1 }),
      smokeInvoke: () => new Promise(() => {}), // 永挂
      outputSchema: OutputSchema,
      timeoutMs: 50,
    });
    const r = await acc.check(cap);
    expect(r.schemaOk).toBe(false);
    expect(r.message).toContain("timeout");
  });

  it("不可达：直接失败不冒烟", async () => {
    let smokeCalled = false;
    const acc = new ComponentAcceptance({
      probe: async () => ({ available: false, latencyMs: 1, message: "refused" }),
      smokeInvoke: async () => {
        smokeCalled = true;
        return { ok: true, latencyMs: 1 };
      },
      outputSchema: OutputSchema,
    });
    const r = await acc.check(cap);
    expect(r.available).toBe(false);
    expect(smokeCalled).toBe(false);
  });
});

describe("5.2 任务级验收器（全过/规则挂/LLM挂/双挂四例）", () => {
  const criteria: TaskCriterion[] = [
    { id: "r1", description: "输出含 result 字段", rule: (o) => (o as { result?: string }).result !== undefined, needsJudge: false },
    { id: "j1", description: "摘要质量达标", needsJudge: true },
  ];

  it("全过", async () => {
    const acc = new TaskAcceptance({ judge: async () => ({ criterionId: "j1", score: 0.9, reason: "好" }) });
    const v = await acc.check({ result: "x" }, criteria);
    expect(v.passed).toBe(true);
    expect(v.judgeScores[0]?.score).toBe(0.9);
  });

  it("规则挂：短路不调 judge", async () => {
    let judgeCalled = false;
    const acc = new TaskAcceptance({ judge: async () => { judgeCalled = true; return { criterionId: "j1", score: 1, reason: "" }; } });
    const v = await acc.check({}, criteria);
    expect(v.passed).toBe(false);
    expect(v.failedAt).toBe("rule:r1");
    expect(judgeCalled).toBe(false);
  });

  it("LLM judge 挂：低于阈值", async () => {
    const acc = new TaskAcceptance({ judge: async () => ({ criterionId: "j1", score: 0.4, reason: "空洞" }) });
    const v = await acc.check({ result: "x" }, criteria);
    expect(v.passed).toBe(false);
    expect(v.failedAt).toBe("judge:j1");
  });

  it("双挂：规则挂 + judge 挂（规则先短路）", async () => {
    const acc = new TaskAcceptance({ judge: async () => ({ criterionId: "j1", score: 0.1, reason: "" }) });
    const v = await acc.check({}, criteria);
    expect(v.failedAt).toBe("rule:r1");
  });

  it("judge 异常 → 失败归因 judge", async () => {
    const acc = new TaskAcceptance({ judge: async () => { throw new Error("LLM down"); } });
    const v = await acc.check({ result: "x" }, [{ id: "j1", description: "", needsJudge: true }]);
    expect(v.passed).toBe(false);
    expect(v.judgeScores[0]?.reason).toContain("LLM down");
  });

  it("无 judge 默认失败，避免把未验收当成通过", async () => {
    const acc = new TaskAcceptance();
    const v = await acc.check({ result: "x" }, [{ id: "j1", description: "", needsJudge: true }]);
    expect(v.passed).toBe(false);
    expect(v.judgeScores[0]?.reason).toContain("unavailable");
  });

  it("只有显式允许时才走 judge 降级", async () => {
    const acc = new TaskAcceptance({ allowDegradedJudge: true });
    const v = await acc.check({ result: "x" }, [{ id: "j1", description: "", needsJudge: true }]);
    expect(v.passed).toBe(true);
    expect(v.judgeScores[0]?.reason).toContain("explicitly degraded");
  });

  it("阈值可配（0.95 下 0.9 分不过）", async () => {
    const acc = new TaskAcceptance({ judge: async () => ({ criterionId: "j1", score: 0.9, reason: "" }), judgeThreshold: 0.95 });
    expect((await acc.check({ result: "x" }, [{ id: "j1", description: "", needsJudge: true }])).passed).toBe(false);
  });
});

describe("5.3 泛化测试器（过拟合拒/正常通过）", () => {
  const slots = [{ name: "path", examples: ["/a", "/b"] }];
  const criteria: TaskCriterion[] = [
    { id: "r1", description: "输出回显路径", rule: (o) => String((o as { echoed?: string }).echoed ?? "").length > 0, needsJudge: false },
  ];

  it("正常流水线：≥2 组换参全过", async () => {
    const tester = new GeneralizationTester({
      run: async (inputs) => ({ ok: true, output: { echoed: inputs.path } }),
      taskAcceptance: new TaskAcceptance(),
      criteria,
    });
    const v = await tester.check(slots);
    expect(v.passed).toBe(true);
    expect(v.attempts.length).toBeGreaterThanOrEqual(2);
    expect(v.attempts[0]?.inputs.path).toBe("/a");
    expect(v.attempts[1]?.inputs.path).toBe("/b");
  });

  it("过拟合流水线被拒：换参即失败", async () => {
    const tester = new GeneralizationTester({
      run: async (inputs) => (inputs.path === "/a" ? { ok: true, output: { echoed: inputs.path } } : { ok: false, error: "only /a works" }),
      taskAcceptance: new TaskAcceptance(),
      criteria,
    });
    const v = await tester.check(slots);
    expect(v.passed).toBe(false);
    expect(v.failedInputs).toEqual({ path: "/b" });
    expect(v.attempts).toHaveLength(2); // 首组过 + 次组挂即停
  });

  it("输出形式过拟合：run 过但任务验收挂", async () => {
    const tester = new GeneralizationTester({
      run: async (_inputs) => ({ ok: true, output: { echoed: "constant" } }), // 不含换参
      taskAcceptance: new TaskAcceptance(),
      criteria: [{ id: "echo", description: "输出必须回显换参输入", rule: (o) => (o as { echoed?: string }).echoed !== "constant", needsJudge: false }],
    });
    const v = await tester.check(slots);
    expect(v.passed).toBe(false);
    expect(v.attempts[0]?.error).toBe("rule:echo");
  });

  it("空槽位拒绝", async () => {
    const tester = new GeneralizationTester({
      run: async () => ({ ok: true }),
      taskAcceptance: new TaskAcceptance(),
      criteria: [],
    });
    await expect(tester.check([])).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("5.4 验收报告（字段完整 + 三层归因）", () => {
  it("全过报告", async () => {
    const reporter = new AcceptanceReporter();
    const ctx = newBuildContext("b-ok", "r");
    const report = await reporter.build({
      ctx,
      componentResults: [{ capabilityId: "c1", available: true, latencyMs: 1, schemaOk: true }],
      taskVerdicts: [{ nodeId: "n1", passed: true, ruleResults: [], judgeScores: [] }],
      generalization: { passed: true, attempts: [{ inputs: { p: "1" }, passed: true }] },
    });
    expect(report.allPassed).toBe(true);
    expect(report.attribution).toEqual(["三层验收全部通过"]);
    expect(report.buildId).toBe("b-ok");
  });

  it("三层各自失败：归因到层级与节点/能力", async () => {
    const reporter = new AcceptanceReporter();
    const seen: string[] = [];
    reporter.onReport((r) => seen.push(r.attribution.join(" | ")));
    const ctx = newBuildContext("b-bad", "r");
    const report = await reporter.build({
      ctx,
      componentResults: [
        { capabilityId: "c-good", available: true, latencyMs: 1, schemaOk: true },
        { capabilityId: "c-dead", available: false, latencyMs: 2, schemaOk: false, message: "refused" },
      ],
      taskVerdicts: [
        { nodeId: "n-ok", passed: true, ruleResults: [], judgeScores: [] },
        { nodeId: "n-bad", passed: false, ruleResults: [{ criterionId: "r1", passed: false }], judgeScores: [], failedAt: "rule:r1" },
      ],
      generalization: { passed: false, attempts: [{ inputs: { p: "2" }, passed: false, error: "rule:echo" }], failedInputs: { p: "2" } },
    });
    expect(report.allPassed).toBe(false);
    expect(report.attribution.join("\n")).toContain("L1 组件级失败: c-dead");
    expect(report.attribution.join("\n")).toContain("L2 任务级失败: 节点 n-bad @ rule:r1");
    expect(report.attribution.join("\n")).toContain("L3 泛化测试失败");
    expect(report.component.failedCapability).toBe("c-dead");
    expect(report.task.failedNode).toBe("n-bad");
    expect(seen).toHaveLength(1); // 事件发出
  });

  it("泛化跳过（无槽位场景）", async () => {
    const reporter = new AcceptanceReporter();
    const report = await reporter.build({
      ctx: newBuildContext("b-skip", "r"),
      componentResults: [],
      taskVerdicts: [],
      generalization: { passed: false, skipped: true, reason: "no slots to vary" },
    });
    expect(report.attribution.join("\n")).toContain("L3 泛化测试跳过");
    expect(report.allPassed).toBe(false);
  });
});
