import { buildCapability, makeStatus, type AdapterResult, type CapabilityAdapter, type CapabilityQuery } from "@/federation/adapters/adapter-utils.js";
import type { Source } from "@/federation/types.js";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

/**
 * METIS 领域联邦层：学术研究场景的"能力源"= 插件自带的研究工作流知识库：
 *  ① metis-spine-source —— 七阶段研究脊柱纪律（SKILL.md 解析为阶段化 knowledge-capability）
 *  ② metis-engine-source —— 引擎命令契约（init/status/plan/advance/tasks/exec/artifacts/deliver/verify）
 *  ③ metis-adapter-source —— adapters/ 目录的格式适配知识（引用格式/期刊规范等）
 * 检索语义：需求文本 → 阶段/引擎命令/适配器命中。
 */

import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
const DOMAIN_MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
function resolveDomainDir(sub: string): string {
  const candidates = [
    path.resolve(DOMAIN_MODULE_DIR, sub),
    path.resolve(process.cwd(), "src/domains/metis", sub),
  ];
  for (const c of candidates) { if (existsSync(c)) return c; }
  return candidates[0] as string;
}
export const METIS_SKILLS_ROOT = resolveDomainDir("metis-skills");

export const SPINE_SOURCE: Source = { id: "metis-spine", tier: "official", name: "METIS 七阶段脊柱", url: "local://metis-skills/metis/SKILL.md" };
export const ENGINE_SOURCE: Source = { id: "metis-engine", tier: "official", name: "METIS 引擎契约", url: "local://metis/docs" };
export const ADAPTER_SOURCE: Source = { id: "metis-adapters", tier: "curated", name: "METIS 格式适配", url: "local://metis/adapters" };

/** 七阶段脊柱（SKILL.md 口径，S1-S10 为引擎细粒度） */
export const SPINE_STAGES = [
  { id: "S1", stage: "① 文献准备", keywords: ["文献", "综述", "检索", "题目"] },
  { id: "S2", stage: "② 研究设计", keywords: ["设计", "假设", "变量", "定量", "定性", "理论"] },
  { id: "S3", stage: "③ 数据/材料", keywords: ["数据", "访谈", "问卷", "档案", "语料"] },
  { id: "S4", stage: "④ 分析执行", keywords: ["分析", "编码", "回归", "检验", "模型"] },
  { id: "S5", stage: "⑤ 阶段验证", keywords: ["验证", "真实性", "稳健", "复核"] },
  { id: "S6", stage: "⑥ 成文与格式", keywords: ["成文", "写作", "格式", "引用", "图表"] },
  { id: "S7", stage: "⑦ 交付", keywords: ["交付", "投稿", "提交", "QA"] },
] as const;

export interface SpineHit {
  id: string;
  stage: string;
  score: number;
}

