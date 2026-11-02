import { fetchJson, httpFetch, makeStatus, buildCapability, type CapabilityAdapter, type CapabilityQuery } from "./adapter-utils.js";
import { readBodyCapped } from "./base.js";
import { ScenarioError, ScenarioErrorCode } from "@/core/errors.js";
import type { AdapterResult, Source } from "../types.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * 技能源适配器 ×3（1.3）—— 仅检索 + 下载到临时目录（技能不进运行时，见 v2.1 架构决策）。
 * 统一契约：search(query) → Capability[kind=skill-knowledge, install.type=context]；
 *          download(capability, dir) → dir/skill/SKILL.md（+附带文件尽力而为）。
 */

// ─────────────────────────── skills.sh（1.3.1）───────────────────────────

export const SKILLS_SH_SOURCE: Source = {
  id: "skills-sh",
  tier: "official",
  name: "skills.sh",
  url: "https://skills.sh",
};

export interface SkillsShItem {
  id: string; // "owner/repo/skillId"
  source: string; // "owner/repo"
  skillId: string;
  name: string;
  installs?: number;
}

export interface SkillsShSearch {
  query: string;
  skills: SkillsShItem[];
}

export function parseSkillsSh(payload: SkillsShSearch): SkillsShItem[] {
  return Array.isArray(payload.skills) ? payload.skills.filter((s) => s.id && s.name) : [];
}

// ─────────────────────────── SkillsMP（1.3.2）───────────────────────────

export const SKILLSMP_SOURCE: Source = {
  id: "skillsmp",
  tier: "aggregate",
  name: "SkillsMP",
  url: "https://skillsmp.com",
};

export interface SkillsMpItem {
  id: string;
  name: string;
  author?: string;
  description?: string;
  githubUrl?: string;
  installs?: number;
  contentLanguage?: string;
}

export function parseSkillsMp(payload: { skills?: SkillsMpItem[] }): SkillsMpItem[] {
  return Array.isArray(payload.skills) ? payload.skills.filter((s) => s.id && s.name) : [];
}

// ─────────────────────────── 腾讯 SkillHub（1.3.3）───────────────────────────

export const SKILLHUB_SOURCE: Source = {
  id: "tencent-skillhub",
  tier: "curated",
  name: "腾讯 SkillHub",
  url: "https://skillhub.cloud.tencent.com",
};

export interface SkillHubItem {
  slug: string;
  namespace?: string;
  name: string;
  description?: string;
  description_zh?: string;
  downloads?: number;
  installs?: number;
  stars?: number;
  updated_at?: number; // epoch ms
  upstream_url?: string;
  homepage?: string;
  verified?: boolean;
  source?: string;
  tags?: string[];
  labels?: string[];
  category?: string;
}

export interface SkillHubSearch {
  code: number;
  data?: { skills?: SkillHubItem[] };
  message?: string;
}

export function parseSkillHub(payload: SkillHubSearch): SkillHubItem[] {
  if (payload.code !== 0) return [];
  return Array.isArray(payload.data?.skills) ? payload.data!.skills!.filter((s) => s.slug && s.name) : [];
}

// ─────────────────────────── 适配器实现 ───────────────────────────

function skillCapability(input: {
  id: string;
  name: string;
  description: string;
  source: Source;
  repoUrl?: string;
  homepage?: string;
  updatedAt?: string;
  downloads?: number;
  stars?: number;
  tags?: string[];
}) {
  return buildCapability({
    kind: "skill-knowledge",
    install: { type: "context", location: input.repoUrl ?? input.homepage ?? input.id },
    requiresAuth: false,
    ...input,
  });
}

export interface SkillDownload {
  /** 落盘的 SKILL.md 路径 */
  skillMdPath: string;
  /** 命中的来源（raw URL 或 npx） */
  from: string;
  bytes: number;
}

/**
 * 通用 SKILL.md 下载：给定 repo 与候选路径逐一尝试（main/master）。
 * candidates 形如 ["skills/foo/SKILL.md", "foo/SKILL.md", "SKILL.md"]。
 */
