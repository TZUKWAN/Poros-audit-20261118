import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { jsonStore } from "@/core/store";
import { ScenarioLibrary, ScenarioRecordSchema, type ScenarioRecord } from "@/scenario/library";
import { intentSignature } from "@/distill/distill";

function baseRecord(id: string, goal: string, keywords: string[]): ScenarioRecord {
  return ScenarioRecordSchema.parse({
    id, name: goal.slice(0, 12), goal, pinnedVersion: 1,
    distilled: { slotDefs: [], branches: [], acceptanceTemplates: [], signature: { keywords, embedding: [], embedVia: "bag-of-words" }, buildId: "b1", pinnedVersion: 1 },
    capabilityIds: [], source: "test", approvals: [],
    stats: { uses: 0, successes: 0, lastUsedAt: null, driftCount: 0 },
    degraded: false, status: "active", tags: [], versionHistory: [], createdAt: "2026-11-05T00:00:00.000Z",
  });
}

describe("match 原文兜底（同需求字面必命中）", () => {
  it("签名漂移（空嵌入+异关键词）但原文相同 → hit", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "match-hint-"));
    try {
      const library = new ScenarioLibrary({ store: jsonStore({ filePath: path.join(dir, "s.json"), schema: ScenarioRecordSchema }) });
      const REQ = "把文本「会议于周三 10 点开始，张三负责记录，李四负责投影」整理成会议纪要简报";
      // 场景蒸馏签名与运行期解析完全不同（模拟 LLM 漂移）
      await library.save(baseRecord("sc-x", REQ, ["完全无关的关键词"]));
      // 空嵌入使 cosine=0；关键词不同使 jaccard=0 → 旧打分 miss
      const driftSig = { keywords: ["别的词"], embedding: [], embedVia: "bag-of-words" } as never;
      const miss = await library.match(driftSig);
      expect(miss.tier).toBe("miss");
      // 原文兜底 → hit
      const hit = await library.match(driftSig, {}, REQ);
      expect(hit.tier).toBe("hit");
      expect(hit.scenario?.id).toBe("sc-x");
      // 不同需求 → 不误命中
      const other = await library.match(driftSig, {}, "帮我写一份股票分析报告并给出评级");
      expect(other.tier).toBe("miss");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("真实签名路径不回退（intentSignature 同需求仍 hit）", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "match-hint2-"));
    try {
      const library = new ScenarioLibrary({ store: jsonStore({ filePath: path.join(dir, "s.json"), schema: ScenarioRecordSchema }) });
      const REQ = "每周整理销售数据并生成周报";
      const sig = await intentSignature(REQ, ["销售", "周报"]);
      await library.save(baseRecord("sc-y", REQ, ["销售", "周报"]));
      const hit = await library.match(sig, {}, REQ);
      expect(hit.tier).toBe("hit");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
