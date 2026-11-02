import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CompetitionSchema, RubricSchema, type AresKnowledge } from "./ares-knowledge.js";

/**
 * Ares 领域数据加载（自 ares-scenario factory.ts 迁入）：与调用方 cwd 无关的
 * 数据根解析 + competitions/rubrics 解析。领域知识 100% 本地，加载一次后缓存于 profile。
 */

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export async function resolveAresDataRoot(explicit?: string): Promise<string> {
  const candidates = [
    explicit,
    process.env.ARES_DATA_ROOT,
    path.resolve(MODULE_DIR, "ares-data"),
    path.resolve(process.cwd(), "src/domains/ares/ares-data"),
    path.resolve(process.cwd(), "src/ares-data"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      await access(path.join(candidate, "competitions.json"));
      await access(path.join(candidate, "rubrics"));
      return candidate;
    } catch {
      // Try the next location; the final error below explains every location.
    }
  }
  throw new Error(`Ares data not found. Checked: ${candidates.join(", ")}`);
}

export async function loadAresKnowledge(dataRoot?: string): Promise<AresKnowledge> {
  const root = await resolveAresDataRoot(dataRoot);
  const [competitionsRaw, rubricFiles] = await Promise.all([readFile(path.join(root, "competitions.json"), "utf8"), loadRubrics(path.join(root, "rubrics"))]);
  const competitions = (JSON.parse(competitionsRaw) as unknown[]).map((c) => CompetitionSchema.parse(c));
  return { competitions, rubrics: rubricFiles };
}

async function loadRubrics(dir: string): Promise<AresKnowledge["rubrics"]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).slice(0, 132);
  const out: AresKnowledge["rubrics"] = [];
  for (const f of files) {
    try {
      out.push(RubricSchema.parse(JSON.parse(await readFile(path.join(dir, f), "utf8"))));
    } catch {
      /* 坏档案跳过（源降级语义） */
    }
  }
  return out;
}
