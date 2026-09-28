import { fetchJson, makeStatus, buildCapability, type CapabilityAdapter, type CapabilityQuery } from "./adapter-utils.js";
import type { AdapterResult, Source } from "../types.js";

/**
 * ModelScope MCP 广场适配器（1.2.3）。
 * 实测（DECISIONS D8）：`PUT https://www.modelscope.cn/api/v1/dolphin/mcpServers`
 * body {PageSize,PageNumber,Query,Criterion[]} → {Code,Data:{FiledAgg,McpServer:{McpServers:[...]}}}。
 * DeployedUrl 非空 = 官方托管可远程运行（远程探活候选）。
 */
export const MODELSCOPE_SOURCE: Source = {
  id: "modelscope",
  tier: "curated",
  name: "ModelScope MCP 广场",
  url: "https://www.modelscope.cn/mcp",
};

export interface MsServer {
  Name: string;
  Abstract?: string;
  AbstractCN?: string;
  ChineseName?: string;
  Category?: string[];
  DeployedUrl?: string;
  DeployedUrlTransportType?: string;
  DeployedUrlAuthCheck?: boolean;
  FromSiteUrl?: string;
  FromSitePath?: string;
  Stars?: number;
  GmtUpdated?: number | string;
  EnvSchema?: { properties?: Record<string, unknown>; required?: string[] };
  Tags?: string[];
  License?: string;
  ViewCount?: number;
  CallVolume?: number;
}

export interface MsResponse {
  Code: number;
  Data?: { McpServer?: { McpServers?: MsServer[] } };
  Message?: string;
}

export function parseModelscopeServers(payload: MsResponse): MsServer[] {
  if (payload.Code !== 200) return [];
  return payload.Data?.McpServer?.McpServers ?? [];
}

export function modelscopeAdapter(http = { search: searchModelscope }): CapabilityAdapter {
  return {
    source: MODELSCOPE_SOURCE,
    supports: (q: CapabilityQuery) => q.text.trim().length > 0,
    async search(query: CapabilityQuery): Promise<AdapterResult> {
      const started = performance.now();
      let servers: MsServer[];
      try {
        servers = await http.search(query.text, query.limit ?? 5, query.signal);
      } catch (err) {
        return {
          capabilities: [],
          status: makeStatus(MODELSCOPE_SOURCE.id, false, false, started, 0, err instanceof Error ? err.message : String(err)),
        };
      }
      const capabilities = servers.map((s) =>
        buildCapability({
          id: `modelscope:${s.Name}`,
          name: s.ChineseName || s.Name,
          kind: "mcp-server",
          description: s.Abstract || s.AbstractCN || s.Name,
          source: MODELSCOPE_SOURCE,
          install: s.DeployedUrl
            ? { type: "remote", url: s.DeployedUrl, transport: s.DeployedUrlTransportType || undefined }
            : s.FromSiteUrl
              ? { type: "git", repoUrl: s.FromSiteUrl, subdir: s.FromSitePath || undefined }
              : { type: "npx", package: s.Name, args: [] },
          remoteRun: s.DeployedUrl
            ? {
                url: s.DeployedUrl,
                transport: s.DeployedUrlTransportType || "streamable-http",
                probeHint: "initialize",
              }
            : undefined,
          repoUrl: s.FromSiteUrl,
          tags: [...(s.Category ?? []), ...(s.Tags ?? [])],
          updatedAt: s.GmtUpdated !== undefined ? new Date(Number(s.GmtUpdated) || Date.parse(String(s.GmtUpdated))).toISOString() : undefined,
          stars: s.Stars,
          requiresAuth: (s.EnvSchema?.required?.length ?? 0) > 0 || s.DeployedUrlAuthCheck === true,
        }),
      );
      return { capabilities, status: makeStatus(MODELSCOPE_SOURCE.id, true, false, started, capabilities.length) };
    },
  };
}

async function searchModelscope(query: string, limit: number, signal?: AbortSignal): Promise<MsServer[]> {
  const payload = await fetchJson<MsResponse>("https://www.modelscope.cn/api/v1/dolphin/mcpServers", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      origin: "https://www.modelscope.cn",
      referer: "https://www.modelscope.cn/mcp",
    },
    body: JSON.stringify({ PageSize: Math.max(limit, 5), PageNumber: 1, Query: query, Criterion: [] }),
    signal,
    timeoutMs: 20_000,
  });
  return parseModelscopeServers(payload).slice(0, limit);
}
