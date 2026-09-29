// 面板前端（浏览器 ES module，静态伺服）：三栏渲染 + WS 联通 + 闸门/控制操作。
// 数据契约与 src/panel/server.ts 一致（快照 JSON + 增量事件）。

const $ = (id) => document.getElementById(id);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) node.append(child);
  return node;
}

/** 8.3 DAG 视图：状态驱动渲染（动画类 per 状态） */
export function renderDag(container, dag, trace) {
  container.replaceChildren();
  if (!dag || !dag.nodes) return;
  const statusOf = (nodeId) => (trace.find((s) => s.nodeId === nodeId) || {}).status || "pending";
  for (const node of dag.nodes) {
    const status = statusOf(node.id);
    container.append(
      el("div", { class: `dag-node status-${status}`, "data-node": node.id },
        el("span", { class: "dag-title", text: node.title }),
        el("span", { class: "dag-status", text: status }),
        node.deps && node.deps.length > 0 ? el("span", { class: "dag-deps", text: `← ${node.deps.join(",")}` }) : el("span"),
      ),
    );
  }
}

/** 8.4 闸门评审视图：与 TUI 等价操作（批准/驳回/编辑注释） */
export function renderGate(container, gateView, onDecide) {
  container.replaceChildren();
  if (!gateView) return;
  container.append(el("h3", { text: `${gateView.title}（闸门${gateView.gate}）` }));
  const pre = el("pre", { class: "gate-lines", text: gateView.lines.join("\n") });
  container.append(pre);
  const comment = el("input", { id: "gate-comment", placeholder: "驳回注释（回退目标自动取默认）" });
  const approve = el("button", { id: "gate-approve", text: "批准", onclick: () => onDecide({ gate: gateView.gate, action: "approve" }) });
  const reject = el("button", {
    id: "gate-reject",
    text: "驳回",
    onclick: () => onDecide({ gate: gateView.gate, action: "reject", targetPhase: defaultRejectTarget(gateView.gate), comment: comment.value || undefined }),
  });
  container.append(el("div", { class: "gate-actions" }, approve, reject, comment));
}

function defaultRejectTarget(gate) {
  return { 1: "parsing", 2: "planning", 3: "retrieving", 4: "assembling", 5: "planning" }[gate] || "planning";
}

/** 8.5 集群监控视图 */
export function renderCluster(container, events) {
  container.replaceChildren();
  for (const e of events.slice(-20)) {
    const text = e.type === "worker:started" ? `▶ ${e.nodeId} 启动（${e.capabilityId}）`
      : e.type === "worker:finished" ? `✓ ${e.nodeId} 完成（${e.durationMs}ms）`
      : `✗ ${e.nodeId} 失败：${e.error}`;
    container.append(el("div", { class: `cluster-event cluster-${e.type.replace(":", "-")}`, text }));
  }
}

/** 8.6 场景库视图：卡片 + 详情 */
export function renderScenarios(container, scenarios) {
  container.replaceChildren();
  if (!scenarios || scenarios.length === 0) {
    container.append(el("div", { class: "scenarios-empty", text: "场景库为空" }));
    return;
  }
  for (const s of scenarios) {
    const card = el("div", { class: `scenario-card${s.degraded ? " degraded" : ""}`, "data-id": s.id },
      el("strong", { text: s.name }),
      el("span", { class: "scenario-meta", text: `v${s.version} · 使用 ${s.uses} 次 · 成功 ${s.successes}${s.degraded ? " · ⚠已降级" : ""}` }),
    );
    card.addEventListener("click", () => {
      const detail = el("div", { class: "scenario-detail", text: `${s.id} 的蒸馏产物与统计（详情接口）` });
      container.append(detail);
    });
    container.append(card);
  }
}

/** 8.7 Memory 树视图：Markdown 渲染（标题/列表最小子集） */
export function renderMemoryTree(container, tree, fileLoader) {
  container.replaceChildren();
  if (!tree || !tree.children) return;
  const renderNode = (node) => {
    if (node.kind === "dir") {
      const details = el("details", { class: "mem-dir" }, el("summary", { text: node.name }));
      for (const child of node.children || []) details.append(renderNode(child));
      return details;
    }
    const link = el("a", { class: "mem-file", text: node.name, href: "#" });
    link.addEventListener("click", async (e) => {
      e.preventDefault();
      const md = fileLoader ? await fileLoader(node.path) : "";
      const viewer = $("memory-viewer") || el("div", { id: "memory-viewer" });
      container.append(viewer);
      viewer.replaceChildren(...renderMarkdown(md));
    });
    return link;
  };
  for (const child of tree.children || []) container.append(renderNode(child));
}

