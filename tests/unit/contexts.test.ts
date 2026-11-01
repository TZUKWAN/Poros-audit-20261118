import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { jsonStore } from "@/core/store";
import { DesktopContextRepository, DesktopContextSchema } from "@/product/contexts";

describe("桌面上下文仓库", () => {
  it("保存、启停、按项目隔离和删除本地上下文", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "contexts-"));
    try {
      const repo = new DesktopContextRepository(jsonStore({ filePath: path.join(dir, "contexts.json"), schema: DesktopContextSchema }));
      const context = await repo.create({ id: "ctx1", workspaceId: "w", projectId: "p", kind: "clipboard", origin: "clipboard", label: "选中文本", content: "结论", enabled: true });
      expect((await repo.list("w", "p"))[0]?.content).toBe("结论");
      await repo.update(context.id, { enabled: false });
      expect((await repo.get(context.id))?.enabled).toBe(false);
      expect(await repo.delete(context.id)).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

