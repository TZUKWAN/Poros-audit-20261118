import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { jsonStore } from "@/core/store";
import { ScenarioLibrary, ScenarioRecordSchema, scenarioNameFromRequirement, scenarioMatchesScope } from "@/scenario/library";

describe("场景库治理", () => {
  it("把需求整理成正常标题并为重名场景加可读后缀", () => {
    expect(scenarioNameFromRequirement("请帮我 每周整理销售数据并生成周报。", [])).toBe("每周整理销售数据并生成周报");
    expect(scenarioNameFromRequirement("请帮我 每周整理销售数据并生成周报。", ["每周整理销售数据并生成周报"])).toBe("每周整理销售数据并生成周报（2）");
    expect(scenarioNameFromRequirement("   ", [])).toBe("未命名场景");
  });

  it("支持归档、恢复、软删除并避免归档场景命中", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "scenario-governance-"));
    try {
      const library = new ScenarioLibrary({ store: jsonStore({ filePath: path.join(dir, "scenarios.json"), schema: ScenarioRecordSchema }) });
      await library.save({ id: "s1", name: "报告", goal: "报告", pinnedVersion: 1, distilled: { slotDefs: [], branches: [], acceptanceTemplates: [], signature: { keywords: ["报告"], embedding: [1, 0], embedVia: "bag-of-words" }, buildId: "b1", pinnedVersion: 1 }, capabilityIds: [], source: "test", approvals: [], stats: { uses: 0, successes: 0, lastUsedAt: null, driftCount: 0 }, degraded: false, status: "active", tags: [], versionHistory: [], createdAt: "2026-10-03T00:00:00.000Z" });
      expect((await library.get("s1"))?.status).toBe("active");
      await library.archive("s1");
      expect((await library.match({ keywords: ["报告"], embedding: [1, 0], embedVia: "bag-of-words" })).tier).toBe("miss");
      await library.restore("s1");
      expect((await library.match({ keywords: ["报告"], embedding: [1, 0], embedVia: "bag-of-words" })).tier).toBe("hit");
      await library.delete("s1");
      expect((await library.get("s1"))?.status).toBe("deleted");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("按工作区和项目隔离场景匹配，同时保留旧的全局场景", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "scenario-scope-"));
    try {
      const library = new ScenarioLibrary({ store: jsonStore({ filePath: path.join(dir, "scenarios.json"), schema: ScenarioRecordSchema }) });
      const base = { goal: "整理报告", pinnedVersion: 1, distilled: { slotDefs: [], branches: [], acceptanceTemplates: [], signature: { keywords: ["报告"], embedding: [1, 0], embedVia: "bag-of-words" }, buildId: "scope-build", pinnedVersion: 1 }, capabilityIds: [], source: "test", approvals: [], stats: { uses: 0, successes: 0, lastUsedAt: null, driftCount: 0 }, degraded: false, status: "active" as const, tags: [], versionHistory: [], createdAt: "2026-10-03T00:00:00.000Z" };
      await library.save({ ...base, id: "global", name: "全局场景" });
      await library.save({ ...base, id: "project-a", name: "项目 A 场景", workspaceId: "ws-1", projectId: "project-a" });
      await library.save({ ...base, id: "project-b", name: "项目 B 场景", workspaceId: "ws-1", projectId: "project-b" });
      expect((await library.match({ keywords: ["报告"], embedding: [1, 0], embedVia: "bag-of-words" }, { workspaceId: "ws-1", projectId: "project-a" })).scenario?.id).toBe("project-a");
      expect((await library.match({ keywords: ["报告"], embedding: [1, 0], embedVia: "bag-of-words" }, { workspaceId: "ws-1", projectId: "project-b" })).scenario?.id).toBe("project-b");
      expect(scenarioMatchesScope({ workspaceId: "ws-1", projectId: "project-a" }, { workspaceId: "ws-1", projectId: "project-b" })).toBe(false);
      expect(scenarioMatchesScope({ workspaceId: null, projectId: null }, { workspaceId: "ws-1", projectId: "project-b" })).toBe(true);
      const legacy = ScenarioRecordSchema.parse({ ...base, id: "legacy", name: "旧场景" });
      expect(legacy.workspaceId).toBeNull();
      expect(legacy.projectId).toBeNull();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
