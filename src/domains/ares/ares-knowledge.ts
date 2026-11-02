import { z } from "zod";
import { buildCapability, makeStatus, type AdapterResult, type CapabilityAdapter, type CapabilityQuery } from "@/federation/adapters/adapter-utils.js";
import type { Source } from "@/federation/types.js";

/**
 * ARES 领域联邦层：竞赛场景的"能力源"不是 MCP 市场，而是插件自带的领域知识库：
 *  ① competitions-source —— 132 项赛事主库（id/name/aliases/level/pipeline/deliverables/timeline）
 *  ② rubrics-source —— 132 份专属评审标准档案（评分维度/交付要求/流程阶段/评审偏好）
 *  ③ pipeline-skills-source —— 16 条生产线技能（SKILL.md 知识注入：总控/写作纪律/docx/ppt/data/prototype/judge + 六线三模块）
 * 检索语义：需求文本 → 赛事匹配（名称/别名命中）→ 产出 Capability（kind=mcp-server 语义改为 knowledge-capability）。
 * trust：本地官方档案按 curated 计；证据= rubric 是否存在 + deliverables 完备度。
 */

// 16 条生产线技能名录（总控/共享/六线三模块）
export const PIPELINE_SKILLS: Array<{ name: string; role: string; summary: string }> = [
  { name: "ares", role: "总控路由", summary: "需求解析→赛事匹配→生产计划→编排生产→质检交付" },
  { name: "ares-writing-style", role: "共享写作纪律", summary: "计划书/论文/讲稿的写作纪律与一致性约束" },
  { name: "ares-docx", role: "Word 生产", summary: "商业计划书/论文/设计文档 docx 程序化生成" },
  { name: "ares-ppt", role: "PPTX 程序化生成", summary: "路演/答辩 PPT 程序化生成" },
  { name: "ares-data", role: "数据与实验数据", summary: "财务三表自动勾稽、实验数据生成" },
  { name: "ares-prototype", role: "多页 HTML 原型", summary: "可交互多页 HTML 原型系统" },
  { name: "ares-judge", role: "模拟评审与质检", summary: "按赛事 rubric 模拟评审打分与一致性扫描" },
  { name: "ares-entrepreneurship", role: "L1 创业竞赛线", summary: "互联网+/挑战杯/三创/iCAN 等创业类赛事" },
  { name: "ares-modeling", role: "L2 理科建模线", summary: "数模国赛/美赛/统计建模等" },
  { name: "ares-engineering", role: "L3 工科作品线", summary: "电子设计/机械创新/智能车/机器人等" },
  { name: "ares-business-case", role: "L4 商科分析线", summary: "市场调查/商业案例/税收风险等" },
  { name: "ares-art-design", role: "L5 艺术设计线", summary: "广告艺术/华灿奖/工业设计等" },
  { name: "ares-coding-contest", role: "L6 程序算法线", summary: "ACM/蓝桥杯/天梯赛等算法训练与题库" },
  { name: "ares-humanities", role: "E1 人文语言模块", summary: "外研社/21世纪杯/韩素音翻译等" },
  { name: "ares-lab-skills", role: "E2 实验技能模块", summary: "金相/医学技术/地质技能训练材料" },
  { name: "ares-simulation", role: "E3 模拟经营模块", summary: "企业竞争模拟/数智化沙盘决策模型" },
];

// SceneFlow 合并：数据根锚定到本模块位置（dev=src/domains/ares/，bundle=dist 同级 src 树），
// 不再依赖 process.cwd——capability install.location 是绝对路径，invoke 层 path.resolve 直达。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
const DOMAIN_MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
function resolveDomainDir(sub: string): string {
  const candidates = [
    path.resolve(DOMAIN_MODULE_DIR, sub),
    path.resolve(process.cwd(), "src/domains/ares", sub),
  ];
  for (const c of candidates) { if (existsSync(c)) return c; }
  return candidates[0] as string;
}
export const ARES_DATA_ROOT = resolveDomainDir("ares-data");
export const ARES_SKILLS_ROOT = resolveDomainDir("ares-skills");

// ── 赛事档案 schema（真实数据字段）──

export const CompetitionSchema = z.object({
  id: z.number(),
  name: z.string(),
  aliases: z.array(z.string()).default([]),
  level: z.string().default(""),
  category: z.string().default(""),
  pipeline: z.string().default(""), // L1..L6 / E1..E3
  organizer: z.string().default(""),
  official_url: z.string().default(""),
  cycle: z.string().default(""),
  typical_timeline: z.record(z.string(), z.string()).default({}),
  tracks: z.array(z.unknown()).default([]),
  deliverables_required: z.array(z.string()).default([]),
  team_rules: z.string().default(""),
  notes: z.string().default(""),
});
export type Competition = z.infer<typeof CompetitionSchema>;

export const RubricSchema = z.object({
  competition_id: z.number(),
  competition_name: z.string(),
  judging_dimensions: z
    .array(z.object({ dimension: z.string(), weight: z.string().optional(), official_wording: z.string().optional() }).passthrough())
    .default([]),
  deliverable_requirements: z.unknown().optional(),
  process_stages: z.unknown().optional(),
  review_format: z.string().optional(),
  judge_preferences: z.unknown().optional(),
  past_winning_patterns: z.unknown().optional(),
  forbidden_or_risky: z.unknown().optional(),
  confidence: z.string().optional(),
  last_updated: z.string().optional(),
});
export type Rubric = z.infer<typeof RubricSchema>;

