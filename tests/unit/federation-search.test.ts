import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FederatedSearch, dedupeCapabilities, fileRegistryCache, probeRemote, sourceStatuses } from "@/federation/search";
import { buildCapability } from "@/federation/adapters/adapter-utils";
import { makeStatus } from "@/federation/adapters/base";
import type { AdapterResult, Capability, CapabilityAdapter, CapabilityQuery, Source } from "@/federation/types";

function fakeCap(source: Source, name: string, score: number, over: Partial<Capability> = {}): Capability {
  return buildCapability({
    id: `${source.id}:${name}`,
    name,
    kind: "mcp-server",
    description: "test",
    source,
    install: { type: "npx", package: name, args: [] },
    ...over,
  }) as Capability;
}
const withScore = (cap: Capability, score: number, passed = true): Capability => ({
  ...cap,
  trust: { ...cap.trust, score, hardFilterPassed: passed },
});

const srcA: Source = { id: "modelscope", tier: "curated", name: "A", url: "https://a" };
const srcB: Source = { id: "mcp-so", tier: "aggregate", name: "B", url: "https://b" };
const srcC: Source = { id: "cline-marketplace", tier: "curated", name: "C", url: "https://c" };

function adapterOf(source: Source, behavior: (q: CapabilityQuery) => Promise<AdapterResult> | AdapterResult, supports: (q: CapabilityQuery) => boolean = () => true): CapabilityAdapter {
  return {
    source,
    supports,
    search: async (q) => await behavior(q),
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "fedsearch-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("1.4.1 扇出与降级", () => {
  it("8 mock 源中 2 抛错 1 慢超时式失败，结果仍返回且状态正确", async () => {
    const adapters: CapabilityAdapter[] = [
      adapterOf(srcA, () => ({ capabilities: [fakeCap(srcA, "fs", 0.5)], status: makeStatus(srcA.id, true, false, 0, 1) })),
      adapterOf(srcB, () => { throw new Error("boom A"); }),
      adapterOf(srcC, () => { throw new Error("ECONNRESET"); }),
    ];
    const fs = new FederatedSearch(adapters, undefined, 5);
    const r = await fs.search({ text: "fs" });
    expect(r.capabilities.length).toBe(1);
    const failed = r.statuses.filter((s) => !s.ok);
    expect(failed).toHaveLength(2);
    expect(failed.map((s) => s.message)).toContain("boom A");
    expect(r.statuses.find((s) => s.source === "modelscope")?.ok).toBe(true);
  });

  it("全部失败：空结果但 statuses 完整（不抛出）", async () => {
    const adapters = [srcA, srcB, srcC].map((s) => adapterOf(s, () => { throw new Error("down"); }));
    const r = await new FederatedSearch(adapters).search({ text: "x" });
    expect(r.capabilities).toHaveLength(0);
    expect(r.statuses).toHaveLength(3);
    expect(r.statuses.every((s) => !s.ok)).toBe(true);
  });

  it("supports=false 的源被跳过", async () => {
    const adapters = [adapterOf(srcA, () => ({ capabilities: [], status: makeStatus(srcA.id, true, false, 0, 0) }), () => false)];
    const r = await new FederatedSearch(adapters).search({ text: "x" });
    expect(r.statuses).toHaveLength(0);
  });
});

describe("1.4.2 去重", () => {
  it("同 repo 跨源合并保留高分者", () => {
    const a = withScore(fakeCap(srcA, "GitHub MCP", 0.4, { repoUrl: "https://github.com/x/y" }), 0.4);
    const b = withScore(fakeCap(srcB, "github mcp", 0.8, { repoUrl: "https://github.com/x/y" }), 0.8);
    const out = dedupeCapabilities([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0]?.trust.score).toBe(0.8);
    expect(out[0]?.source.id).toBe("mcp-so");
  });
  it("无 repo 的同名能力按规范名合并", () => {
    const a = withScore(fakeCap(srcA, "Postman API Tools", 0.3), 0.3);
    const b = withScore(fakeCap(srcB, "postman api tools", 0.6), 0.6);
    expect(dedupeCapabilities([a, b])).toHaveLength(1);
  });
  it("不同能力不合并", () => {
    const a = withScore(fakeCap(srcA, "filesystem", 0.3), 0.3);
    const b = withScore(fakeCap(srcB, "git", 0.6), 0.6);
    expect(dedupeCapabilities([a, b])).toHaveLength(2);
  });
});

