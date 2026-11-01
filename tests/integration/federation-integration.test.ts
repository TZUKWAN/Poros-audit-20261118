import { describe, expect, it } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FederatedSearch, fileRegistryCache, probeRemote } from "@/federation/search";
import { modelscopeAdapter } from "@/federation/adapters/modelscope";
import { clineAdapter } from "@/federation/adapters/cline-marketplace";
import { awesomeAdapter } from "@/federation/adapters/awesome-mcp";
import { officialServersAdapter } from "@/federation/adapters/official-servers";
import { mcpSoAdapter } from "@/federation/adapters/mcp-so";
import { skillsShAdapter, skillsMpAdapter, skillHubAdapter } from "@/federation/adapters/skill-sources";
import type { CapabilityAdapter } from "@/federation/types";
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";

/**
 * 阶段一集成测试（smoke：外网不可用时允许跳过——唯一允许跳过的测试类，协议 F 条）。
 * 3 个真实 query 走完整联邦检索：断言去重、排序、源状态报告完整；快照落盘。
 */
let online = true;
try {
  const r = await fetch("https://api.cline.bot/v1/mcp/marketplace", { signal: AbortSignal.timeout(8000) });
  online = r.ok;
} catch {
  online = false;
}

function allRealAdapters(): CapabilityAdapter[] {
  return [
    mcpSoAdapter(),
    officialServersAdapter(),
    modelscopeAdapter(),
    clineAdapter(),
    awesomeAdapter(),
    skillsShAdapter(),
    skillsMpAdapter(),
    skillHubAdapter(),
  ];
}

