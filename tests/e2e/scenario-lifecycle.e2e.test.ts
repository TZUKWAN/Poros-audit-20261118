import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createOrchestrator, attachVirtualUser } from "@/orchestrator/runner";
import { memoryBuildStore } from "@/orchestrator/build-store";
import { newBuildContext } from "@/orchestrator/context";
import { distill } from "@/distill/distill";
import { ScenarioLibrary, recordFromDistilled } from "@/scenario/library";
import { sessionMemoryMd, knowledgeEntryMd, KnowledgeMemory, memoryPaths, memoryTree } from "@/memory/memory";
import { GoalLoop } from "@/execution/loop";
import { jsonStore } from "@/core/store";
import { z } from "zod";
import { VirtualUser } from "../virtual-user/driver";
import { buildCapability } from "@/federation/adapters/adapter-utils";
import type { Capability, Source } from "@/federation/types";
import type { FederatedResult } from "@/federation/search";
import type { HandlerDeps } from "@/orchestrator/handlers";
import type { BuildContext } from "@/orchestrator/context";
import { DEMO_REQUIREMENTS, DEMO_GOAL } from "./scripts.js";

/**
 * 阶段九 e2e（虚拟用户驱动、无人干预）：
 *  9.2 需求A从零构建 → 固化
 *  9.3 需求B命中复用 → 输出耗时/步骤对比报告
 *  9.4 目标模式 2 轮 → Memory 树生长断言
 *  9.5 漂移场景 → 局部换型恢复
 */

const src: Source = { id: "modelscope", tier: "curated", name: "t", url: "https://t" };

function mkCap(id: string, port: number): Capability {
  return buildCapability({
    id, name: id, kind: "mcp-server", description: id, source: src,
    install: { type: "remote", url: `http://127.0.0.1:${port}/mcp` },
    remoteRun: { url: `http://127.0.0.1:${port}/mcp` },
    tags: ["fs"],
  });
}

function demoDeps(cap: Capability): HandlerDeps {
  return {
    search: async (q: string, _limit?: number): Promise<FederatedResult> => ({
      query: q, capabilities: [cap],
      statuses: [{ source: "modelscope", ok: true, degraded: false, latencyMs: 1, count: 1 }], totalMs: 1,
    }),
    llm: {
      parseIntent: async (req) => ({ goal: req, domain: DEMO_REQUIREMENTS.repoDigest!.domain, slots: [{ name: "path", value: "/data/repo" }], keywords: DEMO_REQUIREMENTS.repoDigest!.keywords, via: "llm" as const }),
      planTasks: async () => ({
        nodes: [
          { id: "n1", title: "读取数据", deps: [], expectedOutput: "rows" },
          { id: "n2", title: "产出报告", deps: ["n1"], expectedOutput: "report" },
        ],
      }),
    },
    execute: async (ctx: BuildContext) => {
      for (const n of ["n1", "n2"]) {
        ctx.trace.push({ nodeId: n, startedAt: "t", finishedAt: "t", status: "success", params: { path: "/data/repo/commits.log" }, output: { ok: true } });
      }
      ctx.acceptance.push({ layer: "task", passed: true, detail: { echo: "/data/repo" }, at: "t" });
    },
  };
}

