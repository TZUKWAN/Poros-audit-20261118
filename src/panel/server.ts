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
  chat: Array<Record<string, unknown>>;
  preview: {
    goal: string | null;
    selections: Array<{ nodeId: string; capabilityId: string; name: string; source: string; tier: string; trust: number; requiresAuth: boolean }>;
    acceptance: Array<{ layer: string; passed: boolean }>;
  };
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

  /** 挂接编排器：状态/闸门事件镜像为聊天消息（每次新构建由 launcher 调用） */
  attachOrchestrator(orch: Orchestrator): void {
    this.deps.orchestrator = orch;
    orch.on("state:enter", ({ to }) => {
      if (to !== "done") this.pushChat({ role: "build-status", tone: "info", text: `▶ 进入阶段：${to}`, ts: Date.now() });
      void this.pushSnapshot();
    });
    orch.on("gate:pending", ({ request }) => {
      const view = renderGateView(request.gate, request.payload);
      this.pushChat({
        role: "gate-card",
        gate: request.gate,
        title: `闸门${request.gate} · ${view.title}`,
        lines: view.lines.filter((l) => !l.startsWith("[")),
        decided: undefined,
        ts: Date.now(),
      });
    });
    // 决策状态行由 handleAction 统一推送（此处不再重复）
  }

  /** 构建完成后强制推送最新快照（场景库/Memory 生长可见） */
  async refresh(): Promise<void> {
    await this.pushSnapshot();
  }

  /** 聊天历史（左栏对话；重连经快照恢复） */
  private readonly chatHistory: Array<Record<string, unknown>> = [];

  pushChat(message: Record<string, unknown>): void {
    this.chatHistory.push(message);
    if (this.chatHistory.length > 200) this.chatHistory.shift();
    this.broadcast({ kind: "chat", message });
  }

  /** 闸门决策落到聊天历史中的对应卡片（重连后仍显示已决状态） */
  markGateCardDecided(gate: number, action: "approve" | "reject", targetPhase?: string): void {
    for (let i = this.chatHistory.length - 1; i >= 0; i--) {
      const m = this.chatHistory[i] as { role?: string; gate?: number; decided?: unknown } | undefined;
      if (m && m.role === "gate-card" && m.gate === gate) {
        m.decided = { action, targetPhase };
        return;
      }
    }
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
    // 右栏即时预览数据：目标/选型（含能力详情）/验收三层
    const sets = (ctx?.candidates ?? []) as Array<{ nodeId: string; candidates: Array<{ id: string; name: string; source: { name: string; tier: string }; trust: { score: number }; requiresAuth: boolean; remoteRun?: unknown }> }>;
    const capById = new Map<string, (typeof sets)[number]["candidates"][number]>();
    for (const s of sets) for (const c of s.candidates) capById.set(c.id, c);
    const selections = (ctx?.selections ?? []).map((sel) => {
      const cap = capById.get(sel.capabilityId);
      return {
        nodeId: sel.nodeId,
        capabilityId: sel.capabilityId,
        name: cap?.name ?? sel.capabilityId,
        source: cap?.source.name ?? "?",
        tier: cap?.source.tier ?? "aggregate",
        trust: cap?.trust.score ?? 0,
        requiresAuth: cap?.requiresAuth ?? false,
      };
    });
    const preview = {
      goal: ctx?.intent?.goal ?? ctx?.requirement ?? null,
      selections,
      acceptance: (ctx?.acceptance ?? []).map((a) => ({ layer: (a as { layer: string }).layer, passed: (a as { passed: boolean }).passed })).slice(-6),
    };
    // 闸门卡片回填已决状态
    const chat = this.chatHistory.map((m) => {
      const mm = m as { role?: string; gate?: number; decided?: unknown };
      if (mm.role === "gate-card" && mm.decided === undefined && mm.gate !== undefined) {
        const rec = (ctx?.approvals ?? []).find((a) => (a as { gate: number }).gate === mm.gate);
        if (rec) {
          const r = rec as { action: string; targetPhase?: string };
          return { ...m, decided: { action: r.action, targetPhase: r.targetPhase } };
        }
      }
      return m;
    });
    return {
      chat,
      preview,
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
      this.markGateCardDecided(action.decision.gate, action.decision.action, action.decision.targetPhase);
      this.pushChat({
        role: "build-status",
        tone: action.decision.action === "approve" ? "ok" : "err",
        text:
          action.decision.action === "approve"
            ? `✓ 闸门${action.decision.gate} 已批准${action.decision.comment ? `（${action.decision.comment}）` : ""}`
            : `✗ 闸门${action.decision.gate} 已驳回 → ${action.decision.targetPhase}${action.decision.comment ? `（${action.decision.comment}）` : ""}`,
        ts: Date.now(),
      });
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
      if (req.url?.startsWith("/api/memory-file")) {
        const reqPath = new URL(req.url, "http://x").searchParams.get("path") ?? "";
        const root = this.deps.memoryRoot ?? "";
        // 仅允许读取 memoryRoot 下的 .md 文件（路径穿越防护）
        const resolved = path.resolve(reqPath);
        if (!resolved.startsWith(path.resolve(root)) || !resolved.endsWith(".md")) {
          res.writeHead(403).end();
          return;
        }
        readFile(resolved, "utf8")
          .then((md) => {
            res.setHeader("content-type", "text/markdown; charset=utf-8");
            res.end(md);
          })
          .catch(() => res.writeHead(404).end());
        return;
      }
      if (req.url === "/panel.js") {
        readFile(path.join(process.cwd(), "dist", "panel-chat.js"), "utf8")
          .then((js) => {
            res.setHeader("content-type", "text/javascript; charset=utf-8");
            res.end(js);
          })
          .catch(() => {
            res.writeHead(404).end("panel client not built; run: npm run panel-client");
          });
        return;
      }
      if (req.url === "/app.css") {
        readFile(path.join(process.cwd(), "dist", "panel-chat.css"), "utf8")
          .then((css) => {
            res.setHeader("content-type", "text/css; charset=utf-8");
            res.end(css);
          })
          .catch(() => {
            res.writeHead(404).end("panel css not built; run: npm run panel-client");
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

/** 8.2 双栏骨架（左对话 = pi-web-ui 聊天组件；右 = 场景即时预览 + 库） */
export function defaultPageHtml(): string {
  return `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>场景Agent · 对话式构建</title>
<link rel="stylesheet" href="/app.css">
<style>
  html,body{height:100%;margin:0;background:#101014;color:#e2e2e8;font-family:system-ui,"Microsoft YaHei",sans-serif}
  .sc-app{display:grid;grid-template-columns:minmax(420px,1fr) minmax(380px,0.9fr);gap:10px;padding:10px;height:100vh;box-sizing:border-box}
  .sc-pane{background:#17171c;border:1px solid #2a2a33;border-radius:10px;padding:10px;overflow:auto;min-height:0;display:flex;flex-direction:column}
  .sc-pane h2{margin:0 0 8px;font-size:14px;color:#7fd1ff;font-weight:600}
  #chat-root{flex:1;display:flex;flex-direction:column;min-height:0;gap:8px}
  #chat-root message-list{flex:1;overflow:auto;min-height:0}
  #chat-root message-editor{border-top:1px solid #2a2a33;padding-top:6px}
  .sc-status{border-left:3px solid;padding:4px 8px;margin:4px 0;font-size:12px;background:#101015;border-radius:4px}
  .sc-gate-card{background:#101015;border:1px solid #4a4430;border-radius:8px;padding:8px 10px;margin:6px 0}
  .sc-gate-title{color:#ffd479;font-size:13px;font-weight:600;margin-bottom:6px}
  .sc-gate-line{font-size:12px;color:#c9c9d4;white-space:pre-wrap;padding:1px 0}
  .sc-gate-actions{display:flex;gap:6px;margin-top:8px;align-items:center}
  .sc-btn{border:none;border-radius:6px;padding:5px 14px;font-size:12px;cursor:pointer;color:#0d0d10;font-weight:600}
  .sc-approve{background:#7fd18a}
  .sc-reject{background:#f08a8a}
  .sc-comment{flex:1;background:#1d1d24;border:1px solid #33333d;color:#ddd;border-radius:6px;padding:4px 8px;font-size:12px}
  .sc-gate-decided{margin-top:6px;font-size:12px;color:#8f8f9c}
  .sc-preview-section{margin:10px 0 4px;font-size:12px;color:#9a9aac;text-transform:letter-spacing:1px}
  .sc-sel{display:flex;align-items:center;gap:6px;background:#101015;border-radius:6px;padding:5px 8px;margin:3px 0;font-size:12px}
  .sc-tier{font-size:10px;border-radius:4px;padding:1px 5px;background:#2c3540;color:#9cd}
  .sc-trust{color:#7fd18a;font-size:11px}
  .sc-auth{color:#f0b06a;font-size:11px}
  .sc-acc{display:flex;gap:6px;font-size:12px;margin:2px 0}
  .dag-node{display:flex;gap:8px;padding:5px 8px;margin:3px 0;background:#101015;border-radius:6px;font-size:12px;align-items:center}
  .dag-title{flex:1}
  .dag-status{font-size:11px;color:#8f8f9c}
  .status-success{border-left:3px solid #6fd06f}
  .status-failed{border-left:3px solid #e07070}
  .status-running{border-left:3px solid #ffd479}
  .status-pending{border-left:3px solid #555}
  .scenario-card{background:#101015;border-radius:8px;padding:8px 10px;margin:4px 0;cursor:pointer;font-size:12px;display:flex;justify-content:space-between;align-items:center}
  .scenario-card.degraded{border:1px solid #8a5a2b}
  .scenario-card strong{color:#e8e8f0}
  .scenario-meta{color:#8f8f9c;font-size:11px}
  .scenario-detail{font-size:11px;color:#9ab;margin:4px 0 0 8px}
  .scenarios-empty{color:#666;font-size:12px}
  .mem-dir,.mem-file{display:block;font-size:12px;margin:2px 0;color:#9cd}
  summary{cursor:pointer;color:#ccd;font-size:12px}
  #memory-viewer{background:#101015;border:1px solid #33333d;border-radius:6px;padding:8px;margin-top:8px;font-size:12px}
  #memory-viewer h2{font-size:13px}
  #memory-viewer h3{font-size:12px}
  #memory-viewer li{margin-left:16px}
  .cluster-event,.loop-event{font-size:11px;padding:2px 6px;border-left:2px solid #3a3a44;margin:2px 0;color:#a0a0b0}
  .sc-tabs{display:flex;gap:6px;margin-top:12px}
  .sc-tab{font-size:12px;padding:4px 10px;border-radius:6px;background:#101015;border:1px solid #2a2a33;cursor:pointer;color:#9a9aac}
  .sc-tab.active{color:#7fd1ff;border-color:#3d6a92}
</style>
</head>
<body>
  <div class="sc-app">
    <section class="sc-pane" data-pane="chat">
      <h2>对话 · 场景构建</h2>
      <div id="chat-root"></div>
    </section>
    <section class="sc-pane" data-pane="preview">
      <h2>场景即时预览</h2>
      <div id="preview-goal" style="font-size:13px;color:#ffd479"></div>
      <div class="sc-preview-section">任务流水线</div>
      <div id="dag-view"></div>
      <div class="sc-preview-section">能力选型</div>
      <div id="sel-view"></div>
      <div class="sc-preview-section">验收</div>
      <div id="acc-view"></div>
      <div class="sc-tabs">
        <div class="sc-tab active" data-tab="scenarios">场景库</div>
        <div class="sc-tab" data-tab="memory">Memory</div>
      </div>
      <div id="tab-scenarios"><div id="scenario-cards"></div></div>
      <div id="tab-memory" style="display:none"><div id="memory-tree"></div><div id="memory-viewer"></div></div>
    </section>
  </div>
  <script type="module" src="/panel.js"></script>
</body>
</html>`;
}
