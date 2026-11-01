import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { jsonStore } from "@/core/store";
import { CommentRepository, CommentSchema } from "@/product/comments";

describe("协作评论", () => {
  it("按资源创建和解决评论", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "comments-"));
    try {
      const repo = new CommentRepository(jsonStore({ filePath: path.join(dir, "comments.json"), schema: CommentSchema }));
      const comment = await repo.create({ id: "c1", workspaceId: "w", resourceType: "run", resourceId: "r1", author: "local-user", body: "检查结果", resolved: false });
      expect((await repo.list("w", "run", "r1"))).toHaveLength(1);
      expect((await repo.resolve(comment.id, true)).resolved).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

