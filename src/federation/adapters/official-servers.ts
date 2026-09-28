import { fetchJson, makeStatus, buildCapability, type CapabilityAdapter, type CapabilityQuery } from "./adapter-utils.js";
import { fetchRawGithub } from "./adapter-utils.js";
import type { AdapterResult, Source } from "../types.js";

/**
 * modelcontextprotocol/servers 适配器（1.2.2）—— 官方源。
 * 检索：GitHub API 读 src/ 顶层目录（每个子目录 = 一个官方 server），按查询词匹配目录名与描述；
 * 详情：README.md 前 400 字作描述。支持 GITHUB_TOKEN/GH_TOKEN 提升限额（1.2.2.c 限流→指数退避由 httpFetch 承担）。
 */
export const OFFICIAL_SERVERS_SOURCE: Source = {
  id: "modelcontextprotocol-servers",
  tier: "official",
  name: "modelcontextprotocol/servers",
  url: "https://github.com/modelcontextprotocol/servers",
};

const REPO = "modelcontextprotocol/servers";

interface GhContentsEntry {
  name: string;
  type: string;
  path: string;
}

function ghHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  return token ? { authorization: `Bearer ${token}` } : {};
}

export function matchOfficialServers(entries: GhContentsEntry[], query: string): GhContentsEntry[] {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  return entries
    .filter((e) => e.type === "dir")
    .filter((e) => {
      const n = e.name.toLowerCase();
      return n.includes(q) || q.includes(n);
    });
}

export function officialServersAdapter(http = { listSrc: listOfficialSrc, fetchReadme: fetchServerReadme }): CapabilityAdapter {
  return {
    source: OFFICIAL_SERVERS_SOURCE,
    supports: (q: CapabilityQuery) => q.text.trim().length > 0,
    async search(query: CapabilityQuery): Promise<AdapterResult> {
      const started = performance.now();
      let entries: GhContentsEntry[];
      try {
        entries = await http.listSrc(query.signal);
      } catch (err) {
        return {
          capabilities: [],
          status: makeStatus(OFFICIAL_SERVERS_SOURCE.id, false, false, started, 0, err instanceof Error ? err.message : String(err)),
        };
      }
      const matched = matchOfficialServers(entries, query.text).slice(0, query.limit ?? 5);
      const capabilities = [];
      for (const entry of matched) {
        let readme: string | undefined;
        try {
          readme = await http.fetchReadme(entry.name, query.signal);
        } catch {
          readme = undefined; // README 拉不到不阻塞该条候选
        }
        capabilities.push(
          buildCapability({
            id: `${OFFICIAL_SERVERS_SOURCE.id}:${entry.name}`,
            name: entry.name,
            kind: "mcp-server",
            description: firstParagraph(readme) ?? `${entry.name} — official MCP server (modelcontextprotocol/servers)`,
            source: OFFICIAL_SERVERS_SOURCE,
            install: { type: "git", repoUrl: `https://github.com/${REPO}`, subdir: `src/${entry.name}` },
            repoUrl: `https://github.com/${REPO}`,
            homepage: `https://github.com/${REPO}/tree/main/src/${entry.name}`,
            tags: ["official"],
            requiresAuth: /api[-_ ]?key|token|oauth/i.test(readme ?? "") ? true : false,
          }),
        );
      }
      return { capabilities, status: makeStatus(OFFICIAL_SERVERS_SOURCE.id, true, false, started, capabilities.length) };
    },
  };
}

async function listOfficialSrc(signal?: AbortSignal): Promise<GhContentsEntry[]> {
  return await fetchJson<GhContentsEntry[]>(`https://api.github.com/repos/${REPO}/contents/src`, {
    headers: ghHeaders(),
    signal,
    timeoutMs: 20_000,
  });
}

async function fetchServerReadme(name: string, _signal?: AbortSignal): Promise<string> {
  return (await fetchRawGithub(REPO, `src/${name}/README.md`, "main")) ?? "";
}

export function firstParagraph(readme: string | undefined): string | undefined {
  if (!readme) return undefined;
  const body = readme.replace(/^#.*$/m, "").trim();
  const para = body.split(/\n\s*\n/).find((p) => p.trim().length > 20);
  return para?.replace(/\s+/g, " ").trim().slice(0, 400);
}
