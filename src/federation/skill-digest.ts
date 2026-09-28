import { mkdir, readdir, readFile, rm, stat, copyFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ScenarioError, ScenarioErrorCode } from "@/core/errors.js";

/**
 * 技能经验提炼器（1.5）—— 四类产物（v2.1：技能=经验矿，检索→克隆→提炼→删除）：
 *  ① 流程片段 processFragments —— 任务拆解步骤 → 供 planning 改进 DAG
 *  ② 坑与对策 pitfalls        —— → 流水线防御分支 / hook
 *  ③ 验收要点 acceptancePoints —— → 闸门4 验收标准
 *  ④ 能力线索 capabilityLeads  —— 提到的工具/API → MCP 市场检索关键词
 */

export const DigestProductsSchema = z.object({
  skillId: z.string(),
  sourceUrl: z.string(),
  processFragments: z
    .array(z.object({ title: z.string(), steps: z.array(z.string()).min(1) }))
    .default([]),
  pitfalls: z.array(z.object({ pitfall: z.string(), countermeasure: z.string() })).default([]),
  acceptancePoints: z.array(z.string()).default([]),
  capabilityLeads: z.array(z.string()).default([]),
  /** 至少一项可落地改动（1.5.2 校验依据） */
  actionable: z.boolean(),
  /** 可执行资产 vendoring 记录（1.5.3） */
  vendored: z.array(z.object({ file: z.string(), destPath: z.string(), provenance: z.string() })).default([]),
});
export type DigestProducts = z.infer<typeof DigestProductsSchema>;

const PITFALL_PATTERNS = /(avoid|don't|do not|never|always|caution|warning|careful|must not|注意|避免|不要|切勿|禁止|务必)/i;
const ACCEPT_PATTERNS = /(verify|check that|ensure|expect|success criteria|acceptance|validate|验收|校验|确认|确保|检查)/i;
const TOOL_HINTS: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/\bnpx\s+([a-z0-9@/._-]+)/i, (m) => m[1] ?? ""],
  [/\bmp?x\s+(install\s+)?([a-z0-9@/._-]+)/i, (m) => m[2] ?? ""],
  [/([a-z0-9-]+)\s+MCP\s+server/i, (m) => `${m[1] ?? ""} mcp`],
  [/MCP\s+server[:\s]+([a-z0-9@/._-]+)/i, (m) => `${m[1] ?? ""} mcp`],
  [/https?:\/\/(api\.[a-z0-9.-]+|[a-z0-9.-]+\/api)/i, (m) => m[1] ?? ""],
  [/\b(claude|openai|gemini|playwright|puppeteer|docker|git|curl|ffmpeg)\b/i, (m) => m[1] ?? ""],
];

export interface DigestOptions {
  /** 可选 LLM 提炼函数（返回 markdown 结构化小节）；缺省用确定性启发式（模板路径） */
  llm?: (md: string) => Promise<string>;
}

/** 提炼 SKILL.md → 四类产物（纯函数，便于 fixture 测试） */
export function digestSkillMd(skillId: string, sourceUrl: string, md: string): DigestProducts {
  const lines = md.split(/\r?\n/);
  const processFragments: DigestProducts["processFragments"] = [];
  const pitfalls: DigestProducts["pitfalls"] = [];
  const acceptancePoints: string[] = [];
  const capabilityLeads = new Set<string>();

  // ① 流程片段：有序步骤列表（1. 2. 3. 或 - 步骤）在 Workflow/Steps/Usage/流程/步骤 小节下
  let currentSection = "";
  let currentSteps: string[] = [];
  let currentTitle = "";
  const flushSteps = () => {
    if (currentSteps.length >= 2) {
      processFragments.push({ title: currentTitle || currentSection || "workflow", steps: [...currentSteps] });
    }
    currentSteps = [];
  };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const h = line.match(/^#{1,4}\s+(.+)$/);
    if (h) {
      flushSteps();
      currentSection = h[1] ?? "";
      if (/(workflow|steps|usage|process|how to|流程|步骤|用法)/i.test(currentSection)) currentTitle = currentSection;
      continue;
    }
    const step = line.match(/^(?:\d+[.)]|[-*])\s+(.{6,})$/);
    if (step && (currentTitle || /^\d+[.)]/.test(line))) {
      const cleaned = (step[1] ?? "")
        .replace(/`([^`]*)`/g, "$1")
        .replace(/\*\*/g, "")
        .trim();
      if (cleaned.length >= 6) currentSteps.push(cleaned.slice(0, 200));
    }
  }
  flushSteps();

  // ②③ 坑与对策 / 验收要点：逐行扫描 + 前后文作为对策
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").replace(/^[-*\s>`]*/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const plain = line.replace(/`([^`]*)`/g, "$1").replace(/\*\*/g, "");
    if (PITFALL_PATTERNS.test(plain) && plain.length >= 12) {
      const next = (lines[i + 1] ?? "").replace(/^[-*\s>`]*/, "").trim();
      pitfalls.push({
        pitfall: plain.slice(0, 200),
        countermeasure: next && !PITFALL_PATTERNS.test(next) ? next.slice(0, 200) : "加入防御分支：失败时按此条检查后重试",
      });
    } else if (ACCEPT_PATTERNS.test(plain) && plain.length >= 12) {
      acceptancePoints.push(plain.replace(/^(?:\d+[.)]|[-*])\s*/, "").slice(0, 200));
    }
    // ④ 能力线索
    for (const [re, extract] of TOOL_HINTS) {
      const m = plain.match(re);
      if (m) capabilityLeads.add(extract(m).toLowerCase().slice(0, 60));
    }
  }

  // 去重截断
  const dedup = (arr: string[]): string[] => [...new Set(arr.filter((x): x is string => typeof x === "string"))].slice(0, 20);
  const actionable =
    processFragments.length > 0 || pitfalls.length > 0 || acceptancePoints.length > 0 || capabilityLeads.size > 0;

  return DigestProductsSchema.parse({
    skillId,
    sourceUrl,
    processFragments: processFragments.slice(0, 10),
    pitfalls: pitfalls.slice(0, 20),
    acceptancePoints: dedup(acceptancePoints),
    capabilityLeads: dedup([...capabilityLeads]),
    actionable,
    vendored: [],
  });
}

