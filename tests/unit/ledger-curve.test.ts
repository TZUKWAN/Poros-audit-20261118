import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { EventEmitter } from "node:events";
import { jsonStore } from "@/core/store";
import { ScenarioLibrary, ScenarioRecordSchema, type ScenarioRecord } from "@/scenario/library";
import { PanelServer, defaultPageHtml } from "@/panel/server";
import { PanelSettingsStore, PanelSettingsSchema } from "@/panel/settings";
import type { Orchestrator } from "@/orchestrator/state-machine";
import type { ScenarioLedger } from "@/scenario/ledger";
import { proposeConstraint } from "@/scenario/ledger";
import { confidence } from "@/scenario/confidence";

function baseRecord(id: string, stats: Partial<ScenarioRecord["stats"]> = {}): ScenarioRecord {
  return ScenarioRecordSchema.parse({
    id,
    name: "周报",
    goal: "每周整理销售数据并生成周报",
    pinnedVersion: 1,
    distilled: { slotDefs: [], branches: [], acceptanceTemplates: [], signature: { keywords: ["报告"], embedding: [1, 0], embedVia: "bag-of-words" }, buildId: "b1", pinnedVersion: 1 },
    capabilityIds: [],
    source: "test",
    approvals: [],
    stats: { uses: 0, successes: 0, lastUsedAt: null, driftCount: 0, ...stats },
    degraded: false,
    status: "active",
    tags: [],
    versionHistory: [],
    createdAt: "2026-11-05T00:00:00.000Z",
  });
}

