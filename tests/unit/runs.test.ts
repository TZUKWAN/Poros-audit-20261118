import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { jsonStore } from "@/core/store";
import { RunProductSchema } from "@/product/contracts";
import { RunRepository } from "@/product/runs";

describe("运行记录仓库", () => {
  it("创建、更新和列表运行记录", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "runs-"));
    try {
      const repo = new RunRepository(jsonStore({ filePath: path.join(dir, "runs.json"), schema: RunProductSchema }));
      await repo.create({ id: "r1", workspaceId: "w", projectId: null, sessionId: null, mode: "work", scenarioId: null, providerId: null, model: "m", status: "running", requirement: "做事", startedAt: "2026-10-03T00:00:00.000Z", finishedAt: null, error: null });
      await repo.update("r1", { status: "succeeded", finishedAt: "2026-10-03T00:01:00.000Z", details: { trace: [{ nodeId: "n1", status: "success" }] } });
      expect((await repo.list())[0]).toMatchObject({ id: "r1", status: "succeeded" });
      expect((await repo.get("r1"))?.details).toMatchObject({ trace: [{ nodeId: "n1", status: "success" }] });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("工作区列表不会泄漏其它工作区，恢复列表不受默认 50 条上限影响", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "runs-isolation-"));
    try {
      const repo = new RunRepository(jsonStore({ filePath: path.join(dir, "runs.json"), schema: RunProductSchema }));
      const make = async (id: string, workspaceId: string, index: number) => repo.create({
        id, workspaceId, projectId: null, sessionId: `session-${id}`, mode: "work", scenarioId: null, providerId: null, model: "m", status: "running", requirement: `需求 ${id}`, startedAt: new Date(Date.UTC(2026, 9, 3, 0, index, 0)).toISOString(), finishedAt: null, error: null,
      });
      for (let index = 0; index < 105; index += 1) await make(`own-${index}`, "workspace-own", index);
      await make("foreign", "workspace-foreign", 200);
      expect((await repo.listForWorkspace("workspace-own")).every((run) => run.id.startsWith("own-"))).toBe(true);
      expect((await repo.listForWorkspace("workspace-own")).length).toBe(50);
      const all = await repo.listAllForWorkspace("workspace-own");
      expect(all).toHaveLength(105);
      expect(all.every((run) => run.workspaceId === "workspace-own")).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
