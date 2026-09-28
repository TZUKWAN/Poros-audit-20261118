import { WebSocketServer, type WebSocket } from "ws";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { z } from "zod";
import { GateDecisionSchema } from "@/orchestrator/state-machine.js";
import type { Orchestrator } from "@/orchestrator/state-machine.js";
import { renderGateView } from "@/gates/views.js";
import { memoryTree, type MemoryTreeNode } from "@/memory/memory.js";
import type { ScenarioLibrary } from "@/scenario/library.js";
import type { GoalLoop, LoopEvent } from "@/execution/loop.js";
import type { ClusterEvent } from "@/execution/cluster.js";
import type { RunController } from "@/execution/repair.js";

/**
 * 8.1 面板服务：HTTP（页面 + 快照 API）+ WS（快照推送与增量事件、决策/控制动作上行）。
 * 前端三栏（8.2）：对话流 / 流水线+集群 / 注册表+Memory+场景库。
 */

export interface PanelSnapshot {
  buildId: string | null;
  phase: string;
  pendingGate: number | null;
  gateView: { gate: number; title: string; lines: string[] } | null;
  dag: unknown;
  trace: unknown[];
  cluster: ClusterEvent[];
  loop: LoopEvent[];
  scenarios: Array<{ id: string; name: string; uses: number; successes: number; degraded: boolean; version: number }>;
  memoryTree: MemoryTreeNode | null;
  updatedAt: string;
}

export const PanelActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("gate-decision"), decision: GateDecisionSchema }),
  z.object({ type: z.literal("control"), action: z.enum(["pause", "resume", "terminate"]) }),
]);
export type PanelAction = z.infer<typeof PanelActionSchema>;

export interface PanelDeps {
  orchestrator?: Orchestrator;
  library?: ScenarioLibrary;
  controller?: RunController;
  memoryRoot?: string;
  loop?: GoalLoop;
  /** 页面 HTML（测试注入；生产读静态文件） */
  pageHtml?: string;
}

export class PanelServer {
  private readonly events = new EventEmitter();
  private readonly clusterEvents: ClusterEvent[] = [];
  private readonly loopEvents: LoopEvent[] = [];
  private server: Server | undefined;
  private wss: WebSocketServer | undefined;
  private readonly clients = new Set<WebSocket>();
  readonly bus = new EventEmitter();

  constructor(private deps: PanelDeps = {}) {}

  /** 执行底座事件接入（集群监控视图 8.5） */
  attachClusterEvents(subscribe: (h: (e: ClusterEvent) => void) => void): void {
    subscribe((e) => {
      this.clusterEvents.push(e);
      this.broadcast({ kind: "cluster", event: e });
    });
  }

  /** 目标模式时间线接入（8.8） */
  attachLoopEvents(loop: GoalLoop): void {
    this.deps.loop = loop;
    loop.on((e) => {
      this.loopEvents.push(e);
      this.broadcast({ kind: "loop", event: e });
    });
  }

  /** 挂接编排器：状态/闸门事件镜像推送 */
  attachOrchestrator(orch: Orchestrator): void {
    this.deps.orchestrator = orch;
    orch.on("state:enter", ({ to }) => {
      this.broadcast({ kind: "state", phase: to });
      void this.pushSnapshot();
    });
    orch.on("gate:pending", ({ request }) => {
      const view = renderGateView(request.gate, request.payload);
      this.broadcast({ kind: "gate", gate: request.gate, title: view.title, lines: view.lines });
    });
  }

  async snapshot(): Promise<PanelSnapshot> {
    const orch = this.deps.orchestrator;
    const ctx = orch?.ctx;
    let gateView: PanelSnapshot["gateView"] = null;
    if (ctx?.pendingGate) {
      const view = renderGateView(ctx.pendingGate as 1 | 2 | 3 | 4 | 5, gatePayloadFor(ctx.pendingGate as 1 | 2 | 3 | 4 | 5, ctx));
      gateView = { gate: ctx.pendingGate, title: view.title, lines: view.lines };
    }
    let scenarios: PanelSnapshot["scenarios"] = [];
    if (this.deps.library) {
      scenarios = (await this.deps.library.list()).map((s) => ({
        id: s.id,
        name: s.name,
        uses: s.stats.uses,
        successes: s.stats.successes,
        degraded: s.degraded,
        version: s.pinnedVersion,
      }));
    }
    let tree: MemoryTreeNode | null = null;
    if (this.deps.memoryRoot) {
      tree = await memoryTree({ root: this.deps.memoryRoot, sessions: "", scenarios: "", knowledge: "" });
    }
    return {
      buildId: ctx?.id ?? null,
      phase: ctx?.phase ?? "idle",
      pendingGate: ctx?.pendingGate ?? null,
      gateView,
      dag: ctx?.dag ?? null,
      trace: (ctx?.trace ?? []) as unknown[],
      cluster: this.clusterEvents,
      loop: this.loopEvents,
      scenarios,
      memoryTree: tree,
      updatedAt: new Date().toISOString(),
    };
  }

