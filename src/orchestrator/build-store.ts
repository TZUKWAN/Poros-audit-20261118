import path from "node:path";
import { jsonStore, scenarioDataRoot } from "@/core/store.js";
import { BuildContextSchema, type BuildContext } from "./context.js";
import type { ZodType } from "zod";

/**
 * 2.1.4 断点持久化：BuildContext 按构建 id 落盘（~/.pi/scenario/builds/），
 * 每闸门后与每状态迁移后由编排器回调 persist()；恢复用 load()/restore。
 */
export interface BuildStore {
  save(ctx: BuildContext): Promise<void>;
  load(id: string): Promise<BuildContext | undefined>;
  list(): Promise<string[]>;
}

export function fileBuildStore(root = path.join(scenarioDataRoot(), "builds")): BuildStore {
  const store = jsonStore<BuildContext>({ filePath: path.join(root, "builds.json"), schema: BuildContextSchema as ZodType<unknown> });
  // R5+ 收尾：builds.json 每次持久化整体重写，长跑面板下每个闸门迁移都 O(全部构建)。
  // 定期修剪：只保留最近 100 个，且只淘汰终态（outcome 非 running）上下文——
  // running 的可恢复构建永不驱逐。
  let saveCount = 0;
  const prune = async (): Promise<void> => {
    try {
      const entries = await store.entries();
      if (entries.length <= 100) return;
      const sorted = entries
        .map(([id, ctx]) => ({ id, startedAt: String((ctx as { startedAt?: string }).startedAt ?? ""), outcome: (ctx as { outcome?: string }).outcome ?? "running" }))
        .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
      for (const item of sorted.slice(100)) {
        if (item.outcome !== "running") await store.delete(item.id);
      }
    } catch {
      /* 修剪失败不影响主流程 */
    }
  };
  return {
    async save(ctx) {
      await store.set(ctx.id, ctx);
      saveCount += 1;
      if (saveCount % 25 === 0) void prune();
    },
    async load(id) {
      return await store.get(id);
    },
    async list() {
      return await store.keys();
    },
  };
}

/** 内存实现（测试用） */
export function memoryBuildStore(): BuildStore & { saves: number } {
  const map = new Map<string, BuildContext>();
  return {
    saves: 0,
    async save(ctx) {
      this.saves++;
      map.set(ctx.id, JSON.parse(JSON.stringify(ctx)) as BuildContext);
    },
    async load(id) {
      const v = map.get(id);
      return v ? (JSON.parse(JSON.stringify(v)) as BuildContext) : undefined;
    },
    async list() {
      return [...map.keys()];
    },
  };
}
