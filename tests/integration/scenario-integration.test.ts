import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createOrchestrator, attachVirtualUser } from "@/orchestrator/runner";
import { memoryBuildStore } from "@/orchestrator/build-store";
import { distill } from "@/distill/distill";
import { ScenarioLibrary, recordFromDistilled } from "@/scenario/library";
import { jsonStore } from "@/core/store";
import { VirtualUser } from "../virtual-user/driver";
import { buildCapability } from "@/federation/adapters/adapter-utils";
import type { Capability, Source } from "@/federation/types";
import type { FederatedResult } from "@/federation/search";
import type { HandlerDeps } from "@/orchestrator/handlers";
import type { BuildContext } from "@/orchestrator/context";
import { z } from "zod";

/**
 * 阶段六集成：需求A从零构建+固化；相似需求B命中复用；禁用能力后复用验证 drift 修复闭环。
 */

const src: Source = { id: "modelscope", tier: "curated", name: "t", url: "https://t" };

function mkCap(id: string, url: string): Capability {
  return buildCapability({
    id,
    name: id,
    kind: "mcp-server",
    description: id,
    source: src,
    install: { type: "remote", url },
    remoteRun: { url },
    tags: ["fs"],
  });
}

function depsFor(cap: Capability): HandlerDeps {
  return {
    search: async (q: string, _limit?: number): Promise<FederatedResult> => ({
      query: q,
      capabilities: [cap],
      statuses: [{ source: "modelscope", ok: true, degraded: false, latencyMs: 1, count: 1 }],
      totalMs: 1,
    }),
    llm: {
      parseIntent: async (req) => ({ goal: req, domain: "dev", slots: [{ name: "path", value: "/data" }], keywords: ["数据", "整理"], via: "llm" as const }),
      planTasks: async () => ({
        nodes: [
          { id: "n1", title: "读取数据", deps: [], expectedOutput: "rows" },
          { id: "n2", title: "产出报告", deps: ["n1"], expectedOutput: "report" },
        ],
      }),
    },
    execute: async (ctx: BuildContext) => {
      ctx.trace.push({
        nodeId: "n1",
        startedAt: "t",
        finishedAt: "t",
        status: "success",
        params: { path: "/data/in.csv" },
        output: { rows: 3 },
      });
      ctx.trace.push({
        nodeId: "n2",
        startedAt: "t",
        finishedAt: "t",
        status: "success",
        params: { path: "/data/out.md" },
        output: { report: "ok" },
      });
      ctx.acceptance.push({ layer: "task", passed: true, detail: { echo: "/data/in.csv" }, at: "t" });
    },
  };
}

let dir: string;
let library: ScenarioLibrary;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "scen-int-"));
  library = new ScenarioLibrary(
    { store: jsonStore<never>({ filePath: path.join(dir, "s.json"), schema: { safeParse: (v: unknown) => ({ success: true, data: v }) } as never }) },
    { hit: 0.7, partial: 0.3 },
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function buildAndPin(id: string, goal: string): Promise<BuildContext> {
  const cap = mkCap("cap-fs", "http://127.0.0.1:65000/mcp");
  const store = memoryBuildStore();
  const orch = createOrchestrator({ handlerDeps: depsFor(cap), store });
  attachVirtualUser(orch, new VirtualUser({ kind: "approve-all" }));
  orch.start(goal, id);
  const final = await orch.run();
  expect(final.phase).toBe("done");
  const distilled = await distill(final);
  const record = recordFromDistilled({
    id,
    name: id,
    ctx: final,
    distilled,
    capabilityIds: final.selections.map((s) => s.capabilityId),
  });
  await library.save(record);
  return final;
}

describe("阶段六集成", () => {
  it("需求A从零构建+固化 → 相似需求B命中复用 → 漂移修复闭环", async () => {
    // 1. 需求A：从零构建并固化
    const buildA = await buildAndPin("sc-a", "整理 /data 下的仓库数据并生成报告");
    expect(buildA.selections.length).toBeGreaterThan(0);

    // 2. 相似需求B：命中复用（不开新构建）
    const sigB = await import("@/distill/distill").then((m) => m.intentSignature("整理 /data 的数据并输出报告", ["数据", "整理"]));
    const match = await library.match(sigB);
    expect(match.tier).toBe("hit");
    expect(match.scenario?.id).toBe("sc-a");

    // 3. 填槽执行复用：stats 更新
    const run = await library.execute("sc-a", { path: "/data/in.csv" }, async () => ({ ok: true }));
    expect(run.ok).toBe(true);
    expect(run.scenario.stats.uses).toBe(1);

    // 4. 禁用能力（探活失败）后复用：drift 检测 → 局部换型 → 版本+1
    const drift = await library.checkDrift(
      "sc-a",
      async (capabilityId) => capabilityId !== "cap-fs", // cap-fs 已禁用
      async () => "cap-fs-v2", // trust 次优替代
    );
    expect(drift.drifted).toBe(true);
    expect(drift.switched).toEqual([{ from: "cap-fs", to: "cap-fs-v2" }]);
    expect(drift.newVersion).toBe(2);
    const updated = await library.get("sc-a");
    expect(updated?.capabilityIds).toContain("cap-fs-v2");
    expect(updated?.stats.driftCount).toBe(1);

    // 5. 换型后复用正常
    const run2 = await library.execute("sc-a", { path: "/data/x" }, async () => ({ ok: true }));
    expect(run2.scenario.pinnedVersion).toBe(2);
    expect(run2.scenario.stats.uses).toBe(2);
  });

  it("输出 schema 全链路：蒸馏产物可 zod 校验（固化格式稳定）", async () => {
    await buildAndPin("sc-schema", "整理 /data 下的仓库数据并生成报告");
    const loaded = await library.get("sc-schema");
    const check = z
      .object({
        slotDefs: z.array(z.object({ name: z.string(), type: z.string(), sourceNodeId: z.string(), examples: z.array(z.string()) })),
        signature: z.object({ keywords: z.array(z.string()), embedding: z.array(z.number()) }),
      })
      .safeParse(loaded?.distilled);
    expect(check.success).toBe(true);
  });
});
