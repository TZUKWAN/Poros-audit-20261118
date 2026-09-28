import { describe, expect, it, vi } from "vitest";
import { RepairLoop, RunController } from "@/execution/repair";
import { newBuildContext, type BuildContext } from "@/orchestrator/context";
import { buildCapability } from "@/federation/adapters/adapter-utils";
import type { Capability, Source } from "@/federation/types";

const src: Source = { id: "modelscope", tier: "curated", name: "t", url: "https://t" };

function mkCap(id: string, score: number): Capability {
  const c = buildCapability({
    id,
    name: id,
    kind: "mcp-server",
    description: id,
    source: src,
    install: { type: "npx", package: id, args: [] },
    tags: ["fs"],
  });
  return { ...c, trust: { ...c.trust, score } };
}

function repairCtx(): BuildContext {
  const ctx = newBuildContext("b1", "r");
  ctx.selections.push({ nodeId: "n1", capabilityId: "cap-a", overridden: false });
  return ctx;
}

describe("3.3.1 自动修复回路", () => {
  it("失败 2 次后成功：按 trust 次优换型 2 次，最终选型 overridden", async () => {
    const ctx = repairCtx();
    const caps = [mkCap("cap-a", 0.9), mkCap("cap-b", 0.7), mkCap("cap-c", 0.5)];
    const loop = new RepairLoop({
      candidatesFor: () => caps,
      runNode: async (_nodeId, capId) => ({ passed: capId === "cap-c" }), // a/b 挂，c 过
    });
    const switches: Array<[string, string]> = [];
    loop.on("repair:switch", (e) => switches.push([e.from, e.to]));
    const out = await loop.repairNode(ctx, "n1");
    expect(out.repaired).toBe(true);
    expect(out.escalated).toBe(false);
    expect(out.attempts).toHaveLength(3);
    expect(switches).toEqual([
      ["cap-a", "cap-b"],
      ["cap-b", "cap-c"],
    ]);
    expect(ctx.selections.find((s) => s.nodeId === "n1")?.capabilityId).toBe("cap-c");
    expect(ctx.selections.find((s) => s.nodeId === "n1")?.overridden).toBe(true);
  });

  it("首轮即成功：零换型", async () => {
    const ctx = repairCtx();
    const loop = new RepairLoop({
      candidatesFor: () => [mkCap("cap-a", 0.9)],
      runNode: async () => ({ passed: true }),
    });
    const out = await loop.repairNode(ctx, "n1");
    expect(out.repaired).toBe(true);
    expect(out.attempts).toHaveLength(1);
    expect(out.escalated).toBe(false);
  });

  it("失败 3 次触发升级（maxRounds 硬顶 + 候选耗尽两路径）", async () => {
    const ctx1 = repairCtx();
    const loop1 = new RepairLoop({
      candidatesFor: () => [mkCap("cap-a", 0.9), mkCap("cap-b", 0.7), mkCap("cap-c", 0.5), mkCap("cap-d", 0.3)],
      runNode: async () => ({ passed: false }), // 全挂
    });
    const escalateSpy = vi.fn();
    loop1.on("repair:escalate", escalateSpy);
    const out1 = await loop1.repairNode(ctx1, "n1");
    expect(out1.escalated).toBe(true);
    expect(out1.attempts).toHaveLength(3); // maxRounds=3
    expect(escalateSpy).toHaveBeenCalledTimes(1);

    const ctx2 = repairCtx();
    const loop2 = new RepairLoop({
      candidatesFor: () => [mkCap("cap-a", 0.9)], // 无次优可换
      runNode: async () => ({ passed: false }),
    });
    const out2 = await loop2.repairNode(ctx2, "n1");
    expect(out2.escalated).toBe(true);
    expect(out2.attempts).toHaveLength(1); // 候选耗尽提前终止
  });

  it("失败者不复活：换型单调排除已失败候选（终止性）", async () => {
    const ctx = repairCtx();
    const tried: string[] = [];
    const loop = new RepairLoop({
      candidatesFor: () => [mkCap("cap-a", 0.9), mkCap("cap-b", 0.7), mkCap("cap-c", 0.5)],
      runNode: async (_n, id) => {
        tried.push(id);
        return { passed: false };
      },
      maxRounds: 3,
    });
    await loop.repairNode(ctx, "n1");
    expect(new Set(tried).size).toBe(tried.length); // 无重复尝试
    expect(tried).toEqual(["cap-a", "cap-b", "cap-c"]); // trust 降序
  });
});

describe("3.3.2 暂停/继续/终止控制", () => {
  it("running → paused → running：checkpoint 挂起至 resume", async () => {
    const ctl = new RunController();
    const events: string[] = [];
    ctl.on("control:changed", ({ to }) => events.push(to));
    ctl.pause();
    const checkpoint = ctl.checkpoint();
    let released = false;
    void checkpoint.then(() => {
      released = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(released).toBe(false); // 暂停中
    ctl.resume();
    await checkpoint;
    expect(released).toBe(true);
    expect(events).toEqual(["paused", "running"]);
  });

  it("terminate：checkpoint 抛 CANCELLED；暂停中终止也被唤醒并抛出", async () => {
    const ctl = new RunController();
    ctl.terminate();
    await expect(ctl.checkpoint()).rejects.toMatchObject({ code: "CANCELLED" });

    const ctl2 = new RunController();
    ctl2.pause();
    const cp = ctl2.checkpoint();
    ctl2.terminate();
    await expect(cp).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("非法迁移：paused→pause、terminated→resume、running→resume 报 CONFLICT", () => {
    const ctl = new RunController();
    expect(() => ctl.resume()).toThrow();
    ctl.pause();
    expect(() => ctl.pause()).toThrow();
    ctl.resume();
    ctl.terminate();
    expect(() => ctl.resume()).toThrow();
    expect(() => ctl.pause()).toThrow();
    expect(ctl.currentState).toBe("terminated");
  });

  it("terminate 幂等 + onTerminate 回调触发", async () => {
    const ctl = new RunController();
    const spy = vi.fn();
    ctl.onTerminateCallback(spy);
    ctl.terminate();
    ctl.terminate();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
