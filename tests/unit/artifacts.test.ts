import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { jsonStore } from "@/core/store";
import { ArtifactSchema } from "@/product/contracts";
import { ArtifactRepository } from "@/product/artifacts";

describe("Artifact 版本仓库", () => {
  it("创建新版本并保留同一产物身份", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "artifacts-"));
    try {
      const repo = new ArtifactRepository(jsonStore({ filePath: path.join(dir, "artifacts.json"), schema: ArtifactSchema }));
      await repo.create({ id: "a1", workspaceId: "w", projectId: null, sessionId: null, runId: null, name: "结果.md", mediaType: "text/markdown", path: path.join(dir, "result.md"), version: 1, status: "ready" });
      expect((await repo.createVersion("a1", { content: "old", checksum: "a" })).version).toBe(2);
      expect((await repo.get("a1"))?.versions[0]?.content).toBe("old");
      expect((await repo.createVersion("a1", { content: "new", checksum: "b" })).version).toBe(3);
      expect((await repo.get("a1"))?.status).toBe("ready");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
