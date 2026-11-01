import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { jsonStore } from "@/core/store";
import { IdentityRepository, IdentitySchema } from "@/product/identities";

describe("本地身份角色", () => {
  it("token 只返回一次，认证、角色更新和撤销有效", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "identities-"));
    try {
      const repo = new IdentityRepository(jsonStore({ filePath: path.join(dir, "identities.json"), schema: IdentitySchema }));
      const created = await repo.create({ id: "i1", workspaceId: "w", displayName: "成员", role: "editor" });
      expect((await repo.authenticate("w", created.token))?.role).toBe("editor");
      await repo.update("i1", { role: "viewer" });
      expect((await repo.authenticate("w", created.token))?.role).toBe("viewer");
      await repo.revoke("i1");
      expect(await repo.authenticate("w", created.token)).toBeUndefined();
      expect(JSON.stringify(await repo.list("w"))).not.toContain(created.token);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

