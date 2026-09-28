import path from "node:path";
import { createRequire } from "node:module";
import { ScenarioError, ScenarioErrorCode } from "@/core/errors.js";

/**
 * 7.4 经验检索：接 context-mode 的 ContentStore（SQLite FTS5 + BM25 排序）。
 * retrieving 阶段把 query 发给检索器，命中历史经验注入构建上下文。
 */

export interface ExperienceDoc {
  id: string;
  text: string;
  source: string;
}

export interface ExperienceHit {
  id: string;
  text: string;
  source: string;
  score: number;
}

export interface ExperienceRetriever {
  add(doc: ExperienceDoc): void;
  search(query: string, limit?: number): ExperienceHit[];
  count(): number;
}

interface ContentStoreLike {
  index(options: { content?: string; path?: string; source?: string }): unknown;
  search(query: string, limit?: number): CmSearchResult[];
}

interface CmSearchResult {
  /** context-mode 实测扁平结构：content/source 顶层，rank 为负值（越接近 0 越相关） */
  content?: string;
  source?: string;
  rank?: number;
  score?: number;
  bm25?: number;
}

/** context-mode ContentStore 适配（绝对路径 require 绕过其 exports 子路径限制，同一编译产物） */
export class ContextModeRetriever implements ExperienceRetriever {
  private store: ContentStoreLike | undefined;
  private readonly ids = new Map<string, string>();

  constructor(private dbPath?: string) {}

  private async ensureStore(): Promise<ContentStoreLike> {
    if (!this.store) {
      try {
        const require = createRequire(import.meta.url);
        const storePath = path.join(process.cwd(), "node_modules", "context-mode", "build", "store.js");
        const mod = require(storePath) as { ContentStore: new (dbPath?: string) => ContentStoreLike };
        this.store = new mod.ContentStore(this.dbPath);
      } catch (err) {
        throw new ScenarioError({
          code: ScenarioErrorCode.SOURCE_UNAVAILABLE,
          message: `context-mode ContentStore unavailable: ${err instanceof Error ? err.message : String(err)}`,
          phase: "retrieving",
        });
      }
    }
    return this.store;
  }

  async add(doc: ExperienceDoc): Promise<void> {
    const store = await this.ensureStore();
    store.index({ content: doc.text, source: `${doc.source}#${doc.id}` });
    this.ids.set(doc.id, doc.text);
  }

  search(query: string, limit = 5): ExperienceHit[] {
    if (!this.store) return [];
    const results = this.store.search(query, limit) as CmSearchResult[];
    return results
      .map((r) => ({
        id: String(r.source ?? "unknown"),
        text: r.content ?? "",
        source: r.source ?? "",
        score: r.score ?? (r.rank !== undefined ? -r.rank : (r.bm25 ?? 0)),
      }))
      .filter((h) => h.text.length > 0);
  }

  count(): number {
    return this.ids.size;
  }

  /** 关闭底层 SQLite 句柄（Windows 下不清理会锁文件） */
  dispose(): void {
    const store = this.store as (ContentStoreLike & { cleanup?: () => void }) | undefined;
    try {
      store?.cleanup?.();
    } catch {
      /* 已关闭 */
    }
    this.store = undefined;
  }
}

/** 内存 BM25 检索（离线测试/降级用；与 ContentStore 同语义） */
export class InMemoryRetriever implements ExperienceRetriever {
  private readonly docs: ExperienceDoc[] = [];

  add(doc: ExperienceDoc): void {
    this.docs.push(doc);
  }

  search(query: string, limit = 5): ExperienceHit[] {
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
    const scored = this.docs.map((doc) => {
      const lower = doc.text.toLowerCase();
      let score = 0;
      for (const t of terms) {
        const occurrences = lower.split(t).length - 1;
        if (occurrences > 0) score += 1 + Math.log(occurrences);
      }
      return { doc, score };
    });
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => ({ id: s.doc.id, text: s.doc.text, source: s.doc.source, score: s.score }));
  }

  count(): number {
    return this.docs.length;
  }
}

/** 生成检索注入块（retrieving 阶段消费） */
export function renderExperienceBlock(hits: ExperienceHit[]): string {
  if (hits.length === 0) return "";
  const lines = ["## 历史经验（Memory 检索注入）"];
  for (const h of hits) {
    lines.push(`- [${h.id}] ${h.text.slice(0, 200)}`);
  }
  return lines.join("\n");
}

export function memoryFilePaths(root: string): { sessions: string; scenarios: string; knowledge: string } {
  return {
    sessions: path.join(root, "sessions"),
    scenarios: path.join(root, "scenarios"),
    knowledge: path.join(root, "knowledge"),
  };
}
