import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { routeDomain, profileOf, domainProfiles } from "@/domains/profile.js";
import { templateDag } from "@/orchestrator/handlers.js";
import { migrateDomainLibraries } from "@/domains/migrate.js";
import { ScenarioLibrary, ScenarioRecordSchema, type ScenarioRecord } from "@/scenario/library.js";
import { jsonStore } from "@/core/store.js";
import type { Intent } from "@/orchestrator/context.js";

function intent(goal: string): Intent {
  return { goal, domain: "general", slots: [], keywords: goal.split(/\s+/).slice(0, 4), via: "template" };
}

describe("SceneFlow 领域路由", () => {
  it("竞赛信号 → ares", () => {
    expect(routeDomain("帮我准备数学建模竞赛，国赛备赛计划")).toBe("ares");
    expect(routeDomain("蓝桥杯算法训练与题单")).toBe("ares");
    expect(routeDomain("写一份商业计划书并做路演答辩准备")).toBe("ares");
  });

  it("研究信号 → metis", () => {
    expect(routeDomain("做一项关于短视频信息茧房的问卷研究")).toBe("metis");
    expect(routeDomain("整理文献综述并设计实证研究方案")).toBe("metis");
  });

  it("无信号 → core", () => {
    expect(routeDomain("整理项目文件并生成一份周报")).toBe("core");
    expect(routeDomain("把 /data 目录的数据汇总成表")).toBe("core");
  });

  it("templateDag 经 profile 落域：ares 七节点材料链 / metis 七阶段脊柱 / core 3 节点", () => {
    const aresDag = templateDag(intent("数学建模竞赛论文与求解代码"));
    expect(aresDag.nodes.length).toBeGreaterThanOrEqual(5);
    expect(aresDag.nodes.some((n) => n.title.includes("赛题") || n.title.includes("赛事") || n.title.includes("训练"))).toBe(true);

    const metisDag = templateDag(intent("短视频信息茧房的问卷研究与论文"));
    expect(metisDag.nodes.map((n) => n.id)).toEqual(["n1", "n2", "n3", "n4", "n5", "n6", "n7"]);
    expect(metisDag.nodes.some((n) => n.title.includes("文献"))).toBe(true);

    const coreDag = templateDag(intent("整理数据并生成报表"));
    expect(coreDag.nodes).toHaveLength(3);
  });

  it("领域 profile 源可加载且 id 带前缀", async () => {
    for (const profile of domainProfiles()) {
      const adapters = await profile.adapters();
      expect(adapters.length).toBeGreaterThan(0);
      for (const adapter of adapters) {
        expect(adapter.source.id.startsWith(profile.id)).toBe(true);
      }
    }
    expect(profileOf("ares")?.name).toContain("竞赛");
    expect(profileOf("metis")?.name).toContain("研究");
  });
});

describe("SceneFlow 领域场景库迁移", () => {
  it("迁入打标、id 冲突重排、二次运行幂等", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sceneflow-migrate-"));
    try {
      const legacyDir = path.join(dir, "legacy");
      await mkdir(legacyDir, { recursive: true });
      const legacyRecord = {
        id: "sc-panel-1793609653244",
        name: "数模竞赛线",
        goal: "数学建模竞赛备赛",
        pinnedVersion: 1,
        distilled: {
          slotDefs: [],
          branches: [],
          acceptanceTemplates: [],
          signature: { keywords: ["数模"], embedding: [], embedVia: "bow" },
          buildId: "panel-1793609653244",
          pinnedVersion: 1,
        },
        capabilityIds: ["ares-competitions:42"],
        stats: { uses: 1, successes: 1, lastUsedAt: null, driftCount: 0 },
        approvals: [],
        createdAt: new Date().toISOString(),
      };
      const legacyFile = path.join(legacyDir, "scenarios.json");
      await writeFile(legacyFile, JSON.stringify({ "sc-panel-1793609653244": legacyRecord }), "utf8");

      const store = jsonStore<ScenarioRecord>({ filePath: path.join(dir, "scenarios.json"), schema: ScenarioRecordSchema });
      const library = new ScenarioLibrary({ store });
      // 统一库里预置一条同 id、不同内容的记录 → 触发重排（经 schema parse 补齐默认字段）
      await library.save(
        ScenarioRecordSchema.parse({
          id: "sc-panel-1793609653244",
          name: "core 同名碰撞记录",
          goal: "另一个普通需求",
          pinnedVersion: 1,
          distilled: { slotDefs: [], branches: [], acceptanceTemplates: [], signature: { keywords: [], embedding: [], embedVia: "bow" }, buildId: "panel-1793609653244", pinnedVersion: 1 },
          capabilityIds: [],
          stats: { uses: 0, successes: 0, lastUsedAt: null, driftCount: 0 },
          createdAt: new Date().toISOString(),
        }),
      );

      const first = await migrateDomainLibraries(library, [{ domain: "ares", file: legacyFile, domainPrefix: "ares" }]);
      expect(first.imported).toBe(1);
      expect(first.rekeyed).toBe(1);
      const migrated = await library.get("ares-sc-panel-1793609653244");
      expect(migrated?.domain).toBe("ares");
      expect(migrated?.capabilityIds).toEqual(["ares-competitions:42"]);

      const second = await migrateDomainLibraries(library, [{ domain: "ares", file: legacyFile, domainPrefix: "ares" }]);
      expect(second.imported).toBe(0);
      expect(second.skipped).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
