import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { jsonStore } from "@/core/store";
import { PanelHistory, PanelSessionSchema } from "@/panel/history";

describe("面板历史标题迁移", () => {
  it("旧的新对话标题会从首条用户需求推导，命令或无用户消息不猜测", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "panel-history-"));
    try {
      const history = new PanelHistory(jsonStore({ filePath: path.join(dir, "sessions.json"), schema: PanelSessionSchema }));
      await history.create("work", "新对话").then(async (session) => {
        session.messages.push({ role: "user", content: "请整理本周销售数据并生成简报", timestamp: Date.now() });
        await history.save(session);
      });
      await history.create("work", "新对话");
      const listed = await history.list();
      expect(listed.some((item) => item.title === "请整理本周销售数据并生成简报")).toBe(true);
      const migrated = listed.find((item) => item.title === "请整理本周销售数据并生成简报");
      expect(migrated && (await history.get(migrated.id))?.title).toBe("请整理本周销售数据并生成简报");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