let dir: string;
let library: ScenarioLibrary;
const knowledge = new KnowledgeMemory();

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "e2e-"));
  library = new ScenarioLibrary(
    { store: jsonStore({ filePath: path.join(dir, "scen.json"), schema: z.unknown() }) },
    { hit: 0.7, partial: 0.3 },
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function buildDemo(spec: { requirement: string }, id: string): Promise<BuildContext> {
  const cap = mkCap("cap-fs", 65000);
  const orch = createOrchestrator({ handlerDeps: demoDeps(cap), store: memoryBuildStore() });
  attachVirtualUser(orch, new VirtualUser({ kind: "approve-all" }));
  orch.start(spec.requirement, id);
  const final = await orch.run();
  expect(final.phase).toBe("done");
  const distilled = await distill(final);
  await library.save(
    recordFromDistilled({ id, name: id, ctx: final, distilled, capabilityIds: [...new Set(final.selections.map((s) => s.capabilityId))] }),
  );
  return final;
}

describe("9.2 e2e：需求A从零构建 → 固化", () => {
  it("无人干预走完五闸门并产出场景记录", async () => {
    const demo = DEMO_REQUIREMENTS.repoDigest as { requirement: string };
    const final = await buildDemo(demo, "e2e-a");
    expect(final.approvals.map((a) => a.action)).toEqual(["approve", "approve", "approve", "approve", "approve"]);
    const saved = await library.get("e2e-a");
    expect(saved?.pinnedVersion).toBe(1);
    expect(saved?.distilled.slotDefs.some((s) => s.name === "path")).toBe(true);
  });
});

describe("9.3 e2e：需求B命中复用 → 对比报告", () => {
  it("输出耗时/步骤对比报告并落盘", async () => {
    const t0 = Date.now();
    await buildDemo(DEMO_REQUIREMENTS.repoDigest as { requirement: string }, "e2e-b1");
    const buildMs = Date.now() - t0;

    // 需求B：命中复用
    const t1 = Date.now();
    const { intentSignature } = await import("@/distill/distill");
    const sigB = await intentSignature(DEMO_REQUIREMENTS.dataReport!.requirement, DEMO_REQUIREMENTS.dataReport!.keywords);
    const match = await library.match(sigB);
    expect(match.tier).toBe("hit");
    const reuse = await library.execute("e2e-b1", { path: "/data/repo" }, async () => ({ ok: true }));
    const reuseMs = Date.now() - t1;
    expect(reuse.ok).toBe(true);

    // 对比报告（可重放产物）
    const report = [
      "# 需求A/B 对比报告",
      "",
      `- A（从零构建）: ${buildMs}ms，闸门 5 道，${2} 步执行`,
      `- B（命中复用）: ${reuseMs}ms，0 道闸门，填槽 1 次执行`,
      `- 耗时比: ${(buildMs / Math.max(reuseMs, 1)).toFixed(1)}x`,
      `- 复用场景: e2e-b1 v${reuse.scenario.pinnedVersion}`,
    ].join("\n");
    await writeFile(path.join(dir, "compare-report.md"), report, "utf8");
    const content = await readFile(path.join(dir, "compare-report.md"), "utf8");
    expect(content).toContain("需求A/B 对比报告");
    expect(content).toContain("复用场景: e2e-b1");
  });
});

function countMemoryFiles(node: { kind: string; children?: Array<{ kind: string; children?: unknown[] }> }): number {
  if (node.kind === "file") return 1;
  return (node.children ?? []).reduce((sum, c) => sum + countMemoryFiles(c as never), 0);
}

describe("9.4 e2e：目标模式 2 轮 → Memory 树生长", () => {
  it("两轮达成 + 轮次放行 + Memory 文件生长", async () => {
    const paths = memoryPaths(dir);
    for (const p of [paths.sessions, paths.knowledge]) await mkdir(p, { recursive: true });
    const before = countMemoryFiles(await memoryTree(paths));

    const gateLog: string[] = [];
    const loop = new GoalLoop({
      goal: DEMO_GOAL.goal,
      maxRounds: DEMO_GOAL.maxRounds,
      goalCheck: (r) => (r.metrics.coverage ?? 0) >= 1,
      runRound: async (n) => {
        return { round: n, summary: `第 ${n} 轮扫描完成`, goalMet: false, metrics: { coverage: n / 2 } };
      },
      roundGate: async (result) => {
        gateLog.push(`轮 ${result.round} 放行`);
        return { action: "approve" };
      },
    });
    const out = await loop.run();
    expect(out.reason).toBe("goal-met");
    expect(out.rounds).toBe(2);
    expect(gateLog).toEqual(["轮 1 放行"]);

    // Memory 生长：会话 + 知识两条落盘
    const loopCtx = newBuildContext("loop-run", DEMO_GOAL.goal);
    loopCtx.trace.push({ nodeId: `round-${out.rounds}`, startedAt: "t", finishedAt: "t", status: "success" });
    await writeFile(path.join(paths.sessions, "loop-run.md"), sessionMemoryMd(loopCtx), "utf8");
    const entry = knowledge.recordFailure("loop:first-round-miss", "首轮覆盖不足 → 放行注入修正指令");
    await writeFile(path.join(paths.knowledge, `${entry.id}.md`), knowledgeEntryMd(entry), "utf8");

    const after = countMemoryFiles(await memoryTree(paths));
    expect(after).toBeGreaterThan(before);
    const files = await readdir(paths.sessions);
    expect(files).toContain("loop-run.md");
  });
});

describe("9.5 e2e：漂移场景 → 局部换型恢复", () => {
  it("禁用能力后复用触发 drift → 换型 → v2 可用", async () => {
    await buildDemo(DEMO_REQUIREMENTS.repoDigest as { requirement: string }, "e2e-drift");
    const drift = await library.checkDrift(
      "e2e-drift",
      async (capabilityId) => capabilityId !== "cap-fs", // cap-fs 被禁用
      async () => "cap-fs-v2",
    );
    expect(drift.drifted).toBe(true);
    expect(drift.newVersion).toBe(2);
    const reuse = await library.execute("e2e-drift", { path: "/data/repo" }, async () => ({ ok: true }));
    expect(reuse.ok).toBe(true);
    expect(reuse.scenario.pinnedVersion).toBe(2);
    expect(reuse.scenario.capabilityIds).toContain("cap-fs-v2");
  });
});
