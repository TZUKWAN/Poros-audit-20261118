/**
 * 左栏对话式客户端 —— 复用 pi 生态 @earendil-works/pi-web-ui：
 *  - MessageList：吃 AgentMessage[]（pi-agent-core 的自定义消息角色机制）
 *  - MessageEditor：底部输入框（onSend → WS）
 *  - registerMessageRenderer：注册 gate-card / build-status 两个自定义角色渲染器
 * 对话对象是场景编排器（不是直连 LLM），消息由 WS 桥映射。
 */
import "@earendil-works/pi-web-ui/app.css";
import { MessageList, MessageEditor, registerMessageRenderer } from "@earendil-works/pi-web-ui";
import { html, type TemplateResult } from "lit";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

// ── 自定义消息角色（pi-agent-core CustomAgentMessages 机制）──

export interface GateCardMessage {
  role: "gate-card";
  gate: number;
  title: string;
  lines: string[];
  decided: null | { action: "approve" | "reject"; targetPhase?: string };
  ts: number;
}

export interface BuildStatusMessage {
  role: "build-status";
  tone: "info" | "ok" | "err";
  text: string;
  ts: number;
}

declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages {
    "gate-card": GateCardMessage;
    "build-status": BuildStatusMessage;
  }
}

const messages: AgentMessage[] = [];
let ws: WebSocket;
const decidedGates = new Set<number>();
// ── 渲染器 ──

registerMessageRenderer(
  "build-status",
  { render: (m: BuildStatusMessage) => {
    const color = m.tone === "ok" ? "var(--sc-ok, #6fd06f)" : m.tone === "err" ? "var(--sc-err, #f08a8a)" : "var(--sc-info, #8ab4ff)";
    return html`<div class="sc-status" style="border-color:${color};color:${color}">${m.text}</div>`;
  } },
);

registerMessageRenderer(
  "gate-card",
  { render: (m: GateCardMessage) => {
  const decided = m.decided ?? (decidedGates.has(m.gate) ? { action: "approve" as const } : null);
  const lines = html`${m.lines.map((l) => html`<div class="sc-gate-line">${l}</div>`)}`;
  const actions = decided
    ? html`<div class="sc-gate-decided">${decided.action === "approve" ? "✓ 已批准" : `✗ 已驳回${decided.targetPhase ? ` → ${decided.targetPhase}` : ""}`}</div>`
    : html`<div class="sc-gate-actions">
        <button data-action="approve" data-gate="${m.gate}" class="sc-btn sc-approve">批准</button>
        <button data-action="reject" data-gate="${m.gate}" class="sc-btn sc-reject">驳回</button>
        <input class="sc-comment" id="gate-comment-${m.gate}" placeholder="驳回注释（可选）" />
      </div>`;
  return html`<div class="sc-gate-card" data-gate="${m.gate}">
    <div class="sc-gate-title">⏸ ${m.title}</div>
    ${lines}
    ${actions}
  </div>`;
  } },
);

// ── 右栏：场景即时预览 ──

const $id = (id: string): HTMLElement | null => document.getElementById(id);

function renderPreview(snap: {
  preview: { goal: string | null; selections: Array<{ nodeId: string; capabilityId: string; name: string; source: string; tier: string; trust: number; requiresAuth: boolean }>; acceptance: Array<{ layer: string; passed: boolean }> };
  dag: { nodes?: Array<{ id: string; title: string; deps: string[] }> } | null;
  trace: Array<{ nodeId: string; status?: string }>;
}): void {
  const goal = $id("preview-goal");
  if (goal) goal.textContent = snap.preview.goal ? `目标：${snap.preview.goal}` : "";
  // 任务流水线（状态驱动）
  const dag = $id("dag-view");
  if (dag) {
    dag.replaceChildren();
    const statusOf = (nodeId: string) => snap.trace.find((s) => s.nodeId === nodeId)?.status ?? "pending";
    for (const n of snap.dag?.nodes ?? []) {
      const row = document.createElement("div");
      row.className = `dag-node status-${statusOf(n.id)}`;
      const t = document.createElement("span");
      t.className = "dag-title";
      t.textContent = n.title;
      const s = document.createElement("span");
      s.className = "dag-status";
      s.textContent = statusOf(n.id) === "success" ? "✓" : statusOf(n.id);
      const d = document.createElement("span");
      d.className = "dag-status";
      d.textContent = n.deps.length ? `← ${n.deps.join(",")}` : "";
      row.append(t, s, d);
      dag.append(row);
    }
  }
  // 能力选型
  const sel = $id("sel-view");
  if (sel) {
    sel.replaceChildren();
    if (snap.preview.selections.length === 0) {
      const empty = document.createElement("div");
      empty.className = "scenarios-empty";
      empty.textContent = "（闸门3 通过后显示）";
      sel.append(empty);
    }
    for (const s of snap.preview.selections) {
      const row = document.createElement("div");
      row.className = "sc-sel";
      const tier = document.createElement("span");
      tier.className = "sc-tier";
      tier.textContent = { official: "官方", curated: "策展", aggregate: "聚合" }[s.tier as "official"] ?? s.tier;
      const name = document.createElement("span");
      name.textContent = s.name;
      const src = document.createElement("span");
      src.style.cssText = "color:#666;font-size:11px";
      src.textContent = s.source;
      const trust = document.createElement("span");
      trust.className = "sc-trust";
      trust.textContent = `trust ${s.trust.toFixed(2)}`;
      row.append(tier, name, src, s.requiresAuth ? Object.assign(document.createElement("span"), { className: "sc-auth", textContent: "⚠需鉴权" }) : document.createTextNode(""), trust);
      sel.append(row);
    }
  }
  // 验收三层
  const acc = $id("acc-view");
  if (acc) {
    acc.replaceChildren();
    const layers = ["component", "task", "generalization"];
    for (const layer of layers) {
      const rec = snap.preview.acceptance.find((a) => a.layer === layer);
      const row = document.createElement("div");
      row.className = "sc-acc";
      row.textContent = `[${rec ? (rec.passed ? "✓" : "✗") : " "}] ${layer}`;
      acc.append(row);
    }
  }
}

