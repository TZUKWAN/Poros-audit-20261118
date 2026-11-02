import type { CapabilityAdapter } from "@/federation/types.js";
import type { Dag, Intent } from "@/orchestrator/context.js";
import { aresTemplateDag } from "./ares/domain-dag.js";
import { metisTemplateDag } from "./metis/metis-knowledge.js";
import { competitionsAdapter, rubricsAdapter, pipelineSkillsAdapter, PIPELINE_SKILLS } from "./ares/ares-knowledge.js";
import { spineAdapter, engineAdapter, metisAdaptersAdapter } from "./metis/metis-knowledge.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * SceneFlow 领域 Profile：把"领域"收敛为单一注册表——检索源、DAG 模板、领域路由
 * 全部从 profile 出发，内核其余部分（闸门/状态机/验收/面板）保持领域中立。
 * 领域能力 100% 本地文件读取；用户输入一句话经 inferDomain 自动落域，无需手选。
 */

export type DomainId = "core" | "ares" | "metis";

export interface DomainProfile {
  id: DomainId;
  /** 用户可见领域名 */
  name: string;
  /** buildId/场景 id 前缀（消除跨域 id 碰撞） */
  buildIdPrefix: string;
  /** 本领域检索源（全部本地，零网络） */
  adapters(): Promise<CapabilityAdapter[]>;
  /** 领域 DAG 模板（闸2 planning 模板路径） */
  templateDag(intent: Intent): Dag;
  /** 领域命中打分：>0 表示文本带有该领域信号 */
  score(text: string): number;
}

// ── 领域路由词表（轻量关键词打分；LLM 意图解析失败时的模板路径同样适用） ──

const ARES_SIGNALS =
  /竞赛|大赛|参赛|报名|参赛队|蓝桥|acm|icpc|天梯|数模|数学建模|统计建模|美赛|挑战杯|互联网\+|三创|ican|电子设计|智能车|机器人|市场调查|商业计划书|路演|答辩|申报|评审|创业|华灿|韩素音|外研社|沙盘|企业竞争模拟|组队|赛题|赛程|获奖|省赛|国赛/i;
const METIS_SIGNALS =
  /研究|文献|综述|论文|期刊|投稿|开题|问卷|访谈|定量|定性|实证|假设|变量|回归|质性|民族志|扎根|语料|档案研究|学术|引用|参考文献|研究设计|研究问题|范式|信息茧房|调查分析/i;

// ── Profile 实现 ──

/** ares 三本地源装配（competitions/rubrics 解析一次后缓存） */
let aresAdaptersCache: CapabilityAdapter[] | undefined;
async function loadAresAdapters(): Promise<CapabilityAdapter[]> {
  if (aresAdaptersCache) return aresAdaptersCache;
  const { loadAresKnowledge } = await import("./ares/ares-loader.js");
  const knowledge = await loadAresKnowledge();
  aresAdaptersCache = [competitionsAdapter(knowledge), rubricsAdapter(knowledge), pipelineSkillsAdapter(PIPELINE_SKILLS)];
  return aresAdaptersCache;
}

let metisAdaptersCache: CapabilityAdapter[] | undefined;
async function loadMetisAdapters(): Promise<CapabilityAdapter[]> {
  if (metisAdaptersCache) return metisAdaptersCache;
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const skillMd = await readFile(path.resolve(moduleDir, "metis/metis-skills/metis/SKILL.md"), "utf8").catch(() => "# METIS spine (skill md unavailable)");
  metisAdaptersCache = [spineAdapter(skillMd), engineAdapter(skillMd), metisAdaptersAdapter(path.resolve(moduleDir, "metis/metis-adapters"))];
  return metisAdaptersCache;
}

export const ARES_PROFILE: DomainProfile = {
  id: "ares",
  name: "竞赛生产线",
  buildIdPrefix: "ares",
  adapters: loadAresAdapters,
  templateDag: aresTemplateDag,
  score: (t) => (ARES_SIGNALS.test(t) ? 1 : 0),
};

export const METIS_PROFILE: DomainProfile = {
  id: "metis",
  name: "学术研究脊柱",
  buildIdPrefix: "metis",
  adapters: loadMetisAdapters,
  templateDag: metisTemplateDag,
  score: (t) => (METIS_SIGNALS.test(t) ? 1 : 0),
};

/** 全部领域 profile（core 是内核默认形态，无独立源，不在此列） */
export function domainProfiles(): DomainProfile[] {
  return [ARES_PROFILE, METIS_PROFILE];
}

/** 文本 → 领域路由：取信号分最高者；无信号 → core。双信号并存时看谁的具体词先命中。 */
export function routeDomain(text: string): DomainId {
  const ares = ARES_PROFILE.score(text);
  const metis = METIS_PROFILE.score(text);
  if (ares === 0 && metis === 0) return "core";
  if (ares > metis) return "ares";
  if (metis > ares) return "metis";
  // 平分（极少见，如"竞赛数据研究"）：竞赛词表更具体（含赛事专名），优先 ares
  return "ares";
}

/** 按 id 取 profile（供 buildId 前缀与展示） */
export function profileOf(id: DomainId): DomainProfile | undefined {
  return domainProfiles().find((p) => p.id === id);
}
