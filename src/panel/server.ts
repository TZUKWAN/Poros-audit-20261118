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
  z.object({ type: z.literal("start-build"), requirement: z.string().min(2).max(500) }),
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
  /** 面板发起构建（launcher 注入：装配真实联邦检索/执行/固化） */
  onStartBuild?: (requirement: string) => Promise<{ ok: boolean; error?: string }>;
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

  /** 挂接编排器：状态/闸门事件镜像推送（每次新构建由 launcher 调用） */
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

  /** 构建完成后强制推送最新快照（场景库/Memory 生长可见） */
  async refresh(): Promise<void> {
    await this.pushSnapshot();
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
    if (action.type === "start-build") {
      if (!this.deps.onStartBuild) return { ok: false, error: "面板未接入构建器" };
      return await this.deps.onStartBuild(action.requirement.trim());
    }
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
<head><meta charset="utf-8"><title>场景Agent 面板</title>
<style>
  body{font-family:system-ui,"Microsoft YaHei",sans-serif;margin:0;background:#111;color:#ddd}
  .three-pane{display:grid;grid-template-columns:1fr 1.4fr 1fr;gap:8px;padding:8px;height:100vh;box-sizing:border-box}
  section{background:#1b1b1f;border:1px solid #2c2c33;border-radius:8px;padding:10px;overflow:auto}
  h2{margin:0 0 8px;font-size:15px;color:#7fd1ff}
  h3{margin:8px 0;font-size:13px;color:#ffd479}
  #build-controls{display:flex;gap:6px;margin-bottom:8px}
  #req-input{flex:1;background:#0e0e11;color:#eee;border:1px solid #3a3a44;border-radius:6px;padding:6px 8px}
  button{background:#2b4a66;color:#cfe9ff;border:1px solid #3d6a92;border-radius:6px;padding:6px 12px;cursor:pointer}
  button:hover{background:#39628a}
  .log-line{padding:3px 6px;border-left:2px solid #3a3a44;margin:2px 0;font-size:12px;white-space:pre-wrap}
  .log-gate{border-color:#ffd479;color:#ffd479}
  .log-ok{border-color:#6fd06f;color:#9fdf9f}
  .log-err{border-color:#e07070;color:#f0a0a0}
  .snapshot-meta{color:#888;font-size:11px;margin:6px 0}
  .dag-node{display:flex;gap:8px;padding:5px 8px;margin:3px 0;background:#232329;border-radius:6px;font-size:12px}
  .status-success{border-left:3px solid #6fd06f}
  .status-failed{border-left:3px solid #e07070}
  .status-running{border-left:3px solid #ffd479;animation:pulse 1s infinite alternate}
  .status-pending{border-left:3px solid #555}
  @keyframes pulse{from{opacity:.7}to{opacity:1}}
  .gate-lines{background:#0e0e11;border:1px solid #3a3a44;border-radius:6px;padding:8px;white-space:pre-wrap;font-size:12px}
  .gate-actions{display:flex;gap:6px;margin-top:8px;align-items:center}
  .gate-actions input{flex:1;background:#0e0e11;color:#eee;border:1px solid #3a3a44;border-radius:6px;padding:6px 8px}
  .cluster-event,.loop-event{font-size:12px;padding:2px 6px;border-left:2px solid #3a3a44;margin:2px 0}
  .scenario-card{background:#232329;border-radius:6px;padding:6px 8px;margin:4px 0;cursor:pointer;font-size:12px;display:flex;justify-content:space-between}
  .scenario-card.degraded{border:1px solid #8a5a2b}
  .scenario-detail{font-size:11px;color:#9ab;margin:4px 0 0 8px}
  .mem-dir,.mem-file{display:block;font-size:12px;margin:2px 0;color:#9cd}
  summary{cursor:pointer;color:#ccd}
  #memory-viewer{background:#0e0e11;border:1px solid #3a3a44;border-radius:6px;padding:8px;margin-top:8px;font-size:12px}
</style>
</head>
<body>
  <div id="app" class="three-pane">
    <section id="pane-dialogue" data-pane="dialogue">
      <h2>对话 · 发起构建</h2>
      <div id="build-controls">
        <input id="req-input" placeholder="输入一句话需求，如：整理 /data 下的数据并生成报告" />
        <button id="req-go">构建</button>
      </div>
      <div id="dialogue-log"></div>
    </section>
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
      <div id="memory-viewer"></div>
    </section>
  </div>
  <script type="module" src="/panel.js"></script>
</body>
</html>`;
}
