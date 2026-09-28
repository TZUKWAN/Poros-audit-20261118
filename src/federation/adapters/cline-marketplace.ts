import { fetchJson, makeStatus, buildCapability, type CapabilityAdapter, type CapabilityQuery } from "./adapter-utils.js";
import type { AdapterResult, Source } from "../types.js";

/**
 * Cline MCP Marketplace 适配器（1.2.4）。
 * 实测（DECISIONS D8）：`GET https://api.cline.bot/v1/mcp/marketplace` → 数组，
 * 字段 mcpId/githubUrl/name/author/description/requiresApiKey/githubStars/downloadCount/createdAt/updatedAt/tags。
 */
export const CLINE_SOURCE: Source = {
  id: "cline-marketplace",
  tier: "curated",
  name: "Cline MCP Marketplace",
  url: "https://github.com/cline/mcp-marketplace",
};

export interface ClineEntry {
  mcpId: string;
  githubUrl?: string;
  name: string;
  author?: string;
  description?: string;
  requiresApiKey?: boolean;
  isRecommended?: boolean;
  githubStars?: number;
  downloadCount?: number;
  createdAt?: string;
  updatedAt?: string;
  tags?: string[];
  category?: string;
}

export function matchClineEntries(entries: ClineEntry[], query: string, limit = 5): ClineEntry[] {
  const q = query.toLowerCase().trim();
  const terms = q.split(/\s+/);
  return entries
    .map((e) => {
      const hay = `${e.name} ${e.description ?? ""} ${(e.tags ?? []).join(" ")}`.toLowerCase();
      const hits = terms.filter((t) => hay.includes(t)).length;
      return { e, hits };
    })
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, limit)
    .map((x) => x.e);
}

export function clineAdapter(http = { marketplace: fetchMarketplace }): CapabilityAdapter {
  return {
    source: CLINE_SOURCE,
    supports: (q: CapabilityQuery) => q.text.trim().length > 0,
    async search(query: CapabilityQuery): Promise<AdapterResult> {
      const started = performance.now();
      let entries: ClineEntry[];
      try {
        entries = await http.marketplace(query.signal);
      } catch (err) {
        return {
          capabilities: [],
          status: makeStatus(CLINE_SOURCE.id, false, false, started, 0, err instanceof Error ? err.message : String(err)),
        };
      }
      const matched = matchClineEntries(entries, query.text, query.limit ?? 5);
      const capabilities = matched.map((e) =>
        buildCapability({
          id: `cline-marketplace:${e.mcpId}`,
          name: e.name,
          kind: "mcp-server",
          description: e.description ?? "",
          source: CLINE_SOURCE,
          install: e.githubUrl
            ? { type: "git", repoUrl: e.githubUrl }
            : { type: "cli", command: `cline mcp install ${e.mcpId}`, args: [] },
          repoUrl: e.githubUrl,
          tags: [...(e.tags ?? []), ...(e.category ? [e.category] : []), ...(e.isRecommended ? ["recommended"] : [])],
          updatedAt: e.updatedAt ?? e.createdAt,
          stars: e.githubStars,
          downloads: e.downloadCount,
          // requiresApiKey 即鉴权标记（市场已记录配置方式）→ 通过 R1；闸门3 展示风险标
          requiresAuth: e.requiresApiKey === true,
        }),
      );
      return { capabilities, status: makeStatus(CLINE_SOURCE.id, true, false, started, capabilities.length) };
    },
  };
}

async function fetchMarketplace(signal?: AbortSignal): Promise<ClineEntry[]> {
  return await fetchJson<ClineEntry[]>("https://api.cline.bot/v1/mcp/marketplace", { signal, timeoutMs: 20_000 });
}
