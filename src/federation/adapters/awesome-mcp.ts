import { httpFetch, makeStatus, buildCapability, type CapabilityAdapter, type CapabilityQuery } from "./adapter-utils.js";
import { readBodyCapped } from "./base.js";
import { ScenarioError, ScenarioErrorCode } from "@/core/errors.js";
import type { AdapterResult, Source } from "../types.js";

/**
 * Awesome MCP Servers 适配器（1.2.5）—— punkpeye/awesome-mcp-servers README 分类解析。
 * 格式：`### 分类名` 段落 + `- [名称](url) - 描述` 列表项；多语言徽章行、License 标记容错。
 */
export const AWESOME_SOURCE: Source = {
  id: "awesome-mcp-servers",
  tier: "curated",
  name: "Awesome MCP Servers",
  url: "https://github.com/punkpeye/awesome-mcp-servers",
};

export interface AwesomeEntry {
  name: string;
  url: string;
  description: string;
  category: string;
}

/** 解析 awesome README：变体容错（`- desc`、`— desc`、`– desc`、License 徽章尾部、嵌套缩进） */
export function parseAwesomeReadme(md: string): AwesomeEntry[] {
  const entries: AwesomeEntry[] = [];
  let category = "";
  const lines = md.split(/\r?\n/);
  for (const line of lines) {
    const h = line.match(/^#{2,4}\s+(.+?)\s*$/);
    if (h) {
      category = (h[1] ?? "").replace(/\d+$/, "").trim();
      continue;
    }
    const item = line.match(/^\s*[-*]\s+\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)\s*(?:[-–—:]\s*)?(.*)$/);
    if (item && category) {
      const desc = (item[3] ?? "")
        .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, "") // 徽章
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/\s+/g, " ")
        .trim();
      entries.push({ name: item[1]!.trim(), url: item[2]!, description: desc, category });
    }
  }
  return entries;
}

export function matchAwesome(entries: AwesomeEntry[], query: string, limit = 5): AwesomeEntry[] {
  const q = query.toLowerCase().trim();
  const terms = q.split(/\s+/);
  return entries
    .map((e) => {
      const hay = `${e.name} ${e.description} ${e.category}`.toLowerCase();
      const hits = terms.filter((t) => hay.includes(t)).length;
      return { e, hits };
    })
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, limit)
    .map((x) => x.e);
}

export function awesomeAdapter(http = { readme: fetchAwesomeReadme }): CapabilityAdapter {
  return {
    source: AWESOME_SOURCE,
    supports: (q: CapabilityQuery) => q.text.trim().length > 0,
    async search(query: CapabilityQuery): Promise<AdapterResult> {
      const started = performance.now();
      let entries: AwesomeEntry[];
      try {
        entries = parseAwesomeReadme(await http.readme(query.signal));
      } catch (err) {
        return {
          capabilities: [],
          status: makeStatus(AWESOME_SOURCE.id, false, false, started, 0, err instanceof Error ? err.message : String(err)),
        };
      }
      const matched = matchAwesome(entries, query.text, query.limit ?? 5);
      const capabilities = matched.map((e) =>
        buildCapability({
          id: `awesome-mcp-servers:${e.name.toLowerCase().replace(/\s+/g, "-")}`,
          name: e.name,
          kind: "mcp-server",
          description: e.description.slice(0, 300),
          source: AWESOME_SOURCE,
          install: e.url.includes("github.com") ? { type: "git", repoUrl: e.url } : { type: "context", location: e.url },
          repoUrl: e.url.includes("github.com") ? e.url : undefined,
          homepage: e.url,
          tags: [e.category],
        }),
      );
      return { capabilities, status: makeStatus(AWESOME_SOURCE.id, true, false, started, capabilities.length) };
    },
  };
}

async function fetchAwesomeReadme(signal?: AbortSignal): Promise<string> {
  const resp = await httpFetch("https://raw.githubusercontent.com/punkpeye/awesome-mcp-servers/main/README.md", {
    signal,
    headers: { accept: "text/plain" },
    timeoutMs: 25_000,
  });
  if (!resp.ok) {
    throw new ScenarioError({
      code: ScenarioErrorCode.SOURCE_UNAVAILABLE,
      message: `awesome README HTTP ${resp.status}`,
      phase: "retrieving",
    });
  }
  return await readBodyCapped(resp); // R5+ 收尾：5MB 预算
}
