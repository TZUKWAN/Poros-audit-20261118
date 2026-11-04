import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { z } from "zod";
import { jsonStore } from "@/core/store";
import { ScenarioLibrary, ScenarioRecordSchema, type ScenarioRecord } from "@/scenario/library";
import { PanelServer, defaultPageHtml } from "@/panel/server";
import type { ScenarioLedger } from "@/scenario/ledger";

/**
 * §18 矩阵 feedback/attended 行（PR-signal-run）：
 *   👎 无 reason→400 / 重复 runId→409 幂等 /
 *   沉默超时=弱 accepted / 👍→accepted / 👎+原因→rejected+提案 /
 *   定时跑成功→runs++ 但 consecutiveClean 不动
 */

function baseRecord(id: string): ScenarioRecord {
  return ScenarioRecordSchema.parse({
    id,
    name: "周报",
    goal: "每周整理销售数据并生成周报",
    pinnedVersion: 1,
    distilled: { slotDefs: [], branches: [], acceptanceTemplates: [], signature: { keywords: ["报告"], embedding: [1, 0], embedVia: "bag-of-words" }, buildId: "b1", pinnedVersion: 1 },
    capabilityIds: [],
    source: "test",
    approvals: [],
    ledger: { version: 1, constraints: [], runStats: { runs: 0, accepted: 0, rejected: 0, corrected: 0, consecutiveClean: 0 }, gateStats: {}, inputPatterns: [], interventions: [] },
    stats: { uses: 0, successes: 0, lastUsedAt: null, driftCount: 0 },
    degraded: false,
    status: "active",
    tags: [],
    versionHistory: [],
    createdAt: "2026-11-05T00:00:00.000Z",
  });
}

async function send(server: PanelServer, ws: WebSocket, payload: unknown): Promise<{ ok: boolean; error?: string }> {
  return await new Promise((resolve) => {
    const handler = (raw: unknown): void => {
      try {
        const data = JSON.parse(String(raw)) as { kind?: string; ok?: boolean; error?: string; requestId?: string };
        if (data.kind !== "action-result" || !("ok" in data)) return;
        ws.off("message", handler);
        resolve(data as { ok: boolean; error?: string });
      } catch {
        /* 非 JSON 忽略 */
      }
    };
    ws.on("message", handler);
    ws.send(JSON.stringify(payload));
    void server;
  });
}

