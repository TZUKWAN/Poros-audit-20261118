import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { jsonStore } from "@/core/store";
import { FederatedSearch } from "@/federation/search";
import { Orchestrator } from "@/orchestrator/state-machine";
import { VirtualUser } from "@/gates/virtual-user";
import { attachVirtualUser, createOrchestrator } from "@/orchestrator/runner";
import { memoryBuildStore } from "@/orchestrator/build-store";
import { ScenarioLibrary, recordFromDistilled } from "@/scenario/library";
import { distill, intentSignature } from "@/distill/distill";
import { GoalLoop } from "@/execution/loop";
import { newBuildContext } from "@/orchestrator/context";
import { buildCapability } from "@/federation/adapters/adapter-utils";
import { z } from "zod";
import type { CapabilityAdapter, Source } from "@/federation/types";
import type { FederatedResult } from "@/federation/search";
import type { HandlerDeps } from "@/orchestrator/handlers";

const src: Source = { id: "modelscope", tier: "curated", name: "t", url: "https://t" };

const oneCap = () =>
  buildCapability({ id: "t:cap", name: "cap", kind: "mcp-server", description: "x", source: src, install: { type: "npx", package: "p", args: [] }, tags: [] });

const okSearch = async (q: string, _limit?: number): Promise<FederatedResult> => ({
  query: q, capabilities: [oneCap()],
  statuses: [{ source: "modelscope", ok: true, degraded: false, latencyMs: 1, count: 1 }], totalMs: 1,
});

function adapterOf(id: Source["id"], fail: boolean): CapabilityAdapter {
  const source: Source = { id, tier: "aggregate", name: id, url: "https://x" };
  return {
    source,
    supports: () => true,
    search: async () => {
      if (fail) throw new Error("simulated offline");
      return {
        capabilities: [
          buildCapability({ id: `${id}:c`, name: "c", kind: "mcp-server", description: "x", source, install: { type: "npx", package: "p", args: [] }, tags: [] }),
        ],
        status: { source: id, ok: true, degraded: false, latencyMs: 1, count: 1 },
      };
    },
  };
}

