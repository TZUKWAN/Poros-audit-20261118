import { describe, expect, it } from "vitest";
import { createOrchestrator, attachVirtualUser } from "@/orchestrator/runner";
import { memoryBuildStore } from "@/orchestrator/build-store";
import { handleExecutingReal } from "@/execution/wire-executing";
import { AcceptanceReporter } from "@/acceptance/acceptance";
import { VirtualUser } from "../virtual-user/driver";
import { buildCapability } from "@/federation/adapters/adapter-utils";
import type { Capability, Source } from "@/federation/types";
import type { FederatedResult } from "@/federation/search";
import type { HandlerDeps } from "@/orchestrator/handlers";
import type { BuildContext } from "@/orchestrator/context";
import type { ExecutingDeps } from "@/execution/wire-executing";
import { z } from "zod";

/**
 * 阶段五集成：制造三层各自失败，验证报告准确归因到层级与节点。
 */

const src: Source = { id: "modelscope", tier: "curated", name: "t", url: "https://t" };

function mkCap(id: string): Capability {
  return buildCapability({
    id,
    name: id,
    kind: "mcp-server",
    description: id,
    source: src,
    install: { type: "remote", url: `http://127.0.0.1:1/${id}` },
    remoteRun: { url: `http://127.0.0.1:1/${id}` },
    tags: ["fs"],
  });
}

function depsWith(invokeImpl: ExecutingDeps["invoke"]): HandlerDeps {
  const caps = [mkCap("cap-a"), mkCap("cap-b"), mkCap("cap-c")];
  const deps: HandlerDeps = {
    search: async (q: string, limit?: number): Promise<FederatedResult> => ({
      query: q,
      capabilities: caps.slice(0, limit ?? 5),
      statuses: [{ source: "modelscope", ok: true, degraded: false, latencyMs: 1, count: 3 }],
      totalMs: 1,
    }),
  };
  deps.execute = (ctx: BuildContext) => handleExecutingReal(ctx, { invoke: invokeImpl });
  return deps;
}

async function runBuild(deps: HandlerDeps, id: string): Promise<BuildContext> {
  const store = memoryBuildStore();
  const orch = createOrchestrator({ handlerDeps: deps, store });
  attachVirtualUser(orch, new VirtualUser({ kind: "approve-all" }));
  orch.start("r", id);
  return await orch.run();
}

describe("阶段五集成：三层失败归因", () => {
  it("L2 失败（invoke 全挂且修复不可救）：执行升级 ACCEPTANCE_FAILED", async () => {
    // 三个候选全挂 → RepairLoop 升级 → 自主模式记录并终止该次执行
    await expect(
      runBuild(depsWith(async () => ({ ok: false, error: "connection refused" })), "b-l2"),
    ).rejects.toMatchObject({ code: "ACCEPTANCE_FAILED" });
  });

  it("L2 首节点挂、修复换型救回：任务验收通过且记录 attempts", async () => {
    const calls: string[] = [];
    const deps = depsWith(async (cap) => {
      calls.push(cap.id);
      // cap-a（默认选型）挂；cap-b/c 好
      return cap.id === "cap-a" ? { ok: false, error: "dead" } : { ok: true, output: { result: "ok" } };
    });
    const ctx = await runBuild(deps, "b-repaired");
    const taskAcc = ctx.acceptance.filter((a) => a.layer === "task");
    expect(taskAcc.length).toBeGreaterThan(0);
    const last = taskAcc.at(-1);
    expect(last?.passed).toBe(true);
    void calls;
  });

  it("报告生成贯通：用真实 run 产物构建三层报告（组件级 schema 失败归因）", async () => {
    const deps = depsWith(async () => ({ ok: true, output: { result: "ok" } }));
    const ctx = await runBuild(deps, "b-report");
    const reporter = new AcceptanceReporter();
    const report = await reporter.build({
      ctx,
      // 模拟 L1 schema 挂：smoke 输出不符合 schema
      componentResults: [
        { capabilityId: "cap-a", available: true, latencyMs: 3, schemaOk: false, schemaError: "required: result" },
      ],
      taskVerdicts: [{ nodeId: "n1", passed: true, ruleResults: [{ criterionId: "r", passed: true }], judgeScores: [] }],
      generalization: { passed: false, skipped: true, reason: "no slots in template dag" },
    });
    expect(report.allPassed).toBe(false);
    expect(report.attribution.some((a) => a.includes("L1") && a.includes("cap-a") && a.includes("required: result"))).toBe(true);
    expect(report.attribution.some((a) => a.includes("L3"))).toBe(true);
  });

  it("泛化测试器接真实执行函数（输出 schema 过规则）", async () => {
    const { GeneralizationTester, TaskAcceptance } = await import("@/acceptance/acceptance");
    const tester = new GeneralizationTester({
      run: async (inputs) => ({ ok: true, output: { result: `processed:${inputs.path}` } }),
      taskAcceptance: new TaskAcceptance(),
      criteria: [{ id: "echo", description: "回显输入", rule: (o) => z.object({ result: z.string() }).safeParse(o).success, needsJudge: false }],
    });
    const v = await tester.check([{ name: "path", examples: ["/x", "/y"] }]);
    expect(v.passed).toBe(true);
    expect(v.attempts).toHaveLength(2);
  });
});
