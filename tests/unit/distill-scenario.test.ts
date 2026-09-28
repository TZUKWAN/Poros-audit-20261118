import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { slotize, branchize, generalizeAcceptance, intentSignature, bagOfWordsEmbed, cosineSimilarity, distill } from "@/distill/distill";
import { ScenarioLibrary, recordFromDistilled } from "@/scenario/library";
import { jsonStore } from "@/core/store";
import type { BuildContext, ExecutionStep } from "@/orchestrator/context";
import { newBuildContext } from "@/orchestrator/context";

function traceWithParams(): ExecutionStep[] {
  return [
    { nodeId: "n1", startedAt: "t", status: "success", params: { path: "/data/in.csv", limit: "100" } },
    { nodeId: "n2", startedAt: "t", status: "success", params: { out: "/data/out.json" } },
    { nodeId: "n3", startedAt: "t", status: "failed", params: { ignored: "x" } },
  ];
}

function ctxForDistill(): BuildContext {
  const ctx = newBuildContext("b-distill", "整理 /data 下的仓库数据并输出报告");
  ctx.intent = { goal: "整理 /data 下的仓库数据并输出报告", domain: "dev", slots: [], keywords: ["数据", "报告"], via: "template" };
  ctx.trace = traceWithParams();
  ctx.acceptance = [
    { layer: "task", passed: true, detail: { rule: "path=/data/in.csv counted" }, at: "t" },
  ];
  ctx.selections = [{ nodeId: "n1", capabilityId: "cap-dead", overridden: false }];
  ctx.acceptance.push({
    layer: "component",
    passed: false,
    detail: { attempts: [{ failedCapabilityId: "cap-dead", switchedTo: "cap-alive" }] },
    at: "t",
  });
  return ctx;
}

describe("6.1.1 槽位化", () => {
  it("3 参数轨迹生成正确槽位（含类型判定）", () => {
    const slots = slotize(traceWithParams());
    const names = slots.map((s) => s.name).sort();
    expect(names).toEqual(["limit", "out", "path"]);
    const path = slots.find((s) => s.name === "path")!;
    expect(path.type).toBe("path");
    expect(path.sourceNodeId).toBe("n1");
    expect(path.examples).toEqual(["/data/in.csv"]);
    const out = slots.find((s) => s.name === "out")!;
    expect(out.type).toBe("path");
  });
  it("失败步骤参数不参与", () => {
    expect(slotize(traceWithParams()).find((s) => s.name === "ignored")).toBeUndefined();
  });
});

describe("6.1.2 分支化", () => {
  it("1 次换型 → 1 条分支", () => {
    const branches = branchize(ctxForDistill());
    expect(branches).toHaveLength(1);
    expect(branches[0]).toMatchObject({ trigger: "capability-failed:cap-dead", fallbackCapabilityId: "cap-alive", nodeId: "n1" });
  });
  it("无修复记录 → 零分支", () => {
    expect(branchize(newBuildContext("b", "r"))).toHaveLength(0);
  });
});

describe("6.1.3 验收泛化", () => {
  it("改写后不含原值（{{slot}} 表达式）", () => {
    const slots = slotize(traceWithParams());
    const templates = generalizeAcceptance(ctxForDistill(), slots);
    const task = templates.find((t) => t.layer === "task")!;
    expect(task.expression).toContain("{{path}}");
    expect(task.expression).not.toContain("/data/in.csv");
  });
});

describe("6.1.4 意图签名", () => {
  it("相似需求距离 < 不相似需求", async () => {
    const s1 = await intentSignature("整理 GitHub 仓库并生成周报", ["github", "周报"]);
    const s2 = await intentSignature("整理 github 仓库生成周报", ["github", "周报"]);
    const s3 = await intentSignature("制作网页游戏并发布上线", ["游戏", "发布"]);
    const dNear = 1 - cosineSimilarity(s1.embedding, s2.embedding);
    const dFar = 1 - cosineSimilarity(s1.embedding, s3.embedding);
    expect(dNear).toBeLessThan(dFar);
  });
  it("注入式 embedder 标记 injected", async () => {
    const s = await intentSignature("x", [], { embed: async () => new Array(8).fill(0.5) });
    expect(s.embedVia).toBe("injected");
    expect(s.embedding).toHaveLength(8);
  });
  it("bag-of-words 确定性", () => {
    expect(bagOfWordsEmbed("hello world")).toEqual(bagOfWordsEmbed("hello world"));
    expect(bagOfWordsEmbed("hello world").length).toBe(64);
  });
});