describe("P7 统一降级：账本置信度为负也判降级（旧成功率规则保留为底线）", () => {
  it("成功率 50%（不触发旧规则）但近期打回压分 → degraded", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ledger-curve-"));
    try {
      const library = new ScenarioLibrary({ store: jsonStore({ filePath: path.join(dir, "s.json"), schema: ScenarioRecordSchema }) });
      const record = baseRecord("sc-1", { uses: 1, successes: 1 });
      record.ledger = {
        version: 1,
        constraints: [],
        attribution: {},
        runStats: { runs: 2, accepted: 1, rejected: 1, corrected: 0, consecutiveClean: 0 },
        gateStats: {},
        inputPatterns: [{ digest: "d", at: new Date().toISOString(), outcome: "rejected" }],
        interventions: [],
      };
      await library.save(record);
      expect(confidence(record.ledger)).toBeLessThan(0);
      const result = await library.execute("sc-1", {}, async () => ({ ok: true }));
      expect(result.scenario.degraded).toBe(true);
      // 对照：账本健康 → 不降级
      await library.updateLedger("sc-1", (ledger) => ({
        ...ledger,
        runStats: { runs: 4, accepted: 4, rejected: 1, corrected: 0, consecutiveClean: 3 },
        inputPatterns: [],
      }));
      const healthy = await library.execute("sc-1", {}, async () => ({ ok: true }));
      expect(healthy.scenario.degraded).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("PR-curve：签约/退役 action + 快照账本摘要 + 抽查态闸门", () => {
  let dir: string;
  let library: ScenarioLibrary;
  let server: PanelServer;
  let ws: WebSocket;
  let port: number;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ledger-curve-srv-"));
    library = new ScenarioLibrary({ store: jsonStore({ filePath: path.join(dir, "scenarios.json"), schema: ScenarioRecordSchema }) });
    const record = baseRecord("sc-1");
    record.ledger = { version: 1, constraints: [], attribution: {}, runStats: { runs: 3, accepted: 3, rejected: 0, corrected: 0, consecutiveClean: 3 }, gateStats: {}, inputPatterns: [{ digest: "d1", at: new Date().toISOString(), outcome: "accepted" }], interventions: [{ runId: "r1", at: new Date().toISOString(), gatesAnswered: 1, questionsAnswered: 0, correctionsGiven: 0, total: 1 }] };
    await library.save(record);
    // 一条待签约提案
    await library.updateLedger("sc-1", (ledger) => proposeConstraint(ledger, { clause: "行动项必须带负责人和截止日", scope: "output", origin: { type: "feedback", text: "行动项必须带负责人和截止日", at: new Date().toISOString(), runId: "r2" } })?.ledger ?? ledger);
    const settingsStore = new PanelSettingsStore(jsonStore({ filePath: path.join(dir, "settings.json"), schema: PanelSettingsSchema }));
    server = new PanelServer({ library, settings: settingsStore, pageHtml: defaultPageHtml() });
    port = await server.start(0);
    ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve) => ws.once("open", resolve));
  });

  afterEach(async () => {
    ws?.close();
    await server.stop().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  });

  async function sendAndCollectSnapshots(payload: unknown): Promise<{ ok: boolean; error?: string; snapshot?: Record<string, unknown> }> {
    return await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        ws.off("message", handler);
        resolve({ ok: false, error: "timeout" });
      }, 3000);
      const handler = (raw: unknown): void => {
        try {
          const data = JSON.parse(String(raw)) as { kind?: string; ok?: boolean; error?: string; requestId?: string; snapshot?: Record<string, unknown> };
          if (data.kind === "snapshot" && data.snapshot) {
            clearTimeout(timeout);
            ws.off("message", handler);
            resolve({ ok: true, snapshot: data.snapshot });
            return;
          }
          if (data.kind === "action-result" && "ok" in data) {
            if (data.ok === false) {
              clearTimeout(timeout);
              ws.off("message", handler);
              resolve({ ok: false, error: data.error });
            }
            // ok=true → 继续等 snapshot
          }
        } catch {
          /* ignore */
        }
      };
      ws.on("message", handler);
      ws.send(JSON.stringify(payload));
    });
  }

  it("confirm-constraints 签约 → confirmedAt 落账；retire-constraint 退役 → active=false（不删）", async () => {
    let ledger = (await library.get("sc-1"))?.ledger as ScenarioLedger;
    const pending = ledger.constraints.find((c) => c.confirmedAt === null);
    expect(pending).toBeTruthy();
    const confirmed = await sendAndCollectSnapshots({ type: "confirm-constraints", scenarioId: "sc-1", ids: [pending!.id] });
    expect(confirmed.ok).toBe(true);
    ledger = (await library.get("sc-1"))?.ledger as ScenarioLedger;
    expect(ledger.constraints.find((c) => c.id === pending!.id)?.confirmedAt).toBeTruthy();
    const retired = await sendAndCollectSnapshots({ type: "retire-constraint", scenarioId: "sc-1", constraintId: pending!.id });
    expect(retired.ok).toBe(true);
    ledger = (await library.get("sc-1"))?.ledger as ScenarioLedger;
    const retiredConstraint = ledger.constraints.find((c) => c.id === pending!.id);
    expect(retiredConstraint?.active).toBe(false);
    expect(retiredConstraint?.clause).toBeTruthy(); // 不删，可溯
  });

  it("快照携带账本摘要（tier/置信度/条款/介入曲线）", async () => {
    const result = await sendAndCollectSnapshots({ type: "confirm-constraints", scenarioId: "sc-1", ids: ["nonexistent"] });
    const summary = ((result.snapshot as { scenarios?: Array<Record<string, unknown>> })?.scenarios ?? []).find((s) => s.id === "sc-1");
    expect(summary).toBeTruthy();
    const ledger = summary!.ledger as { tier: string; confidence: number; activeCount: number; pendingCount: number; curve: Array<{ total: number }>; constraints: unknown[] };
    expect(ledger.tier).toBe("replay");
    expect(ledger.confidence).toBe(3);
    expect(ledger.pendingCount).toBe(1);
    expect(ledger.curve).toHaveLength(1);
    expect(ledger.constraints.length).toBeGreaterThanOrEqual(1);
  });

  it("抽查态闸门（spot/full）：gateStats 足够 → 自动通过；legacy → 照常出卡片", async () => {
    // 切 full
    const modeSet = await sendAndCollectSnapshots({ type: "update-settings", settings: { routingMode: "full" } });
    expect(modeSet.ok).toBe(true);
    const decided: Array<{ gate: number; action: string }> = [];
    const fakeOrch = new EventEmitter() as unknown as Orchestrator;
    (fakeOrch as unknown as { ctx: unknown }).ctx = { selections: [], acceptance: [], dag: null, approvals: [] };
    (fakeOrch as unknown as { decide: (d: unknown) => Promise<void> }).decide = async (d) => {
      decided.push(d as { gate: number; action: string });
    };
    server.attachOrchestrator(fakeOrch, { interactive: true });
    server.setBuildLedgerScenarioId("sc-1");
    await library.updateLedger("sc-1", (ledger) => ({ ...ledger, gateStats: { "3": { passes: 3, rejects: 0, edits: 0, lastEventAt: new Date().toISOString() } } }));
    const ctx = { selections: [], acceptance: [], dag: null, approvals: [] };
    (fakeOrch as unknown as EventEmitter).emit("gate:pending", { request: { gate: 3, payload: [], context: ctx } });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(decided).toEqual([{ gate: 3, action: "approve" }]);
    // 无统计的闸门 → 出人工卡片
    (fakeOrch as unknown as EventEmitter).emit("gate:pending", { request: { gate: 2, payload: { nodes: [] }, context: ctx } });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(decided).toHaveLength(1);
    const history = (server as unknown as { chatHistory: Array<Record<string, unknown>> }).chatHistory;
    expect(history.some((m) => m.role === "gate-card" && m.gate === 2)).toBe(true);
  });

  it("legacy 模式抽查态闸门不生效（照常出卡片）", async () => {
    const decided: Array<{ gate: number; action: string }> = [];
    const fakeOrch = new EventEmitter() as unknown as Orchestrator;
    (fakeOrch as unknown as { ctx: unknown }).ctx = { selections: [], acceptance: [], dag: null, approvals: [] };
    (fakeOrch as unknown as { decide: (d: unknown) => Promise<void> }).decide = async (d) => {
      decided.push(d as { gate: number; action: string });
    };
    server.attachOrchestrator(fakeOrch, { interactive: true });
    server.setBuildLedgerScenarioId("sc-1");
    await library.updateLedger("sc-1", (ledger) => ({ ...ledger, gateStats: { "3": { passes: 5, rejects: 0, edits: 0, lastEventAt: new Date().toISOString() } } }));
    const ctx = { selections: [], acceptance: [], dag: null, approvals: [] };
    (fakeOrch as unknown as EventEmitter).emit("gate:pending", { request: { gate: 3, payload: [], context: ctx } });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(decided).toEqual([]);
    const history = (server as unknown as { chatHistory: Array<Record<string, unknown>> }).chatHistory;
    expect(history.some((m) => m.role === "gate-card" && m.gate === 3)).toBe(true);
  });
});

