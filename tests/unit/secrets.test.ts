import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { jsonStore } from "@/core/store";
import { SecretRecordSchema, SecretRepository } from "@/product/secrets";

describe("连接器 Secret 凭据库", () => {
  it("加密落盘且公开读取只通过 owner 查询", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "secrets-"));
    try {
      const repo = new SecretRepository(jsonStore({ filePath: path.join(dir, "secrets.json"), schema: SecretRecordSchema }));
      await repo.set("w1", "connector", "c1", "top-secret");
      expect(await repo.get("connector", "c1")).toBe("top-secret");
      expect(await repo.get("connector", "c2")).toBeUndefined();
      expect(await readFile(path.join(dir, "secrets.json"), "utf8")).not.toContain("top-secret");
      await repo.delete("connector", "c1");
      expect(await repo.get("connector", "c1")).toBeUndefined();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