/** 赛事检索：名称/别名/类目 分词命中打分 */
export function matchCompetitions(competitions: Competition[], query: string, limit = 5): Array<{ competition: Competition; score: number }> {
  const q = query.toLowerCase();
  const terms = q.split(/[\s，。,.;；!？?、]+/).filter((t) => t.length >= 2);
  return competitions
    .map((c) => {
      const hay = [c.name, ...c.aliases, c.category, c.pipeline, ...c.tracks.map((t) => String((t as { track?: string })?.track ?? ""))]
        .join(" ")
        .toLowerCase();
      let score = 0;
      for (const t of terms) if (hay.includes(t)) score += 1;
      // 全名直接出现给最高分
      if (q.includes(c.name.toLowerCase())) score += 10;
      for (const alias of c.aliases) if (q.includes(alias.toLowerCase())) score += 5;
      return { competition: c, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export const COMPETITIONS_SOURCE: Source = {
  id: "ares-competitions",
  tier: "curated",
  name: "ARES 赛事主库",
  url: "local://ares-data/competitions.json",
};

export const RUBRICS_SOURCE: Source = {
  id: "ares-rubrics",
  tier: "curated",
  name: "ARES 评审标准档案",
  url: "local://ares-data/rubrics/",
};

export const PIPELINE_SKILLS_SOURCE: Source = {
  id: "ares-pipeline-skills",
  tier: "official",
  name: "ARES 生产线技能",
  url: "local://ares-skills/",
};

/** 数据驱动适配器工厂（注入 competitions/rubrics，便于测试与生产共用解析逻辑） */
export interface AresKnowledge {
  competitions: Competition[];
  rubrics: Rubric[];
}

export function competitionsAdapter(knowledge: AresKnowledge): CapabilityAdapter {
  const source = COMPETITIONS_SOURCE;
  return {
    source,
    supports: (q: CapabilityQuery) => q.text.trim().length > 0,
    async search(query: CapabilityQuery): Promise<AdapterResult> {
      const started = performance.now();
      const matched = matchCompetitions(knowledge.competitions, query.text, query.limit ?? 5);
      const capabilities = matched.map(({ competition: c, score }) =>
        buildCapability({
          id: `ares-competitions:${c.id}`,
          name: c.name,
          kind: "cli-tool",
          description: `【${c.pipeline} ${c.level}】${c.category} · 主办 ${c.organizer || "—"} · 周期 ${c.cycle} · 需交付 ${(c.deliverables_required ?? []).length} 类材料 · ${c.team_rules.slice(0, 60)}`,
          source,
          install: { type: "context", location: `${ARES_DATA_ROOT}/competitions.json#${c.id}` },
          tags: [c.pipeline, c.level, c.category, ...c.aliases.slice(0, 3)],
          requiresAuth: false,
        }),
      );
      return { capabilities, status: makeStatus(source.id, true, false, started, capabilities.length, matched.length > 0 ? undefined : "no competition matched") };
    },
  };
}

export function rubricsAdapter(knowledge: AresKnowledge): CapabilityAdapter {
  const source = RUBRICS_SOURCE;
  return {
    source,
    supports: (q) => q.text.trim().length > 0,
    async search(query: CapabilityQuery): Promise<AdapterResult> {
      const started = performance.now();
      const matched = matchCompetitions(knowledge.competitions, query.text, query.limit ?? 5);
      const capabilities = matched
        .map(({ competition: c }) => {
          const rubric = knowledge.rubrics.find((r) => r.competition_id === c.id);
          if (!rubric) return null;
          const dims = rubric.judging_dimensions.map((d) => d.dimension).slice(0, 5);
          return buildCapability({
            id: `ares-rubrics:${c.id}`,
            name: `${c.name} 评审标准`,
            kind: "cli-tool",
            description: `${rubric.judging_dimensions.length} 个评分维度（${dims.join(" / ")}）· 评审形式 ${rubric.review_format ?? "—"} · 置信 ${rubric.confidence ?? "—"}`,
            source,
            install: { type: "context", location: `${ARES_DATA_ROOT}/rubrics/${String(c.id).padStart(3, "0")}.json` },
            tags: ["rubric", c.pipeline, c.level],
            requiresAuth: false,
          });
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
      return { capabilities, status: makeStatus(source.id, true, false, started, capabilities.length, capabilities.length > 0 ? undefined : "no rubric for matched competitions") };
    },
  };
}

/** 生产线技能源：SKILL.md 名录 → knowledge-capability（闸门3 选型池） */
export function pipelineSkillsAdapter(skills: Array<{ name: string; role: string; summary: string }>): CapabilityAdapter {
  const source = PIPELINE_SKILLS_SOURCE;
  return {
    source,
    supports: (q) => q.text.trim().length > 0,
    async search(query: CapabilityQuery): Promise<AdapterResult> {
      const started = performance.now();
      const q = query.text.toLowerCase();
      const terms = q.split(/[\s，。,.;；!？?、]+/).filter((t) => t.length >= 2);
      const matched = skills
        .map((s) => {
          const hay = `${s.name} ${s.role} ${s.summary}`.toLowerCase();
          const score = terms.filter((t) => hay.includes(t)).length;
          return { s, score };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, query.limit ?? 5);
      const capabilities = matched.map(({ s }) =>
        buildCapability({
          id: `ares-pipeline-skills:${s.name}`,
          name: s.name,
          kind: "skill-knowledge",
          description: `[${s.role}] ${s.summary}`,
          source,
          install: { type: "context", location: `${ARES_SKILLS_ROOT}/${s.name}/SKILL.md` },
          tags: ["ares-skill", s.role],
          requiresAuth: false,
        }),
      );
      return { capabilities, status: makeStatus(source.id, true, false, started, capabilities.length) };
    },
  };
}
