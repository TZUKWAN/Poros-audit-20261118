import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ScenarioError } from "@/core/errors";
import { jsonStore, scenarioDataRoot, type Store } from "@/core/store";

interface Item {
  name: string;
  n: number;
}
const ItemSchema = z.object({ name: z.string(), n: z.number() });

let dir: string;
let store: Store<Item>;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pistore-"));
  store = jsonStore<Item>({ filePath: path.join(dir, "data.json"), schema: ItemSchema });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("Store 增删查改", () => {
  it("set → get 往返", async () => {
    await store.set("a", { name: "x", n: 1 });
    expect(await store.get("a")).toEqual({ name: "x", n: 1 });
  });

  it("get 缺失键返回 undefined", async () => {
    expect(await store.get("nope")).toBeUndefined();
  });

  it("has / keys / entries", async () => {
    await store.set("a", { name: "x", n: 1 });
    await store.set("b", { name: "y", n: 2 });
    expect(await store.has("a")).toBe(true);
    expect((await store.keys()).sort()).toEqual(["a", "b"]);
    expect((await store.entries()).length).toBe(2);
  });

  it("delete 返回是否存在", async () => {
    await store.set("a", { name: "x", n: 1 });
    expect(await store.delete("a")).toBe(true);
    expect(await store.delete("a")).toBe(false);
  });

  it("update 覆盖旧值", async () => {
    await store.set("a", { name: "x", n: 1 });
    await store.set("a", { name: "x2", n: 2 });
    expect(await store.get("a")).toEqual({ name: "x2", n: 2 });
  });

  it("clear 清空", async () => {
    await store.set("a", { name: "x", n: 1 });
    await store.clear();
    expect(await store.keys()).toEqual([]);
  });
});

describe("持久化与恢复", () => {
  it("目录自动创建：深层路径直接可写", async () => {
    const deep = path.join(dir, "l1", "l2", "l3", "data.json");
    const s = jsonStore<Item>({ filePath: deep, schema: ItemSchema });
    await s.set("k", { name: "deep", n: 9 });
    expect(await s.get("k")).toEqual({ name: "deep", n: 9 });
    expect(await readFile(deep, "utf8")).toContain("deep");
  });

  it("跨实例读取（重启模拟）", async () => {
    await store.set("a", { name: "persist", n: 3 });
    const store2 = jsonStore<Item>({ filePath: path.join(dir, "data.json"), schema: ItemSchema });
    expect(await store2.get("a")).toEqual({ name: "persist", n: 3 });
  });

  it("损坏 JSON 从 .bak 恢复", async () => {
    await store.set("good", { name: "good", n: 1 });
    // 模拟写入过程中崩溃：主文件半截
    await writeFile(path.join(dir, "data.json"), '{"good":{"name":"goo', "utf8");
    const store2 = jsonStore<Item>({ filePath: path.join(dir, "data.json"), schema: ItemSchema });
    expect(await store2.get("good")).toEqual({ name: "good", n: 1 });
  });

  it("无 .bak 且损坏：视为空表不抛错，写回即修复", async () => {
    await writeFile(path.join(dir, "data.json"), "not-json{{", "utf8");
    const s = jsonStore<Item>({ filePath: path.join(dir, "data.json"), schema: ItemSchema });
    expect(await s.keys()).toEqual([]);
    await s.set("fresh", { name: "f", n: 0 });
    expect(await s.get("fresh")).toEqual({ name: "f", n: 0 });
  });

  it("schema 不符的存量值被剔除（坏值防御）", async () => {
    await writeFile(
      path.join(dir, "data.json"),
      JSON.stringify({ good: { name: "ok", n: 1 }, bad: { name: 123, n: "x" } }),
      "utf8",
    );
    const s = jsonStore<Item>({ filePath: path.join(dir, "data.json"), schema: ItemSchema });
    expect(await s.has("good")).toBe(true);
    expect(await s.has("bad")).toBe(false);
  });

  it("set 违反 schema 抛 ScenarioError.VALIDATION 且不落盘", async () => {
    await store.set("a", { name: "x", n: 1 });
    await expect(store.set("bad", { name: 42, n: 1 } as unknown as Item)).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(await store.has("bad")).toBe(false);
    expect(await store.get("a")).toEqual({ name: "x", n: 1 });
  });
});

describe("并发写", () => {
  it("并发 set 20 键互不丢失、文件不损坏", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.set(`k${i}`, { name: `n${i}`, n: i })),
    );
    const s2 = jsonStore<Item>({ filePath: path.join(dir, "data.json"), schema: ItemSchema });
    expect((await s2.keys()).length).toBe(20);
    for (let i = 0; i < 20; i++) {
      expect(await s2.get(`k${i}`)).toEqual({ name: `n${i}`, n: i });
    }
  });

  it("并发写同一键：串行化后保留最后一次写入", async () => {
    await Promise.all([
      store.set("same", { name: "first", n: 1 }),
      store.set("same", { name: "second", n: 2 }),
      store.set("same", { name: "third", n: 3 }),
    ]);
    const v = await store.get("same");
    expect(v?.n).toBe(3);
  });
});

describe("scenarioDataRoot", () => {
  it("位于 ~/.pi/scenario", () => {
    const root = scenarioDataRoot("C:\\Users\\tester");
    expect(root).toBe("C:\\Users\\tester\\.pi\\scenario");
  });

  it("无 homedir 抛 IO 错误", () => {
    expect(() => scenarioDataRoot("")).toThrowError(ScenarioError);
  });
});
