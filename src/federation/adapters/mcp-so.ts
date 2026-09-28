import { ScenarioError, ScenarioErrorCode } from "@/core/errors.js";
import { buildCapability, makeStatus, type CapabilityAdapter, type CapabilityQuery } from "./adapter-utils.js";
import type { AdapterResult, Source } from "../types.js";
import { canonicalName } from "../types.js";

/**
 * mcp.so 适配器（1.2.1）。
 * 实测（DECISIONS D8）：搜索页为纯 SPA（TanStack ServerFn），无公开 JSON API（api.mcp.so 502）；
 * 但详情页 /servers/<slug> 为 SSR，含 schema.org/SoftwareApplication JSON-LD + GitHub 仓库链接。
 * 检索策略：查询词 slug 化后直查详情页，命中即返回单条候选；404 → 空结果（非错误）。
 */
export const MCP_SO_SOURCE: Source = {
  id: "mcp-so",
  tier: "aggregate",
  name: "mcp.so",
  url: "https://mcp.so",
};

export function slugify(query: string): string {
  return canonicalName(query);
}

export interface JsonLdApplication {
  "@type": string;
  name?: string;
  description?: string;
  applicationCategory?: string;
  operatingSystem?: string;
  url?: string;
  author?: { name?: string };
}

/** 从 mcp.so 详情页 HTML 提取 JSON-LD（多块时优先 SoftwareApplication）与 GitHub 仓库链接（也用于 fixture 解析测试） */
export function parseMcpSoDetail(html: string, _slug: string): { jsonld: JsonLdApplication; repoUrl?: string; remoteHint?: string } | null {
  const blocks = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)];
  let jsonld: JsonLdApplication | undefined;
  for (const block of blocks) {
    try {
      const candidate = JSON.parse((block[1] ?? "").trim()) as JsonLdApplication;
      if (candidate["@type"] === "SoftwareApplication") {
        jsonld = candidate;
        break;
      }
      jsonld ??= candidate; // 无 SoftwareApplication 时退而取第一块
    } catch {
      continue;
    }
  }
  if (!jsonld) return null;
  const repo = html.match(/https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/);
  const remote = html.match(/(https?:\/\/(?!.*github\.com|.*mcp\.so)[^\s"'<>]*\/mcp)\b/i);
  return {
    jsonld,
    repoUrl: repo ? `https://github.com/${repo[1]}` : undefined,
    remoteHint: remote?.[1],
  };
}

export function mcpSoAdapter(http = { fetch: fetchMcpSoHtml }): CapabilityAdapter {
  return {
    source: MCP_SO_SOURCE,
    supports: (q: CapabilityQuery) => q.text.trim().length > 0,
    async search(query: CapabilityQuery): Promise<AdapterResult> {
      const started = performance.now();
      const slug = slugify(query.text);
      if (!slug) {
        return { capabilities: [], status: makeStatus(MCP_SO_SOURCE.id, true, false, started, 0) };
      }
      let html: string;
      try {
        html = await http.fetch(`https://mcp.so/servers/${encodeURIComponent(slug)}`, query.signal);
      } catch (err) {
        if (err instanceof ScenarioError && err.code === ScenarioErrorCode.NOT_FOUND) {
          return { capabilities: [], status: makeStatus(MCP_SO_SOURCE.id, true, false, started, 0, "no detail page") };
        }
        return {
          capabilities: [],
          status: makeStatus(MCP_SO_SOURCE.id, false, false, started, 0, err instanceof Error ? err.message : String(err)),
        };
      }
      const parsed = parseMcpSoDetail(html, slug);
      if (!parsed) {
        return { capabilities: [], status: makeStatus(MCP_SO_SOURCE.id, true, false, started, 0, "no json-ld") };
      }
      const cap = buildCapability({
        id: `mcp-so:${parsed.jsonld.name ?? slug}`,
        name: parsed.jsonld.name ?? slug,
        kind: "mcp-server",
        description: parsed.jsonld.description ?? "",
        source: MCP_SO_SOURCE,
        install: parsed.repoUrl
          ? { type: "git", repoUrl: parsed.repoUrl }
          : parsed.remoteHint
            ? { type: "remote", url: parsed.remoteHint }
            : { type: "npx", package: slug },
        remoteRun: parsed.remoteHint ? { url: parsed.remoteHint, probeHint: "tools/list" } : undefined,
        repoUrl: parsed.repoUrl,
        homepage: parsed.jsonld.url,
        tags: parsed.jsonld.applicationCategory ? [parsed.jsonld.applicationCategory] : [],
      } as Parameters<typeof buildCapability>[0]);
      return { capabilities: [cap], status: makeStatus(MCP_SO_SOURCE.id, true, false, started, 1) };
    },
  };
}

async function fetchMcpSoHtml(url: string, signal?: AbortSignal): Promise<string> {
  const { httpFetch } = await import("./base.js");
  const resp = await httpFetch(url, { signal, headers: { accept: "text/html" } });
  if (resp.status === 404) {
    throw new ScenarioError({ code: ScenarioErrorCode.NOT_FOUND, message: `no mcp.so page: ${url}`, phase: "retrieving" });
  }
  if (!resp.ok) {
    throw new ScenarioError({
      code: ScenarioErrorCode.SOURCE_UNAVAILABLE,
      message: `HTTP ${resp.status} from ${url}`,
      phase: "retrieving",
      context: { url, status: resp.status },
    });
  }
  return await resp.text();
}