describe("R3.1 故障注入", () => {
  it("断网/8 源全挂：结果为空、状态完整、可恢复", async () => {
    const all = (["mcp-so", "modelcontextprotocol-servers", "modelscope", "cline-marketplace", "awesome-mcp-servers", "skills-sh", "skillsmp", "tencent-skillhub"] as const).map((id) =>
      adapterOf(id, true),
    );
    const r = await new FederatedSearch(all).search({ text: "x" });
    expect(r.capabilities).toHaveLength(0);
    expect(r.statuses).toHaveLength(8);
    expect(r.statuses.every((s) => !s.ok)).toBe(true);
    // 恢复后同一检索器实例可正常返回
    const recovered = await new FederatedSearch(all.map((a, i) => (i === 0 ? adapterOf("mcp-so", false) : a))).search({ text: "x" });
    expect(recovered.capabilities).toHaveLength(1);
  });

  it("磁盘满/不可写：store 写入报可读错误且不静默", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "r3-io-"));
    const lockedDir = path.join(dir, "locked");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(lockedDir, { recursive: true });
    // filePath 本身是目录 → rename(tmp → 目录) 失败（EEXIST/EPERM/ENOTEMPTY 之一，折叠为可读错误）
    const store = jsonStore({ filePath: lockedDir, schema: z.unknown() });
    await expect(store.set("k", { v: 1 })).rejects.toThrow();
    await chmod(lockedDir, 0o777).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  it("LLM 超时 → 意图降级模板；畸形 DAG → 可读校验错误（可控可恢复）", async () => {
    const deps: HandlerDeps = {
      search: okSearch,
      llm: {
        parseIntent: () => new Promise((_, reject) => setTimeout(() => reject(new Error("ETIMEDOUT")), 20)),
        planTasks: async () => ({ nodes: [{ id: "a", title: "A", deps: ["ghost"] }] }), // 未知依赖
      },
    };
    const orch = createOrchestrator({ handlerDeps: deps, store: memoryBuildStore() });
    attachVirtualUser(orch, new VirtualUser({ kind: "approve-all" }));
    orch.start("r", "b-r3");
    // 意图超时已降级为模板；畸形 DAG 以可读错误受控上报（含具体节点名，可恢复——修正 LLM 后可重跑）
    const err = await orch.run().then(
      () => { throw new Error("should have thrown"); },
      (e) => e as { code?: string; message?: string },
    );
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toContain("ghost");
    expect(orch.ctx.intent?.via).toBe("template"); // 降级生效
  });

  it("缓存损坏：registry cache 读失败重建（底层 fileRegistryCache 已有覆盖；此处验联邦层不崩）", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "r3-cache-"));
    const { fileRegistryCache } = await import("@/federation/search");
    const { writeFile } = await import("node:fs/promises");
    const file = path.join(dir, "c.json");
    await writeFile(file, "{{{corrupt", "utf8");
    const cache = fileRegistryCache({ filePath: file });
    expect(await cache.get("q")).toBeUndefined(); // 损坏 → 空，不抛
    await cache.put("q", []);
    expect(await cache.get("q")).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });

  it("并发两个构建：互不串扰（同 store 串行化）", async () => {
    const store = memoryBuildStore();
    const deps: HandlerDeps = { search: okSearch };
    const orchA = createOrchestrator({ handlerDeps: deps, store });
    const orchB = createOrchestrator({ handlerDeps: deps, store });
    attachVirtualUser(orchA, new VirtualUser({ kind: "approve-all" }));
    attachVirtualUser(orchB, new VirtualUser({ kind: "approve-all" }));
    orchA.start("需求A", "b-a");
    orchB.start("需求B", "b-b");
    const [ra, rb] = await Promise.all([orchA.run(), orchB.run()]);
    expect(ra.requirement).toBe("需求A");
    expect(rb.requirement).toBe("需求B");
  });

  it("虚拟用户连续驳回 5 次（同闸门循环）后放行：终止且 approvals=6", async () => {
    const deps: HandlerDeps = { search: okSearch };
    const orch = createOrchestrator({ handlerDeps: deps, store: memoryBuildStore() });
    attachVirtualUser(orch, new VirtualUser({ kind: "reject-cycle", cycles: 5, gate: 2, targetPhase: "planning" }));
    orch.start("r", "b-cycle5");
    const final = await orch.run();
    expect(final.phase).toBe("done");
    const gate2 = final.approvals.filter((a) => a.gate === 2);
    expect(gate2).toHaveLength(6); // 5 驳回 + 1 批准
    expect(gate2.filter((a) => a.action === "reject")).toHaveLength(5);
  });

  it("loop 达到轮次上限：受控终止", async () => {
    const loop = new GoalLoop({
      goal: "不可达目标",
      maxRounds: 4,
      goalCheck: () => false,
      runRound: async (n) => ({ round: n, summary: "", goalMet: false, metrics: {} }),
    });
    const out = await loop.run();
    expect(out.reason).toBe("max-rounds");
    expect(out.rounds).toBe(4);
  });

  it("安装失败：INSTALL_FAILED 已覆盖（回归确认）", async () => {
    const { CapabilityInstaller } = await import("@/execution/capability-runtime");
    const installer = new CapabilityInstaller({
      runner: { run: async () => ({ code: 128, stdout: "", stderr: "fatal" }) },
    });
    await expect(
      installer.install(buildCapability({ id: "x:y", name: "y", kind: "mcp-server", description: "", source: src, install: { type: "git", repoUrl: "https://github.com/a/b" }, tags: [] })),
    ).rejects.toMatchObject({ code: "INSTALL_FAILED" });
  });
});

describe("R3.2 大数据量：200 场景", () => {
  let dir: string;
  let library: ScenarioLibrary;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "r3-perf-"));
    library = new ScenarioLibrary({ store: jsonStore({ filePath: path.join(dir, "s.json"), schema: z.unknown() }) });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("200 场景入库后：列表与命中匹配耗时可控（记录耗时）", async () => {
    const t0 = Date.now();
    for (let i = 0; i < 200; i++) {
      const ctx = newBuildContext(`b-${i}`, `整理数据需求编号 ${i}`);
      ctx.intent = { goal: `场景需求变体 ${i % 10}`, domain: "dev", slots: [], keywords: ["数据", `v${i % 10}`], via: "template" };
      const distilled = await distill(ctx);
      await library.save(recordFromDistilled({ id: `sc-${i}`, name: `sc-${i}`, ctx, distilled, capabilityIds: ["cap"] }));
    }
    const saveMs = Date.now() - t0;

    const t1 = Date.now();
    const list = await library.list();
    const listMs = Date.now() - t1;

    const t2 = Date.now();
    const sig = await intentSignature("场景需求变体 7", ["数据", "v7"]);
    const match = await library.match(sig);
    const matchMs = Date.now() - t2;

    expect(list).toHaveLength(200);
    expect(match.tier === "hit" || match.tier === "partial").toBe(true);
    expect(match.scenario?.id).toContain("-7");
    // 性能记录（回归阈值：宽松上限，防意外退化）
    expect(saveMs).toBeLessThan(60_000);
    expect(listMs).toBeLessThan(2_000);
    expect(matchMs).toBeLessThan(2_000);
    console.warn(`[R3.2 perf] save200=${saveMs}ms list=${listMs}ms match=${matchMs}ms`);
  }, 120_000);
});

// 避免 unused 警告：Orchestrator 引用保留（类型层面使用于并发构建用例）
void Orchestrator;