  /** 8.4 Web 闸门操作 / 8.3 控制动作（与 TUI 决策协议同 schema） */
  async handleAction(raw: unknown): Promise<{ ok: boolean; error?: string }> {
    const parsed = PanelActionSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: `invalid action: ${parsed.error.issues[0]?.message ?? "unknown"}` };
    }
    const action = parsed.data;
    if (action.type === "gate-decision") {
      await this.deps.orchestrator?.decide(action.decision);
      this.bus.emit("gate-decision", action.decision);
      return { ok: true };
    }
    const ctl = this.deps.controller;
    if (!ctl) return { ok: false, error: "no controller attached" };
    if (action.action === "pause") ctl.pause();
    else if (action.action === "resume") ctl.resume();
    else ctl.terminate();
    return { ok: true };
  }

  async start(port = 0): Promise<number> {
    this.server = createServer((req, res) => {
      if (req.url === "/api/snapshot") {
        void this.snapshot().then((snap) => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(snap));
        });
        return;
      }
      if (req.url === "/panel.js") {
        void readFile(path.join(process.cwd(), "src", "panel", "panel-client.js"), "utf8").then((js) => {
          res.setHeader("content-type", "text/javascript; charset=utf-8");
          res.end(js);
        });
        return;
      }
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(this.deps.pageHtml ?? defaultPageHtml());
    });
    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on("connection", (ws: WebSocket) => {
      this.clients.add(ws);
      void this.snapshot().then((snap) => ws.send(JSON.stringify({ kind: "snapshot", snapshot: snap })));
      ws.on("message", (data) => {
        try {
          void this.handleAction(JSON.parse(String(data))).then((r) => {
            ws.send(JSON.stringify({ kind: "action-result", ...r }));
          });
        } catch {
          ws.send(JSON.stringify({ kind: "action-result", ok: false, error: "malformed JSON" }));
        }
      });
      ws.on("close", () => this.clients.delete(ws));
    });
    return await new Promise((resolve) => {
      this.server!.listen(port, "127.0.0.1", () => {
        const addr = this.server!.address();
        resolve(typeof addr === "object" && addr ? addr.port : 0);
      });
    });
  }

  async stop(): Promise<void> {
    for (const ws of this.clients) ws.close();
    this.wss?.close();
    await new Promise<void>((r) => this.server?.close(() => r()));
  }

  broadcast(payload: unknown): void {
    const data = JSON.stringify(payload);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  private async pushSnapshot(): Promise<void> {
    const snap = await this.snapshot();
    this.broadcast({ kind: "snapshot", snapshot: snap });
  }

  get clientCount(): number {
    return this.clients.size;
  }
}

function gatePayloadFor(gate: 1 | 2 | 3 | 4 | 5, ctx: unknown): unknown {
  // 与 state-machine.gatePayload 相同语义；ctx 为深拷贝
  const c = ctx as { intent?: unknown; dag?: unknown; candidates?: unknown; assembly?: unknown; acceptance?: unknown; trace?: unknown };
  switch (gate) {
    case 1:
      return c.intent;
    case 2:
      return c.dag;
    case 3:
      return c.candidates;
    case 4:
      return { assembly: c.assembly, acceptance: c.acceptance };
    case 5:
      return { intent: c.intent, trace: c.trace, acceptance: c.acceptance };
  }
}

/** 8.2 三栏骨架页面（生产默认；测试可注入） */
export function defaultPageHtml(): string {
  return `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>场景Agent 面板</title></head>
<body>
  <div id="app" class="three-pane">
    <section id="pane-dialogue" data-pane="dialogue"><h2>对话</h2><div id="dialogue-log"></div></section>
    <section id="pane-pipeline" data-pane="pipeline">
      <h2>流水线与集群</h2>
      <div id="dag-view"></div>
      <div id="gate-view"></div>
      <div id="cluster-view"></div>
      <div id="loop-timeline"></div>
    </section>
    <section id="pane-registry" data-pane="registry">
      <h2>场景库 / Memory</h2>
      <div id="scenario-cards"></div>
      <div id="memory-tree"></div>
    </section>
  </div>
  <script type="module" src="/panel.js"></script>
</body>
</html>`;
}
