import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { jsonStore } from "@/core/store";
import { ShareLinkRepository, ShareLinkSchema } from "@/product/shares";

describe("分享令牌", () => {
  it("创建、按 token 查询并删除角色化分享", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "shares-"));
    try {
      const repo = new ShareLinkRepository(jsonStore({ filePath: path.join(dir, "shares.json"), schema: ShareLinkSchema }));
      const share = await repo.create({ id: "s1", workspaceId: "w", resourceType: "scenario", resourceId: "sc1", role: "viewer", expiresAt: null });
      expect((await repo.getByToken(share.token))?.role).toBe("viewer");
      expect(await repo.delete("s1")).toBe(true);
      expect(await repo.getByToken(share.token)).toBeUndefined();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