/**
 * 带重试提炼（1.5.2）：首轮启发式；若空泛（actionable=false）且提供了 LLM，则 LLM 再来一次；
 * LLM 输出解析失败也回退启发式。仍然空泛 → 抛 ScenarioError（调用方可决定跳过该技能）。
 */
export async function digestWithRetry(skillId: string, sourceUrl: string, md: string, options: DigestOptions = {}): Promise<DigestProducts> {
  const first = digestSkillMd(skillId, sourceUrl, md);
  if (first.actionable) return first;
  if (options.llm) {
    try {
      const llmMd = await options.llm(md);
      const merged = `${md}\n\n## LLM 提炼\n${llmMd}`;
      const second = digestSkillMd(skillId, sourceUrl, merged);
      if (second.actionable) return second;
    } catch {
      // LLM 失败 → 启发式结果已是空泛，走下方报错
    }
  }
  throw new ScenarioError({
    code: ScenarioErrorCode.SOURCE_PARSE,
    message: `skill ${skillId} digest produced no actionable products (vague) after retry`,
    phase: "retrieving",
    context: { skillId, sourceUrl },
  });
}

export interface VendorResult {
  products: DigestProducts;
  /** 技能本体已删除的临时目录 */
  cleanedUp: boolean;
}

const VENDORABLE_EXT = [".py", ".sh", ".js", ".mjs", ".ts", ".json", ".tmpl", ".txt", ".csv", ".yaml", ".yml"];

/**
 * 完整流水线（1.5.1 + 1.5.3）：读 tempDir 中 SKILL.md → 提炼 → 有用资产复制进场景产物目录（带出处头）→ 删除技能本体。
 */
export async function digestAndVendor(
  tempDir: string,
  productsDir: string,
  meta: { skillId: string; sourceUrl: string; license?: string },
  options: DigestOptions = {},
): Promise<VendorResult> {
  const skillMdPath = await findSkillMd(tempDir);
  if (!skillMdPath) {
    throw new ScenarioError({
      code: ScenarioErrorCode.NOT_FOUND,
      message: `no SKILL.md under ${tempDir}`,
      phase: "retrieving",
      context: meta,
    });
  }
  const md = await readFile(skillMdPath, "utf8");
  const products = await digestWithRetry(meta.skillId, meta.sourceUrl, md, options);

  // ①⑤ vendoring：非 SKILL.md 的可执行/模板资产，>10 字节的都算"有用"候选（脚本/模板/词表）
  const vendored: DigestProducts["vendored"] = [];
  const baseDir = path.dirname(skillMdPath);
  const entries = await walk(baseDir, 3);
  await mkdir(productsDir, { recursive: true });
  for (const file of entries) {
    const rel = path.relative(baseDir, file);
    if (rel === "SKILL.md") continue;
    const ext = path.extname(file).toLowerCase();
    if (!VENDORABLE_EXT.includes(ext)) continue;
    const s = await stat(file);
    if (s.size < 10 || s.size > 512 * 1024) continue;
    const destPath = path.join(productsDir, "vendor", meta.skillId.replace(/[^\w.-]/g, "_"), rel);
    await mkdir(path.dirname(destPath), { recursive: true });
    const header =
      `# vendored from skill: ${meta.skillId}\n# source: ${meta.sourceUrl}\n# license: ${meta.license ?? "see upstream"}\n# file: ${rel}\n\n`;
    const content = await readFile(file, "utf8");
    await copyFile(file, destPath);
    await writeFileWithHeader(destPath, header, content);
    vendored.push({ file: rel, destPath, provenance: meta.sourceUrl });
  }
  products.vendored.push(...vendored);

  // 技能本体删除（用完即删）
  await rm(tempDir, { recursive: true, force: true });
  return { products, cleanedUp: !(await exists(tempDir)) };
}

async function writeFileWithHeader(destPath: string, header: string, content: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(destPath, header + content, "utf8");
}

async function findSkillMd(dir: string): Promise<string | undefined> {
  const direct = path.join(dir, "SKILL.md");
  if (await exists(direct)) return direct;
  const entries = await walk(dir, 3);
  return entries.find((f) => path.basename(f).toUpperCase() === "SKILL.MD");
}

async function walk(dir: string, depth: number): Promise<string[]> {
  if (depth < 0) return [];
  let out: string[] = [];
  let items: Dirent[];
  try {
    items = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const it of items) {
    const p = path.join(dir, it.name);
    if (it.isDirectory()) out = out.concat(await walk(p, depth - 1));
    else if (it.isFile()) out.push(p);
  }
  return out;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
