import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { CapabilityAdapter, AdapterResult, CapabilityQuery } from "./adapters/base.js";
import { makeStatus } from "./adapters/base.js";
import { canonicalName, repoIdentity, type Capability, type SourceId } from "./types.js";

/** 联邦检索结果：合并去重后的候选 + 各源状态 */
export interface FederatedResult {
  query: string;
  capabilities: Capability[];
  statuses: AdapterResult["status"][];
  totalMs: number;
}

export class FederatedSearch {
  /** R2 体验：分源完成回调（面板显示 "n/8 源完成" 进度） */
  onSourceSettled?: (sourceId: SourceId, ok: boolean, completed: number, total: number) => void;

  constructor(
    private adapters: CapabilityAdapter[],
    private cache?: RegistryCache,
    private topN = 5,
  ) {}

  async search(query: CapabilityQuery): Promise<FederatedResult> {
    const started = performance.now();
    const key = query.text.trim().toLowerCase();

    const cached = this.cache ? await this.cache.get(key) : undefined;
    if (cached) {
      return {
        query: key,
        capabilities: cached.slice(0, this.topN),
        statuses: this.adapters.map((adapter) => ({ source: adapter.source.id, ok: true, degraded: true, message: "registry cache", latencyMs: 0, count: cached.length })),
        totalMs: Math.round(performance.now() - started),
      };
    }

    // 1.4.1 八源并行扇出（Promise.allSettled），单源失败折叠为状态报告
    const activeAdapters = this.adapters.filter((a) => a.supports(query));
    // R2 体验：分源完成即回调（面板可在检索中显示"n/8 源完成"进度）
    let completedSources = 0;
    const markDone = (sourceId: SourceId, ok: boolean): void => {
      completedSources += 1;
      this.onSourceSettled?.(sourceId, ok, completedSources, activeAdapters.length);
    };
    const settled = await Promise.allSettled(
      activeAdapters.map(async (a) => {
        try {
          return await a.search({ ...query, limit: query.limit ?? this.topN });
        } catch (err) {
          markDone(a.source.id, false);
          throw err;
        }
      }),
    );
    const results: AdapterResult[] = settled.map((s, i) => {
      const adapter = activeAdapters[i] as CapabilityAdapter;
      if (s.status === "fulfilled") {
        markDone(adapter.source.id, s.value.status.ok);
        return s.value;
      }
      markDone(adapter.source.id, false);
      return {
        capabilities: [],
        status: makeStatus(
          adapter.source.id,
          false,
          false,
          started,
          0,
          s.reason instanceof Error ? s.reason.message : String(s.reason),
        ),
      };
    });

    const all = results.flatMap((r) => r.capabilities);
    // 1.4.2 去重：规范名 + 底层仓库 归并，保留 trust 最高
    const deduped = dedupeCapabilities(all);
    // 1.4.3 排序截断：先按查询相关性，再按硬过滤与可信度。
    deduped.sort((a, b) => {
      const relevanceDelta = lexicalRelevance(b, key) - lexicalRelevance(a, key);
      if (Math.abs(relevanceDelta) > 0.15) return relevanceDelta;
      if (a.trust.hardFilterPassed !== b.trust.hardFilterPassed) return a.trust.hardFilterPassed ? -1 : 1;
      return b.trust.score - a.trust.score;
    });
    const top = deduped.slice(0, this.topN);

    if (this.cache && top.length > 0) {
      await this.cache.put(key, top);
    }

    return {
      query: key,
      capabilities: top,
      statuses: results.map((r) => r.status),
      totalMs: Math.round(performance.now() - started),
    };
  }
}

function lexicalRelevance(capability: Capability, query: string): number {
  const tokens = query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((token) => token.length >= 2);
  if (tokens.length === 0) return 0;
  const text = `${capability.name} ${capability.description} ${capability.tags.join(" ")}`.toLowerCase();
  let hits = 0;
  for (const token of tokens) if (text.includes(token)) hits++;
  return hits / tokens.length;
}

export interface DedupeGroup {
  key: string;
  kept: Capability;
  merged: Capability[];
}

