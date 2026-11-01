import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { jsonStore } from "@/core/store";
import { MemoryItemSchema } from "@/product/contracts";
import { MemoryRepository } from "@/product/memory";

describe("Memory 项目可见性", () => {
  it("只返回当前项目、会话和场景的记录，同时保留工作区全局记录", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "memory-visible-"));
    try {
      const repo = new MemoryRepository(jsonStore({ filePath: path.join(dir, "memory.json"), schema: MemoryItemSchema }));
      const base = { workspaceId: "w", content: "内容", path: null, sourceType: "user" as const, sourceId: null, enabled: true };
      await repo.create({ ...base, id: "global", projectId: null, sessionId: null, scenarioId: null, scope: "global", name: "全局" });
      await repo.create({ ...base, id: "project-a", projectId: "a", sessionId: null, scenarioId: null, scope: "project", name: "项目 A" });
      await repo.create({ ...base, id: "project-b", projectId: "b", sessionId: null, scenarioId: null, scope: "project", name: "项目 B" });
      await repo.create({ ...base, id: "session-a", projectId: null, sessionId: "sa", scenarioId: null, scope: "session", name: "会话 A" });
      await repo.create({ ...base, id: "session-other", projectId: null, sessionId: "other", scenarioId: null, scope: "session", name: "其它会话" });
      await repo.create({ ...base, id: "scenario-a", projectId: "a", sessionId: null, scenarioId: "scene-a", scope: "scenario", name: "场景 A" });
      const visible = await repo.listVisible("w", { projectId: "a", sessionId: "sa", scenarioId: "scene-a" });
      expect(visible.map((item) => item.id).sort()).toEqual(["global", "project-a", "scenario-a", "session-a"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