export function renderMarkdown(md) {
  const out = [];
  for (const line of String(md).split("\n")) {
    if (line.startsWith("### ")) out.push(el("h4", { text: line.slice(4) }));
    else if (line.startsWith("## ")) out.push(el("h3", { text: line.slice(3) }));
    else if (line.startsWith("# ")) out.push(el("h2", { text: line.slice(2) }));
    else if (line.startsWith("- ")) out.push(el("li", { text: line.slice(2) }));
    else if (line.trim().length > 0) out.push(el("p", { text: line }));
  }
  return out;
}

/** 8.8 目标模式轮次时间线（两轮放行操作历史） */
export function renderLoopTimeline(container, events) {
  container.replaceChildren();
  for (const e of events) {
    const text = e.type === "round:start" ? `轮 ${e.round} 开始`
      : e.type === "round:end" ? `轮 ${e.result.round} 结束（${e.result.summary || "无摘要"}）`
      : e.type === "round:gate" ? `轮 ${e.result.round} 放行：${e.decision.action}`
      : `循环结束：${e.reason}（${e.rounds} 轮）`;
    container.append(el("div", { class: `loop-event loop-${e.type.replace(":", "-")}`, text }));
  }
}

function addLog(text, cls = "") {
  const log = $("dialogue-log");
  if (!log) return;
  log.append(el("div", { class: `log-line ${cls}`, text }));
  log.scrollTop = log.scrollHeight;
}

let metaEl;
function setMeta(text) {
  const log = $("dialogue-log");
  if (!log) return;
  if (!metaEl || !log.contains(metaEl)) {
    metaEl = el("div", { class: "snapshot-meta" });
    log.prepend(metaEl);
  }
  metaEl.textContent = text;
}

/** 主入口：连接 WS + 数据联通 */
export function startPanel(opts = {}) {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${protocol}://${location.host}/ws`);
  ws.addEventListener("open", () => addLog("已连接面板服务。输入需求开始一次五闸门构建。"));
  ws.addEventListener("message", (msg) => {
    let data;
    try { data = JSON.parse(msg.data); } catch { return; }
    if (data.kind === "snapshot") {
      renderSnapshot(data.snapshot);
    } else if (data.kind === "state") {
      addLog(`▶ 进入阶段：${data.phase}`);
    } else if (data.kind === "gate") {
      addLog(`⏸ 闸门 ${data.gate} 挂起：${data.title} —— 请在右侧批准/驳回`, "log-gate");
      renderGate($("gate-view"), { gate: data.gate, title: data.title, lines: data.lines }, sendDecision);
    } else if (data.kind === "cluster") {
      renderCluster($("cluster-view"), [data.event]);
    } else if (data.kind === "loop") {
      renderLoopTimeline($("loop-timeline"), [data.event]);
    } else if (data.kind === "action-result") {
      addLog(data.ok ? "✓ 操作已受理" : `✗ ${data.error ?? "操作失败"}`, data.ok ? "log-ok" : "log-err");
    } else if (data.kind === "run-error") {
      addLog(`✗ 构建失败：${data.message}`, "log-err");
    } else if (data.kind === "run-done") {
      addLog(`✓ 构建完成：${data.buildId}（已固化场景 + 写入 Memory）`, "log-ok");
    }
  });
  function sendDecision(decision) {
    ws.send(JSON.stringify({ type: "gate-decision", decision }));
  }
  function startBuild() {
    const input = $("req-input");
    const requirement = (input?.value ?? "").trim();
    if (requirement.length < 2) {
      addLog("请先输入至少 2 个字符的需求", "log-err");
      return;
    }
    addLog(`➤ 发起构建：${requirement}`);
    ws.send(JSON.stringify({ type: "start-build", requirement }));
  }
  const go = $("req-go");
  const input = $("req-input");
  if (go) go.addEventListener("click", startBuild);
  if (input) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") startBuild();
    });
  }
  function renderSnapshot(snap) {
    renderDag($("dag-view"), snap.dag, snap.trace);
    renderGate($("gate-view"), snap.gateView, sendDecision);
    renderCluster($("cluster-view"), snap.cluster);
    renderScenarios($("scenario-cards"), snap.scenarios);
    renderMemoryTree($("memory-tree"), snap.memoryTree, opts.fileLoader);
    renderLoopTimeline($("loop-timeline"), snap.loop);
    setMeta(`阶段: ${snap.phase} · 构建: ${snap.buildId ?? "—"} · 场景: ${snap.scenarios.length}`);
  }
  return ws;
}

if (typeof window !== "undefined" && document.getElementById("app")) {
  window.addEventListener("DOMContentLoaded", () => startPanel());
}
