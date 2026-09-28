import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Dirent } from "node:fs";
import type { BuildContext } from "@/orchestrator/context.js";
import type { AcceptanceReport } from "@/acceptance/acceptance.js";

/**
 * 阶段七：Memory 三层（会话/场景/知识）+ 检索（context-mode ContentStore：SQLite FTS5 + BM25）
 * + 文件树数据接口。根目录 ~/.pi/scenario/memory/{sessions,scenarios,knowledge}/。
 */

export interface MemoryPaths {
  root: string;
  sessions: string;
  scenarios: string;
  knowledge: string;
}

export function memoryPaths(root: string): MemoryPaths {
  return {
    root,
    sessions: path.join(root, "sessions"),
    scenarios: path.join(root, "scenarios"),
    knowledge: path.join(root, "knowledge"),
  };
}

// ── 7.1 会话 Memory：全轨迹 → 结构化 Markdown ──

export function sessionMemoryMd(ctx: BuildContext, report?: AcceptanceReport): string {
  const lines: string[] = [];
  lines.push(`# 会话 ${ctx.id}`);
  lines.push("");
  lines.push(`- 需求: ${ctx.requirement}`);
  lines.push(`- 目标: ${ctx.intent?.goal ?? "—"}`);
  lines.push(`- 阶段: ${ctx.phase}   构建: ${ctx.createdAt} → ${ctx.updatedAt}`);
  lines.push("");
  lines.push("## 意图");
  if (ctx.intent) {
    lines.push(`- 领域: ${ctx.intent.domain}（解析: ${ctx.intent.via}）`);
    if (ctx.intent.slots.length > 0) lines.push(`- 槽位: ${ctx.intent.slots.map((s) => `${s.name}=${s.value}`).join(", ")}`);
  } else {
    lines.push("-（未解析）");
  }
  lines.push("");
  lines.push("## 任务 DAG");
  if (ctx.dag) {
    for (const n of ctx.dag.nodes) lines.push(`- [${n.id}] ${n.title}${n.deps.length > 0 ? ` ← ${n.deps.join(",")}` : ""}`);
  }
  lines.push("");
  lines.push("## 执行轨迹");
  if (ctx.trace.length === 0) lines.push("-（无）");
  for (const step of ctx.trace) {
    lines.push(`- ${step.nodeId}: ${step.status}${step.error ? `（${step.error}）` : ""}`);
  }
  lines.push("");
  lines.push("## 闸门决策");
  if (ctx.approvals.length === 0) lines.push("-（无）");
  for (const a of ctx.approvals) {
    lines.push(`- 闸门${a.gate} ${a.action === "approve" ? "批准" : `驳回→${a.targetPhase ?? "?"}`}（${a.decidedBy}）${a.comment ? `：${a.comment}` : ""}`);
  }
  lines.push("");
  lines.push("## 验收");
  if (report) {
    lines.push(`- 三层结论: ${report.allPassed ? "全部通过" : "存在失败"}`);
    for (const a of report.attribution) lines.push(`- ${a}`);
  } else {
    for (const acc of ctx.acceptance) lines.push(`- [${acc.layer}] ${acc.passed ? "过" : "挂"}`);
  }
  lines.push("");
  return lines.join("\n");
}

// ── 7.2 场景 Memory：复用记录追加 ──

export interface ScenarioReuseEntry {
  scenarioId: string;
  at: string;
  slots: Record<string, string>;
  ok: boolean;
  note?: string;
}

export function scenarioReuseEntryMd(entry: ScenarioReuseEntry): string {
  const slotText = Object.entries(entry.slots)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  return [`## 复用 ${entry.at}`, `- 场景: ${entry.scenarioId}`, `- 槽位: ${slotText || "（无）"}`, `- 结果: ${entry.ok ? "成功" : "失败"}`, entry.note ? `- 备注: ${entry.note}` : "", ""].filter(Boolean).join("\n");
}

// ── 7.3 知识 Memory：失败/漂移 → 经验条目（同类去重）──

export interface KnowledgeEntry {
  id: string;
  /** 失败签名（同类判定键） */
  signature: string;
  lesson: string;
  occurrences: number;
  updatedAt: string;
}

export class KnowledgeMemory {
  private readonly entries = new Map<string, KnowledgeEntry>();

  /** 2 次同类失败 → 仍 1 条目（occurrences 累加，lesson 可更新） */
  recordFailure(signature: string, lesson: string, now = new Date()): KnowledgeEntry {
    const id = knowledgeIdOf(signature);
    const existing = this.entries.get(id);
    if (existing) {
      existing.occurrences += 1;
      existing.lesson = lesson;
      existing.updatedAt = now.toISOString();
      return existing;
    }
    const entry: KnowledgeEntry = { id, signature, lesson, occurrences: 1, updatedAt: now.toISOString() };
    this.entries.set(id, entry);
    return entry;
  }

  all(): KnowledgeEntry[] {
    return [...this.entries.values()];
  }
}

export function knowledgeIdOf(signature: string): string {
  let h = 2166136261;
  for (let i = 0; i < signature.length; i++) {
    h ^= signature.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `kb-${(h >>> 0).toString(36)}`;
}

export function knowledgeEntryMd(entry: KnowledgeEntry): string {
  return [`## ${entry.id}`, `- 失败签名: ${entry.signature}`, `- 对策: ${entry.lesson}`, `- 累计: ${entry.occurrences} 次（更新 ${entry.updatedAt}）`, ""].join("\n");
}

// ── 7.5 Memory 文件树数据接口 ──

export interface MemoryTreeNode {
  name: string;
  path: string;
  kind: "dir" | "file";
  size?: number;
  children?: MemoryTreeNode[];
}

export async function memoryTree(paths: MemoryPaths): Promise<MemoryTreeNode> {
  return await walk(paths.root);
}

async function walk(dir: string): Promise<MemoryTreeNode> {
  const node: MemoryTreeNode = { name: path.basename(dir) || dir, path: dir, kind: "dir", children: [] };
  let items: Dirent[] = [];
  try {
    items = await readdir(dir, { withFileTypes: true });
  } catch {
    return node;
  }
  for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      node.children!.push(await walk(full));
    } else {
      let size: number | undefined;
      try {
        size = (await stat(full)).size;
      } catch {
        size = undefined;
      }
      node.children!.push({ name: item.name, path: full, kind: "file", size });
    }
  }
  return node;
}

export { mkdir, readFile, writeFile };