describe("PR-signal-run 反应窗与 attended 规则", () => {
  let dir: string;
  let library: ScenarioLibrary;
  let server: PanelServer;
  let ws: WebSocket;
  let port: number;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "feedback-run-"));
    library = new ScenarioLibrary({ store: jsonStore({ filePath: path.join(dir, "scenarios.json"), schema: ScenarioRecordSchema }) });
    await library.save(baseRecord("sc-1"));
    server = new PanelServer({ library, pageHtml: defaultPageHtml(), feedbackWindowMs: 30 });
    port = await server.start(0);
    ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve) => ws.once("open", resolve));
  });

  afterEach(async () => {
    ws?.close();
    await server.stop().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  });

  it("👎 无 reason → 400；重复 runId → 409 幂等", async () => {
    // 先制造一个开着反应窗的 run：模拟有人值守成功（直接落 runLedgerMeta + 手动 settle 不可行——
    // 走完整 start-build 需要 launcher；这里通过内部 API 驱动）。
    const meta = (server as unknown as { runLedgerMeta: Map<string, unknown> }).runLedgerMeta;
    meta.set("run-fb-1", { scenarioId: "sc-1", digest: "d1", attended: true, mode: "work" });
    (server as unknown as { settleWorkRunLedgerOutcome: (id: string, status: "succeeded") => void }).settleWorkRunLedgerOutcome("run-fb-1", "succeeded");
    const noReason = await send(server, ws, { type: "feedback-run", runId: "run-fb-1", verdict: "down" });
    expect(noReason.ok).toBe(false);
    expect(noReason.error).toContain("400");
    // 反应窗仍开着（400 不关窗），补上原因
    const ok = await send(server, ws, { type: "feedback-run", runId: "run-fb-1", verdict: "down", reason: "行动项要带负责人和截止日" });
    expect(ok.ok).toBe(true);
    const duplicate = await send(server, ws, { type: "feedback-run", runId: "run-fb-1", verdict: "up" });
    expect(duplicate.ok).toBe(false);
    expect(duplicate.error).toContain("409");
    const ledger = (await library.get("sc-1"))?.ledger as ScenarioLedger;
    expect(ledger.runStats.rejected).toBe(1);
    expect(ledger.runStats.consecutiveClean).toBe(0);
    // 👎+原因 → pendingConfirm 提案
    expect(ledger.constraints).toHaveLength(1);
    expect(ledger.constraints[0]!.clause).toBe("行动项要带负责人和截止日");
    expect(ledger.constraints[0]!.origin.type).toBe("feedback");
  });

  it("👍 → accepted 显式入账并推连胜", async () => {
    const meta = (server as unknown as { runLedgerMeta: Map<string, unknown> }).runLedgerMeta;
    meta.set("run-fb-2", { scenarioId: "sc-1", digest: "d2", attended: true, mode: "work" });
    (server as unknown as { settleWorkRunLedgerOutcome: (id: string, status: "succeeded") => void }).settleWorkRunLedgerOutcome("run-fb-2", "succeeded");
    const ok = await send(server, ws, { type: "feedback-run", runId: "run-fb-2", verdict: "up" });
    expect(ok.ok).toBe(true);
    const ledger = (await library.get("sc-1"))?.ledger as ScenarioLedger;
    expect(ledger.runStats.accepted).toBe(1);
    expect(ledger.runStats.consecutiveClean).toBe(1);
    expect(ledger.interventions).toHaveLength(1);
  });

  it("沉默超时 → 弱 accepted（silent-accepted）", async () => {
    const meta = (server as unknown as { runLedgerMeta: Map<string, unknown> }).runLedgerMeta;
    meta.set("run-fb-3", { scenarioId: "sc-1", digest: "d3", attended: true, mode: "work" });
    (server as unknown as { settleWorkRunLedgerOutcome: (id: string, status: "succeeded") => void }).settleWorkRunLedgerOutcome("run-fb-3", "succeeded");
    await new Promise((resolve) => setTimeout(resolve, 120));
    const ledger = (await library.get("sc-1"))?.ledger as ScenarioLedger;
    expect(ledger.runStats.accepted).toBe(1);
    expect(ledger.runStats.consecutiveClean).toBe(1);
    expect(ledger.inputPatterns.map((e) => e.outcome)).toEqual(["accepted"]);
    expect(ledger.inputPatterns[0]!.digest).toBe("d3");
  });

  it("定时跑（无人值守）成功 → runs++ 但 accepted/consecutiveClean 不动", async () => {
    const meta = (server as unknown as { runLedgerMeta: Map<string, unknown> }).runLedgerMeta;
    meta.set("run-fb-4", { scenarioId: "sc-1", digest: "d4", attended: false, mode: "work" });
    (server as unknown as { settleWorkRunLedgerOutcome: (id: string, status: "succeeded") => void }).settleWorkRunLedgerOutcome("run-fb-4", "succeeded");
    await new Promise((resolve) => setTimeout(resolve, 60));
    const ledger = (await library.get("sc-1"))?.ledger as ScenarioLedger;
    expect(ledger.runStats.runs).toBe(1);
    expect(ledger.runStats.accepted).toBe(0);
    expect(ledger.runStats.consecutiveClean).toBe(0);
    expect(ledger.inputPatterns).toHaveLength(0);
  });

  it("运行中 guide → corrected + guide 提案（attended 与否都断连胜）", async () => {
    const meta = (server as unknown as { runLedgerMeta: Map<string, unknown> }).runLedgerMeta;
    const guidance = (server as unknown as { runGuidanceNotes: Map<string, string[]> }).runGuidanceNotes;
    meta.set("run-fb-5", { scenarioId: "sc-1", digest: "d5", attended: true, mode: "work" });
    guidance.set("run-fb-5", ["表格输出要带汇总行"]);
    (server as unknown as { settleWorkRunLedgerOutcome: (id: string, status: "succeeded") => void }).settleWorkRunLedgerOutcome("run-fb-5", "succeeded");
    await new Promise((resolve) => setTimeout(resolve, 60));
    const ledger = (await library.get("sc-1"))?.ledger as ScenarioLedger;
    expect(ledger.runStats.corrected).toBe(1);
    expect(ledger.runStats.consecutiveClean).toBe(0);
    expect(ledger.constraints.map((c) => c.clause)).toEqual(["表格输出要带汇总行"]);
    expect(ledger.constraints[0]!.origin.type).toBe("guide");
  });

  it("failed → rejected（无人值守同样失败自证）", async () => {
    const meta = (server as unknown as { runLedgerMeta: Map<string, unknown> }).runLedgerMeta;
    meta.set("run-fb-6", { scenarioId: "sc-1", digest: "d6", attended: false, mode: "work" });
    (server as unknown as { settleWorkRunLedgerOutcome: (id: string, status: "failed") => void }).settleWorkRunLedgerOutcome("run-fb-6", "failed");
    await new Promise((resolve) => setTimeout(resolve, 60));
    const ledger = (await library.get("sc-1"))?.ledger as ScenarioLedger;
    expect(ledger.runStats.rejected).toBe(1);
    expect(ledger.runStats.runs).toBe(1);
    expect(ledger.inputPatterns.map((e) => e.outcome)).toEqual(["rejected"]);
  });
});