/** 1.4.2 去重：规范名相同 或 repoIdentity 相同 → 合并，保留 trust 最高来源 */
export function dedupeCapabilities(caps: Capability[]): Capability[] {
  const groups = new Map<string, Capability[]>();
  for (const cap of caps) {
    const key = repoIdentity(cap.repoUrl) ?? `name:${canonicalName(cap.name)}`;
    const list = groups.get(key) ?? [];
    list.push(cap);
    groups.set(key, list);
  }
  const out: Capability[] = [];
  for (const [, list] of groups) {
    list.sort((a, b) => {
      if (a.trust.hardFilterPassed !== b.trust.hardFilterPassed) return a.trust.hardFilterPassed ? -1 : 1;
      return b.trust.score - a.trust.score;
    });
    out.push(list[0] as Capability);
  }
  return out;
}

// ─────────────────────────── 缓存（1.4.4）───────────────────────────

const CacheFileSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string(), z.object({ savedAt: z.number(), capabilities: z.array(z.unknown()) })),
});

export interface RegistryCache {
  get(query: string): Promise<Capability[] | undefined>;
  put(query: string, capabilities: Capability[]): Promise<void>;
}

export interface FileCacheOptions {
  filePath: string;
  ttlMs?: number;
  now?: () => number;
}

export function fileRegistryCache(options: FileCacheOptions): RegistryCache {
  const ttl = options.ttlMs ?? 24 * 60 * 60 * 1000;
  const now = options.now ?? Date.now;

  async function loadRaw(): Promise<z.infer<typeof CacheFileSchema>> {
    try {
      const raw = await readFile(options.filePath, "utf8");
      const parsed = CacheFileSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : { version: 1, entries: {} };
    } catch {
      return { version: 1, entries: {} };
    }
  }

  async function persist(file: z.infer<typeof CacheFileSchema>): Promise<void> {
    await mkdir(path.dirname(options.filePath), { recursive: true });
    const tmp = `${options.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(file), "utf8");
    await rename(tmp, options.filePath);
  }

  return {
    async get(query) {
      const file = await loadRaw();
      const entry = file.entries[query];
      if (!entry) return undefined;
      if (now() - entry.savedAt > ttl) return undefined; // 过期 → 重拉
      const caps: Capability[] = [];
      for (const raw of entry.capabilities) {
        const parsed = (await import("./types.js")).CapabilitySchema.safeParse(raw);
        if (parsed.success) caps.push(parsed.data);
      }
      return caps;
    },
    async put(query, capabilities) {
      const file = await loadRaw();
      file.entries[query] = { savedAt: now(), capabilities: JSON.parse(JSON.stringify(capabilities)) };
      await persist(file);
    },
  };
}

// ─────────────────────────── 远程探活（1.4.5）───────────────────────────

export interface ProbeResult {
  capabilityId: string;
  available: boolean;
  latencyMs: number;
  message?: string;
}

/**
 * 对支持 remoteRun 的能力发最小调用（默认 HTTP POST JSON-RPC initialize/tools/list 形态）。
 * 仅做可用性与延迟测量，不校验业务语义。
 */
export async function probeRemote(cap: Capability, timeoutMs = 8_000): Promise<ProbeResult> {
  const started = performance.now();
  const base: ProbeResult = { capabilityId: cap.id, available: false, latencyMs: 0 };
  if (!cap.remoteRun) return { ...base, message: "no remoteRun endpoint" };
  try {
    const resp = await fetch(cap.remoteRun.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pi-scenario-probe", version: "0.1.0" } } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Math.round(performance.now() - started);
    if (resp.ok) return { capabilityId: cap.id, available: true, latencyMs };
    return { ...base, latencyMs, message: `HTTP ${resp.status}` };
  } catch (err) {
    return { ...base, latencyMs: Math.round(performance.now() - started), message: err instanceof Error ? err.message : String(err) };
  }
}

export function sourceStatuses(adapters: CapabilityAdapter[], results: FederatedResult): Record<SourceId, "ok" | "degraded" | "failed" | "skipped"> {
  const map = {} as Record<SourceId, "ok" | "degraded" | "failed" | "skipped">;
  for (const a of adapters) map[a.source.id] = "skipped";
  for (const s of results.statuses) {
    if (!s.ok) map[s.source] = "failed";
    else if (s.degraded) map[s.source] = "degraded";
    else map[s.source] = "ok";
  }
  return map;
}