describe("6.2 场景库", () => {
  let dir: string;
  let library: ScenarioLibrary;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "scenarios-"));
    const store = jsonStore<ReturnType<typeof recordFromDistilled> extends infer R ? R : never>({
      filePath: path.join(dir, "s.json"),
      schema: { safeParse: (v: unknown) => ({ success: true, data: v }) } as never,
    });
    library = new ScenarioLibrary({ store });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function saveOne(id: string, goal = "整理 /data 仓库数据"): Promise<ReturnType<typeof recordFromDistilled>> {
    const ctx = ctxForDistill();
    ctx.intent = { goal, domain: "dev", slots: [], keywords: ["数据"], via: "template" };
    const distilled = await distill(ctx);
    const record = recordFromDistilled({ id, name: id, ctx, distilled, capabilityIds: ["cap-alive"] });
    await library.save(record);
    return record;
  }

  it("6.2.1 存取往返", async () => {
    const record = await saveOne("sc-1");
    const loaded = await library.get("sc-1");
    expect(loaded).toEqual(record);
  });

  it("6.2.2 命中三档路由（阈值标定）", async () => {
    await saveOne("sc-hit");
    const sigSame = await intentSignature("整理 /data 仓库数据", ["数据"]);
    const hit = await library.match(sigSame);
    expect(hit.tier).toBe("hit");

    const sigPartial = await intentSignature("汇总 数据 报告 概览", ["数据", "汇总"]);
    const partial = await library.match(sigPartial);
    expect(["hit", "partial"]).toContain(partial.tier);

    const sigMiss = await intentSignature(" Completely different domain like cooking recipes 深海鱼料理", ["烹饪"]);
    const miss = await library.match(sigMiss);
    expect(miss.tier).toBe("miss");
  });

  it("6.2.3 填槽执行更新 stats", async () => {
    await saveOne("sc-exec");
    const r1 = await library.execute("sc-exec", { path: "/x" }, async () => ({ ok: true }));
    const r2 = await library.execute("sc-exec", { path: "/y" }, async () => ({ ok: false }));
    expect(r1.ok).toBe(true);
    expect(r2.scenario.stats.uses).toBe(2);
    expect(r2.scenario.stats.successes).toBe(1);
    expect(r2.scenario.stats.lastUsedAt).toBeTruthy();
    expect(r2.scenario.degraded).toBe(false); // 50% 不低于 0.5
  });

  it("6.2.5 低成功率标降级（1/3 < 0.5）", async () => {
    await saveOne("sc-bad");
    await library.execute("sc-bad", {}, async () => ({ ok: true }));
    await library.execute("sc-bad", {}, async () => ({ ok: false }));
    const r3 = await library.execute("sc-bad", {}, async () => ({ ok: false }));
    expect(r3.scenario.stats.uses).toBe(3);
    expect(r3.scenario.stats.successes).toBe(1);
    expect(r3.scenario.degraded).toBe(true);
  });

  it("6.2.4 漂移检测：失效→局部换型→版本+1（mock 全链路）", async () => {
    await saveOne("sc-drift");
    const result = await library.checkDrift(
      "sc-drift",
      async (capabilityId) => capabilityId !== "cap-alive", // 探活：cap-alive 失效
      async (capabilityId) => (capabilityId === "cap-alive" ? "cap-v2" : undefined), // 换型
    );
    expect(result.drifted).toBe(true);
    expect(result.switched).toEqual([{ from: "cap-alive", to: "cap-v2" }]);
    expect(result.newVersion).toBe(2);
    const updated = await library.get("sc-drift");
    expect(updated?.capabilityIds).toEqual(["cap-v2"]);
    expect(updated?.stats.driftCount).toBe(1);
  });

  it("无漂移：版本不变", async () => {
    await saveOne("sc-stable");
    const result = await library.checkDrift("sc-stable", async () => true);
    expect(result.drifted).toBe(false);
    expect(result.newVersion).toBe(1);
  });

  it("execute 未知场景 NOT_FOUND", async () => {
    await expect(library.execute("nope", {}, async () => ({ ok: true }))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