import { ArtifactRepository } from "@/product/artifacts";
import { ArtifactSchema } from "@/product/contracts";
import { WorkspaceRepository } from "@/product/repository";
import { WorkspaceSchema, ProjectSchema } from "@/product/contracts";
import { writeFile } from "node:fs/promises";

describe("PR-edit-accept revise-output 竞态（§7/§18）", () => {
  it("沉默窗内编辑 → 撤销 pending 沉默改记 corrected + 提案；编辑后 👍 被忽略(409)", async () => {
    const dir2 = await mkdtemp(path.join(tmpdir(), "revise-output-"));
    try {
      const lib = new ScenarioLibrary({ store: jsonStore({ filePath: path.join(dir2, "scenarios.json"), schema: ScenarioRecordSchema }) });
      await lib.save(baseRecord("sc-r"));
      const artifactPath = path.join(dir2, "result.md");
      await writeFile(artifactPath, "# 报告\n旧的结论行\n# 数据\n表格内容", "utf8");
      const repository = new WorkspaceRepository(
        jsonStore({ filePath: path.join(dir2, "workspaces.json"), schema: WorkspaceSchema }),
        jsonStore({ filePath: path.join(dir2, "projects.json"), schema: ProjectSchema }),
        jsonStore({ filePath: path.join(dir2, "project-files.json"), schema: z.unknown() }),
      );
      const workspace = await repository.getDefaultWorkspace();
      const artifacts = new ArtifactRepository(jsonStore({ filePath: path.join(dir2, "artifacts.json"), schema: ArtifactSchema }));
      await artifacts.create({ id: "artifact-r1", workspaceId: workspace.id, projectId: null, sessionId: null, runId: "run-r1", name: "结果.md", mediaType: "text/markdown", path: artifactPath, version: 1, status: "ready" });
      const srv = new PanelServer({ library: lib, artifacts, repository, pageHtml: defaultPageHtml(), artifactRoot: dir2, feedbackWindowMs: 60_000 });
      const port2 = await srv.start(0);
      const ws2 = new WebSocket(`ws://127.0.0.1:${port2}`);
      await new Promise((resolve) => ws2.once("open", resolve));
      try {
        // 反应窗开着（有人值守成功）
        const meta = (srv as unknown as { runLedgerMeta: Map<string, unknown> }).runLedgerMeta;
        meta.set("run-r1", { scenarioId: "sc-r", digest: "d-r1", attended: true, mode: "work" });
        (srv as unknown as { settleWorkRunLedgerOutcome: (id: string, status: "succeeded") => void }).settleWorkRunLedgerOutcome("run-r1", "succeeded");
        // 窗内编辑产出
        const revised = "# 报告\n新的结论行（含负责人和截止日）\n# 数据\n表格内容";
        const sent = await send(srv, ws2, { type: "revise-output", runId: "run-r1", content: revised });
        expect(sent.ok).toBe(true);
        let ledger = (await lib.get("sc-r"))?.ledger as ScenarioLedger;
        // 沉默被撤销 → corrected（而不是 accepted）
        expect(ledger.runStats.corrected).toBe(1);
        expect(ledger.runStats.accepted).toBe(0);
        expect(ledger.runStats.consecutiveClean).toBe(0);
        expect(ledger.constraints.length).toBeGreaterThanOrEqual(1);
        // 产出文件已写为改后版本
        expect(await readFile(artifactPath, "utf8")).toBe(revised);
        // 编辑后 👍 被忽略（窗口已关）
        const lateUp = await send(srv, ws2, { type: "feedback-run", runId: "run-r1", verdict: "up" });
        expect(lateUp.ok).toBe(false);
        expect(lateUp.error).toContain("409");
        // 同 runId 再编辑 → corrected 只计 1 次，提案去重
        const again = await send(srv, ws2, { type: "revise-output", runId: "run-r1", content: "# 报告\n新的结论行（含负责人和截止日）\n# 数据\n表格内容加边框" });
        expect(again.ok).toBe(true);
        ledger = (await lib.get("sc-r"))?.ledger as ScenarioLedger;
        expect(ledger.runStats.corrected).toBe(1);
      } finally {
        ws2.close();
        await srv.stop().catch(() => undefined);
      }
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }
  });
});