function renderLibrary(snap: { scenarios: Array<{ id: string; name: string; uses: number; successes: number; degraded: boolean; version: number }> }): void {
  const box = $id("scenario-cards");
  if (!box) return;
  box.replaceChildren();
  if (snap.scenarios.length === 0) {
    const empty = document.createElement("div");
    empty.className = "scenarios-empty";
    empty.textContent = "场景库为空";
    box.append(empty);
    return;
  }
  for (const s of snap.scenarios) {
    const card = document.createElement("div");
    card.className = `scenario-card${s.degraded ? " degraded" : ""}`;
    const name = document.createElement("strong");
    name.textContent = s.name;
    const meta = document.createElement("span");
    meta.className = "scenario-meta";
    meta.textContent = `v${s.version} · 用${s.uses}次 ✓${s.successes}${s.degraded ? " ⚠降级" : ""}`;
    card.append(name, meta);
    card.addEventListener("click", () => {
      const detail = document.createElement("div");
      detail.className = "scenario-detail";
      detail.textContent = `${s.id} · 蒸馏产物与统计`;
      box.append(detail);
    });
    box.append(card);
  }
}

function renderMemory(snap: { memoryTree: { name: string; kind: string; children?: unknown[] } | null }): void {
  const tree = $id("memory-tree");
  if (!tree) return;
  tree.replaceChildren();
  const walk = (node: { name: string; kind: string; path?: string; children?: unknown[] }): HTMLElement => {
    if (node.kind === "dir") {
      const details = document.createElement("details");
      details.className = "mem-dir";
      const summary = document.createElement("summary");
      summary.textContent = node.name;
      details.append(summary);
      for (const c of node.children ?? []) details.append(walk(c as never));
      return details;
    }
    const link = document.createElement("a");
    link.className = "mem-file";
    link.textContent = node.name;
    link.href = "#";
    link.addEventListener("click", async (e) => {
      e.preventDefault();
      const viewer = $id("memory-viewer");
      if (!viewer || !node.path) return;
      const md = await fetch("/api/memory-file?path=" + encodeURIComponent(node.path)).then((r) => (r.ok ? r.text() : "（读取失败）")).catch(() => "（读取失败）");
      viewer.replaceChildren(...renderMarkdown(md));
    });
    return link;
  };
  for (const c of snap.memoryTree?.children ?? []) tree.append(walk(c as never));
}

function renderMarkdown(md: string): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const line of String(md).split("\n")) {
    if (line.startsWith("### ")) out.push(Object.assign(document.createElement("h4"), { textContent: line.slice(4) }));
    else if (line.startsWith("## ")) out.push(Object.assign(document.createElement("h3"), { textContent: line.slice(3) }));
    else if (line.startsWith("# ")) out.push(Object.assign(document.createElement("h2"), { textContent: line.slice(2) }));
    else if (line.startsWith("- ")) out.push(Object.assign(document.createElement("li"), { textContent: line.slice(2) }));
    else if (line.trim().length > 0) out.push(Object.assign(document.createElement("p"), { textContent: line }));
  }
  return out;
}

function renderRight(snap: Parameters<typeof renderPreview>[0] & { scenarios: Parameters<typeof renderLibrary>[0]["scenarios"]; memoryTree: Parameters<typeof renderMemory>[0]["memoryTree"] }): void {
  renderPreview(snap);
  renderLibrary(snap);
  renderMemory(snap);
}

function bindTabs(): void {
  for (const tab of document.querySelectorAll<HTMLElement>(".sc-tab")) {
    tab.addEventListener("click", () => {
      for (const t of document.querySelectorAll<HTMLElement>(".sc-tab")) t.classList.toggle("active", t === tab);
      const target = tab.getAttribute("data-tab");
      const scenarios = $id("tab-scenarios");
      const memory = $id("tab-memory");
      if (scenarios) scenarios.style.display = target === "scenarios" ? "block" : "none";
      if (memory) memory.style.display = target === "memory" ? "block" : "none";
    });
  }
}