export async function downloadSkillMd(
  repo: string,
  candidates: string[],
  targetDir: string,
  signal?: AbortSignal,
): Promise<SkillDownload> {
  for (const branch of ["main", "master"]) {
    for (const c of candidates) {
      const url = `https://raw.githubusercontent.com/${repo}/${branch}/${c}`;
      try {
        const resp = await httpFetch(url, { signal, headers: { accept: "text/plain" }, retries: 1 });
        if (!resp.ok) continue;
        const text = await readBodyCapped(resp); // R5+ 收尾：5MB 预算
        if (!text.includes("#") || text.length < 20) continue; // 粗校验：像 markdown
        const dir = path.join(targetDir, path.posix.dirname(c) === "." ? "" : path.posix.dirname(c));
        await mkdir(dir, { recursive: true });
        const file = path.join(dir, "SKILL.md");
        await writeFile(file, text, "utf8");
        return { skillMdPath: file, from: url, bytes: Buffer.byteLength(text) };
      } catch {
        if (signal?.aborted) {
          throw new ScenarioError({ code: ScenarioErrorCode.CANCELLED, message: "download cancelled", phase: "retrieving" });
        }
        // 404/网络抖动 → 试下一候选
      }
    }
  }
  throw new ScenarioError({
    code: ScenarioErrorCode.NOT_FOUND,
    message: `SKILL.md not found for ${repo} (tried ${candidates.length} paths × 2 branches)`,
    phase: "retrieving",
  });
}

export function skillsShAdapter(http = { search: fetchSkillsSh }): CapabilityAdapter {
  return {
    source: SKILLS_SH_SOURCE,
    supports: (q) => q.text.trim().length > 0,
    async search(query: CapabilityQuery): Promise<AdapterResult> {
      const started = performance.now();
      try {
        const payload = await http.search(query.text, query.signal);
        const items = parseSkillsSh(payload).slice(0, query.limit ?? 5);
        const capabilities = items.map((it) =>
          skillCapability({
            id: `skills-sh:${it.id}`,
            name: it.name,
            description: `skill ${it.skillId} from ${it.source}${it.installs !== undefined ? ` (${it.installs} installs)` : ""}`,
            source: SKILLS_SH_SOURCE,
            repoUrl: `https://github.com/${it.source}`,
            downloads: it.installs,
            tags: ["skill", it.skillId],
          }),
        );
        return { capabilities, status: makeStatus(SKILLS_SH_SOURCE.id, true, false, started, capabilities.length) };
      } catch (err) {
        return {
          capabilities: [],
          status: makeStatus(SKILLS_SH_SOURCE.id, false, false, started, 0, err instanceof Error ? err.message : String(err)),
        };
      }
    },
    // 下载：owner/repo + skillId → 候选路径
    async download(cap, dir, signal): Promise<SkillDownload> {
      const id = cap.id.replace("skills-sh:", ""); // owner/repo/skillId
      const parts = id.split("/");
      const skillId = parts[2] ?? parts[parts.length - 1] ?? id;
      const repo = cap.repoUrl ? cap.repoUrl.replace("https://github.com/", "") : id.split("/").slice(0, 2).join("/");
      return await downloadSkillMd(repo, [`skills/${skillId}/SKILL.md`, `${skillId}/SKILL.md`, "SKILL.md"], dir, signal);
    },
  } as CapabilityAdapter & { download: SkillDownloader };
}

export function skillsMpAdapter(http = { search: fetchSkillsMp }): CapabilityAdapter {
  return {
    source: SKILLSMP_SOURCE,
    supports: (q) => q.text.trim().length > 0,
    async search(query: CapabilityQuery): Promise<AdapterResult> {
      const started = performance.now();
      try {
        const payload = await http.search(query.text, query.signal);
        const items = parseSkillsMp(payload).slice(0, query.limit ?? 5);
        const capabilities = items.map((it) =>
          skillCapability({
            id: `skillsmp:${it.id}`,
            name: it.name,
            description: it.description ?? "",
            source: SKILLSMP_SOURCE,
            repoUrl: it.githubUrl,
            downloads: it.installs,
            tags: ["skill", ...(it.contentLanguage ? [it.contentLanguage] : [])],
          }),
        );
        return { capabilities, status: makeStatus(SKILLSMP_SOURCE.id, true, false, started, capabilities.length) };
      } catch (err) {
        return {
          capabilities: [],
          status: makeStatus(SKILLSMP_SOURCE.id, false, false, started, 0, err instanceof Error ? err.message : String(err)),
        };
      }
    },
    async download(cap, dir, signal): Promise<SkillDownload> {
      const repo = githubRepoFromUrl(cap.repoUrl);
      if (!repo) {
        throw new ScenarioError({ code: ScenarioErrorCode.NOT_FOUND, message: `no github repo for ${cap.id}`, phase: "retrieving" });
      }
      return await downloadSkillMd(repo, [`skills/${cap.name}/SKILL.md`, `${cap.name}/SKILL.md`, "SKILL.md"], dir, signal);
    },
  } as CapabilityAdapter & { download: SkillDownloader };
}

