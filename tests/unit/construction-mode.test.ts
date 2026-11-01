import { describe, expect, it } from "vitest";
import { buildCapability } from "@/federation/adapters/adapter-utils";
import { makeStatus } from "@/federation/adapters/base";
import type { FederatedResult } from "@/federation/search";
import type { Source } from "@/federation/types";
import { createOrchestrator, attachVirtualUser } from "@/orchestrator/runner";
import { memoryBuildStore } from "@/orchestrator/build-store";
import { VirtualUser } from "@/gates/virtual-user";

const source: Source = { id: "modelscope", tier: "curated", name: "local test", url: "https://example.com" };

describe("construction-only 场景构建", () => {
  it("只记录 planned 映射，不调用外部执行器，并以未验证状态完成构建", async () => {
    const capability = buildCapability({
      id: "local:planner",
      name: "本地规划能力",
      kind: "skill-knowledge",
      description: "仅用于构建阶段的本地规划说明",
      source,
      install: { type: "context", location: "builtin://planner" },
    });
    const result: FederatedResult = {
      query: "测试",
      capabilities: [capability],
      statuses: [makeStatus(source.id, true, false, performance.now(), 1)],
      totalMs: 0,
    };
    let constructionHandlerCalls = 0;
    const orchestrator = createOrchestrator({
      handlerDeps: {
        search: async () => result,
        execute: async (ctx) => {
          constructionHandlerCalls++;
          for (const node of ctx.assembly?.nodes ?? []) {
            ctx.trace.push({ nodeId: node.nodeId, capabilityId: node.capabilityId, startedAt: "t", finishedAt: "t", status: "planned" });
          }
          ctx.acceptance.push({ layer: "task", passed: true, detail: { mode: "construction", verified: false }, at: "t" });
        },
        probe: async () => ({ available: true, latencyMs: 0, message: "construction-only" }),
        distill: async (ctx) => {
          ctx.acceptance.push({ layer: "generalization", passed: true, detail: { mode: "construction", verified: false }, at: "t" });
        },
      },
      store: memoryBuildStore(),
    });
    attachVirtualUser(orchestrator, new VirtualUser({ kind: "approve-all" }));
    orchestrator.start("测试一个本地场景", "construction-test", null, "construction");
    const final = await orchestrator.run();
    expect(constructionHandlerCalls).toBe(1);
    expect(final.executionMode).toBe("construction");
    expect(final.outcome).toBe("completed");
    expect(final.trace.length).toBeGreaterThan(0);
    expect(final.trace.every((step) => step.status === "planned")).toBe(true);
    expect(final.acceptance.some((record) => record.detail.verified === false)).toBe(true);
  });
});
