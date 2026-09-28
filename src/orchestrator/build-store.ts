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
  return {
    async save(ctx) {
      await store.set(ctx.id, ctx);
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
