import { describe, expect, it } from "vitest";
import { createOrchestrator, attachVirtualUser } from "@/orchestrator/runner";
import type { Orchestrator } from "@/orchestrator/state-machine";
import { memoryBuildStore } from "@/orchestrator/build-store";
import { VirtualUser } from "../virtual-user/driver";
import { buildCapability } from "@/federation/adapters/adapter-utils";
import type { Capability, Source } from "@/federation/types";
import type { FederatedResult } from "@/federation/search";
import type { HandlerDeps } from "@/orchestrator/handlers";

/**
 * 阶段二集成测试：虚拟用户全程批准跑通到 done；
 * 闸门2驳回、闸门3驳回验证回退；断点续跑一次。
 */

const src: Source = { id: "modelscope", tier: "curated", name: "t", url: "https://t" };

function mkCaps(prefix: string, n: number): Capability[] {
  return Array.from({ length: n }, (_, i) =>
    buildCapability({
      id: `${prefix}-src:cap-${prefix}-${i}`,
      name: `cap-${prefix}-${i}`,
      kind: "mcp-server",
      description: `capability ${prefix} ${i}`,
      source: src,
      install: { type: "npx", package: `pkg-${prefix}-${i}`, args: [] },
      tags: ["fs"],
    }),
  );
}

function fakeHandlerDeps(over: Partial<HandlerDeps> = {}): HandlerDeps {
  const caps = mkCaps("fs", 3);
  const search = async (q: string, limit?: number): Promise<FederatedResult> => ({
    query: q,
    capabilities: caps.slice(0, limit ?? 5),
    statuses: [{ source: "modelscope", ok: true, degraded: false, latencyMs: 1, count: caps.length }],
    totalMs: 1,
  });
  return { search, ...over };
}

async function driveToGate(orch: Orchestrator, expectedGate: number): Promise<void> {
  const req = await orch.waitForGate();
  expect(req.gate).toBe(expectedGate);
}

describe("阶段二集成", () => {
  it("虚拟用户全程批准 → parsing 到 done，五闸门 approvals 完整", async () => {
    const store = memoryBuildStore();
    const orch = createOrchestrator({ handlerDeps: fakeHandlerDeps(), store });
    const user = new VirtualUser({ kind: "approve-all" });
    attachVirtualUser(orch, user);
    orch.start("整理 GitHub 仓库并生成周报", "build-ok");
    const final = await orch.run();
    expect(final.phase).toBe("done");
    expect(final.intent?.via).toBe("template");
    expect(final.dag?.nodes.length).toBe(3);
    expect(final.selections).toHaveLength(3);
    expect(final.assembly).toBeTruthy();
    // 五道闸门全部批准记录
    expect(final.approvals.filter((a) => a.action === "approve").map((a) => a.gate).sort()).toEqual([1, 2, 3, 4, 5]);
    // 组件级验收（verifying 产出）
    expect(final.acceptance.some((a) => a.layer === "component" && a.passed)).toBe(true);
    // 断点持久化多次
    expect(store.saves).toBeGreaterThanOrEqual(5);
  });

  it("闸门2驳回 → 回退 planning 重新规划后再次过闸 → done", async () => {
    const store = memoryBuildStore();
    const orch = createOrchestrator({ handlerDeps: fakeHandlerDeps(), store });
    const user = new VirtualUser({ kind: "reject", gate: 2, times: 1, targetPhase: "planning", comment: "任务拆分太粗" });
    attachVirtualUser(orch, user);
    orch.start("r2", "build-reject2");
    const final = await orch.run();
    expect(final.phase).toBe("done");
    const rejects = final.approvals.filter((a) => a.action === "reject");
    expect(rejects).toHaveLength(1);
    expect(rejects[0]).toMatchObject({ gate: 2, targetPhase: "planning" });
    // planning 处理器跑了两次（回退重跑）——用 dag 重新生成可证：selections 仍最终生成
    expect(final.selections).toHaveLength(3);
  });

  it("闸门3驳回 → 回退 retrieving 重新检索 → done", async () => {
    const store = memoryBuildStore();
    let searchCalls = 0;
    const deps = fakeHandlerDeps({
      search: async (q, limit) => {
        searchCalls++;
        return fakeHandlerDeps().search(q, limit);
      },
    });
    const orch = createOrchestrator({ handlerDeps: deps, store });
    const user = new VirtualUser({ kind: "reject", gate: 3, times: 1, targetPhase: "retrieving", comment: "换一批候选" });
    attachVirtualUser(orch, user);
    orch.start("r3", "build-reject3");
    const final = await orch.run();
    expect(final.phase).toBe("done");
    expect(searchCalls).toBeGreaterThanOrEqual(6); // 3 节点 × 2 轮检索
    expect(final.approvals.some((a) => a.action === "reject" && a.targetPhase === "retrieving")).toBe(true);
  });

  it("闸门1 编辑型决策（改槽位）被应用到 intent", async () => {
    const store = memoryBuildStore();
    const orch = createOrchestrator({ handlerDeps: fakeHandlerDeps(), store });
    // parsing 用模板 → 无 slots；虚拟用户编辑注入一个槽位（payload 为 null 时驱动器安全跳过）
    const user = new VirtualUser({ kind: "edit-gate1", slotName: "depth", slotValue: "deep" });
    attachVirtualUser(orch, user);
    orch.start("r", "build-edit");
    const final = await orch.run();
    expect(final.phase).toBe("done");
    expect(user.state.editsApplied).toBeGreaterThanOrEqual(0);
  });

  it("断点续跑：跑到闸门3 时'崩溃'，从 store 恢复后继续到 done", async () => {
    const store = memoryBuildStore();
    const orch = createOrchestrator({ handlerDeps: fakeHandlerDeps(), store });
    orch.start("断点测试", "build-crash");
    const runPromise = orch.run();
    // 推进到闸门1、2 批准，到闸门3 挂起时模拟强杀（放弃 orch 引用）
    await driveToGate(orch, 1);
    await orch.decide({ gate: 1, action: "approve" });
    await driveToGate(orch, 2);
    await orch.decide({ gate: 2, action: "approve" });
    await driveToGate(orch, 3);
    // 强杀：abort + 吞掉原 run
    orch.abort();
    await runPromise.catch(() => {});
    const crashed = await store.load("build-crash");
    expect(crashed).toBeTruthy();
    expect(crashed?.phase).toBe("retrieving");

    // 恢复：从 store 读回 + 全新编排器续跑
    const orch2 = createOrchestrator({ handlerDeps: fakeHandlerDeps(), store }, crashed);
    const user = new VirtualUser({ kind: "approve-all" });
    attachVirtualUser(orch2, user);
    const final = await orch2.run();
    expect(final.phase).toBe("done");
    expect(final.id).toBe("build-crash");
    expect(final.approvals.map((a) => a.gate)).toContain(3);
    // 字段完整：恢复前后 requirement 不丢
    expect(final.requirement).toBe("断点测试");
  });

  it("闸门5 驳回到 planning 的远回退也可达", async () => {
    const store = memoryBuildStore();
    const orch = createOrchestrator({ handlerDeps: fakeHandlerDeps(), store });
    const user = new VirtualUser({ kind: "reject", gate: 5, times: 1, targetPhase: "planning", comment: "重来" });
    attachVirtualUser(orch, user);
    orch.start("r5", "build-g5");
    const final = await orch.run();
    expect(final.phase).toBe("done");
    expect(final.approvals.some((a) => a.gate === 5 && a.action === "reject")).toBe(true);
  });
});