export function skillHubAdapter(http = { search: fetchSkillHub }): CapabilityAdapter {
  return {
    source: SKILLHUB_SOURCE,
    supports: (q) => q.text.trim().length > 0,
    async search(query: CapabilityQuery): Promise<AdapterResult> {
      const started = performance.now();
      try {
        const payload = await http.search(query.text, query.limit ?? 5, query.signal);
        const items = parseSkillHub(payload).slice(0, query.limit ?? 5);
        const capabilities = items.map((it) =>
          skillCapability({
            id: `tencent-skillhub:${it.namespace ? `${it.namespace}/` : ""}${it.slug}`,
            name: it.name,
            description: it.description_zh || it.description || "",
            source: SKILLHUB_SOURCE,
            repoUrl: it.upstream_url,
            homepage: it.homepage,
            updatedAt: it.updated_at ? new Date(it.updated_at).toISOString() : undefined,
            downloads: it.installs ?? it.downloads,
            stars: it.stars,
            tags: ["skill", ...(it.tags ?? []), ...(it.verified ? ["verified"] : [])],
          }),
        );
        return { capabilities, status: makeStatus(SKILLHUB_SOURCE.id, true, false, started, capabilities.length) };
      } catch (err) {
        return {
          capabilities: [],
          status: makeStatus(SKILLHUB_SOURCE.id, false, false, started, 0, err instanceof Error ? err.message : String(err)),
        };
      }
    },
    async download(cap, dir, signal): Promise<SkillDownload> {
      const repo = githubRepoFromUrl(cap.repoUrl);
      if (!repo) {
        throw new ScenarioError({ code: ScenarioErrorCode.NOT_FOUND, message: `no upstream repo for ${cap.id}`, phase: "retrieving" });
      }
      const slug = cap.id.split("/").pop() as string;
      return await downloadSkillMd(repo, [`skills/${slug}/SKILL.md`, `${slug}/SKILL.md`, "SKILL.md"], dir, signal);
    },
  } as CapabilityAdapter & { download: SkillDownloader };
}

export type SkillDownloader = (cap: { id: string; name: string; repoUrl?: string }, dir: string, signal?: AbortSignal) => Promise<SkillDownload>;

export function githubRepoFromUrl(url?: string): string | undefined {
  if (!url) return undefined;
  const m = url.match(/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/);
  return m ? (m[1] ?? "").replace(/\.git$/, "") : undefined;
}

async function fetchSkillsSh(query: string, signal?: AbortSignal): Promise<SkillsShSearch> {
  return await fetchJson<SkillsShSearch>(`https://skills.sh/api/search?q=${encodeURIComponent(query)}`, { signal, timeoutMs: 15_000 });
}

async function fetchSkillsMp(query: string, signal?: AbortSignal): Promise<{ skills: SkillsMpItem[] }> {
  return await fetchJson<{ skills: SkillsMpItem[] }>(`https://skillsmp.com/api/skills?q=${encodeURIComponent(query)}`, {
    signal,
    timeoutMs: 15_000,
  });
}

async function fetchSkillHub(query: string, limit: number, signal?: AbortSignal): Promise<SkillHubSearch> {
  return await fetchJson<SkillHubSearch>(
    `https://api.skillhub.tencent.com/api/skills?page=1&pageSize=${Math.max(limit, 5)}&keyword=${encodeURIComponent(query)}`,
    { signal, timeoutMs: 15_000 },
  );
}