// ── 组件装配 ──

function rerender(): void {
  if (!list) return;
  list.messages = [...messages];
  // MessageList 未声明 reactive properties，外部赋值需手动触发 lit 更新
  (list as unknown as { requestUpdate(): void }).requestUpdate();
}

let list: MessageList | undefined;
let editor: MessageEditor | undefined;

function push(m: AgentMessage): void {
  messages.push(m);
  rerender();
  requestAnimationFrame(() => {
    const root = (list as unknown as { shadowRoot: ShadowRoot | null })?.shadowRoot ?? list;
    root?.lastElementChild?.scrollIntoView?.({ block: "end" });
  });
}

function userMessage(text: string): void {
  push({ role: "user", content: text, timestamp: Date.now() });
}

function status(tone: BuildStatusMessage["tone"], text: string): void {
  push({ role: "build-status", tone, text, ts: Date.now() });
}

function gateCard(m: GateCardMessage): void {
  decidedGates.delete(m.gate);
  push(m);
}
void gateCard;

// ── WS 桥 ──

function connect(): void {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${protocol}://${location.host}/ws`);
  ws.addEventListener("open", () => {
    status("info", "已连接场景编排器。输入一句话需求（回车发送），我会带你过五道闸门。");
  });
  ws.addEventListener("message", (ev) => {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(String(ev.data)) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (m.kind) {
      case "chat":
        {
          const msg = m.message as AgentMessage;
          if ((msg as { role: string }).role === "gate-card") {
            const g = msg as unknown as GateCardMessage;
            if (g.decided) decidedGates.add(g.gate);
          }
          push(msg);
        }
        break;
      case "snapshot": {
        // 重连恢复：用快照里的聊天历史整体重建 + 右栏预览
        const snap = m.snapshot as Parameters<typeof renderRight>[0] & { chat?: AgentMessage[] };
        renderRight(snap);
        if (Array.isArray(snap.chat) && snap.chat.length > 0) {
          messages.length = 0;
          messages.push(...snap.chat);
          for (const c of messages) {
            if ((c as { role: string }).role === "gate-card") {
              const d = (c as unknown as GateCardMessage).decided;
              if (d) decidedGates.add((c as unknown as GateCardMessage).gate);
            }
          }
          rerender();
        }
        break;
      }
      case "action-result": {
        const ok = m.ok as boolean;
        status(ok ? "ok" : "err", ok ? "✓ 已受理" : `✗ ${String(m.error ?? "操作失败")}`);
        break;
      }
      case "run-error":
        status("err", `✗ 构建失败：${String(m.message)}`);
        if (editor) editor.isStreaming = false;
        break;
      case "run-done":
        status("ok", `✓ 构建完成，场景已固化入库、会话已写入 Memory（右栏可看）`);
        if (editor) editor.isStreaming = false;
        break;
      default:
        break;
    }
  });
}

function decide(gate: number, action: "approve" | "reject"): void {
  const input = document.getElementById(`gate-comment-${gate}`) as HTMLInputElement | null;
  const comment = input?.value?.trim() || undefined;
  // 驳回目标：闸门默认回退表（与服务端 GATES 一致）
  const targets: Record<number, string> = { 1: "parsing", 2: "planning", 3: "retrieving", 4: "assembling", 5: "planning" };
  const decision: Record<string, unknown> = { gate, action };
  if (action === "reject") {
    decision.targetPhase = targets[gate] ?? "planning";
    if (comment) decision.comment = comment;
  }
  decidedGates.add(gate);
  rerender();
  ws.send(JSON.stringify({ type: "gate-decision", decision }));
}

// ── 挂载 ──

function mount(): void {
  const left = document.getElementById("chat-root");
  if (!left) return;

  list = new MessageList();
  list.tools = [];
  list.messages = [];
  list.style.display = "block";
  list.className = "sc-message-list";

  editor = new MessageEditor();
  editor.showAttachmentButton = false;
  editor.showModelSelector = false;
  editor.showThinkingSelector = false;
  editor.thinkingLevel = "off";
  editor.isStreaming = false;
  editor.addEventListener("input", () => {
    /* 值经 onSend 取 */
  });
  editor.onSend = (text: string) => {
    const requirement = text.trim();
    if (!requirement) return;
    userMessage(requirement);
    ws.send(JSON.stringify({ type: "start-build", requirement }));
    editor!.isStreaming = true;
    editor!.value = "";
  };
  editor.onAbort = () => {
    ws.send(JSON.stringify({ type: "control", action: "terminate" }));
  };

  // 卡片按钮事件委托
  left.addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement).closest("button[data-action]") as HTMLElement | null;
    if (!btn) return;
    const gate = Number(btn.getAttribute("data-gate"));
    const action = btn.getAttribute("data-action") as "approve" | "reject";
    decide(gate, action);
  });

  left.append(list, editor);
  bindTabs();
  connect();
}

if (typeof window !== "undefined") {
  window.addEventListener("DOMContentLoaded", mount);
}

export type { TemplateResult };
