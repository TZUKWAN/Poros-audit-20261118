import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { jsonStore } from "@/core/store";

/**
 * R1 审计回归：store 串行链的失败后 rejection 处理。
 * 历史缺陷：`queueRef.current = prev.then(() => gate)` 在某次操作失败后，
 * 链尾成为 rejected promise；若此后无后续操作，该 rejection 无人消费
 * → unhandledRejection（Node 默认崩溃进程）。修复后链尾必须自愈。
 */
describe("store 串行链失败自愈（R1 审计回归）", () => {
  it("操作失败后无后续操作：不产生 unhandledRejection（进程存活）", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "store-chain-"));
    const store = jsonStore<{ n: number }>({ filePath: path.join(dir, "d.json"), schema: z.object({ n: z.number() }) });
    const unhandled: unknown[] = [];
    const handler = (e: unknown): void => {
      unhandled.push(e);
    };
    process.on("unhandledRejection", handler);
    try {
      await expect(store.set("k", { n: "bad" } as unknown as { n: number })).rejects.toMatchObject({ code: "VALIDATION" });
      // 关键：失败后不做任何后续操作，等待微任务/宏任务排空
      await new Promise((r) => setTimeout(r, 120));
      await new Promise((r) => setImmediate(r));
      expect(unhandled).toEqual([]);
      // 失败后 store 仍可用（链未死锁）
      await store.set("ok", { n: 1 });
      expect(await store.get("ok")).toEqual({ n: 1 });
    } finally {
      process.off("unhandledRejection", handler);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("并发失败+成功交错：链不污染后续结果", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "store-chain2-"));
    const store = jsonStore<{ n: number }>({ filePath: path.join(dir, "d.json"), schema: z.object({ n: z.number() }) });
    const results = await Promise.allSettled([
      store.set("a", { n: "bad" } as unknown as { n: number }),
      store.set("b", { n: 2 }),
      store.set("c", { n: 3 }),
      store.set("d", { n: "bad2" } as unknown as { n: number }),
      store.set("e", { n: 5 }),
    ]);
    expect(results[0]?.status).toBe("rejected");
    expect(results[1]?.status).toBe("fulfilled");
    expect(results[2]?.status).toBe("fulfilled");
    expect(results[3]?.status).toBe("rejected");
    expect(results[4]?.status).toBe("fulfilled");
    expect(await store.get("b")).toEqual({ n: 2 });
    expect(await store.get("e")).toEqual({ n: 5 });
    expect(await store.keys()).toEqual(expect.arrayContaining(["b", "c", "e"]));
    await rm(dir, { recursive: true, force: true });
  });
});