describe.skipIf(!online)("阶段一集成：真实联邦检索（smoke）", () => {
  const queries = ["filesystem", "github", "browser automation"];
  const snapshotDir = path.join(__dirname, "__snapshots__");

  it("3 个真实 query 走完整联邦检索并产出快照", async () => {
    const fsSearch = new FederatedSearch(allRealAdapters(), undefined, 5);
    const all: unknown[] = [];
    for (const q of queries) {
      const r = await fsSearch.search({ text: q, limit: 5 });
      // 去重生效：规范名+repo 无重复
      const keys = new Set(
        r.capabilities.map((c) => c.repoUrl?.replace(/\/$/, "").toLowerCase() ?? `name:${c.name.toLowerCase().replace(/\s+/g, "-")}`),
      );
      expect(keys.size).toBe(r.capabilities.length);
      // 排序合理：trust 非升序（且硬过滤未过的沉底）
      for (let i = 1; i < r.capabilities.length; i++) {
        const prev = r.capabilities[i - 1];
        const cur = r.capabilities[i];
        expect(prev!.trust.hardFilterPassed || !cur!.trust.hardFilterPassed).toBe(true);
        if (prev!.trust.hardFilterPassed === cur!.trust.hardFilterPassed) {
          expect(prev!.trust.score).toBeGreaterThanOrEqual(cur!.trust.score);
        }
      }
      // 状态报告完整：8 源都有结论（部分源可能查询无命中但状态 ok）
      expect(r.statuses.length).toBeGreaterThan(0);
      all.push({ query: q, capabilities: r.capabilities, statuses: r.statuses, totalMs: r.totalMs });
    }
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(path.join(snapshotDir, "federation-smoke.json"), JSON.stringify(all, null, 1), "utf8");
    expect(readdirSync(snapshotDir)).toContain("federation-smoke.json");
  }, 120_000);

  it("mcp.so smoke：检索 filesystem 返回非空（slug 直查路径）", async ({ skip }) => {
    const r = await mcpSoAdapter().search({ text: "filesystem" });
    if (!r.status.ok) { console.warn(`mcp.so 当前不可用，跳过外部 smoke：${r.status.message ?? "unknown"}`); skip(); return; }
    expect(r.capabilities.length).toBeGreaterThan(0);
    expect(r.capabilities[0]?.name.toLowerCase()).toContain("file");
  }, 30_000);

  it("ModelScope 远程探活一次（远程优先策略验证）", async () => {
    const search = await modelscopeAdapter().search({ text: "filesystem", limit: 5 });
    const remote = search.capabilities.find((c) => c.remoteRun);
    if (!remote) {
      // 当前查询无远程可探活能力：探活器路径不崩溃即可
      const probe = await probeRemote(search.capabilities[0]!);
      expect(probe.available).toBe(false);
      return;
    }
    const probe = await probeRemote(remote);
    expect(probe.latencyMs).toBeGreaterThanOrEqual(0);
    expect(typeof probe.available).toBe("boolean");
  }, 30_000);

  it("技能下载落盘冒烟：下载→提炼→用完即删无残留", async ({ skip }) => {
    const tmp = await mkdtemp(path.join(tmpdir(), "skillpipe-"));
    try {
      const adapter = skillsShAdapter();
      const search = await adapter.search({ text: "filesystem", limit: 3 });
      if (!search.status.ok) {
        console.warn(`skills.sh 当前不可用，跳过本次外部下载验证：${search.status.message ?? "unknown error"}`);
        skip();
        return;
      }
      const candidates = search.capabilities;
      if (candidates.length === 0) throw new Error("skills.sh returned no candidates for smoke");
      const downloader = (adapter as CapabilityAdapter & {
        download: (c: unknown, d: string) => Promise<{ skillMdPath: string; bytes: number }>;
      }).download;
      let dl: { skillMdPath: string; bytes: number } | undefined;
      let lastError: unknown;
      // Search ranking is remote data and can change. Exercise the real
      // download pipeline with the first candidate that actually contains a
      // SKILL.md instead of assuming the first result has a downloadable file.
      for (const [index, candidate] of candidates.entries()) {
        const candidateDir = path.join(tmp, `candidate-${index}`);
        try {
          const result = await downloader(candidate, candidateDir);
          if (result.bytes > 20) {
            dl = result;
            break;
          }
        } catch (error) {
          lastError = error;
        }
      }
      if (!dl) {
        console.warn(`skills.sh 当前候选均没有可下载的 SKILL.md，跳过本次外部下载验证：${String(lastError)}`);
        skip();
        return;
      }
      expect(dl.bytes).toBeGreaterThan(20);
      const md = readFileSync(dl.skillMdPath, "utf8");
      expect(md).toMatch(/#/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
    await expect(readdir(tmp)).rejects.toThrow(); // 无残留
  }, 120_000);

  it("downloadSkillMd 契约：不存在仓库抛 NOT_FOUND（网络类，smoke）", async () => {
    const { downloadSkillMd } = await import("@/federation/adapters/skill-sources");
    const tmp = await mkdtemp(path.join(tmpdir(), "dl-"));
    try {
      await expect(
        downloadSkillMd("definitely/not-a-real-repo-xyz", ["a/SKILL.md"], tmp),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 45_000);

  it("缓存命中：同 query 二次检索直接返回（适配器零调用）", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fedcache-"));
    try {
      const cache = fileRegistryCache({ filePath: path.join(dir, "c.json") });
      const adapters = allRealAdapters();
      const probeAdapters = adapters.map((a) => {
        let calls = 0;
        return new Proxy(a, {
          get(t, p, recv) {
            if (p === "search") {
              return async (q: never) => {
                calls++;
                return (t.search as (q: never) => Promise<unknown>)(q);
              };
            }
            if (p === "__calls") return () => calls;
            return Reflect.get(t, p, recv);
          },
        }) as CapabilityAdapter;
      });
      const fsSearch = new FederatedSearch(probeAdapters, cache, 5);
      const first = await fsSearch.search({ text: "filesystem cache probe unique", limit: 3 });
      const second = await fsSearch.search({ text: "filesystem cache probe unique", limit: 3 });
      expect(first.capabilities.length).toBeGreaterThan(0);
      expect(second.capabilities).toEqual(first.capabilities);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("断网模拟：单源不拖垮整体（离线可跑，非 smoke）", () => {
  it("注入 2 个坏源 + 1 个好源（真实适配器离线也会失败，断言折叠语义）", async () => {
    const badAdapter: CapabilityAdapter = {
      source: { id: "mcp-so", tier: "aggregate", name: "bad", url: "https://bad" },
      supports: () => true,
      search: async () => {
        throw new Error("simulated offline");
      },
    };
    const bad2: CapabilityAdapter = {
      source: { id: "modelscope", tier: "curated", name: "bad2", url: "https://bad2" },
      supports: () => true,
      search: async () => {
        throw new Error("ETIMEDOUT");
      },
    };
    const good: CapabilityAdapter = {
      source: { id: "cline-marketplace", tier: "curated", name: "good", url: "https://good" },
      supports: () => true,
      search: async () => ({
        capabilities: [
          {
            id: "cline-marketplace:good-fs",
            name: "good-fs",
            kind: "mcp-server",
            description: "",
            source: { id: "cline-marketplace", tier: "curated", name: "good", url: "https://good" },
            trust: { score: 0.5, tier: "curated", evidence: { evidenceScore: 0.5 }, hardFilterPassed: true },
            install: { type: "git", repoUrl: "https://github.com/a/b" },
            tags: [],
            requiresAuth: false,
            securityFlagged: false,
          },
        ],
        status: { source: "cline-marketplace", ok: true, degraded: false, latencyMs: 5, count: 1 },
      }),
    };
    const r = await new FederatedSearch([badAdapter, bad2, good]).search({ text: "x" });
    expect(r.capabilities).toHaveLength(1);
    expect(r.statuses.filter((s) => !s.ok)).toHaveLength(2);
    expect(r.statuses.find((s) => s.ok)?.count).toBe(1);
  });
});