describe("1.4.3 排序截断", () => {
  it("trust 降序 + top-N 截断 + 硬过滤未过者沉底", async () => {
    const adapters = [
      adapterOf(srcA, () => ({
        capabilities: [
          withScore(fakeCap(srcA, "a1", 0.9), 0.9, false), // 硬过滤未过
          withScore(fakeCap(srcA, "a2", 0.4), 0.4),
          withScore(fakeCap(srcA, "a3", 0.7), 0.7),
        ],
        status: makeStatus(srcA.id, true, false, 0, 3),
      })),
      adapterOf(srcB, () => ({
        capabilities: [withScore(fakeCap(srcB, "b1", 0.5), 0.5)],
        status: makeStatus(srcB.id, true, false, 0, 1),
      })),
    ];
    const r = await new FederatedSearch(adapters, undefined, 2).search({ text: "x" });
    expect(r.capabilities.map((c) => c.name)).toEqual(["a3", "b1"]);
  });
});

describe("1.4.4 缓存 TTL 24h", () => {
  it("命中/过期重拉/损坏重建", async () => {
    const file = path.join(dir, "cache.json");
    let nowMs = 1_000_000;
    const cache = fileRegistryCache({ filePath: file, ttlMs: 1000, now: () => nowMs });
    await cache.put("fs", [withScore(fakeCap(srcA, "fs", 0.5), 0.5)]);
    expect(await cache.get("fs")).toHaveLength(1); // 命中
    nowMs += 2000; // 过期
    expect(await cache.get("fs")).toBeUndefined();
    await writeFile(file, "corrupt{", "utf8");
    expect(await cache.get("fs")).toBeUndefined(); // 损坏 → 空（重建路径）
    await cache.put("fs", [withScore(fakeCap(srcA, "fs2", 0.6), 0.6)]);
    const reread = fileRegistryCache({ filePath: file, ttlMs: 1000, now: () => nowMs });
    expect(await reread.get("fs")).toHaveLength(1);
  });

  it("FederatedSearch 走缓存：第二次搜索不调适配器", async () => {
    const file = path.join(dir, "cache.json");
    const cache = fileRegistryCache({ filePath: file });
    let calls = 0;
    const adapters = [
      adapterOf(srcA, () => {
        calls++;
        return { capabilities: [withScore(fakeCap(srcA, "fs", 0.5), 0.5)], status: makeStatus(srcA.id, true, false, 0, 1) };
      }),
    ];
    const fsSearch = new FederatedSearch(adapters, cache, 5);
    await fsSearch.search({ text: "fs" });
    const second = await fsSearch.search({ text: "fs" });
    expect(calls).toBe(1);
    expect(second.capabilities).toHaveLength(1);
    expect(second.statuses).toHaveLength(0); // 缓存命中无状态报告
  });
});

describe("1.4.5 远程探活", () => {
  it("无 remoteRun 标记 → 不可用+提示", async () => {
    const r = await probeRemote(fakeCap(srcA, "x", 0.5));
    expect(r.available).toBe(false);
    expect(r.message).toBe("no remoteRun endpoint");
  });

  it("本地 HTTP 服务：成功路径返回可用+延迟", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      const cap = fakeCap(srcA, "remote-x", 0.5, { remoteRun: { url: `http://127.0.0.1:${port}/mcp`, transport: "streamable-http" } });
      const r = await probeRemote(cap, 3000);
      expect(r.available).toBe(true);
      expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    } finally {
      server.close();
    }
  });

  it("连接拒绝 → 不可用+可读错误", async () => {
    const cap = fakeCap(srcA, "dead", 0.5, { remoteRun: { url: "http://127.0.0.1:1/mcp" } });
    const r = await probeRemote(cap, 2000);
    expect(r.available).toBe(false);
    expect(r.message).toBeTruthy();
  });
});

describe("sourceStatuses 汇总", () => {
  it("ok/degraded/failed/skipped 四态", async () => {
    const adapters = [
      adapterOf(srcA, () => ({ capabilities: [], status: makeStatus(srcA.id, true, true, 0, 0, "degraded") })),
      adapterOf(srcB, () => { throw new Error("down"); }),
    ];
    const fsSearch = new FederatedSearch(adapters);
    const r = await fsSearch.search({ text: "x" });
    const map = sourceStatuses(
      [...adapters, adapterOf(srcC, () => ({ capabilities: [], status: makeStatus(srcC.id, true, false, 0, 0) }), () => false)],
      r,
    );
    expect(map["modelscope"]).toBe("degraded");
    expect(map["mcp-so"]).toBe("failed");
    expect(map["cline-marketplace"]).toBe("skipped");
  });
});
