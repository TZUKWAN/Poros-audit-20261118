import { describe, expect, it } from "vitest";
import { createOrchestrator, attachVirtualUser } from "@/orchestrator/runner";
import { memoryBuildStore } from "@/orchestrator/build-store";
import { renderGate1, renderGate2, renderGate3, renderGate4, renderGate5 } from "@/gates/views";
import { GATES } from "@/gates/framework";
import { VirtualUser } from "../virtual-user/driver";
import { buildCapability } from "@/federation/adapters/adapter-utils";
import type { Capability, Source } from "@/federation/types";
import type { FederatedResult } from "@/federation/search";
import type { HandlerDeps } from "@/orchestrator/handlers";
import type { GateRequest } from "@/orchestrator/state-machine";

/**
 * 阶段三集成：虚拟用户完成一轮全五闸门（每个闸门视图渲染被真实消费）；
 * 闸门3 驳回一次验证重出候选；approvals 完整。
 */

const src: Source = { id: "modelscope", tier: "curated", name: "t", url: "https://t" };

function mkCaps(seed: string, n: number): Capability[] {
  return Array.from({ length: n }, (_, i) =>
    buildCapability({
      id: `src:cap-${seed}-${i}`,
      name: `cap-${seed}-${i}`,
      kind: "mcp-server",
      description: `能力 ${seed} ${i}`,
      source: src,
      install: { type: "npx", package: `pkg-${seed}-${i}`, args: [] },
      tags: ["fs"],
    }),
  );
}

function handlerDepsWithCallounter(counter: { n: number }): HandlerDeps {
  const caps = mkCaps("fs", 3);
  return {
    search: async (q: string, limit?: number): Promise<FederatedResult> => {
      counter.n++;
      return {
        query: q,
        capabilities: caps.slice(0, limit ?? 5),
        statuses: [{ source: "modelscope", ok: true, degraded: false, latencyMs: 1, count: caps.length }],
        totalMs: 1,
      };
    },
  };
}

describe("阶段三集成：全五闸门联测", () => {
  it("虚拟用户全程批准：每道闸门视图渲染且决策被应用，approvals 完整", async () => {
    const store = memoryBuildStore();
    const orch = createOrchestrator({ handlerDeps: handlerDepsWithCallounter({ n: 0 }), store });
    const renderedGates: number[] = [];
    const user = new VirtualUser({ kind: "approve-all" });
    attachVirtualUser(orch, user);
    // 观测每个闸门的渲染（模拟 TUI/面板消费）
    orch.on("gate:pending", ({ request }) => {
      renderedGates.push(request.gate);
      const view = renderForGate(request);
      expect(view.lines.length).toBeGreaterThan(2);
      expect(view.title).toBe(GATES[request.gate].name);
    });
    orch.start("整理仓库并周报", "build-gates");
    const final = await orch.run();
    expect(final.phase).toBe("done");
    expect(renderedGates).toEqual([1, 2, 3, 4, 5]);
    expect(final.approvals.map((a) => a.action)).toEqual(["approve", "approve", "approve", "approve", "approve"]);
  });

  it("闸门3 驳回一次：重出候选（retrieving 重跑），最终 done", async () => {
    const store = memoryBuildStore();
    const counter = { n: 0 };
    const orch = createOrchestrator({ handlerDeps: handlerDepsWithCallounter(counter), store });
    const user = new VirtualUser({ kind: "reject", gate: 3, times: 1, targetPhase: "retrieving", comment: "换一批" });
    attachVirtualUser(orch, user);
    const gate3Count: number[] = [];
    orch.on("gate:pending", ({ request }) => {
      if (request.gate === 3) {
        gate3Count.push((request.payload as unknown[]).length);
      }
    });
    orch.start("r", "build-g3reject");
    const final = await orch.run();
    expect(final.phase).toBe("done");
    expect(gate3Count).toHaveLength(2); // 两次出候选
    expect(counter.n).toBeGreaterThanOrEqual(6); // 3 节点 × 2 轮检索
    expect(final.approvals.some((a) => a.gate === 3 && a.action === "reject")).toBe(true);
  });

  it("闸门1 编辑型决策：槽位编辑进入后续闸门渲染", async () => {
    const store = memoryBuildStore();
    // parsing 注入含槽位的意图（LLM 形态）
    const deps = handlerDepsWithCallounter({ n: 0 });
    deps.llm = {
      parseIntent: async (req) => ({
        goal: req,
        domain: "dev",
        slots: [{ name: "repo", value: "OLD/REPO" }],
        keywords: ["github"],
        via: "llm" as const,
      }),
      planTasks: async () => null,
    };
    const orch2 = createOrchestrator({ handlerDeps: deps, store });
    const user = new VirtualUser({ kind: "edit-gate1", slotName: "repo", slotValue: "NEW/REPO" });
    attachVirtualUser(orch2, user);
    let gate1Intent: { slots?: Array<{ name: string; value: string }> } | null = null;
    orch2.on("gate:pending", ({ request }) => {
      if (request.gate === 1) gate1Intent = request.payload as { slots?: Array<{ name: string; value: string }> };
    });
    orch2.start("整理仓库", "build-edit1");
    const final = await orch2.run();
    expect(final.phase).toBe("done");
    // 虚拟用户编辑作用在 payload 上（同一对象引用被闸门1提案消费）
    const gate1: { slots?: Array<{ name: string; value: string }> } = gate1Intent ?? {};
    const slot = (gate1.slots ?? []).find((s) => s.name === "repo");
    expect(slot?.value).toBe("NEW/REPO");
  });

  it("五道闸门渲染内容各自含关键元素（真实 payload 形态）", async () => {
    const store = memoryBuildStore();
    const orch = createOrchestrator({ handlerDeps: handlerDepsWithCallounter({ n: 0 }), store });
    const user = new VirtualUser({ kind: "approve-all" });
    attachVirtualUser(orch, user);
    const rendered: Record<number, string> = {};
    orch.on("gate:pending", ({ request }) => {
      rendered[request.gate] = renderForGate(request).lines.join("\n");
    });
    orch.start("需求", "build-render");
    await orch.run();
    expect(rendered[1]).toContain("目标:");
    expect(rendered[2]).toContain("任务节点");
    expect(rendered[3]).toContain("候选");
    expect(rendered[3]).toContain("[策展]");
    expect(rendered[4]).toContain("流水线图");
    expect(rendered[5]).toContain("固化入库");
  });
});

function renderForGate(request: GateRequest) {
  switch (request.gate) {
    case 1:
      return renderGate1(request.payload as never);
    case 2:
      return renderGate2(request.payload as never);
    case 3:
      return renderGate3(request.payload as never);
    case 4:
      return renderGate4(request.payload as never);
    case 5:
      return renderGate5(request.payload as never);
  }
}
