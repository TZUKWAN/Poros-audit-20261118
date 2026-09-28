import { copyFile, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { ZodType } from "zod";
import { ScenarioError, ScenarioErrorCode } from "./errors.js";

/**
 * 通用 JSON 键值存储（~/.pi/scenario/ 下各子系统共用）。
 * 语义：
 *  - 每个 store 对应一个 JSON 文件（map 形态），整读整写；
 *  - 原子写：tmp 文件 + rename；
 *  - 损坏恢复：读时 JSON.parse 失败且存在 .bak 则从 .bak 恢复；否则视为空表（不抛），
 *    下次写回即修复。写前总是先落 .bak（保留上一份好数据）。
 */
export interface Store<T> {
  get(key: string): Promise<T | undefined>;
  set(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  has(key: string): Promise<boolean>;
  keys(): Promise<string[]>;
  entries(): Promise<Array<[string, T]>>;
  /** 清空全部条目 */
  clear(): Promise<void>;
}

export interface JsonStoreOptions {
  /** 存储文件绝对路径 */
  filePath: string;
  /** 值 schema（写入前校验，损坏数据读出时校验并按缺省处理） */
  schema: ZodType<unknown>;
}

export function jsonStore<T>(options: JsonStoreOptions): Store<T> {
  const { filePath, schema } = options;
  const bakPath = `${filePath}.bak`;
  const tmpPath = `${filePath}.tmp`;
  const queue: Promise<unknown> = Promise.resolve();
  let cache: Map<string, unknown> | undefined;
  let loadedFromDisk = false;

  /** 串行化所有读改写，避免并发交错损坏 */
  const serialized = async <R>(fn: () => Promise<R>): Promise<R> => {
    let release: () => void = () => {};
    const prev = queueRef.current;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    queueRef.current = prev.then(() => gate);
    try {
      await prev;
      return await fn();
    } finally {
      release();
    }
  };

  // 模块级可变引用，保证同一 store 实例内所有操作串行
  const queueRef = { current: queue };

  async function loadRaw(): Promise<Map<string, unknown>> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      // 主文件不存在：尝试 bak
      try {
        raw = await readFile(bakPath, "utf8");
        await copyFile(bakPath, filePath);
      } catch {
        return new Map();
      }
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 主文件损坏：尝试 bak
      try {
        const bakRaw = await readFile(bakPath, "utf8");
        parsed = JSON.parse(bakRaw);
        await copyFile(bakPath, filePath);
      } catch {
        return new Map();
      }
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return new Map();
    const map = new Map<string, unknown>(Object.entries(parsed as Record<string, unknown>));
    // 值级校验：坏值剔除（视为该键缺失）
    for (const [k, v] of map) {
      if (!schema.safeParse(v).success) map.delete(k);
    }
    return map;
  }

  async function ensureLoaded(): Promise<Map<string, unknown>> {
    if (!loadedFromDisk) {
      cache = await loadRaw();
      loadedFromDisk = true;
    }
    return cache as Map<string, unknown>;
  }

  async function persist(map: Map<string, unknown>): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const obj = Object.fromEntries(map);
    const body = JSON.stringify(obj, null, 2);
    const tmp = tmpPath;
    const handle = await open(tmp, "w");
    try {
      await handle.writeFile(body, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, filePath);
    // 写后备份：.bak 恒为最近一次完整成功状态（首次写入也有备份，单写后损坏可恢复）
    await safeCopy(filePath, bakPath);
  }

  return {
    get: (key) =>
      serialized(async () => {
        const map = await ensureLoaded();
        const v = map.get(key);
        return v === undefined ? undefined : (structuredClone(v) as T);
      }),
    set: (key, value) =>
      serialized(async () => {
        const parsed = schema.safeParse(value);
        if (!parsed.success) {
          throw new ScenarioError({
            code: ScenarioErrorCode.VALIDATION,
            message: `store.set schema violation for key ${key}`,
            phase: "infra",
            context: { key, issues: parsed.error.issues },
          });
        }
        const map = await ensureLoaded();
        map.set(key, structuredClone(value));
        await persist(map);
      }),
    delete: (key) =>
      serialized(async () => {
        const map = await ensureLoaded();
        const existed = map.delete(key);
        if (existed) await persist(map);
        return existed;
      }),
    has: (key) =>
      serialized(async () => {
        const map = await ensureLoaded();
        return map.has(key);
      }),
    keys: () =>
      serialized(async () => {
        const map = await ensureLoaded();
        return [...map.keys()];
      }),
    entries: () =>
      serialized(async () => {
        const map = await ensureLoaded();
        return [...map.entries()].map(([k, v]) => [k, structuredClone(v) as T] as [string, T]);
      }),
    clear: () =>
      serialized(async () => {
        cache = new Map();
        loadedFromDisk = true;
        await persist(cache);
      }),
  };
}

async function safeCopy(from: string, to: string): Promise<void> {
  const tmpTo = `${to}.tmp`;
  await copyFile(from, tmpTo);
  await rename(tmpTo, to);
}

/** 项目数据根：~/.pi/scenario/（DECISIONS D3） */
export function scenarioDataRoot(homedir = process.env.USERPROFILE ?? process.env.HOME ?? ""): string {
  if (!homedir) {
    throw new ScenarioError({
      code: ScenarioErrorCode.IO,
      message: "cannot resolve home directory",
      phase: "infra",
    });
  }
  return path.join(homedir, ".pi", "scenario");
}

/** 测试辅助：删除整个数据根（仅测试路径使用） */
export async function wipeDataRootForTests(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}
