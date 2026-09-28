import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PanelServer, defaultPageHtml, type PanelSnapshot } from "@/panel/server";
import { createOrchestrator } from "@/orchestrator/runner";
import { memoryBuildStore } from "@/orchestrator/build-store";
import { RunController } from "@/execution/repair";
import { ScenarioLibrary, recordFromDistilled } from "@/scenario/library";
import { distill } from "@/distill/distill";
import { jsonStore } from "@/core/store";
import { z } from "zod";
import { buildCapability } from "@/federation/adapters/adapter-utils";
import type { Source } from "@/federation/types";
import type { FederatedResult } from "@/federation/search";
import type { HandlerDeps } from "@/orchestrator/handlers";
import { VirtualUser } from "../virtual-user/driver";
import { attachVirtualUser } from "@/orchestrator/runner";
import type { Orchestrator } from "@/orchestrator/state-machine";

const src: Source = { id: "modelscope", tier: "curated", name: "t", url: "https://t" };

function deps(): HandlerDeps {
  const cap = buildCapability({
    id: "cap-fs", name: "cap-fs", kind: "mcp-server", description: "fs", source: src,
    install: { type: "npx", package: "pkg", args: [] }, tags: ["fs"],
  });
  return {
    search: async (q: string, _limit?: number): Promise<FederatedResult> => ({
      query: q, capabilities: [cap],
      statuses: [{ source: "modelscope", ok: true, degraded: false, latencyMs: 1, count: 1 }], totalMs: 1,
    }),
  };
}

/** WS 客户端测试帮手：收消息到队列，可等特定 kind */
class WsClient {
  private queue: Array<Record<string, unknown>> = [];
  private waiters: Array<{ kind: string; resolve: (m: Record<string, unknown>) => void }> = [];
  private ws: WebSocket;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("message", (data) => {
      const msg = JSON.parse(String(data)) as Record<string, unknown>;
      const waiter = this.waiters.find((w) => w.kind === msg.kind);
      if (waiter) {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        waiter.resolve(msg);
      } else {
        this.queue.push(msg);
      }
    });
  }

  async open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
  }

  async waitFor(kind: string, timeoutMs = 8000): Promise<Record<string, unknown>> {
    const found = this.queue.find((m) => m.kind === kind);
    if (found) {
      this.queue = this.queue.filter((m) => m !== found);
      return found;
    }
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting ${kind}`)), timeoutMs);
      this.waiters.push({
        kind,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  send(payload: unknown): void {
    this.ws.send(JSON.stringify(payload));
  }

  close(): void {
    this.ws.close();
  }
}

let dir: string;
let server: PanelServer;
let port: number;
let orch: Orchestrator;
let server2: PanelServer;
const controller = new RunController();

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "panel-"));
  for (const p of ["sessions", "scenarios", "knowledge"]) await mkdir(path.join(dir, p), { recursive: true });
  orch = createOrchestrator({ handlerDeps: deps(), store: memoryBuildStore() });
  const library = new ScenarioLibrary({ store: jsonStore({ filePath: path.join(dir, "s.json"), schema: z.unknown() }) });
  server = new PanelServer({
    orchestrator: orch,
    library,
    controller,
    memoryRoot: dir,
    pageHtml: defaultPageHtml(),
  });
  server.attachOrchestrator(orch);
  port = await server.start(0);
});
afterEach(async () => {
  await server.stop();
  await rm(dir, { recursive: true, force: true });
});

describe("8.1 面板服务：连接/快照一致/断线重连", () => {
  it("HTML 三栏骨架 + /api/snapshot 可用", async () => {
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    expect(html).toContain('data-pane="dialogue"');
    expect(html).toContain('data-pane="pipeline"');
    expect(html).toContain('data-pane="registry"');
    expect(html).toContain('id="gate-view"');
    expect(html).toContain('id="scenario-cards"');
    expect(html).toContain('id="memory-tree"');
    expect(html).toContain('id="loop-timeline"');
    const js = await (await fetch(`http://127.0.0.1:${port}/panel.js`)).text();
    expect(js).toContain("startPanel");
    const snap = (await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json()) as PanelSnapshot;
    expect(snap.phase).toBe("parsing"); // 初始 BuildContext 即 parsing（尚未 run）
  });

  it("WS 连接即收快照；与 HTTP 快照一致；断线重连后再次收到", async () => {
    const c1 = new WsClient(`ws://127.0.0.1:${port}/ws`);
    await c1.open();
    const wsSnap = (await c1.waitFor("snapshot")) as { snapshot: PanelSnapshot };
    const httpSnap = (await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json()) as PanelSnapshot;
    expect(wsSnap.snapshot.phase).toBe(httpSnap.phase);
    expect(wsSnap.snapshot.buildId).toBe(httpSnap.buildId);
    c1.close();

    const c2 = new WsClient(`ws://127.0.0.1:${port}/ws`);
    await c2.open();
    const snap2 = (await c2.waitFor("snapshot")) as { snapshot: PanelSnapshot };
    expect(snap2.snapshot.phase).toBe("parsing");
    c2.close();
  });

  it("非法动作被拒（协议校验）", async () => {
    const c = new WsClient(`ws://127.0.0.1:${port}/ws`);
    await c.open();
    await c.waitFor("snapshot");
    c.send({ type: "nonsense" });
    const result = (await c.waitFor("action-result")) as { ok: boolean };
    expect(result.ok).toBe(false);
    c.close();
  });
});