/** 需求文本 → 脊柱阶段命中（给闸2 DAG 定制用） */
export function matchSpineStages(query: string): SpineHit[] {
  const terms = query.toLowerCase().split(/[\s，。,.;；!？?、]+/).filter((t) => t.length >= 2);
  return SPINE_STAGES.map((s) => {
    let score = 0;
    for (const t of terms) {
      if (s.stage.toLowerCase().includes(t)) score += 2;
      if (s.keywords.some((k) => t.includes(k) || k.includes(t))) score += 1;
    }
    return { id: s.id, stage: s.stage, score };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
}

/** 七阶段研究 DAG（闸2 领域模板）：检查点节点（真实性闸门）以 deps 串成脊柱 */
export function metisTemplateDag(_intent: { domain?: string; goal?: string }): { nodes: Array<{ id: string; title: string; deps: string[]; expectedOutput: string }> } {
  return {
    nodes: [
      { id: "n1", title: "① 文献准备与选题确认（检查点：用户裁定选题）", deps: [], expectedOutput: "文献综述+selected_topic" },
      { id: "n2", title: "② 研究设计（检查点：研究问题/变量/范式确认）", deps: ["n1"], expectedOutput: "研究设计文档（定量设计/质性方案/理论框架）" },
      { id: "n3", title: "③ 数据/材料获取（fail-closed：无证据即停）", deps: ["n2"], expectedOutput: "数据集/语料/档案（含来源凭证）" },
      { id: "n4", title: "④ 分析执行（引擎任务编排）", deps: ["n3"], expectedOutput: "分析结果（可复现脚本）" },
      { id: "n5", title: "⑤ 阶段验证（真实性闸门：证据链复核）", deps: ["n4"], expectedOutput: "验证报告（fail-closed）" },
      { id: "n6", title: "⑥ 成文与格式（引用/图表/术语一致性）", deps: ["n5"], expectedOutput: "论文/报告稿" },
      { id: "n7", title: "⑦ 交付（QA 报告 + delivery-note，检查点）", deps: ["n6"], expectedOutput: "交付包" },
    ],
  };
}

/** 研究类型推断（parsing 模板路径的 domain 填充） */
export function inferResearchParadigm(text: string): string {
  const t = text.toLowerCase();
  if (/定量|问卷|回归|统计|实证|测量/.test(t)) return "quantitative";
  if (/访谈|民族志|扎根|质性|个案|话语/.test(t)) return "qualitative";
  if (/思辨|理论|哲学|概念|诠释/.test(t)) return "theoretical";
  return "general";
}

/** 引擎命令契约（真实 SKILL.md 中解析出的命令面） */
export const ENGINE_COMMANDS = ["init", "status", "plan", "advance", "tasks", "exec", "artifacts", "deliver", "verify"] as const;

export function spineAdapter(_skillMd: string): CapabilityAdapter {
  const source = SPINE_SOURCE;
  return {
    source,
    supports: (q) => q.text.trim().length > 0,
    async search(query: CapabilityQuery): Promise<AdapterResult> {
      const started = performance.now();
      const hits = matchSpineStages(query.text).slice(0, query.limit ?? 5);
      const capabilities = hits.map((h) =>
        buildCapability({
          id: `metis-spine:${h.id}`,
          name: h.stage,
          kind: "skill-knowledge",
          description: `七阶段脊柱阶段（S1-S10 引擎细粒度）；fail-closed 纪律：验证失败/证据缺失即停，禁止编造文献数据结果。`,
          source,
          install: { type: "context", location: `${METIS_SKILLS_ROOT}/metis/SKILL.md` },
          tags: ["spine", h.id],
          requiresAuth: false,
        }),
      );
      return { capabilities, status: makeStatus(source.id, true, false, started, capabilities.length, hits.length > 0 ? undefined : "no stage matched") };
    },
  };
}

export function engineAdapter(_skillMd: string): CapabilityAdapter {
  const source = ENGINE_SOURCE;
  return {
    source,
    supports: (q) => q.text.trim().length > 0,
    async search(query: CapabilityQuery): Promise<AdapterResult> {
      const started = performance.now();
      const q = query.text.toLowerCase();
      const matched = ENGINE_COMMANDS.filter((c) => q.includes(c)).slice(0, query.limit ?? 5);
      const capabilities = (matched.length > 0 ? matched : [...ENGINE_COMMANDS].slice(0, 3)).map((cmd) =>
        buildCapability({
          id: `metis-engine:${cmd}`,
          name: `metis ${cmd}`,
          kind: "cli-tool",
          description: `研究引擎 CLI 命令（经引擎执行，不直接写 .metis/ 状态）——cmd=${cmd}`,
          source,
          install: { type: "cli", command: `metis ${cmd}`, args: [] },
          tags: ["engine", cmd],
          requiresAuth: false,
        }),
      );
      return { capabilities, status: makeStatus(source.id, true, false, started, capabilities.length) };
    },
  };
}

/** adapters/ 目录知识源：读真实文件名+首段（若目录存在） */
export function metisAdaptersAdapter(adaptersDir?: string): CapabilityAdapter {
  const source = ADAPTER_SOURCE;
  // R5+ 收尾：目录内容闭包缓存——旧实现每次 search 重读 20 个整文件只为取 200 字符。
  // 60s TTL 兜底：开发期新增适配文件最多延迟一分钟可见。
  let docsCache: Array<{ name: string; head: string }> | undefined;
  let docsCacheAt = 0;
  const loadDocs = async (): Promise<Array<{ name: string; head: string }>> => {
    if (docsCache && Date.now() - docsCacheAt < 60_000) return docsCache;
    const docs: Array<{ name: string; head: string }> = [];
    if (adaptersDir) {
      try {
        const files = (await readdir(adaptersDir)).filter((f) => f.endsWith(".md") || f.endsWith(".py") || f.endsWith(".json"));
        for (const f of files.slice(0, 20)) {
          const text = await readFile(path.join(adaptersDir, f), "utf8").catch(() => "");
          docs.push({ name: f, head: text.slice(0, 200) });
        }
      } catch {
        /* 目录不存在 → 空态 */
      }
    }
    docsCache = docs;
    docsCacheAt = Date.now();
    return docs;
  };
  return {
    source,
    supports: (q) => q.text.trim().length > 0,
    async search(query: CapabilityQuery): Promise<AdapterResult> {
      const started = performance.now();
      const docs = await loadDocs();
      const q = query.text.toLowerCase();
      const matched = docs.filter((d) => d.name.toLowerCase().includes(q.replace(/\s+/g, "")) || d.head.toLowerCase().includes(q.split(/\s+/)[0] ?? "###"));
      const capabilities = (matched.length > 0 ? matched : docs).slice(0, query.limit ?? 5).map((d) =>
        buildCapability({
          id: `metis-adapters:${d.name}`,
          name: d.name,
          kind: "skill-knowledge",
          description: d.head || "METIS 格式适配知识",
          source,
          install: { type: "context", location: adaptersDir ? path.join(adaptersDir, d.name) : d.name },
          tags: ["adapter"],
          requiresAuth: false,
        }),
      );
      return { capabilities, status: makeStatus(source.id, true, matched.length === 0, started, capabilities.length, docs.length === 0 ? "adapters dir unavailable" : undefined) };
    },
  };
}