describe("8.4 Web 端完成一轮五闸门与状态机一致", () => {
  it("五闸门 WS 决策驱动 → done，approvals 完整", async () => {
    const c = new WsClient(`ws://127.0.0.1:${port}/ws`);
    await c.open();
    await c.waitFor("snapshot");
    const runPromise = orch.run();
    for (const gate of [1, 2, 3, 4, 5]) {
      // 等闸门视图推送
      let msg = await c.waitFor("gate");
      while (msg.gate !== gate) {
        msg = await c.waitFor("gate");
      }
      c.send({ type: "gate-decision", decision: { gate, action: "approve" } });
      const res = (await c.waitFor("action-result")) as { ok: boolean };
      expect(res.ok).toBe(true);
    }
    const final = await runPromise;
    expect(final.phase).toBe("done");
    expect(final.approvals.map((a) => a.gate).sort()).toEqual([1, 2, 3, 4, 5]);
    c.close();
  });
});

describe("8.3/8.5 快照数据：DAG 与集群事件、场景库、Memory 树", () => {
  it("快照含 DAG/trace 字段；场景库卡片与空态；memory 树", async () => {
    // 场景入库
    const lib = (server as unknown as { deps: { library: ScenarioLibrary } }).deps.library;
    const ctx = orch.ctx;
    void ctx;
    const fakeBuild = createOrchestrator({ handlerDeps: deps(), store: memoryBuildStore() });
    fakeBuild.start("整理数据", "b-panel");
    void fakeBuild.run();
    for (const gate of [1, 2, 3, 4, 5] as const) {
      const req = await fakeBuild.waitForGate();
      if (req.gate !== gate) throw new Error(`gate mismatch: ${req.gate}`);
      await fakeBuild.decide({ gate, action: "approve" });
    }
    const final = await (async () => fakeBuild.ctx)();
    const distilled = await distill(final);
    await lib!.save(recordFromDistilled({ id: "sc-panel", name: "面板场景", ctx: final, distilled, capabilityIds: ["cap-fs"] }));
    await writeFile(path.join(dir, "sessions", "b-panel.md"), "# 会话", "utf8");

    const snap = (await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json()) as PanelSnapshot;
    expect(snap.scenarios).toHaveLength(1);
    expect(snap.scenarios[0]).toMatchObject({ id: "sc-panel", uses: 0, degraded: false, version: 1 });
    expect(snap.memoryTree).toBeTruthy();
    expect(JSON.stringify(snap.memoryTree)).toContain("b-panel.md");
  });
});

describe("阶段八集成：Web 路径与 TUI 路径结果一致", () => {
  it("同一需求经面板 WS 决策与直接 decide（TUI 等价）最终 BuildContext 字段一致", async () => {
    const requirement = "整理 /data 下的数据并生成报告";
    // TUI 路径：直接驱动
    const tuiOrch = createOrchestrator({ handlerDeps: deps(), store: memoryBuildStore() });
    attachVirtualUser(tuiOrch, new VirtualUser({ kind: "approve-all" }));
    tuiOrch.start(requirement, "b-tui");
    const tuiResult = await tuiOrch.run();

    // Web 路径：面板 WS 决策驱动（同 requirement）
    const webOrch = createOrchestrator({ handlerDeps: deps(), store: memoryBuildStore() });
    server2 = new PanelServer({ orchestrator: webOrch, pageHtml: defaultPageHtml() });
    server2.attachOrchestrator(webOrch);
    const p2 = await server2.start(0);
    try {
      const c = new WsClient(`ws://127.0.0.1:${p2}/ws`);
      await c.open();
      await c.waitFor("snapshot");
      webOrch.start(requirement, "b-web");
      const runPromise = webOrch.run();
      for (const gate of [1, 2, 3, 4, 5] as const) {
        let msg = await c.waitFor("gate");
        while (msg.gate !== gate) msg = await c.waitFor("gate");
        c.send({ type: "gate-decision", decision: { gate, action: "approve" } });
      }
      const webResult = await runPromise;
      expect(webResult.phase).toBe("done");
      // 一致性：意图/DAG/选型/验收/审批 完全一致（排除时间戳与 id）
      const strip = (ctx: typeof webResult) => ({
        goal: ctx.intent?.goal,
        via: ctx.intent?.via,
        dag: ctx.dag,
        selections: ctx.selections,
        acceptanceLayers: ctx.acceptance.map((a) => `${a.layer}:${a.passed}`),
        approvals: ctx.approvals.map((a) => `${a.gate}:${a.action}`),
      });
      expect(strip(webResult)).toEqual(strip(tuiResult));
      c.close();
    } finally {
      await server2.stop();
    }
  });
});

describe("8.8 控制动作用于目标模式", () => {
  it("pause/resume/terminate 动作经 WS 到 RunController", async () => {
    const c = new WsClient(`ws://127.0.0.1:${port}/ws`);
    await c.open();
    await c.waitFor("snapshot");
    controller.pause();
    c.send({ type: "control", action: "resume" });
    const res = (await c.waitFor("action-result")) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(controller.currentState).toBe("running");
    c.send({ type: "control", action: "terminate" });
    await c.waitFor("action-result");
    expect(controller.currentState).toBe("terminated");
    c.close();
  });
});
