import "./panel.css";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { commandSuggestions, type CommandDefinition } from "./commands.js";
import { pendingLongRunForSession, shouldResetChatScroll, type PendingLongRunConfig } from "./chat-state.js";

type PanelMode = "work" | "build";
type Tone = "info" | "ok" | "err";

interface GateCardMessage {
  role: "gate-card";
  gate: number;
  title: string;
  lines: string[];
  editSeed?: unknown;
  canPin?: boolean;
  approvalIndex?: number;
  stale?: boolean;
  decided?: { action: "approve" | "reject" | "edit"; targetPhase?: string };
  ts?: number;
}

interface BuildStatusMessage {
  role: "build-status";
  tone: Tone;
  text: string;
  terminal?: boolean;
  /** Optional next step shown inline when the current mode cannot continue. */
  action?: "switch-to-build";
  requirement?: string;
  ts?: number;
}

/** SceneFlow 进度卡：构建过程唯一的过程性消息——服务端 pushProgress 原地更新，不追加。 */
interface ProgressCardMessage {
  role: "progress-card";
  runId: string;
  phase: string | null;
  /** 最新一行叙述（步骤文本） */
  line: string;
  /** LLM 流式叙述（逐字累积） */
  narration: string;
  /** 分源检索微状态 */
  sources: Array<{ id: string; ok: boolean; done: boolean }>;
  sourcesTotal: number;
  /** 完整步骤时间线（折叠区）；nodeId/status 来自工作模式节点级事件 */
  steps: Array<{ at: number; text: string; nodeId?: string; status?: "running" | "ok" | "err" }>;
  startedAt: number;
  finishedAt: number | null;
  ts?: number;
}
interface ActivityGroupMessage { role: "activity-group"; items: Array<{ tone?: Tone; text?: string; ts?: number }>; ts?: number; }
interface RunGroupMessage { role: "run-group"; user: Record<string, unknown>; items: Array<Record<string, unknown>>; expanded: boolean; groupId?: string; }
interface AwaitingUserMessage { role: "awaiting-user"; runId: string; question: string; inputs: Array<{ name: string; description: string; type: string }>; ts?: number; }
interface ThinkingMessage { role: "model-thinking"; content?: string; text?: string; streaming?: boolean; ts?: number; nodeId?: string; }
interface ToolActivityMessage { role: "tool-call" | "tool-result"; toolName?: string; toolCallId?: string; arguments?: Record<string, unknown>; content?: string; ts?: number; nodeId?: string; }

interface ScenarioSummary {
  id: string;
  name: string;
  goal: string;
  projectId: string | null;
  uses: number;
  successes: number;
  degraded: boolean;
  version: number;
  status: string;
  historyCount: number;
  versionHistory: Array<{ version: number; capabilityIds: string[]; createdAt: string; reason: string }>;
  slotDefs: Array<{ name: string; type?: string; required?: boolean; description?: string }>;
  capabilityCount: number;
  source: string;
}
interface SessionSummary { id: string; title: string; mode: PanelMode; projectId: string | null; messageCount: number; createdAt: string; updatedAt: string; archived: boolean; }
interface PublicSettings { baseUrl: string; model: string; plannerModel: string | null; fallbackModel: string | null; temperature: number; maxTokens: number | null; timeoutMs: number; hasApiKey: boolean; apiKeyMasked: string; useHistory: boolean; autoMemory: boolean; temporarySession: boolean; providerId: string | null; streaming: boolean; syncEndpoint: string | null; hasSyncToken: boolean; syncTokenMasked: string; }
interface ProjectSummary {
  id: string;
  name: string;
  rootPath?: string | null;
  description: string;
  instructions: string;
  pinned: boolean;
  providerId: string | null;
  status: string;
  /** Folder-style inventory counts supplied by the panel snapshot. */
  sessionCount?: number;
  fileCount?: number;
  memoryCount?: number;
  scenarioCount?: number;
}
interface ConnectorSummary { id: string; name: string; kind: string; status: string; endpoint: string | null; permissionScopes: string[]; hasSecret: boolean; source: string; trustStatus: string; trustScore: number; trustEvidenceCount: number; lastHealthAt: string | null; lastError: string | null; }
interface RunSummary { id: string; mode: PanelMode; status: string; requirement: string; scenarioId: string | null; model: string; startedAt: string; finishedAt: string | null; error: string | null; durationMs: number | null; tokenCount: number | null; cost: number | null; retryCount: number; }
interface ArtifactSummary { id: string; name: string; mediaType: string; projectId: string | null; sessionId: string | null; runId: string | null; version: number; status: string; path: string; createdAt: string; updatedAt: string; }
interface ProviderSummary { id: string; name: string; kind: string; baseUrl: string; model: string; enabled: boolean; hasSecret: boolean; timeoutMs: number; contextLength: number | null; supportsTools: boolean; supportsVision: boolean; supportsStructuredOutput: boolean; costPerMillion: number | null; rateLimit: number | null; createdAt: string; updatedAt: string; }
interface TaskSummary { id: string; requirement: string; schedule: string; enabled: boolean; projectId: string | null; scenarioId: string | null; lastRunId: string | null; lastRunAt: string | null; lastRunStatus: string | null; lastError: string | null; failureCount: number; runCount: number; maxRuns: number | null; timeoutMs: number; createdAt: string; updatedAt: string; }
interface LongRunSummary { id: string; workspaceId: string; projectId: string | null; sessionId: string | null; scenarioId: string; goal: string; maxRounds: number; nextRound: number; completedRounds: number; status: string; terminalReason: string | null; nextInstruction: string | null; lastRound: number | null; lastSummary: string | null; lastMetrics: Record<string, number>; lastError: string | null; pauseRequested: boolean; revision: number; startedAt: string | null; finishedAt: string | null; createdAt: string; updatedAt: string; }
interface MemorySummary { id: string; name: string; scope: string; enabled: boolean; sourceType: string; sourceId: string | null; path: string | null; updatedAt: string; }
interface AuditSummary { id: string; actor: string; action: string; resourceType: string; resourceId: string; summary: string; createdAt: string; }
interface IdentitySummary { id: string; workspaceId: string; displayName: string; role: string; status: string; createdAt: string; updatedAt: string; }
interface ShareSummary { id: string; resourceType: string; resourceId: string; role: string; tokenMasked: string; expiresAt: string | null; createdAt: string; }

interface PanelSnapshot {
  mode: PanelMode;
  activeScenarioId: string | null;
  chat: Array<Record<string, unknown>>;
  preview: {
    goal: string | null;
    context: { projectInstructions: string; fileCount: number; memoryCount: number; connectorCount: number; desktopContextCount: number; providerModel: string | null };
    planner: { requested: string; actual: string; fallbackReason: string | null; attempts: number } | null;
    selections: Array<{ nodeId: string; capabilityId: string; name: string; source: string; tier: string; trust: number; requiresAuth: boolean }>;
    acceptance: Array<{ layer: string; passed: boolean; verified?: boolean }>;
  };
  buildId: string | null;
  phase: string;
  pendingGate: number | null;
  dag: { nodes?: Array<{ id: string; title: string; deps: string[] }> } | null;
  trace: Array<{ nodeId: string; status?: string }>;
  scenarios: ScenarioSummary[];
  availableScenarios: ScenarioSummary[];
  memoryTree: { name: string; kind: string; path?: string; children?: unknown[] } | null;
  sessions: SessionSummary[];
  sessionId: string | null;
  settings: PublicSettings | null;
  hostExecution: { enabled: boolean; allowedCommands: string[]; workspaceRoot: string | null; installRoot: string | null; maxTimeoutMs: number | null; maxOutputBytes: number | null; error: string | null };
  busy: boolean;
  run: { kind: "idle" | "work" | "build"; status: "idle" | "running" | "waiting-gate" | "waiting-user" | "paused" | "succeeded" | "failed" | "cancelled"; runId?: string; scenarioId?: string; text?: string };
  awaitingUser: AwaitingUserMessage | null;
  workspace: { id: string; name: string } | null;
  projectId: string | null;
  projects: ProjectSummary[];
  files: Array<{ id: string; name: string; path: string; mediaType: string; size: number; indexed: boolean }>;
  connectors: ConnectorSummary[];
  contexts: Array<{ id: string; kind: string; origin: string; label: string; enabled: boolean; projectId: string | null; updatedAt: string }>;
  policy: { read: boolean; write: boolean; install: boolean; network: boolean; send: boolean; approvalMode: string } | null;
  comments: Array<{ id: string; resourceType: string; resourceId: string; author: string; body: string; resolved: boolean; createdAt: string; updatedAt: string }>;
  identities: IdentitySummary[];
  shares: ShareSummary[];
  memoryItems: MemorySummary[];
  runs: RunSummary[];
  artifacts: ArtifactSummary[];
  providers: ProviderSummary[];
  tasks: TaskSummary[];
  longRuns: LongRunSummary[];
  audit: AuditSummary[];
  revision: number;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;
function focusModalControl(modalId: string, preferredId?: string): void {
  window.setTimeout(() => {
    const modal = $(modalId);
    if (!modal || modal.classList.contains("hidden")) return;
    const preferred = preferredId ? $(preferredId) : null;
    if (preferred && isVisibleElement(preferred)) { preferred.focus(); return; }
    modal.querySelector<HTMLElement>("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])")?.focus();
  }, 0);
}
let ws: WebSocket | undefined;
let reconnectTimer: number | undefined;
let reconnectAttempts = 0;
const RECONNECT_MAX_DELAY_MS = 30_000;
let panelMode: PanelMode = "work";
let busy = false;
let currentSnapshot: PanelSnapshot | null = null;
let messages: Array<Record<string, unknown>> = [];
const pendingActions = new Map<string, { type: string; gate?: number }>();
let requestSequence = 0;
const pendingDecisions = new Set<number>();
let editingMemoryPath: string | null = null;
let editingMemoryId: string | undefined;
let editingProjectId: string | null = null;
let selectedRunId: string | null = null;
const selectedRunIds = new Set<string>();
let editingTaskId: string | null = null;
let pendingLongRunConfig: PendingLongRunConfig | null = null;
let artifactsExpanded = false;
let commandIndex = 0;
const inputHistory: string[] = [];
let inputHistoryIndex = -1;
let composerComposing = false;
let composerCompositionEndedAt = 0;
let railPreviousFocus: HTMLElement | null = null;
let inspectorPreviousFocus: HTMLElement | null = null;
let utilityPreviousFocus: HTMLElement | null = null;
// `renderChat` deliberately rebuilds the message list so streamed output can
// be rendered from one source of truth. Keep disclosure state separately so a
// user's decision to inspect or collapse a historical run survives that redraw.
const timelineExpanded = new Map<string, boolean>();
// Thinking disclosures remain inspectable after a stream redraw. While a
// provider is still sending reasoning chunks the block is forced open; once
// complete, the user's last disclosure choice is retained.
const thinkingExpanded = new Map<string, boolean>();
const toolExpanded = new Map<string, boolean>();
// Model output can arrive as dozens of small chunks per second. Rebuilding
// the entire conversation DOM for each chunk makes the stream visibly jump
// and needlessly reflows the side panels. Keep the authoritative message list
// unchanged, but coalesce DOM work into one frame.
let chatRenderScheduled = false;
// A snapshot or a newly submitted request starts a new visible conversation
// position. Ordinary stream chunks must never pull someone who is reading the
// top of the history back to the bottom.
let chatNeedsInitialScroll = true;
let hasReceivedSnapshot = false;
let snapshotSessionId: string | null | undefined;

/**
 * Focus restoration must account for responsive CSS, not only `.hidden`.
 * The mobile rail is removed with `display: none` when its drawer closes, so
 * an element can remain connected and still be impossible for a user to see
 * or reach with a keyboard.
 */
function isVisibleElement(element: HTMLElement | null): element is HTMLElement {
  if (!element || !element.isConnected || element.closest(".hidden") || element.getAttribute("aria-hidden") === "true") return false;
  return element.getClientRects().length > 0;
}

function scheduleChatRender(): void {
  if (chatRenderScheduled) return;
  chatRenderScheduled = true;
  const render = () => {
    chatRenderScheduled = false;
    renderChat();
  };
  if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(render);
  else window.setTimeout(render, 0);
}

function applyTheme(theme: "light" | "dark"): void {
  document.documentElement.dataset.theme = theme;
  try { window.localStorage.setItem("scenario-panel-theme", theme); } catch { /* storage can be unavailable in embedded previews */ }
  const toggle = $("toggle-theme");
  if (toggle) {
    toggle.textContent = theme === "dark" ? "☼" : "☾";
    toggle.setAttribute("aria-label", theme === "dark" ? "切换到亮色主题" : "切换到暗色主题");
    toggle.setAttribute("title", theme === "dark" ? "切换到亮色主题" : "切换到暗色主题");
  }
}

function initializeTheme(): void {
  // ?theme=dark|light 优先（自动化验收/分享链接用），其次用户保存的偏好
  let theme: "light" | "dark" = "light";
  try {
    const param = new URLSearchParams(window.location.search).get("theme");
    if (param === "dark" || param === "light") theme = param;
    else {
      const saved = window.localStorage.getItem("scenario-panel-theme");
      if (saved === "dark" || saved === "light") theme = saved;
    }
  } catch { /* use the product default */ }
  applyTheme(theme);
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  return el;
}

function textBlock(text: unknown, className = ""): HTMLDivElement {
  const el = node("div", className);
  el.textContent = String(text ?? "");
  return el;
}

async function copyText(value: string): Promise<boolean> {
  if (!value) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch { /* fall through to the local, non-permission API */ }
  // The fallback keeps copying useful in an embedded HTTP panel where the
  // Clipboard API can be unavailable or denied. It never injects the value as
  // HTML and removes the temporary selection immediately.
  try {
    const area = node("textarea") as HTMLTextAreaElement;
    area.value = value; area.setAttribute("readonly", "");
    area.style.position = "fixed"; area.style.opacity = "0"; area.style.pointerEvents = "none";
    document.body.append(area); area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  } catch { return false; }
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value, null, 2); } catch { return "{}"; }
}

function renderCommandMenu(input: string): void {
  const menu = $("command-menu");
  if (!menu) return;
  const inputElement = $("req-input") as HTMLTextAreaElement | null;
  const suggestions = commandSuggestions(input);
  if (!suggestions.length) {
    menu.classList.add("hidden"); menu.replaceChildren();
    inputElement?.setAttribute("aria-expanded", "false");
    inputElement?.removeAttribute("aria-activedescendant");
    return;
  }
  commandIndex = Math.min(commandIndex, suggestions.length - 1);
  menu.classList.remove("hidden");
  inputElement?.setAttribute("aria-expanded", "true");
  menu.replaceChildren(...suggestions.map((command: CommandDefinition, index: number) => {
    const button = node("button", `command-item${index === commandIndex ? " active" : ""}`);
    button.type = "button"; button.dataset.command = command.usage;
    button.id = `command-option-${index}`;
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(index === commandIndex));
    button.append(textBlock(command.usage, "command-name"), textBlock(command.description, "command-description"));
    return button;
  }));
  inputElement?.setAttribute("aria-activedescendant", `command-option-${commandIndex}`);
}

function setConnection(online: boolean): void {
  const dot = $("connection-dot");
  const label = $("connection-text");
  dot?.classList.toggle("offline", !online);
  if (label) label.textContent = online ? "已连接" : "正在重连";
  label?.setAttribute("role", "status");
  label?.setAttribute("aria-live", "polite");
}

function setBusy(next: boolean): void {
  busy = next;
  const input = $("req-input") as HTMLTextAreaElement | null;
  const send = $("req-go") as HTMLButtonElement | null;
  if (input) { input.disabled = false; input.placeholder = next ? "运行中输入引导或纠正，例如：下一步改读 docs/meeting.md" : modeText(panelMode).placeholder; }
  if (send) { send.disabled = !input?.value.trim(); send.textContent = next ? "引导" : "↑"; send.setAttribute("aria-label", next ? "发送运行中引导" : "发送"); }
  const hint = $("composer-hint"); if (hint) hint.textContent = next ? "运行中输入引导 · 回车发送给当前运行 · 停止后可重试" : "回车发送 · 输入 / 查看命令 · Shift + 回车换行";
  document.querySelectorAll<HTMLButtonElement>(".mode-btn").forEach((button) => { button.disabled = next; });
  $("run-stop")?.classList.toggle("hidden", !next);
  $("compact-run-stop")?.classList.toggle("hidden", !next);
  document.querySelector<HTMLElement>(".app-shell")?.setAttribute("aria-busy", String(next));
  $("run-phase")?.setAttribute("aria-live", "polite");
}

function setRailOpen(open: boolean): void {
  const rail = document.querySelector<HTMLElement>(".rail");
  const backdrop = $("rail-backdrop");
  const button = $("open-rail");
  if (!rail || !backdrop || !button) return;
  if (open) {
    // The two compact drawers share the same edge of the viewport. Close the
    // inspector before opening the rail so their focus scopes and backdrops
    // cannot overlap on a phone.
    const inspector = document.querySelector<HTMLElement>(".inspector");
    if (inspector?.classList.contains("responsive-open")) {
      inspector.classList.remove("responsive-open");
      inspector.setAttribute("aria-hidden", "true");
      $("open-inspector")?.setAttribute("aria-expanded", "false");
      inspectorPreviousFocus = null;
    }
  }
  if (open && !rail.classList.contains("responsive-open")) {
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    railPreviousFocus = isVisibleElement(active) ? active : button;
  }
  rail.classList.toggle("responsive-open", open);
  backdrop.classList.toggle("hidden", !open);
  backdrop.setAttribute("aria-hidden", String(!open));
  button.setAttribute("aria-expanded", String(open));
  document.body.classList.toggle("rail-open", open);
  if (open) {
    window.setTimeout(() => {
      if (!rail.classList.contains("responsive-open")) return;
      const first = rail.querySelector<HTMLElement>("button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])");
      first?.focus();
    }, 0);
  } else {
    const restore = railPreviousFocus;
    railPreviousFocus = null;
    if (isVisibleElement(restore)) window.setTimeout(() => restore.focus(), 0);
  }
}

function setInspectorOpen(open: boolean): void {
  const inspector = document.querySelector<HTMLElement>(".inspector");
  const button = $("open-inspector");
  if (!inspector || !button) return;
  if (open) {
    // Keep only one compact drawer mounted over the chat surface at a time.
    // The rail's backdrop must not obscure the inspector opened from More.
    const rail = document.querySelector<HTMLElement>(".rail");
    const backdrop = $("rail-backdrop");
    if (rail?.classList.contains("responsive-open")) {
      rail.classList.remove("responsive-open");
      backdrop?.classList.add("hidden");
      backdrop?.setAttribute("aria-hidden", "true");
      $("open-rail")?.setAttribute("aria-expanded", "false");
      document.body.classList.remove("rail-open");
      railPreviousFocus = null;
    }
  }
  if (open && !inspector.classList.contains("responsive-open")) {
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // On compact screens the inspector is reached through the utility menu.
    // That menu is hidden before the drawer opens, so its item cannot be a
    // valid restoration target. Keep focus on the visible menu opener instead.
    inspectorPreviousFocus = isVisibleElement(active) ? active : $("open-more") ?? button;
  }
  inspector.classList.toggle("responsive-open", open);
  inspector.classList.toggle("open", open);
  inspector.setAttribute("aria-hidden", String(!open));
  button.setAttribute("aria-expanded", String(open));
  const insBackdrop = $("inspector-backdrop");
  if (insBackdrop) {
    insBackdrop.classList.toggle("hidden", !open);
    insBackdrop.setAttribute("aria-hidden", String(!open));
  }
  if (open) {
    window.setTimeout(() => {
      if (!inspector.classList.contains("responsive-open")) return;
      const first = inspector.querySelector<HTMLElement>("button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])");
      first?.focus();
    }, 0);
  } else {
    const restore = inspectorPreviousFocus;
    inspectorPreviousFocus = null;
    if (isVisibleElement(restore)) window.setTimeout(() => restore.focus(), 0);
  }
}

function setUtilityMenuOpen(open: boolean, restoreFocus = true): void {
  const menu = $("utility-menu");
  const button = $("open-more");
  if (!menu || !button) return;
  if (open && menu.classList.contains("hidden")) {
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    utilityPreviousFocus = isVisibleElement(active) ? active : button;
  }
  menu.classList.toggle("hidden", !open);
  button.setAttribute("aria-expanded", String(open));
  if (open) {
    window.setTimeout(() => {
      if (!menu.classList.contains("hidden")) menu.querySelector<HTMLElement>("[role=menuitem]:not([disabled])")?.focus();
    }, 0);
  } else {
    const restore = restoreFocus ? utilityPreviousFocus : null;
    utilityPreviousFocus = null;
    if (isVisibleElement(restore)) window.setTimeout(() => restore.focus(), 0);
  }
}

function friendlyRunStatus(status: string): string {
  return ({
    idle: "空闲",
    running: "运行中",
    "waiting-gate": "等待确认",
    "waiting-user": "等待补充",
    paused: "已暂停",
    succeeded: "已完成",
    failed: "失败",
    cancelled: "已终止",
    untested: "未验证",
  } as Record<string, string>)[status] ?? status;
}

function modeText(mode: PanelMode): { kicker: string; title: string; description: string; copy: string; placeholder: string } {
  return mode === "work"
    ? { kicker: "当前项目 · 工作模式", title: "你现在想完成什么？", description: "直接描述目标。我会先判断已有场景和可用工具，需要新能力时再进入构建。", copy: "描述目标，直接开始一次工作。", placeholder: "例如：整理 /data/meeting.md 并生成行动项" }
    : { kicker: "SceneFlow · 场景构建", title: "把一次工作变成可复用场景", description: "先确认目标、步骤和工具，再决定是否保存为场景。", copy: "把重复工作整理成下次可直接使用的场景。", placeholder: "例如：每周整理销售数据并生成周报" };
}

function applyMode(mode: PanelMode): void {
  panelMode = mode;
  const meta = modeText(mode);
  const shell = document.querySelector<HTMLElement>(".app-shell");
  shell?.setAttribute("data-mode", mode);
  document.querySelectorAll<HTMLButtonElement>(".mode-btn").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === mode);
    button.setAttribute("aria-selected", String(button.dataset.mode === mode));
    button.tabIndex = button.dataset.mode === mode ? 0 : -1;
  });
  const kicker = $("chat-kicker"); if (kicker) kicker.textContent = meta.kicker;
  const title = $("chat-title"); if (title) title.textContent = meta.title;
  const description = $("chat-description"); if (description) description.textContent = meta.description;
  const copy = $("mode-copy"); if (copy) copy.textContent = meta.copy;
  const input = $("req-input") as HTMLTextAreaElement | null; if (input) input.placeholder = meta.placeholder;
  const inspector = $("inspector-subtitle"); if (inspector && !currentSnapshot?.preview.goal) inspector.textContent = mode === "work" ? "工作模式会先尝试复用场景" : "构建模式会生成新的场景方案";
}

function syncModeLabels(): void {
  const compact = window.matchMedia("(max-width: 720px)").matches;
  document.querySelectorAll<HTMLButtonElement>(".mode-btn").forEach((button) => {
    const full = button.dataset.mode === "build" ? "场景构建" : "工作模式";
    button.textContent = compact ? (button.dataset.mode === "build" ? "构建" : "工作") : full;
    button.setAttribute("aria-label", full);
    button.title = full;
  });
}

function renderHeaderContext(snap: PanelSnapshot): void {
  const strip = $("chat-context-strip"); if (!strip) return;
  strip.replaceChildren();
  const project = snap.projects.find((item) => item.id === snap.projectId);
  const untested = snap.run.status === "failed" && /未验证|Provider 不可用/.test(snap.run.text ?? "");
  const configuredModel = snap.settings?.model ?? snap.settings?.plannerModel;
  const chips = [
    project ? `项目 · ${project.name}` : "未选择项目",
    snap.preview.context.providerModel ? `模型 · ${snap.preview.context.providerModel}` : configuredModel ? `模型 · ${configuredModel}` : "模型 · 默认",
    untested ? "状态 · 未验证" : `状态 · ${friendlyRunStatus(snap.run.status)}`,
    `记忆 · ${snap.preview.context.memoryCount}`,
  ];
  for (const value of chips) strip.append(textBlock(value, "context-chip"));
}

function phaseLabel(phase: string, gate: number | null): { label: string; index: number } {
  if (gate) return { label: ({ 1: "请确认目标", 2: "请确认步骤", 3: "请确认能力", 4: "请确认流程", 5: "请决定是否保存" } as Record<number, string>)[gate] ?? "请确认下一步", index: Math.max(0, gate - 1) };
  const map: Record<string, { label: string; index: number }> = {
    parsing: { label: "理解你的目标", index: 0 },
    planning: { label: "拆分成几步", index: 1 },
    retrieving: { label: "寻找合适能力", index: 2 },
    assembling: { label: "组合执行流程", index: 3 },
    executing: { label: "按计划执行", index: 4 },
    verifying: { label: "检查是否可用", index: 4 },
    distilling: { label: "整理成可复用场景", index: 4 },
    done: { label: "已经完成", index: 4 },
    failed: { label: "需要处理问题", index: 4 },
  };
  return map[phase] ?? { label: "等待输入", index: -1 };
}

function renderProgress(snap: PanelSnapshot): void {
  const untested = snap.run.status === "failed" && /未验证|Provider 不可用/.test(snap.run.text ?? "");
  const phase = untested
    ? { label: "未验证", index: 4 }
    : snap.run.status === "succeeded"
    ? { label: "已经完成", index: 4 }
    : snap.run.status === "failed"
      ? { label: "运行失败", index: 4 }
      : snap.run.status === "cancelled"
        ? { label: "已终止", index: 4 }
        : phaseLabel(snap.phase, snap.pendingGate);
  const phaseEl = $("run-phase"); if (phaseEl) phaseEl.textContent = phase.label;
  const label = $("progress-label"); if (label) label.textContent = phase.label;
  const count = $("progress-count"); if (count) count.textContent = phase.index < 0 ? "0 / 5" : `${Math.min(5, phase.index + 1)} / 5`;
  document.querySelectorAll<HTMLElement>(".progress-step").forEach((step, index) => {
    step.classList.toggle("done", phase.index >= 0 && index < phase.index);
    step.classList.toggle("active", index === phase.index);
  });
}

function renderDag(snap: PanelSnapshot): void {
  const box = $("dag-view"); if (!box) return;
  box.replaceChildren();
  const nodes = snap.dag?.nodes ?? [];
  if (!nodes.length) { box.append(textBlock("构建或运行后显示", "inspector-subtitle")); return; }
  const statusOf = (id: string) => snap.trace.find((step) => step.nodeId === id)?.status ?? "pending";
  const statusText = (status: string) => ({ success: "完成", running: "运行中", failed: "失败", skipped: "已定义", delegated: "宿主执行", pending: "等待" } as Record<string, string>)[status] ?? status;
  for (const item of nodes) {
    const phaseStatus = statusOf(item.id);
    const row = node("div", `dag-node status-${phaseStatus}`);
    const dot = node("span", "dag-dot");
    const title = textBlock(item.title, "dag-title");
    const status = textBlock(statusText(phaseStatus), "dag-status");
    row.append(dot, title, status);
    box.append(row);
  }
}

function renderPreview(snap: PanelSnapshot): void {
  const longRun = snap.longRuns.find((run) => run.id === snap.run.runId) ?? snap.longRuns.find((run) => run.sessionId === snap.sessionId && ["queued", "running", "paused"].includes(run.status));
  const isLongRun = Boolean(longRun && ["queued", "running", "paused"].includes(longRun.status));
  const longSummary = $("long-run-summary");
  if (longSummary) {
    longSummary.classList.toggle("hidden", !longRun);
    if (longRun) longSummary.textContent = `长程进度 ${longRun.completedRounds}/${longRun.maxRounds} 轮 · ${longRun.status === "paused" ? "已暂停" : longRun.status === "running" ? "运行中" : longRun.status}`;
  }
  const goal = $("preview-goal"); if (goal) goal.textContent = snap.preview.goal ?? snap.run.text ?? "还没有开始运行";
  const alert = $("run-alert");
  if (alert) {
    const failed = snap.run.status === "failed";
    const untested = failed && /未验证|Provider 不可用/.test(snap.run.text ?? "");
    alert.classList.toggle("hidden", !failed);
    alert.classList.toggle("ok", snap.run.status === "succeeded");
    alert.classList.toggle("warning", untested);
    alert.textContent = failed ? (untested ? `运行未验证：${snap.run.text || "模型 Provider 不可用，已保存草稿。"}` : `运行失败：${snap.run.text || "流程没有完成，请查看聊天中的错误详情。"}`) : "";
  }
  const context = $("context-view"); if (context) { const item = snap.preview.context; const planner = snap.preview.planner; const configuredModel = snap.settings?.model ?? snap.settings?.plannerModel; context.replaceChildren(textBlock(`文件 ${item.fileCount} · Memory ${item.memoryCount} · 桌面上下文 ${item.desktopContextCount} · 连接器 ${item.connectorCount}`, "context-meta"), textBlock(item.providerModel ? `Provider · ${item.providerModel}` : configuredModel ? `Provider · ${configuredModel}` : "Provider · 默认设置", "context-meta"), planner ? textBlock(`规划器 · ${planner.actual}${planner.fallbackReason ? ` · 降级：${planner.fallbackReason}` : ""}`, "context-meta") : textBlock("规划器 · 等待运行", "context-meta"), textBlock(item.projectInstructions || "项目没有额外指令", "context-instructions")); }
  const inspector = $("inspector-subtitle"); if (inspector) {
    const untested = snap.run.status === "failed" && /未验证|Provider 不可用/.test(snap.run.text ?? "");
    inspector.textContent = isLongRun && longRun ? `长程场景 · 第 ${longRun.completedRounds} / ${longRun.maxRounds} 轮${longRun.status === "paused" ? " · 已暂停" : ""}`
      : snap.run.status === "succeeded" ? "本次运行已完成，可查看过程与产物"
      : untested ? "本次运行未验证，已保存草稿；配置 Provider 后可重试"
        : snap.run.status === "failed" ? (snap.run.text ? `运行失败：${snap.run.text}` : "本次运行失败，请查看过程记录")
        : snap.run.status === "cancelled" ? "本次运行已终止"
          : snap.run.kind === "work" && snap.run.text ? snap.run.text
            : snap.buildId ? `运行 ${snap.buildId}`
              : panelMode === "work" ? "工作模式会先尝试复用场景" : "构建模式会生成新的场景方案";
  }
  const canPause = isLongRun ? longRun?.status === "running" : snap.busy && snap.run.status === "running";
  const canResume = isLongRun ? longRun?.status === "paused" : snap.busy && snap.run.status === "paused";
  $("run-pause")?.classList.toggle("hidden", !canPause);
  $("compact-run-pause")?.classList.toggle("hidden", !canPause);
  $("run-resume")?.classList.toggle("hidden", !canResume);
  $("compact-run-resume")?.classList.toggle("hidden", !canResume);
  renderProgress(snap);
  renderDag(snap);
  const sel = $("sel-view"); if (sel) {
    sel.replaceChildren();
    if (!snap.preview.selections.length) sel.append(textBlock("尚未选择能力", "inspector-subtitle"));
    // 同名能力去重（7 个节点常选同一规划器，重复 5 行没有信息量）
    const seen = new Set<string>();
    for (const item of snap.preview.selections) {
      const key = `${item.name}|${item.source}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const row = node("div", "selection-row");
      const pill = textBlock(item.tier === "official" ? "官方" : item.tier === "curated" ? "策展" : "聚合", "tier-pill");
      const name = textBlock(item.name);
      const source = textBlock(`${item.source}${item.requiresAuth ? " · 需鉴权" : ""}`, "selection-source");
      row.append(pill, name, source); sel.append(row);
    }
  }
  const acc = $("acc-view"); if (acc) {
    acc.replaceChildren();
    for (const layer of ["component", "task", "generalization"]) {
      const rec = snap.preview.acceptance.find((item) => item.layer === layer);
      const row = node("div", `acceptance-row${rec?.passed ? " pass" : ""}${rec?.verified === false ? " defined" : ""}`);
      const status = !rec ? "—" : rec.verified === false ? "·" : rec.passed ? "✓" : "✕";
      const label = !rec ? layer : rec.verified === false ? `${layer} · 已定义，待首次运行验证` : layer;
      row.append(textBlock(status, "acceptance-icon"), textBlock(label));
      acc.append(row);
    }
  }
}

function renderMarkdown(md: string): HTMLElement[] {
  return md.split("\n").filter((line) => line.trim()).map((line) => {
    if (line.startsWith("# ")) { const el = node("h3"); el.textContent = line.slice(2); return el; }
    if (line.startsWith("## ")) { const el = node("h4"); el.textContent = line.slice(3); return el; }
    if (line.startsWith("- ")) { const el = node("div"); el.textContent = `• ${line.slice(2)}`; return el; }
    return textBlock(line);
  });
}

function renderMemory(snap: PanelSnapshot): void {
  const tree = $("memory-tree"); if (!tree) return;
  tree.replaceChildren();
  const walk = (item: { name: string; kind: string; path?: string; children?: unknown[] }): HTMLElement => {
    if (item.kind === "dir") {
      const details = node("details");
      const summary = node("summary"); summary.textContent = item.name; details.append(summary);
      for (const child of item.children ?? []) details.append(walk(child as { name: string; kind: string; path?: string; children?: unknown[] }));
      return details;
    }
    const metadata = snap.memoryItems.find((entry) => entry.path === item.path);
    const row = node("div", "memory-file-row");
    const link = node("a", "memory-file"); link.textContent = metadata ? `${item.name} · ${metadata.scope}${metadata.enabled ? "" : " · 已停用"}` : item.name; link.href = "#";
    link.addEventListener("click", async (event) => {
      event.preventDefault();
      const viewer = $("memory-viewer"); if (!viewer || !item.path) return;
      viewer.classList.remove("hidden");
      try {
        const response = await fetch("/api/memory-file?path=" + encodeURIComponent(item.path));
         renderMemoryViewer(item.path, response.ok ? await response.text() : "读取失败", metadata?.id);
       } catch { renderMemoryViewer(item.path, "读取失败，请检查面板连接", metadata?.id); }
    });
    row.append(link);
    if (metadata) { const select = node("input") as HTMLInputElement; select.type = "checkbox"; select.dataset.memorySelect = "true"; select.dataset.memoryId = metadata.id; const toggle = node("button", "session-action"); toggle.type = "button"; toggle.dataset.memoryAction = "toggle"; toggle.dataset.memoryId = metadata.id; toggle.dataset.enabled = String(metadata.enabled); toggle.textContent = metadata.enabled ? "停用" : "启用"; row.prepend(select); row.append(toggle); }
    return row;
  };
  for (const child of snap.memoryTree?.children ?? []) tree.append(walk(child as { name: string; kind: string; path?: string; children?: unknown[] }));
}

function renderMemoryViewer(memoryPath: string, content: string, memoryId?: string): void {
  const viewer = $("memory-viewer"); if (!viewer) return;
  const body = node("div", "memory-content"); body.append(...renderMarkdown(content));
  const actions = node("div", "memory-actions");
  const edit = node("button", "ghost-btn"); edit.type = "button"; edit.textContent = "编辑";
  edit.addEventListener("click", () => {
    editingMemoryPath = memoryPath;
    editingMemoryId = memoryId;
    const nameInput = $("memory-name") as HTMLInputElement | null; if (nameInput) nameInput.value = memoryPath.split(/[\\/]/).pop()?.replace(/\.md$/i, "") ?? "";
    const contentInput = $("memory-content") as HTMLTextAreaElement | null; if (contentInput) contentInput.value = content;
    $("memory-modal")?.classList.remove("hidden");
  });
  const remove = node("button", "session-action session-delete"); remove.type = "button"; remove.textContent = "删除";
   remove.addEventListener("click", () => { if (window.confirm("删除这条 Memory？")) sendPayload({ type: "delete-memory", path: memoryPath, memoryId, confirm: true }); });
  actions.append(edit, remove); viewer.replaceChildren(body, actions);
}

function renderScenarios(snap: PanelSnapshot): void {
  const box = $("scenario-cards"); if (!box) return;
  box.replaceChildren();
  const filter = (($("scenario-filter") as HTMLInputElement | null)?.value ?? "").trim().toLowerCase();
  const scenarios = snap.scenarios.filter((item) => !filter || `${item.name} ${item.goal} ${item.source}`.toLowerCase().includes(filter));
  if (!scenarios.length) { box.append(textBlock(snap.scenarios.length ? "没有匹配的场景" : "还没有固化场景", "inspector-subtitle")); return; }
  const renderCards = (items: ScenarioSummary[], target: HTMLElement): void => { for (const item of items) {
    const card = node("div", `scenario-card${item.degraded ? " degraded" : ""}${item.status !== "active" ? " archived" : ""}`);
    if (item.id === snap.activeScenarioId) card.classList.add("active");
    const name = textBlock(item.name, "scenario-name");
    const meta = node("div", "scenario-meta");
    meta.append(textBlock(`v${item.version}`), textBlock(`使用 ${item.uses} · 成功 ${item.successes}${item.degraded ? " · 已降级" : ""}`));
    const actions = node("div", "scenario-actions");
    const use = node("button", "scenario-use"); use.type = "button"; use.dataset.scenarioUse = item.id; use.textContent = item.status === "active" ? "用于新对话" : "不可用"; use.disabled = item.status !== "active";
    const lifecycle = node("button", "session-action"); lifecycle.type = "button"; lifecycle.dataset.scenarioAction = item.status === "archived" ? "restore" : "archive"; lifecycle.dataset.scenarioId = item.id; lifecycle.textContent = item.status === "archived" ? "恢复" : "归档";
    const remove = node("button", "session-action session-delete"); remove.type = "button"; remove.dataset.scenarioAction = "delete"; remove.dataset.scenarioId = item.id; remove.textContent = "删除";
    const exportButton = node("button", "session-action"); exportButton.type = "button"; exportButton.dataset.scenarioAction = "export"; exportButton.dataset.scenarioId = item.id; exportButton.textContent = "导出";
    const share = node("button", "session-action"); share.type = "button"; share.dataset.scenarioAction = "share"; share.dataset.scenarioId = item.id; share.textContent = "分享";
    const test = node("button", "session-action"); test.type = "button"; test.dataset.scenarioAction = "test"; test.dataset.scenarioId = item.id; test.textContent = "泛化测试";
    actions.append(use, lifecycle, test, exportButton, share, remove); card.append(name, meta, actions);
    card.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest("button")) return;
      if (item.status !== "active") return;
      sendPayload({ type: "select-scenario", scenarioId: item.id });
      renderScenarioDetail(item);
    });
    target.append(card);
  } };
  const recent = filter ? scenarios : scenarios.slice(0, 4);
  if (!filter && snap.activeScenarioId && !recent.some((item) => item.id === snap.activeScenarioId)) {
    const active = scenarios.find((item) => item.id === snap.activeScenarioId); if (active) recent.unshift(active);
  }
  renderCards(recent, box);
  const recentIds = new Set(recent.map((item) => item.id));
  const older = filter ? [] : scenarios.filter((item) => !recentIds.has(item.id));
  if (older.length) {
    const details = node("details", "scenario-history-more");
    const summary = node("summary"); summary.append(textBlock("全部场景", "session-group-label"), textBlock(`${older.length}`, "session-history-count"));
    const list = node("div", "scenario-list-collapsed"); renderCards(older, list); details.append(summary, list); box.append(details);
  }
}

function renderScenarioDetail(item: ScenarioSummary): void {
  const detail = $("scenario-detail"); if (!detail) return;
  detail.replaceChildren();
  detail.append(textBlock(item.name, "scenario-detail-title"), textBlock(`${item.goal || "未填写目标"} · v${item.version} · 使用 ${item.uses} 次 · 成功 ${item.successes} 次`, "scenario-detail-meta"), textBlock(`能力 ${item.capabilityCount} 个 · 来源 ${item.source} · 状态 ${item.status} · 历史版本 ${item.historyCount}${item.degraded ? " · 已降级" : ""}`, "scenario-detail-meta"));
  if (item.versionHistory.length) {
    detail.append(textBlock("版本历史", "section-label"));
    for (const version of item.versionHistory) {
      const row = node("div", "version-row");
      row.append(textBlock(`v${version.version} · ${version.reason} · ${new Date(version.createdAt).toLocaleString()}`, "connector-meta"));
      const compare = node("button", "session-action"); compare.type = "button"; compare.dataset.scenarioCompareId = item.id; compare.dataset.scenarioCompareVersion = String(version.version); compare.textContent = "对比当前"; row.append(compare); detail.append(row);
    }
  }
  if (!item.slotDefs.length) { detail.append(textBlock("此场景没有需要填写的参数。", "inspector-subtitle")); return; }
  detail.append(textBlock("运行前参数", "section-label"));
  for (const slot of item.slotDefs) {
    const label = node("label", "settings-field"); label.textContent = `${slot.name}${slot.required === false ? "（可选）" : ""}`;
    const input = node("input") as HTMLInputElement; input.type = slot.type === "number" ? "number" : slot.type === "path" ? "text" : "text"; input.dataset.slotName = slot.name; input.placeholder = slot.description ?? `填写 ${slot.name}`; label.append(input); detail.append(label);
  }
  detail.append(textBlock("填写后在输入框发送需求，参数会随本次运行一起提交。", "inspector-subtitle"));
}

function renderSessions(snap: PanelSnapshot): void {
  const box = $("session-list"); if (!box) return;
  box.replaceChildren();
  if (!snap.sessions.length) { box.append(textBlock("暂无历史对话", "inspector-subtitle")); return; }
  const sortRecent = (items: SessionSummary[]) => [...items].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  // Empty replacement sessions are implementation scaffolding created while
  // starting a fresh conversation. Keep the current draft visible, but keep
  // old empty shells out of navigation so the rail stays about real work.
  const visibleSessions = snap.sessions.filter((item) => item.messageCount > 0 || item.id === snap.sessionId);
  const active = sortRecent(visibleSessions.filter((item) => !item.archived));
  const archived = sortRecent(visibleSessions.filter((item) => item.archived));
  const renderRows = (items: SessionSummary[]) => {
    const fragment = document.createDocumentFragment();
    for (const item of items) {
      const row = node("div", `session-item${item.id === snap.sessionId ? " active" : ""}`);
      const open = node("button", "session-open"); open.type = "button"; open.dataset.sessionId = item.id; open.dataset.sessionAction = item.archived ? "restore-session" : "open-session";
      open.append(textBlock(item.title || "未命名对话", "session-title"), textBlock(`${item.mode === "work" ? "工作" : "构建"} · ${item.messageCount} 条消息`, "session-meta"));
      const actions = node("div", "session-actions");
      const archive = node("button", "session-action"); archive.type = "button"; archive.dataset.sessionId = item.id; archive.dataset.sessionAction = item.archived ? "restore-session" : "archive-session"; archive.textContent = item.archived ? "恢复" : "归档";
      const remove = node("button", "session-action session-delete"); remove.type = "button"; remove.dataset.sessionId = item.id; remove.dataset.sessionAction = "delete-session"; remove.textContent = "删除";
      actions.append(archive, remove); row.append(open, actions); fragment.append(row);
    }
    return fragment;
  };
  const renderGroup = (title: string, items: SessionSummary[], collapsible = false) => {
    if (!items.length) return;
    if (!collapsible) { box.append(textBlock(title, "session-group-label"), renderRows(items)); return; }
    const details = node("details", "session-history-more");
    const summary = node("summary"); summary.append(textBlock(title, "session-group-label"), textBlock(`${items.length}`, "session-history-count"));
    details.append(summary, renderRows(items)); box.append(details);
  };
  const projectName = (projectId: string | null): string => {
    if (!projectId) return "未归类历史";
    return snap.projects.find((project) => project.id === projectId)?.name ?? "其它项目";
  };
  const groups = new Map<string, SessionSummary[]>();
  for (const item of active) {
    const label = item.projectId === snap.projectId ? `当前项目 · ${projectName(item.projectId)}` : projectName(item.projectId);
    const group = groups.get(label) ?? [];
    group.push(item);
    groups.set(label, group);
  }
  // Current project first, then named projects, with legacy unbound sessions
  // last. Every group is visible so project/folder ownership is clear without
  // making users discover another collapsed disclosure.
  const orderedGroups = [...groups.entries()].sort(([a], [b]) => {
    const aRank = a.startsWith("当前项目 · ") ? 0 : a === "未归类历史" ? 2 : 1;
    const bRank = b.startsWith("当前项目 · ") ? 0 : b === "未归类历史" ? 2 : 1;
    return aRank - bRank || a.localeCompare(b, "zh-CN");
  });
  for (const [label, items] of orderedGroups) renderGroup(`${label} · ${items.length}`, items, !label.startsWith("当前项目 · "));
  if (!orderedGroups.length) box.append(textBlock("暂无历史对话", "inspector-subtitle"));
  const archivedGroups = new Map<string, SessionSummary[]>();
  for (const item of archived) {
    const label = item.projectId === snap.projectId ? `当前项目 · ${projectName(item.projectId)}` : projectName(item.projectId);
    const group = archivedGroups.get(label) ?? [];
    group.push(item);
    archivedGroups.set(label, group);
  }
  const orderedArchivedGroups = [...archivedGroups.entries()].sort(([a], [b]) => a.localeCompare(b, "zh-CN"));
  for (const [label, items] of orderedArchivedGroups) renderGroup(`已归档 · ${label} · ${items.length}`, items, true);
}

function sessionAction(event: Event): void {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-session-action]");
  if (!button) return;
  const action = button.dataset.sessionAction;
  const sessionId = button.dataset.sessionId;
  if (!action || !sessionId) return;
  event.stopPropagation();
  if (action === "delete-session" && !window.confirm("删除后无法恢复，只删除这段对话记录，不影响场景库和 Memory。确定删除吗？")) return;
  // History navigation invalidates any long-run choice staged by the
  // new-session dialog. Without this guard, returning to a session that uses
  // the same scenario could unexpectedly launch a long run on the next send.
  pendingLongRunConfig = null;
  const sent = sendPayload(action === "delete-session" ? { type: action, sessionId, confirm: true } : { type: action, sessionId });
  // A rail selection is a navigation action on touch screens.  Close the
  // drawer immediately so the newly opened conversation is visible instead
  // of leaving a dark overlay over the chat while the snapshot arrives.
  if (sent) setRailOpen(false);
}

function renderSettings(snap: PanelSnapshot): void {
  const settings = snap.settings; if (!settings) return;
  const base = $("setting-base-url") as HTMLInputElement | null;
  const model = $("setting-model") as HTMLInputElement | null;
  const plannerModel = $("setting-planner-model") as HTMLInputElement | null;
  const fallbackModel = $("setting-fallback-model") as HTMLInputElement | null;
  const temperature = $("setting-temperature") as HTMLInputElement | null;
  const maxTokens = $("setting-max-tokens") as HTMLInputElement | null;
  const timeout = $("setting-timeout") as HTMLInputElement | null;
  const provider = $("setting-provider") as HTMLSelectElement | null;
  const keyStatus = $("settings-key-status");
  if (base && document.activeElement !== base) base.value = settings.baseUrl;
  if (model && document.activeElement !== model) model.value = settings.model;
  if (plannerModel && document.activeElement !== plannerModel) plannerModel.value = settings.plannerModel ?? "";
  if (fallbackModel && document.activeElement !== fallbackModel) fallbackModel.value = settings.fallbackModel ?? "";
  if (temperature && document.activeElement !== temperature) temperature.value = String(settings.temperature);
  if (maxTokens && document.activeElement !== maxTokens) maxTokens.value = settings.maxTokens === null ? "" : String(settings.maxTokens);
  if (timeout && document.activeElement !== timeout) timeout.value = String(settings.timeoutMs);
  if (provider && document.activeElement !== provider) {
    provider.replaceChildren(new Option("默认设置", ""), ...snap.providers.map((item) => new Option(`${item.name} · ${item.model}`, item.id)));
    provider.value = settings.providerId ?? "";
  }
  const useHistory = $("setting-use-history") as HTMLInputElement | null; if (useHistory) useHistory.checked = settings.useHistory;
  const autoMemory = $("setting-auto-memory") as HTMLInputElement | null; if (autoMemory) autoMemory.checked = settings.autoMemory;
  const temporary = $("setting-temporary") as HTMLInputElement | null; if (temporary) temporary.checked = settings.temporarySession;
  const streaming = $("setting-streaming") as HTMLInputElement | null; if (streaming) streaming.checked = settings.streaming;
  const syncEndpoint = $("setting-sync-endpoint") as HTMLInputElement | null; if (syncEndpoint && document.activeElement !== syncEndpoint) syncEndpoint.value = settings.syncEndpoint ?? "";
  if (keyStatus) keyStatus.textContent = `${settings.hasApiKey ? `当前 Key：${settings.apiKeyMasked}（留空保持不变）` : "当前未配置 API Key，将使用本地规划器。"}${settings.hasSyncToken ? ` · 同步 Token：${settings.syncTokenMasked}` : ""}`;
}

function renderProjects(snap: PanelSnapshot): void {
  const box = $("project-list"); if (!box) return;
  box.replaceChildren();
  if (!snap.projects.length) { box.append(textBlock("暂无项目", "inspector-subtitle")); return; }
  const projects = [...snap.projects].sort((a, b) => {
    const active = (project: ProjectSummary) => project.id === snap.projectId ? 0 : project.pinned ? 1 : 2;
    return active(a) - active(b) || a.name.localeCompare(b.name, "zh-CN");
  });
  for (const project of projects) {
    const row = node("div", `project-item-row${project.id === snap.projectId ? " active" : ""}`);
    row.setAttribute("role", "listitem");
    const button = node("button", `project-item${project.id === snap.projectId ? " active" : ""}`);
    button.type = "button"; button.dataset.projectId = project.id;
    button.setAttribute("aria-current", project.id === snap.projectId ? "page" : "false");
    const description = project.pinned ? "已置顶" : project.rootPath ? `📁 ${project.rootPath}` : project.description || "项目文件夹";
    const counts = [
      typeof project.sessionCount === "number" ? `${project.sessionCount} 对话` : "",
      typeof project.fileCount === "number" ? `${project.fileCount} 文件` : "",
      typeof project.memoryCount === "number" ? `${project.memoryCount} Memory` : "",
      typeof project.scenarioCount === "number" ? `${project.scenarioCount} 场景` : "",
    ].filter(Boolean).join(" · ");
    const meta = node("div", "project-meta");
    meta.append(textBlock(description, "project-description"));
    if (counts) meta.append(textBlock(counts, "project-counts"));
    button.append(textBlock(project.name, "project-name"), meta);
    const actions = node("div", "project-item-actions");
    const edit = node("button", "session-action"); edit.type = "button"; edit.dataset.projectAction = "edit"; edit.dataset.projectId = project.id; edit.textContent = "编辑";
    const pin = node("button", "session-action"); pin.type = "button"; pin.dataset.projectAction = "pin"; pin.dataset.projectId = project.id; pin.textContent = project.status === "active" ? project.pinned ? "取消置顶" : "置顶" : "不可置顶"; pin.disabled = project.status !== "active"; pin.title = project.status === "active" ? "切换置顶" : "归档项目不能置顶";
    const share = node("button", "session-action"); share.type = "button"; share.dataset.projectAction = "share"; share.dataset.projectId = project.id; share.textContent = "分享";
    const archive = node("button", "session-action"); archive.type = "button"; archive.dataset.projectAction = project.status === "archived" ? "restore" : "archive"; archive.dataset.projectId = project.id; archive.textContent = project.status === "archived" ? "恢复" : "归档";
    const remove = node("button", "session-action session-delete"); remove.type = "button"; remove.dataset.projectAction = "delete"; remove.dataset.projectId = project.id; remove.textContent = "删除";
    actions.append(edit, pin, share, archive, remove); row.append(button, actions); box.append(row);
  }
}

function renderNewSessionDialog(snap: PanelSnapshot): void {
  const projectSelect = $("new-session-project") as HTMLSelectElement | null;
  const select = $("new-session-scenario") as HTMLSelectElement | null;
  if (!select) return;
  const currentProjectValue = projectSelect ? projectSelect.value : (snap.projectId ?? "");
  if (projectSelect) {
    projectSelect.replaceChildren(new Option("不绑定项目", ""), ...snap.projects.filter((project) => project.status === "active").map((project) => new Option(project.name, project.id)));
    projectSelect.value = [...projectSelect.options].some((option) => option.value === currentProjectValue) ? currentProjectValue : "";
  }
  const currentValue = select.value;
  select.replaceChildren(new Option("空白对话（自动匹配场景）", ""));
  const targetProjectId = projectSelect?.value || null;
  const scenarios = (snap.availableScenarios ?? snap.scenarios).filter((item) => item.status === "active" && (item.projectId === null || item.projectId === targetProjectId));
  for (const scenario of scenarios) {
    // The name is the navigation label. Repeating the raw goal here made
    // ordinary scenarios look duplicated and made selection harder to scan
    // on mobile, especially after a duplicate was migrated to “（2）”.
    select.append(new Option(scenario.name, scenario.id));
  }
  if ([...select.options].some((option) => option.value === currentValue)) select.value = currentValue;
  const hint = $("new-session-scenario-hint");
  const selected = scenarios.find((scenario) => scenario.id === select.value);
  const transient = snap.settings?.temporarySession === true || snap.settings?.useHistory === false;
  if (hint) hint.textContent = selected
    ? transient ? `新对话会默认使用「${selected.name}」；临时会话不支持长程运行。` : `新对话会默认使用「${selected.name}」，发送需求时可直接开始工作。`
    : targetProjectId ? "不选场景时，系统会在当前项目和全局场景中自动匹配；需要长期复用时再进入场景构建。" : "不选场景时，系统会根据每条需求自动匹配；需要长期复用时再进入场景构建。";
  const longToggle = $("new-session-long-run") as HTMLInputElement | null;
  const roundsField = $("new-session-rounds-field");
  if (longToggle) {
    longToggle.disabled = !selected || transient;
    if (!selected || transient) longToggle.checked = false;
  }
  roundsField?.classList.toggle("hidden", !selected || !longToggle?.checked);
}

function renderFiles(snap: PanelSnapshot): void {
  const box = $("file-list"); if (!box) return;
  box.replaceChildren();
  if (!snap.projectId) { box.append(textBlock("选择项目后添加文件", "inspector-subtitle")); return; }
  if (!snap.files.length) { box.append(textBlock("项目还没有文件", "inspector-subtitle")); return; }
  for (const file of snap.files) {
    const row = node("div", "file-row");
    const main = node("div"); main.append(textBlock(file.name, "file-name"), textBlock(file.indexed ? "已索引" : formatBytes(file.size), "file-size"));
    const actions = node("div", "file-actions");
    const open = node("button", "session-action"); open.type = "button"; open.textContent = "预览"; open.dataset.filePath = file.path; open.dataset.fileName = file.name; open.dataset.fileMedia = file.mediaType;
    const index = node("button", "session-action"); index.type = "button"; index.textContent = file.indexed ? "已索引" : "索引"; index.disabled = file.indexed; index.dataset.fileIndexId = file.id;
    const remove = node("button", "session-action session-delete"); remove.type = "button"; remove.textContent = "删除"; remove.dataset.fileId = file.id;
    actions.append(open, index, remove); row.append(main, actions);
    box.append(row);
  }
}

function renderArtifacts(snap: PanelSnapshot): void {
  const box = $("artifact-list"); if (!box) return;
  box.replaceChildren();
  if (!snap.artifacts.length) { box.append(textBlock("运行后生成的产物会出现在这里", "inspector-subtitle")); return; }
  const artifacts = [...snap.artifacts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const visible = artifactsExpanded ? artifacts : artifacts.slice(0, 12);
  for (const artifact of visible) {
    const row = node("div", "file-row");
    const main = node("div");
    main.append(textBlock(artifact.name, "file-name"), textBlock(`${artifact.mediaType} · v${artifact.version} · ${artifact.status}`, "file-size"));
    const actions = node("div", "file-actions");
    // Use an opaque artifact id in the browser URL.  The local filesystem
    // path is an implementation detail and must not end up in history,
    // screenshots, copied links, or accessibility output.
    const open = node("a", "session-action"); open.href = "/api/artifact?id=" + encodeURIComponent(artifact.id); open.target = "_blank"; open.rel = "noreferrer"; open.textContent = "打开";
    const version = node("button", "session-action"); version.type = "button"; version.dataset.artifactVersionId = artifact.id; version.textContent = "新版本";
    const diff = node("button", "session-action"); diff.type = "button"; diff.dataset.artifactDiffId = artifact.id; diff.dataset.artifactVersion = String(artifact.version); diff.textContent = "差异";
    const share = node("button", "session-action"); share.type = "button"; share.dataset.artifactShareId = artifact.id; share.textContent = "分享";
    const remove = node("button", "session-action session-delete"); remove.type = "button"; remove.textContent = "删除"; remove.dataset.artifactId = artifact.id;
    actions.append(open, version, diff, share, remove); row.append(main, actions); box.append(row);
  }
  if (artifacts.length > 12) {
    const toggle = node("button", "session-action artifact-expand-toggle") as HTMLButtonElement;
    toggle.type = "button";
    toggle.dataset.artifactsExpand = artifactsExpanded ? "false" : "true";
    toggle.textContent = artifactsExpanded ? "收起较早产物" : `显示全部 ${artifacts.length} 个产物`;
    box.append(toggle);
  }
}

function renderConnectors(snap: PanelSnapshot): void {
  const box = $("connector-list"); if (!box) return;
  box.replaceChildren();
  if (!snap.connectors.length) { box.append(textBlock("还没有连接器", "inspector-subtitle")); return; }
  for (const connector of snap.connectors) {
    const row = node("div", "connector-row");
    const main = node("div"); main.append(textBlock(connector.name, "connector-name"), textBlock(`${connector.kind} · ${connector.permissionScopes.join(", ") || "只读未配置"}`, "connector-meta"), textBlock(`来源 ${connector.source} · 信任 ${connector.trustStatus} ${(connector.trustScore * 100).toFixed(0)}% · 证据 ${connector.trustEvidenceCount}`, "connector-meta"));
    const actions = node("div", "connector-actions");
    const test = node("button", "session-action"); test.type = "button"; test.dataset.connectorAction = "test"; test.dataset.connectorId = connector.id; test.textContent = "探活";
    const toggle = node("button", "session-action"); toggle.type = "button"; toggle.dataset.connectorAction = "toggle"; toggle.dataset.connectorId = connector.id; toggle.textContent = connector.status === "enabled" ? "停用" : "启用";
    const remove = node("button", "session-action session-delete"); remove.type = "button"; remove.dataset.connectorAction = "delete"; remove.dataset.connectorId = connector.id; remove.textContent = "删除";
    actions.append(textBlock(connector.status === "error" ? "异常" : connector.status === "enabled" ? "正常" : "停用", `connector-status connector-${connector.status}`), test, toggle, remove); row.append(main, actions); box.append(row);
  }
}

function renderPolicy(snap: PanelSnapshot): void {
  const box = $("policy-list"); if (!box || !snap.policy) return;
  box.replaceChildren();
  for (const scope of ["read", "write", "install", "network", "send"] as const) { const label = node("label"); const input = node("input") as HTMLInputElement; input.type = "checkbox"; input.id = `policy-${scope}`; input.checked = snap.policy[scope]; label.append(input, textBlock(scope)); box.append(label); }
  const mode = node("select") as HTMLSelectElement; mode.id = "policy-approval"; for (const value of ["ask", "always-allow", "always-deny"]) mode.append(new Option(value, value)); mode.value = snap.policy.approvalMode; box.append(textBlock("审批策略"), mode);
}

function renderIdentities(snap: PanelSnapshot): void {
  const box = $("identity-list"); if (!box) return;
  box.replaceChildren();
  if (!snap.identities.length) { box.append(textBlock("还没有本地身份", "inspector-subtitle")); return; }
  for (const identity of snap.identities) { const row = node("div", "connector-row"); row.append(textBlock(identity.displayName, "connector-name"), textBlock(`${identity.role} · ${identity.status}`, "connector-meta")); const revoke = node("button", "session-action session-delete"); revoke.type = "button"; revoke.textContent = identity.status === "revoked" ? "已撤销" : "撤销"; revoke.disabled = identity.status === "revoked"; revoke.dataset.identityId = identity.id; row.append(revoke); box.append(row); }
}

function renderShares(snap: PanelSnapshot): void {
  const box = $("shares-list"); if (!box) return;
  box.replaceChildren();
  if (!snap.shares.length) { box.append(textBlock("还没有分享令牌", "inspector-subtitle")); return; }
  for (const share of snap.shares) { const row = node("div", "connector-row"); row.append(textBlock(`${share.resourceType} · ${share.resourceId}`, "connector-name"), textBlock(`${share.role} · ${share.tokenMasked}`, "connector-meta")); const remove = node("button", "session-action session-delete"); remove.type = "button"; remove.textContent = "撤销"; remove.dataset.shareId = share.id; row.append(remove); box.append(row); }
}

function renderProviders(snap: PanelSnapshot): void {
  const box = $("provider-list"); if (!box) return;
  box.replaceChildren();
  if (!snap.providers.length) { box.append(textBlock("还没有 Provider 配置", "inspector-subtitle")); return; }
  for (const provider of snap.providers) {
    const row = node("div", "connector-row");
    const capabilityText = `${provider.contextLength ? `${provider.contextLength} ctx` : "ctx 未知"} · 工具 ${provider.supportsTools ? "✓" : "—"} · 视觉 ${provider.supportsVision ? "✓" : "—"} · 结构化 ${provider.supportsStructuredOutput ? "✓" : "—"}`;
    const main = node("div"); main.append(textBlock(provider.name, "connector-name"), textBlock(`${provider.kind} · ${provider.model} · ${provider.hasSecret ? "已配置 Key" : "无 Key"}`, "connector-meta"), textBlock(capabilityText, "connector-meta"));
    const actions = node("div", "connector-actions");
    const toggle = node("button", "session-action"); toggle.type = "button"; toggle.dataset.providerAction = "toggle"; toggle.dataset.providerId = provider.id; toggle.textContent = provider.enabled ? "停用" : "启用";
    const remove = node("button", "session-action session-delete"); remove.type = "button"; remove.dataset.providerAction = "delete"; remove.dataset.providerId = provider.id; remove.textContent = "删除";
    actions.append(textBlock(provider.enabled ? "启用" : "停用", `connector-status connector-${provider.enabled ? "enabled" : "disabled"}`), toggle, remove); row.append(main, actions); box.append(row);
  }
}

function renderTasks(snap: PanelSnapshot): void {
  const box = $("task-list"); if (!box) return;
  box.replaceChildren();
  if (!snap.tasks.length) { box.append(textBlock("还没有后台任务", "inspector-subtitle")); return; }
  for (const task of snap.tasks) {
    const row = node("div", "run-row");
    const title = textBlock(task.requirement, "run-title");
    const meta = node("div", "run-meta");
    const last = task.lastRunAt ? ` · 上次 ${new Date(task.lastRunAt).toLocaleString()}` : "";
    const result = task.lastRunStatus ? ` · ${friendlyRunStatus(task.lastRunStatus)}${task.lastError ? `：${task.lastError}` : ""}` : "";
    meta.append(textBlock(`${task.schedule} · ${task.runCount}${task.maxRuns === null ? "" : `/${task.maxRuns}`}${last}${result}`), textBlock(task.enabled ? "启用" : "停用", `run-status ${task.enabled ? "succeeded" : "cancelled"}`));
    const actions = node("div", "connector-actions");
    const run = node("button", "session-action"); run.type = "button"; run.dataset.taskAction = "run"; run.dataset.taskId = task.id; run.textContent = "立即运行";
    const toggle = node("button", "session-action"); toggle.type = "button"; toggle.dataset.taskAction = "toggle"; toggle.dataset.taskId = task.id; toggle.textContent = task.enabled ? "停用" : "启用";
    const edit = node("button", "session-action"); edit.type = "button"; edit.dataset.taskAction = "edit"; edit.dataset.taskId = task.id; edit.textContent = "编辑";
    const remove = node("button", "session-action session-delete"); remove.type = "button"; remove.dataset.taskAction = "delete"; remove.dataset.taskId = task.id; remove.textContent = "删除";
    actions.append(run, toggle, edit, remove); row.append(title, meta, actions); box.append(row);
  }
}

function renderAudit(snap: PanelSnapshot): void {
  const box = $("audit-list"); if (!box) return;
  box.replaceChildren();
  if (!snap.audit.length) { box.append(textBlock("暂无审批或权限操作记录", "inspector-subtitle")); return; }
  for (const entry of snap.audit.slice(0, 30)) {
    const row = node("div", "run-row");
    row.append(textBlock(entry.summary, "run-title"), textBlock(`${entry.action} · ${new Date(entry.createdAt).toLocaleString()}`, "run-meta"));
    box.append(row);
  }
}

function renderContexts(snap: PanelSnapshot): void {
  const box = $("context-list"); if (!box) return;
  box.replaceChildren();
  if (!snap.contexts.length) { box.append(textBlock("还没有导入桌面上下文", "inspector-subtitle")); return; }
  for (const context of snap.contexts) {
    const row = node("div", "connector-row");
    const main = node("div"); main.append(textBlock(context.label, "connector-name"), textBlock(`${context.kind} · ${context.origin}`, "connector-meta"));
    const actions = node("div", "connector-actions");
    const toggle = node("button", "session-action"); toggle.type = "button"; toggle.dataset.contextAction = "toggle"; toggle.dataset.contextId = context.id; toggle.textContent = context.enabled ? "停用" : "启用";
    const remove = node("button", "session-action session-delete"); remove.type = "button"; remove.dataset.contextAction = "delete"; remove.dataset.contextId = context.id; remove.textContent = "删除";
    actions.append(toggle, remove); row.append(main, actions); box.append(row);
  }
}

function renderRuns(snap: PanelSnapshot): void {
  const box = $("run-list"); if (!box) return;
  box.replaceChildren();
  if (!snap.runs.length && !snap.longRuns.length) { box.append(textBlock("还没有运行记录", "inspector-subtitle")); return; }
  const entries = [
    ...snap.runs.map((run) => ({ kind: "run" as const, at: run.finishedAt ?? run.startedAt, run })),
    ...snap.longRuns.map((run) => ({ kind: "long" as const, at: run.updatedAt, run })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  for (const entry of entries) {
    if (entry.kind === "long") {
      const run = entry.run;
      const row = node("div", "run-row run-row-button long-run-row");
      row.setAttribute("role", "button");
      row.tabIndex = 0;
      row.dataset.longRunId = run.id;
      const title = textBlock(run.goal, "run-title");
      const status = textBlock(friendlyRunStatus(run.status), `run-status ${run.status}`);
      const meta = node("div", "run-meta");
      meta.append(textBlock(`长程 · 第 ${run.completedRounds}/${run.maxRounds} 轮`), status);
      row.append(title, meta);
      box.append(row);
      continue;
    }
    const run = entry.run;
    const row = node("div", "run-row run-row-button");
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    row.dataset.runId = run.id;
    row.dataset.runStatus = run.status;
    const title = textBlock(run.requirement, "run-title");
    const status = textBlock(friendlyRunStatus(run.status), `run-status ${run.status}`);
    const duration = run.durationMs === null ? "进行中" : `${(run.durationMs / 1000).toFixed(1)}s`;
    const meta = node("div", "run-meta"); meta.append(textBlock(`${run.mode === "work" ? "工作" : "构建"} · ${run.model} · ${duration}`), status);
    const select = node("input") as HTMLInputElement;
    select.type = "checkbox";
    select.dataset.runSelect = run.id;
    select.checked = selectedRunIds.has(run.id);
    // The row itself is a keyboard-focusable disclosure target. Give the
    // comparison control its own stable accessible name so screen readers
    // do not announce an anonymous “checkbox 0” inside every run row.
    select.setAttribute("aria-label", `选择运行记录：${run.requirement}`);
    select.title = `选择运行记录：${run.requirement}`;
    row.prepend(select); row.append(title, meta); box.append(row);
  }
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function renderRight(snap: PanelSnapshot): void {
  renderHeaderContext(snap); renderPreview(snap); renderMemory(snap); renderScenarios(snap); renderSessions(snap); renderSettings(snap); renderProjects(snap); renderNewSessionDialog(snap); renderFiles(snap); renderArtifacts(snap); renderConnectors(snap); renderPolicy(snap); renderProviders(snap); renderIdentities(snap); renderRuns(snap); renderTasks(snap); renderAudit(snap); renderContexts(snap); renderShares(snap);
}

function renderRichText(value: unknown): HTMLElement {
  const content = String(value ?? "").replace(/\r\n?/g, "\n");
  const root = node("div", "rich-content");
  const lines = content.split("\n");
  let code: HTMLPreElement | null = null;
  let list: HTMLUListElement | HTMLOListElement | null = null;
  let listKind: "ul" | "ol" | null = null;
  const closeList = () => { if (list) { root.append(list); list = null; listKind = null; } };
  const inline = (value: string): DocumentFragment => {
    const fragment = document.createDocumentFragment();
    // Keep this deliberately small and DOM based: model text is untrusted and
    // must never be inserted as HTML. Inline code and links are enough to make
    // streamed explanations readable without opening an XSS surface.
    const pattern = /(`[^`]+`|https?:\/\/[^\s<]+|\*\*[^*]+\*\*)/g;
    let last = 0;
    for (const match of value.matchAll(pattern)) {
      const index = match.index ?? 0;
      if (index > last) fragment.append(document.createTextNode(value.slice(last, index)));
      const token = match[0];
      if (token.startsWith("`") && token.endsWith("`")) {
        const el = node("code", "inline-code"); el.textContent = token.slice(1, -1); fragment.append(el);
      } else if (token.startsWith("**") && token.endsWith("**")) {
        const el = node("strong"); el.textContent = token.slice(2, -2); fragment.append(el);
      } else {
        const link = node("a", "rich-link") as HTMLAnchorElement;
        link.href = token.replace(/[),.;!?]+$/, ""); link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = token; fragment.append(link);
      }
      last = index + token.length;
    }
    if (last < value.length) fragment.append(document.createTextNode(value.slice(last)));
    return fragment;
  };
  const paragraph: string[] = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    closeList();
    const p = node("p", "rich-paragraph");
    paragraph.forEach((line, index) => { if (index) p.append(document.createElement("br")); p.append(inline(line)); });
    root.append(p); paragraph.length = 0;
  };
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      flushParagraph();
      if (code) { root.append(code); code = null; } else { code = node("pre", "rich-code"); }
      continue;
    }
    if (code) { code.append(document.createTextNode(`${line}\n`)); continue; }
    const heading = line.match(/^#{1,3}\s+(.+)$/);
    if (heading) { flushParagraph(); closeList(); const h = node(heading[0].startsWith("###") ? "h4" : heading[0].startsWith("##") ? "h3" : "h2", "rich-heading"); h.append(inline(heading[1]!)); root.append(h); continue; }
    const bullet = line.match(/^\s*[-*•]\s+(.+)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (bullet || numbered) {
      flushParagraph(); const kind = bullet ? "ul" : "ol";
      if (!list || listKind !== kind) { closeList(); list = node(kind, "rich-list") as HTMLUListElement | HTMLOListElement; listKind = kind; }
      const li = node("li"); li.append(inline((bullet ?? numbered)![1]!)); list.append(li); continue;
    }
    if (!line.trim()) { flushParagraph(); closeList(); continue; }
    paragraph.push(line);
  }
  if (code) root.append(code);
  flushParagraph(); closeList();
  return root;
}

/** SceneFlow 进度卡：构建过程内联进度——步进器 + 流式叙述 + 分源微状态，全程一张卡原地更新。 */
/** 完成摘要：DeepSeek 式一行（用时 + 步数，无明细时省略步数） */
function progressLiveSummary(card: ProgressCardMessage): string {
  const phaseLabel = card.phase ? (PROGRESS_PHASE_LABELS[card.phase] ?? card.phase) : "";
  const nodeSteps = card.steps.filter((s) => s.nodeId);
  const sources = card.sourcesTotal > 0 ? ` · ${card.sources.filter((s) => s.done).length}/${card.sourcesTotal} 源` : "";
  if (nodeSteps.length > 0) {
    const ok = nodeSteps.filter((s) => s.status === "ok").length;
    const running = nodeSteps.some((s) => s.status === "running");
    return running
      ? `${phaseLabel ? `${phaseLabel} · ` : ""}执行中 · 已完成 ${ok}/${nodeSteps.length} 步${sources}`
      : `${phaseLabel ? `${phaseLabel} · ` : ""}执行中（${nodeSteps.length} 步）${sources}`;
  }
  return `${phaseLabel ? `${phaseLabel} · ` : ""}思考与执行中（${card.steps.length}）${sources}`;
}

function progressDoneSummary(card: ProgressCardMessage): string {  const seconds = card.finishedAt !== null ? Math.max(1, Math.round((card.finishedAt - card.startedAt) / 1000)) : 0;
  const nodeSteps = card.steps.filter((s) => s.nodeId);
  if (nodeSteps.length > 0) {
    const ok = nodeSteps.filter((s) => s.status === "ok").length;
    const err = nodeSteps.filter((s) => s.status === "err").length;
    return err > 0 ? `执行结束 · ${ok} 步成功 · ${err} 步失败` : `执行完成 · ${ok} 步全部成功 · 用时 ${seconds} 秒`;
  }
  return card.steps.length > 0 ? `已完成构建 · 用时 ${seconds} 秒 · ${card.steps.length} 步` : `已完成构建 · 用时 ${seconds} 秒`;
}

/** SceneFlow 进度卡：DeepSeek 思考块式——进行中展开实时流出，完成后折叠为一行摘要。 */
function renderProgressCard(card: ProgressCardMessage): HTMLElement {
  const done = card.finishedAt !== null;
  const root = node("article", "message progress-message assistant");
  const cardEl = node("div", `progress-card ${done ? "finished" : "live"}`);
  cardEl.dataset.runId = card.runId;

  const head = node("div", "progress-card-head");
  const pulse = node("span", "progress-pulse");
  pulse.setAttribute("aria-hidden", "true");
  const phase = node("span", "progress-phase");
  phase.textContent = done ? "完成" : card.phase ? (PROGRESS_PHASE_LABELS[card.phase] ?? card.phase) : "准备中";
  const title = node("span", "progress-title");
  // DeepSeek 式减层：live 态信息全部收进折叠条一行（summary），head 仅 finished 显示
  title.textContent = "";
  title.style.display = "none";
  const sourceCount = node("span", "progress-source-count");
  sourceCount.textContent = "";
  sourceCount.style.display = "none";
  if (!done) head.style.display = "none";
  head.append(pulse, phase, title, sourceCount);

  const narration = node("div", "progress-narration");
  narration.textContent = done ? "" : card.narration;
  if (!narration.textContent) narration.classList.add("empty");

  const line = node("div", "progress-line");
  // line 与 steps 首条重复，仅在没有任何步骤记录时兜底显示
  if (card.line && !done && card.steps.length === 0) line.textContent = card.line;
  else line.style.display = "none";

  const chips = node("div", "progress-source-chips");
  if (done) chips.style.display = "none";
  chips.replaceChildren(...card.sources.map((s) => {
    const chip = node("span", `progress-source-chip ${s.ok ? "ok" : "err"}`);
    chip.textContent = s.id;
    return chip;
  }));

  const details = node("details", "progress-details");
  const summary = node("summary", "progress-details-summary");
  summary.textContent = done ? progressDoneSummary(card) : progressLiveSummary(card);
  const steps = node("div", "progress-steps");
  steps.replaceChildren(...card.steps.map((step, index) => buildStepRow(card, step)));
  if (done && card.line && !card.steps.some((s) => s.text === card.line)) {
    const row = node("div", "progress-step-row");
    const timeEl = node("span", "progress-step-time");
    timeEl.textContent = new Date(card.finishedAt ?? card.ts ?? Date.now()).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const textEl = node("span", "progress-step-text");
    textEl.textContent = card.line;
    row.append(timeEl, textEl);
    steps.append(row);
  }
  details.append(summary, steps);
  // DeepSeek 行为：进行中默认展开（过程实时可见），完成即折叠
  if (!done) details.setAttribute("open", "");

  cardEl.append(head, narration, line, chips, details);
  root.append(cardEl);
  return root;
}

/** 任务画布步骤卡：状态点 + 时间 + 内容 + 悬停操作（编辑 / 重做单步 / 级联重做）。 */
function buildStepRow(card: ProgressCardMessage, step: ProgressCardMessage["steps"][number]): HTMLElement {
  const row = node("div", `progress-step-row${step.status ? ` step-${step.status}` : ""}`);
  const dot = node("span", `progress-step-dot ${step.status ?? ""}`);
  dot.setAttribute("aria-hidden", "true");
  const timeEl = node("span", "progress-step-time");
  timeEl.textContent = new Date(step.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const textEl = node("span", "progress-step-text");
  textEl.textContent = step.text;
  row.append(dot, timeEl, textEl);
  // plain 叙述行（无 nodeId）不是 DAG 节点：不提供编辑/重做操作
  if (!step.nodeId) return row;

  // SceneFlow 核心机制：步骤级操作（编辑、独立重做当前步、级联重做后续依赖）
  const stepId = step.nodeId;
  const actions = node("div", "step-actions");
  const editBtn = node("button", "step-btn");
  editBtn.type = "button";
  editBtn.textContent = "编辑";
  editBtn.title = "修改该步骤内容与预期产出";
  editBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const updated = window.prompt("编辑该步骤内容：", step.text);
    if (updated && updated.trim() && updated.trim() !== step.text) {
      sendPayload({ type: "step-action", runId: card.runId, stepId, action: "edit", updatedTitle: updated.trim() });
    }
  });

  const redoBtn = node("button", "step-btn step-redo-btn");
  redoBtn.type = "button";
  redoBtn.textContent = "重做 ▾";
  redoBtn.title = "重新执行该步骤";
  const redoMenu = node("div", "step-redo-menu");

  const redoSingle = node("button", "step-redo-item");
  redoSingle.type = "button";
  redoSingle.innerHTML = `<span>仅重做当前步</span><span class="step-redo-hint">保持其他步骤产出不变</span>`;
  redoSingle.addEventListener("click", (e) => {
    e.stopPropagation();
    redoMenu.classList.remove("open");
    sendPayload({ type: "step-action", runId: card.runId, stepId, action: "redo-single" });
  });

  const redoCascade = node("button", "step-redo-item");
  redoCascade.type = "button";
  redoCascade.innerHTML = `<span>重做此步及后续步骤</span><span class="step-redo-hint">按依赖链级联更新后续产出</span>`;
  redoCascade.addEventListener("click", (e) => {
    e.stopPropagation();
    redoMenu.classList.remove("open");
    sendPayload({ type: "step-action", runId: card.runId, stepId, action: "redo-cascade" });
  });

  redoMenu.append(redoSingle, redoCascade);
  redoBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    document.querySelectorAll(".step-redo-menu.open").forEach((m) => {
      if (m !== redoMenu) m.classList.remove("open");
    });
    redoMenu.classList.toggle("open");
  });

  actions.append(editBtn, redoBtn, redoMenu);
  row.append(actions);
  return row;
}

function renderActivityGroup(message: ActivityGroupMessage): HTMLElement {
  const card = node("div", "status-card activity-card");
  const items = Array.isArray(message.items) ? message.items : [];
  const header = node("div", "activity-header");
  header.append(textBlock("执行过程", "activity-title"), textBlock(`${items.length} 条`, "activity-count"));
  card.append(header);
  const list = node("div", "activity-list");
  for (const item of items) {
    const row = node("div", `activity-row activity-${item.tone === "err" ? "err" : item.tone === "ok" ? "ok" : "info"}`);
    const dot = node("span", "activity-dot");
    const text = textBlock(friendlyBuildStatusText(String(item.text ?? "")), "activity-text");
    row.append(dot, text); list.append(row);
  }
  card.append(list);
  return card;
}

function renderThinkingMessage(message: ThinkingMessage): HTMLElement {
  const content = String(message.content ?? message.text ?? "");
  const streaming = message.streaming !== false;
  const key = String((message as unknown as Record<string, unknown>).streamKey ?? `thinking-${message.nodeId ?? "main"}`);
  const details = node("details", "thinking-block");
  // A live reasoning stream must remain visible. Once the provider finishes,
  // the user can inspect it on demand without the transcript becoming a wall
  // of internal-looking text.
  details.open = streaming || thinkingExpanded.get(key) === true;
  const summary = node("summary", "thinking-summary");
  summary.append(textBlock(streaming ? "正在思考" : "思考过程", "thinking-title"), textBlock(streaming ? "实时" : "已完成", "thinking-state"));
  details.append(summary, renderRichText(content));
  details.dataset.thinkingKey = key;
  details.addEventListener("toggle", () => { if (!streaming) thinkingExpanded.set(key, details.open); });
  return details;
}

function renderToolActivity(message: ToolActivityMessage): HTMLElement {
  const role = message.role;
  const toolName = String(message.toolName ?? "未命名工具");
  const card = node("details", `tool-activity tool-${role === "tool-call" ? "call" : "result"}`);
  const key = `${role}-${message.toolCallId ?? message.nodeId ?? toolName}`;
  card.open = toolExpanded.get(key) ?? role === "tool-call";
  const summary = node("summary", "tool-summary");
  summary.append(textBlock(role === "tool-call" ? "调用工具" : "工具返回", "tool-kind"), textBlock(toolName, "tool-name"));
  card.append(summary);
  if (role === "tool-call") {
    const args = message.arguments && Object.keys(message.arguments).length ? JSON.stringify(message.arguments, null, 2) : "无参数";
    const pre = node("pre", "tool-payload"); pre.textContent = args; card.append(pre);
  } else {
    const output = String(message.content ?? "");
    card.append(renderRichText(output));
  }
  card.addEventListener("toggle", () => { toolExpanded.set(key, card.open); });
  return card;
}

function renderRunGroup(message: RunGroupMessage): HTMLElement {
  const section = node("section", "run-group-card");
  section.append(renderMessage(message.user));
  const items = Array.isArray(message.items) ? message.items : [];
  const terminal = [...items].reverse().find((item) => item.role === "build-status" && item.terminal === true);
  const primaryRoles = new Set(["model-stream", "model-thinking", "awaiting-user", "gate-card", "memory-proposal", "progress-card"]);
  const primary: Array<Record<string, unknown>> = [];
  const processItems: Array<Record<string, unknown>> = [];
  const isSlashUser = typeof message.user?.content === "string" && (message.user.content as string).trim().startsWith("/");
  for (const item of items) {
    const isHelp = String(item.text ?? "").startsWith("/help ·");
    if (primaryRoles.has(String(item.role)) || (item.role === "build-status" && (item.terminal === true || isHelp || isSlashUser))) primary.push(item);
    else processItems.push(item);
  }
  for (const item of primary) section.append(renderMessage(item));
  if (!processItems.length) return section;
  const details = node("details", "run-timeline");
  const groupId = message.groupId ?? `run-${String(message.user.ts ?? message.user.timestamp ?? message.user.content ?? "").slice(0, 160)}`;
  details.dataset.groupId = groupId;
  details.open = timelineExpanded.get(groupId) ?? (!terminal && message.expanded);
  const summary = node("summary", "run-timeline-summary");
  summary.setAttribute("aria-label", `执行过程，${processItems.length} 条记录`);
  const summaryText = terminal ? "查看步骤、工具和状态" : "Agent 正在处理这项工作";
  summary.append(textBlock("执行过程", "run-timeline-label"), textBlock(summaryText, "run-timeline-result"), textBlock(`${processItems.length} 条`, "run-timeline-count"));
  details.append(summary);
  const timeline = node("div", "run-timeline-items");
  for (const item of processItems) timeline.append(renderMessage(item));
  details.append(timeline);
  details.addEventListener("toggle", () => { timelineExpanded.set(groupId, details.open); });
  section.append(details);
  return section;
}

function renderMessage(message: Record<string, unknown>): HTMLElement {
  const role = String(message.role ?? "");
  if (role === "run-group") return renderRunGroup(message as unknown as RunGroupMessage);
  if (role === "progress-card") return renderProgressCard(message as unknown as ProgressCardMessage);
  const streaming = (role === "model-stream" || role === "model-thinking") && message.streaming !== false;
  const wrapper = node("article", `message message-${role || "event"} ${role === "user" ? "user" : "assistant"}${streaming ? " message-streaming" : ""}`);
  const timestamp = Number(message.ts ?? message.timestamp ?? 0);
  const time = timestamp > 0 ? new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  if (role === "user") {
    const body = node("div", "message-body");
    const head = node("div", "message-head"); head.append(textBlock("你", "message-author"), textBlock(time, "message-time"));
    body.append(head, textBlock(message.content, "message-content"));
    const actions = node("div", "message-actions message-actions-user");
    const edit = node("button", "message-action"); edit.type = "button"; edit.dataset.messageAction = "edit"; edit.dataset.messageContent = String(message.content ?? ""); edit.textContent = "编辑";
    actions.append(edit); body.append(actions);
    wrapper.append(body);
    return wrapper;
  }
  const avatar = textBlock(role === "gate-card" ? "决" : role === "awaiting-user" ? "问" : role === "model-thinking" ? "思" : role.startsWith("tool-") ? "工" : role === "model-stream" ? "A" : role === "build-status" ? "✓" : "A", `avatar avatar-${role || "event"}`);
  if (role === "model-stream" || role === "model-thinking") avatar.setAttribute("aria-label", "Agent");
  const body = node("div", "message-body");
  const head = node("div", "message-head");
  const label = role === "gate-card" ? "需要你确认" : role === "awaiting-user" ? "需要补充输入" : role === "model-stream" ? (streaming ? "正在回复" : "Agent 回复") : role === "model-thinking" ? (streaming ? "正在思考" : "思考过程") : role === "tool-call" ? "工具调用" : role === "tool-result" ? "工具结果" : role === "build-status" ? "结果" : role === "activity-group" ? "执行过程" : role === "memory-proposal" ? "Memory 提议" : "SceneFlow";
  head.append(textBlock(label, "message-author"), textBlock(time, "message-time"));
  const meta = head;
  body.append(meta);
  if (role === "model-thinking") {
    body.append(renderThinkingMessage(message as unknown as ThinkingMessage));
  } else if (role === "tool-call" || role === "tool-result") {
    body.append(renderToolActivity(message as unknown as ToolActivityMessage));
  } else if (role === "activity-group") {
    body.append(renderActivityGroup(message as unknown as ActivityGroupMessage));
  } else if (role === "awaiting-user") {
    const awaiting = message as unknown as AwaitingUserMessage;
    const card = node("div", "status-card awaiting-user-card");
    card.append(textBlock(awaiting.question, "awaiting-user-question"));
    const form = node("div", "awaiting-user-fields");
    for (const input of awaiting.inputs ?? []) {
      const label = node("label", "awaiting-user-field");
      label.append(textBlock(`${input.name}${input.description ? ` · ${input.description}` : ""}`, "awaiting-user-label"));
      const control = document.createElement("input"); control.type = input.type === "number" ? "number" : "text"; control.name = input.name; control.dataset.awaitingInput = input.name; control.placeholder = input.type === "path" ? "填写文件或文件夹路径" : input.type === "url" ? "填写 URL" : "填写内容";
      label.append(control); form.append(label);
    }
    const submit = document.createElement("button"); submit.type = "button"; submit.className = "gate-approve"; submit.dataset.awaitingAction = "submit"; submit.dataset.runId = awaiting.runId; submit.textContent = "补充并继续";
    form.append(submit); card.append(form); body.append(card);
  } else if (role === "build-status") {
    const status = message as unknown as BuildStatusMessage;
    const statusText = friendlyBuildStatusText(status.text);
    if (statusText.startsWith("/help ·")) body.append(renderHelpCard(statusText));
    else {
      const card = textBlock(statusText, `status-card progress-card ${status.tone === "ok" ? "ok" : status.tone === "err" ? "err" : ""}`);
      if (status.action === "switch-to-build") {
        const actions = node("div", "status-actions");
        const switchButton = node("button", "status-action") as HTMLButtonElement;
        switchButton.type = "button";
        switchButton.dataset.statusAction = "switch-to-build";
        switchButton.dataset.requirement = status.requirement ?? "";
        switchButton.textContent = "切换到场景构建";
        actions.append(switchButton);
        card.append(actions);
      }
      body.append(card);
    }
  } else if (role === "search-result" || role === "task-notification" || role === "model-stream") {
    const content = message.content ?? message.text ?? "";
    if (role === "model-stream") {
      const rich = renderRichText(content);
      rich.className = `status-card event-card stream-card rich-content${streaming ? " is-live" : ""}`;
      body.append(rich);
    } else body.append(textBlock(content, "status-card event-card"));
  } else if (role === "memory-proposal") {
    body.append(textBlock(message.text ?? "", "status-card"));
    const actions = node("div", "gate-actions"); const save = node("button", "gate-approve"); save.type = "button"; save.dataset.memoryProposal = "save"; save.dataset.memoryName = String(message.proposalName ?? "运行记录"); save.dataset.memoryContent = String(message.content ?? ""); save.textContent = "保存 Memory"; const discard = node("button", "gate-reject"); discard.type = "button"; discard.dataset.memoryProposal = "discard"; discard.textContent = "忽略"; actions.append(save, discard); body.append(actions);
  } else if (role === "gate-card") {
    body.append(renderGateCard(message as unknown as GateCardMessage));
  } else if (role === "ui-command") {
    body.append(textBlock(uiCommandLabel(String(message.command ?? "")), "status-card event-card ui-command-card"));
  } else {
    body.append(textBlock(message.content ?? message.text ?? "", "status-card"));
  }
  if (["build-status", "search-result", "task-notification", "model-stream", "model-thinking", "tool-result"].includes(role)) {
    const copyText = String(message.content ?? message.text ?? "");
    if (copyText || (role === "build-status" && ["failed", "cancelled"].includes(String(message.runStatus ?? "")))) {
      const actions = node("div", "message-actions");
      if (copyText) { const copy = node("button", "message-copy"); copy.type = "button"; copy.dataset.copyText = copyText; copy.textContent = "复制"; actions.append(copy); }
      if (role === "build-status" && ["failed", "cancelled"].includes(String(message.runStatus ?? ""))) { const retry = node("button", "message-action"); retry.type = "button"; retry.dataset.messageAction = "retry"; retry.textContent = "重试"; actions.append(retry); }
      body.append(actions);
    }
  }
  wrapper.append(avatar, body);
  return wrapper;
}

function uiCommandLabel(command: string): string {
  const labels: Record<string, string> = { settings: "已打开运行设置", connectors: "已打开连接器中心", memory: "已打开 Memory 编辑", "file-picker": "已打开文件选择", "export-session": "正在导出当前对话", "export-workspace": "正在导出工作区" };
  return labels[command] ?? `已执行：${command}`;
}

function friendlyBuildStatusText(text: string): string {
  if (text.startsWith("正在解析意图并检查可复用场景")) return "我先把你的目标和输入整理清楚。";
  if (text.startsWith("好，开始构建。第一步")) return "好，开始构建。我先去能力库里寻找能完成这件事的可靠工具。";
  if (/^命中\s+\d+\s+个候选/.test(text)) {
    const count = text.match(/^命中\s+(\d+)/)?.[1] ?? "一些";
    return `我找到了 ${count} 个候选能力，接下来会先说明它们分别能做什么，再请你选择。`;
  }
  const phase = text.match(/^▶\s*进入阶段：(.+)$/)?.[1];
  if (phase) return phaseProgressTextForUi(phase);
  const approved = text.match(/^✓\s*闸门(\d+)\s*已批准/);
  if (approved) return `第 ${approved[1] ?? ""} 步已确认，我继续往下做。`;
  if (/^✗\s*闸门5\s*已驳回/.test(text)) return "最后检查没有通过，我会回到步骤安排重新检查。";
  return text;
}

function phaseProgressTextForUi(phase: string): string {
  return ({
    parsing: "我先把你的目标、输入和限制整理清楚。",
    planning: "接下来我会把这件事拆成几步，并说明每一步会产出什么。",
    retrieving: "我正在寻找能完成这些步骤的可靠能力。",
    assembling: "我正在把选中的能力按顺序组合起来。",
    verifying: "我先检查这些能力是否真的可用。",
    executing: "确认无误后，我会按刚才的步骤执行。",
    distilling: "最后我会把这次成功的做法整理成可复用场景。",
  } as Record<string, string>)[phase] ?? `我正在处理“${phase}”这一步。`;
}

function renderHelpCard(text: string): HTMLElement {
  const card = node("div", "status-card help-card");
  const title = node("div", "help-title"); title.append(textBlock("命令面板", "help-heading"), textBlock("输入命令或按 Ctrl/Cmd + K 快速打开", "help-hint")); card.append(title);
  const lines = text.split(/\r?\n/);
  const renderRows = (items: string[]): HTMLElement => {
    const grid = node("div", "help-grid");
    for (const line of items) {
      const separator = line.indexOf(" · ");
      const usage = separator >= 0 ? line.slice(0, separator) : line;
      const description = separator >= 0 ? line.slice(separator + 3) : "";
      const row = node("div", "help-row"); row.append(textBlock(usage, "help-command"), textBlock(description, "help-description")); grid.append(row);
    }
    return grid;
  };
  card.append(renderRows(lines.slice(0, 8)));
  if (lines.length > 8) {
    const more = node("details", "help-more"); const summary = node("summary"); summary.textContent = `查看全部命令（${lines.length}）`; more.append(summary, renderRows(lines.slice(8))); card.append(more);
  }
  return card;
}

function renderGateCard(message: GateCardMessage): HTMLElement {
  const card = node("div", "gate-card");
  const top = node("div", "gate-top");
  const heading = node("div");
  heading.append(textBlock(`阶段 ${message.gate} / 5`, "gate-step"), textBlock(gateTitle(message.gate), "gate-title"));
  top.append(heading, textBlock(message.decided ? "已处理" : "等待确认", "gate-pending"));
  card.append(top, textBlock(gateGuidance(message.gate, Boolean(message.decided)), "gate-guidance"));
  card.append(renderGateOverview(message));
  if (message.stale) {
    card.append(textBlock("这是服务恢复前的旧卡片，当前这一轮请使用最新的确认卡片。", "receipt"));
    return card;
  }
  if (message.decided) {
    card.append(textBlock(message.decided.action === "approve" ? "✓ 已确认，流程继续" : `已返回 ${message.decided.targetPhase ?? "上一阶段"}`, "receipt"));
    return card;
  }
  if (message.gate === 1 && message.editSeed && typeof message.editSeed === "object") {
    const intent = (message.editSeed as { intent?: { goal?: string; domain?: string; slots?: Array<{ name: string; value: string }>; keywords?: string[] } }).intent;
    const form = node("div", "gate-structured-form");
    const goal = node("input", "gate-field") as HTMLInputElement; goal.id = "gate-goal-1"; goal.value = intent?.goal ?? ""; goal.placeholder = "目标";
    const domain = node("input", "gate-field") as HTMLInputElement; domain.id = "gate-domain-1"; domain.value = intent?.domain ?? ""; domain.placeholder = "领域";
    form.append(textBlock("目标", "gate-field-label"), goal, textBlock("领域", "gate-field-label"), domain);
    for (const slot of intent?.slots ?? []) { const input = node("input", "gate-field") as HTMLInputElement; input.id = `gate-slot-1-${slot.name}`; input.value = slot.value; input.placeholder = slot.name; form.append(textBlock(slot.name, "gate-field-label"), input); }
    card.append(form);
  }
  if (message.gate === 2 && message.editSeed && typeof message.editSeed === "object") {
    const dag = (message.editSeed as { dag?: { nodes?: Array<{ id: string; title: string; deps?: string[]; expectedOutput?: string }> } }).dag;
    const form = node("div", "gate-structured-list");
    for (const [index, item] of (dag?.nodes ?? []).entries()) {
      const row = node("div", "gate-structured-row");
      row.append(textBlock(`第 ${index + 1} 步`, "gate-field-label"));
      const title = node("input", "gate-field") as HTMLInputElement; title.value = item.title; title.dataset.gate2Node = item.id; title.placeholder = "这一步要完成什么";
      const deps = node("input", "gate-field") as HTMLInputElement; deps.value = (item.deps ?? []).map((dep) => `第 ${nodeNumberForUi(dep)} 步`).join(", "); deps.dataset.gate2Deps = item.id; deps.placeholder = "前置步骤（可选）";
      row.append(title, deps); form.append(row);
    }
    const editor = node("details", "gate-editor");
    const summary = node("summary"); summary.textContent = "调整步骤（可选）";
    editor.append(summary, textBlock("你可以改每一步的说法，前置步骤留空表示从这里开始。", "section-label"), form);
    card.append(editor);
  }
  if (message.gate === 3 && message.editSeed && typeof message.editSeed === "object") {
    const seed = message.editSeed as { selections?: Array<{ nodeId: string; capabilityId: string; rationale?: string }>; candidates?: Array<{ nodeId: string; candidates: Array<{ id: string; name: string }> }> };
    const selections = seed.selections ?? [];
    const form = node("div", "gate-structured-list");
    for (const [index, item] of selections.entries()) {
      const row = node("div", "gate-structured-row"); row.append(textBlock(`第 ${index + 1} 步`, "gate-field-label"));
      const options = seed.candidates?.find((set) => set.nodeId === item.nodeId)?.candidates ?? [];
      const capability = options.length ? node("select", "gate-field") as HTMLSelectElement : node("input", "gate-field") as HTMLInputElement;
      capability.dataset.gate3Selection = item.nodeId;
      if (capability instanceof HTMLSelectElement) {
        capability.append(...options.map((option) => new Option(option.name, option.id)));
        capability.value = item.capabilityId;
      } else {
        capability.value = item.capabilityId;
        capability.placeholder = "选择或填写能力";
      }
      row.append(capability); form.append(row);
    }
    card.append(textBlock("每一步只需要选一个最合适的能力；如果推荐不合适，可以换一批。", "section-label"), form);
  }
  if (message.gate === 4 && message.editSeed && typeof message.editSeed === "object") {
    const acceptance = (message.editSeed as { acceptance?: Array<{ layer: string; passed: boolean; detail?: unknown; at?: string }> }).acceptance ?? [];
    const form = node("div", "gate-structured-list");
    acceptance.forEach((item, index) => {
      const row = node("label", "gate-structured-row");
      const checkbox = node("input") as HTMLInputElement; checkbox.type = "checkbox"; checkbox.checked = item.passed; checkbox.dataset.gate4Acceptance = String(index);
      const label = ({ component: "选中的能力可以正常工作", task: "整件任务可以完成", generalization: "换一组输入仍然可以完成" } as Record<string, string>)[item.layer] ?? item.layer;
      row.append(checkbox, textBlock(`${label} · ${item.passed ? "已通过" : "待检查"}`, "gate-field-label")); form.append(row);
    });
    card.append(textBlock("验收标准", "section-label"), form);
  }
  const actions = node("div", "gate-actions");
  if (message.gate === 5) {
    const pin = node("button", "gate-approve"); pin.dataset.action = "pin"; pin.dataset.gate = String(message.gate); pin.textContent = "保存为场景";
    if (message.canPin === false) { pin.disabled = true; pin.textContent = "检查通过后保存"; pin.title = "还有检查没有通过，请先重新检查"; }
    const rerun = node("button", "gate-edit"); rerun.dataset.action = "rerun"; rerun.dataset.gate = String(message.gate); rerun.textContent = "重新检查一次";
    const discard = node("button", "gate-reject"); discard.dataset.action = "discard"; discard.dataset.gate = String(message.gate); discard.textContent = "放弃这次构建";
    actions.append(pin, rerun, discard);
    if (message.canPin === false) actions.prepend(textBlock("还有检查未通过，暂时不能保存；可以重新检查，或放弃这次构建。", "gate-hint warning"));
  } else {
    const approve = node("button", "gate-approve"); approve.dataset.action = "approve"; approve.dataset.gate = String(message.gate); approve.textContent = gateApproveLabel(message.gate);
    const reject = node("button", "gate-reject"); reject.dataset.action = "reject"; reject.dataset.gate = String(message.gate); reject.textContent = gateRejectLabel(message.gate);
    const comment = node("input", "gate-comment"); comment.id = `gate-comment-${message.gate}`; comment.placeholder = "告诉系统要改什么（可选）";
    actions.append(approve, reject, comment);
  }
  card.append(actions);
  if (message.gate < 5 && message.editSeed) {
    const details = node("details", "gate-advanced");
    const summary = node("summary"); summary.textContent = "高级：查看并编辑原始结构";
    const area = node("textarea", "gate-json") as HTMLTextAreaElement; area.id = `gate-edit-${message.gate}`; area.value = safeJson(message.editSeed);
    const save = node("button", "gate-edit"); save.dataset.action = "edit"; save.dataset.gate = String(message.gate); save.textContent = "提交结构修改";
    details.append(summary, area, save); card.append(details);
  }
  return card;
}

function renderGateOverview(message: GateCardMessage): HTMLElement {
  const box = node("div", "gate-overview");
  const readableFallback = humanizeGateLines(message.gate, message.lines);
  const addLabel = (label: string, value: string, className = "") => {
    const row = node("div", `gate-overview-row ${className}`.trim());
    row.append(textBlock(label, "gate-overview-label"), textBlock(value, "gate-overview-value"));
    box.append(row);
  };
  if (message.gate === 1) {
    const intent = (message.editSeed as { intent?: { goal?: string; slots?: Array<{ name: string; value: string }> } } | undefined)?.intent;
    addLabel("目标", intent?.goal ?? "我正在确认这次要完成的事情。", "gate-overview-focus");
    const slots = (intent?.slots ?? []).filter((slot) => slot.value.trim()).map((slot) => `${slot.name}：${slot.value}`);
    if (slots.length) addLabel("已识别的输入", slots.join(" · "));
    return box;
  }
  if (message.gate === 2) {
    const dag = (message.editSeed as { dag?: { nodes?: Array<{ id: string; title: string; expectedOutput?: string }> } } | undefined)?.dag;
    const nodes = dag?.nodes ?? [];
    if (!nodes.length) addLabel("当前状态", "还没有拆出可执行步骤，请稍后重试。", "gate-overview-empty");
    for (const [index, item] of nodes.entries()) {
      const row = node("div", "gate-plan-row");
      row.append(textBlock(String(index + 1).padStart(2, "0"), "gate-plan-index"));
      const main = node("div", "gate-plan-main");
      main.append(textBlock(item.title, "gate-plan-title"));
      if (item.expectedOutput) main.append(textBlock(`会得到：${item.expectedOutput}`, "gate-plan-output"));
      row.append(main); box.append(row);
    }
    return box;
  }
  if (message.gate === 3) {
    const seed = message.editSeed as { candidates?: Array<{ nodeId: string; candidates: Array<{ name: string }> }> } | undefined;
    const candidates = seed?.candidates ?? [];
    if (!candidates.length) addLabel("当前状态", "还没有找到可用能力，请重新寻找。", "gate-overview-empty");
    for (const [index, set] of candidates.entries()) {
      const names = [...new Set(set.candidates.map((candidate) => candidate.name).filter(Boolean))].slice(0, 3);
      addLabel(`第 ${index + 1} 步`, names.length ? `推荐：${names.join("、")}${set.candidates.length > 3 ? ` 等 ${set.candidates.length} 项` : ""}` : "暂时没有候选能力");
    }
    return box;
  }
  if (message.gate === 4) {
    const acceptance = (message.editSeed as { acceptance?: Array<{ layer: string; passed: boolean }> } | undefined)?.acceptance ?? [];
    addLabel("执行顺序", "按已确认的步骤依次执行", "gate-overview-focus");
    const labels: Record<string, string> = { component: "能力可用", task: "任务完成", generalization: "换输入仍可完成" };
    for (const item of acceptance) addLabel(labels[item.layer] ?? item.layer, item.passed ? "已通过" : "待检查", item.passed ? "gate-overview-pass" : "gate-overview-pending");
    return box;
  }
  const lines = message.lines.map((line) => String(line).trim());
  const steps = lines.find((line) => line.startsWith("执行步骤:"))?.slice(5).trim();
  if (steps) addLabel("本次执行", `${steps} 步`);
  const acceptance = lines.find((line) => line.startsWith("验收:"));
  if (acceptance) {
    const labels: Record<string, string> = { component: "能力可用", task: "任务完成", generalization: "换输入仍可完成" };
    const latest = new Map<string, string>();
    for (const item of acceptance.slice(3).trim().split(/\s+/)) {
      const [layer, state] = item.split(":");
      if (layer) latest.set(layer, state === "过" ? "已通过" : "未通过");
    }
    for (const layer of ["component", "task", "generalization"]) { const state = latest.get(layer); if (state) addLabel(labels[layer] ?? layer, state, state === "已通过" ? "gate-overview-pass" : "gate-overview-fail"); }
  }
  if (!box.childElementCount) addLabel("当前状态", readableFallback[0] ?? "正在整理最终检查结果。", "gate-overview-empty");
  return box;
}

function gateTitle(gate: number): string {
  return ({ 1: "先确认我们要做什么", 2: "把工作拆成几步", 3: "选出要用的能力", 4: "检查流程能不能跑", 5: "决定是否保存成场景" } as Record<number, string>)[gate] ?? "确认下一步";
}

function gateGuidance(gate: number, decided: boolean): string {
  if (decided) return "这一步已经处理过了，下面是当时的确认结果。";
  return ({
    1: "我先把你的目标和输入整理出来。请确认我理解得对不对，也可以直接改。",
    2: "我把这件事拆成几个小步骤。请确认顺序和每一步的产出是否合理。",
    3: "我找到了几种可能的能力。请确认推荐选择，必要时可以换一批。",
    4: "我把能力连成了执行流程，并先做一次可用性检查。请确认后开始执行。",
    5: "最后检查这次结果能不能稳定复用。全部通过后，就可以保存成下次直接使用的场景。",
  } as Record<number, string>)[gate] ?? "请确认这一步后继续。";
}

function gateApproveLabel(gate: number): string {
  return ({ 1: "确认我的理解", 2: "确认步骤安排", 3: "采用这些能力", 4: "确认并开始执行" } as Record<number, string>)[gate] ?? "确认并继续";
}

function gateRejectLabel(gate: number): string {
  return ({ 1: "重新说明目标", 2: "返回调整步骤", 3: "换一批能力", 4: "返回调整流程" } as Record<number, string>)[gate] ?? "返回修改";
}

function nodeNumberForUi(id: string): string {
  return id.match(/\d+/)?.[0] ?? id;
}

function normalizeDependencyInput(value: string): string {
  const clean = value.trim();
  const friendly = clean.match(/^第\s*(\d+)\s*步$/);
  return friendly ? `n${friendly[1]}` : clean;
}

function humanizeGateLines(gate: number, source: string[]): string[] {
  const result: string[] = [];
  const friendlyLayer: Record<string, string> = { component: "选中的能力是否可用", task: "这次任务是否完成", generalization: "换一组输入后是否仍能完成" };
  const nodeNumber = (id: string): string => {
    const match = id.match(/\d+/);
    return match ? match[0] : id;
  };
  for (const raw of source) {
    const line = String(raw).trim();
    if (!line || /^═+$/.test(line) || /^\[[a-z]\]/i.test(line)) continue;
    if (gate === 1) {
      if (line.startsWith("确认意图与槽位")) continue;
      if (line.startsWith("目标:")) { result.push(`我理解的目标：${line.slice(3).trim()}`); continue; }
      if (line.startsWith("领域:")) { result.push(`工作类型：${line.replace(/^领域:\s*/, "").replace(/\s+解析方式:\s*\w+$/, "")}`); continue; }
      if (line.startsWith("槽位")) { result.push("需要你补充或确认的输入："); continue; }
      if (line.startsWith("关键词:")) { result.push(`我会重点关注：${line.slice(4).trim()}`); continue; }
      if (line.startsWith("（意图尚未解析）")) { result.push("我还没能完整理解目标，请补充一句具体想完成的结果。"); continue; }
      if (line.startsWith("·")) { result.push(`• ${line.slice(1).trim()}`); continue; }
      result.push(line);
      continue;
    }
    if (gate === 2) {
      if (line.startsWith("审阅任务清单")) continue;
      const count = line.match(/^任务节点\s*×(\d+)/);
      if (count) { result.push(`我把这件事拆成 ${count[1] ?? "几"} 步，请确认下面的安排。`); continue; }
      const task = line.match(/^\[(n\d+)\]\s*(.*?)(?:\s*←\s*依赖:.*|（起点）)?$/);
      if (task) { result.push(`第 ${nodeNumber(task[1] ?? "")} 步：${(task[2] ?? "").trim()}`); continue; }
      if (line.startsWith("期望输出:")) { result.push(`这一步会产出：${line.slice(5).trim()}`); continue; }
      if (line.startsWith("（任务清单尚未生成）")) { result.push("我还没有拆出可执行步骤，请稍等片刻后重试。"); continue; }
      result.push(line);
      continue;
    }
    if (gate === 3) {
      const count = line.match(/^节点\s+([^ ]+)\s+候选\s*×(\d+)/);
      if (count) { result.push(`第 ${nodeNumber(count[1] ?? "")} 步有 ${count[2] ?? "几个"} 个可用能力，请选择最合适的一项。`); continue; }
      const candidate = line.match(/^\[(官方|策展|聚合)\]\s+(.+?)\s+trust\s+.*?来源:\s*([^\s]+)/);
      if (candidate) { result.push(`推荐能力：${candidate[2] ?? "一项能力"}（来源：${candidate[3] ?? "能力库"}）`); continue; }
      if (line.startsWith("（候选尚未检索）")) { result.push("我还没有找到可用能力，请重试检索。"); continue; }
      if (line.startsWith("来源:") || line.startsWith("安装:") || line.startsWith("[")) continue;
      result.push(line);
      continue;
    }
    if (gate === 4) {
      if (line === "流水线图:") { result.push("我会按下面的顺序执行："); continue; }
      if (/──.*──▶/.test(line)) continue;
      const step = line.match(/^\(([^)]+)\)\s+(.+)/);
      if (step) { result.push(`第 ${nodeNumber(step[1] ?? "")} 步：${(step[2] ?? "").replace(/\s+⟲需胶水$/, "（需要额外衔接）")}`); continue; }
      if (line.startsWith("验收清单")) { result.push("开始前请确认这些检查标准："); continue; }
      const check = line.match(/^\[([✓✗ ])\]\s*(component|task|generalization)$/);
      if (check) { result.push(`${friendlyLayer[check[2] ?? ""] ?? "这项检查"}：${check[1] === "✓" ? "已通过" : check[1] === "✗" ? "未通过" : "待检查"}`); continue; }
      if (line.startsWith("（装配图尚未生成）")) { result.push("执行流程还没有生成，请稍等片刻后重试。"); continue; }
      result.push(line);
      continue;
    }
    if (gate === 5) {
      if (line === "升维前后对照:") { result.push("最后，我会检查这次成功是否能变成长期可复用场景。"); continue; }
      if (line.startsWith("需求:")) { result.push(`这次要固化的目标：${line.slice(3).trim()}`); continue; }
      if (line.startsWith("执行步骤:")) { result.push(`本次实际执行了 ${line.slice(5).trim()} 步。`); continue; }
      if (line.startsWith("验收:")) {
        const latest = new Map<string, string>();
        for (const item of line.slice(3).trim().split(/\s+/)) { const [layer, state] = item.split(":"); if (layer) latest.set(layer, state === "过" ? "已通过" : "未通过"); }
        for (const layer of ["component", "task", "generalization"]) { const state = latest.get(layer); if (state) result.push(`${friendlyLayer[layer] ?? layer}：${state}`); }
        continue;
      }
      if (line.startsWith("泛化结果:")) { result.push("换不同输入测试已准备好，全部通过后可以保存。"); continue; }
      if (line.startsWith("当前执行或验收")) continue;
      result.push(line);
      continue;
    }
    result.push(line);
  }
  return result;
}

// ── 聊天栏左侧微型进度导轨与右侧短横微地图（复刻用户截图） ──

let activeMinimapIndex = 0;

function renderLeftProgress(snap: PanelSnapshot): void {
  const container = $("chat-left-progress");
  if (!container) return;
  container.replaceChildren();

  const phases = [
    { key: "parsing", label: "意图解析" },
    { key: "planning", label: "任务清单" },
    { key: "retrieving", label: "能力选型" },
    { key: "assembling", label: "流程装配" },
    { key: "distilling", label: "固化场景" },
  ];

  const currentPhaseIndex = phases.findIndex((p) => p.key === (snap.phase ?? ""));
  const rail = node("div", "left-progress-rail");
  const fill = node("div", "left-progress-fill");
  const percent = snap.run.status === "succeeded" ? 100 : currentPhaseIndex >= 0 ? ((currentPhaseIndex + 0.5) / phases.length) * 100 : 0;
  fill.style.height = `${percent}%`;
  container.append(rail, fill);

  phases.forEach((p, index) => {
    const isDone = snap.run.status === "succeeded" || (currentPhaseIndex >= 0 && index < currentPhaseIndex);
    const isActive = snap.run.status === "running" && index === currentPhaseIndex;
    const dot = node("div", `left-progress-dot${isDone ? " done" : ""}${isActive ? " active" : ""}`);
    dot.dataset.phase = p.key;
    const tooltip = textBlock(`${index + 1}. ${p.label}`, "progress-tooltip");
    dot.append(tooltip);
    container.append(dot);
  });
}

function renderMinimap(): void {
  const container = $("chat-minimap");
  if (!container) return;
  container.replaceChildren();

  const items = document.querySelectorAll<HTMLElement>(".chat-stream .run-group-card, .chat-stream > .message");
  if (items.length <= 1) {
    container.style.display = "none";
    return;
  }
  container.style.display = "flex";
  // 长会话刻度压缩：数量超出视口容量时按级收紧间距与刻度高度
  container.classList.toggle("dense", items.length > 24);
  container.classList.toggle("super-dense", items.length > 44);
  container.style.maxHeight = `${Math.round(window.innerHeight * 0.72)}px`;
  container.style.overflow = "hidden";

  items.forEach((el, index) => {
    const isUser = el.classList.contains("message-user") || el.querySelector(".message-user");
    const isProgress = el.classList.contains("progress-message") || el.querySelector(".progress-card");
    const isGate = el.classList.contains("message-gate-card") || el.querySelector(".gate-card");

    let title = "消息";
    let subtitle = "";
    const bullets: string[] = [];

    if (isUser) {
      const contentEl = el.querySelector(".message-content");
      const userText = (contentEl ? contentEl.textContent : el.textContent)?.trim().replace(/\s+/g, " ") ?? "";
      title = userText.slice(0, 32);
      subtitle = "用户需求";
    } else if (isProgress) {
      title = "构建与思考流程";
      const summaryText = el.querySelector(".progress-details-summary")?.textContent ?? "";
      subtitle = summaryText || "进行中";
      const stepTexts = el.querySelectorAll(".progress-step-text");
      stepTexts.forEach((st, i) => {
        if (i < 3) bullets.push(st.textContent?.slice(0, 24) ?? "");
      });
    } else if (isGate) {
      title = el.querySelector(".gate-title")?.textContent ?? "闸门确认";
      subtitle = el.querySelector(".gate-step")?.textContent ?? "阶段等待确认";
      const lines = el.querySelectorAll(".sc-gate-line, .gate-plan-title");
      lines.forEach((l, i) => {
        if (i < 3) bullets.push(l.textContent?.slice(0, 24) ?? "");
      });
    } else {
      const content = el.querySelector(".message-content")?.textContent?.trim().replace(/\s+/g, " ") ?? "";
      title = content.slice(0, 30) || "AI 产出与答复";
      subtitle = "执行产物";
      const listItems = el.querySelectorAll("li");
      listItems.forEach((li, i) => {
        if (i < 3) bullets.push(li.textContent?.slice(0, 24) ?? "");
      });
    }

    const tick = node("button", `minimap-tick${index === activeMinimapIndex ? " active" : ""}`);
    tick.type = "button";
    tick.dataset.index = String(index);
    tick.setAttribute("aria-label", title);

    const dash = node("span", "minimap-tick-dash");

    // 悬浮预览卡片（严格复刻用户截图格式）
    const popover = node("div", "minimap-popover");
    const popTitle = textBlock(title, "minimap-popover-title");
    popover.append(popTitle);
    if (subtitle) {
      const popSub = textBlock(subtitle, "minimap-popover-subtitle");
      popover.append(popSub);
    }
    if (bullets.length) {
      const ul = node("ul", "minimap-popover-bullets");
      for (const b of bullets) {
        const li = node("li");
        li.textContent = `• ${b}`;
        ul.append(li);
      }
      popover.append(ul);
    }

    tick.append(dash, popover);
    tick.addEventListener("click", () => {
      activeMinimapIndex = index;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      updateMinimapTicks();
    });
    container.append(tick);
  });
}

function updateMinimapTicks(): void {
  const ticks = document.querySelectorAll(".minimap-tick");
  ticks.forEach((tick, i) => {
    tick.classList.toggle("active", i === activeMinimapIndex);
  });
}

function updateMinimapActive(): void {
  const root = $("chat-root");
  if (!root) return;
  const items = document.querySelectorAll<HTMLElement>(".chat-stream .run-group-card, .chat-stream > .message");
  if (!items.length) return;
  const rootRect = root.getBoundingClientRect();
  const centerY = rootRect.top + rootRect.height / 2;

  let closestIndex = 0;
  let minDistance = Infinity;

  items.forEach((el, index) => {
    const rect = el.getBoundingClientRect();
    const itemCenter = rect.top + rect.height / 2;
    const distance = Math.abs(itemCenter - centerY);
    if (distance < minDistance) {
      minDistance = distance;
      closestIndex = index;
    }
  });

  if (activeMinimapIndex !== closestIndex) {
    activeMinimapIndex = closestIndex;
    updateMinimapTicks();
  }
}

function renderChat(): void {
  const root = $("chat-root"); if (!root) return;
  const resetPosition = chatNeedsInitialScroll;
  chatNeedsInitialScroll = false;
  const wasAtBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 48;
  const previousTop = root.scrollTop;
  const liveStream = messages.some((message) => (message.role === "model-stream" || message.role === "model-thinking") && message.streaming !== false);
  root.setAttribute("aria-busy", String(liveStream));
  root.replaceChildren();
  if (!messages.length) {
    const empty = node("div", "chat-empty");
    const card = node("div", "empty-card");
    const h = node("h3"); h.textContent = panelMode === "work" ? "把重复工作交给 SceneFlow 场景" : "从一句话开始，构建可复用场景";
    const p = node("p"); p.textContent = panelMode === "work" ? "系统会优先复用已固化场景，并把运行过程显示在右侧检查台。" : "确认每一个关键阶段，把一次成功流程沉淀成下次可以直接调用的场景。";
    card.append(h, p); empty.append(card); root.append(empty); updateJumpButton(false);
    $("chat-minimap")?.replaceChildren();
    $("chat-left-progress")?.replaceChildren();
    return;
  }
  for (const message of condensedMessages(messages)) root.append(renderMessage(message));
  if (resetPosition || wasAtBottom) root.scrollTop = root.scrollHeight;
  else root.scrollTop = previousTop;
  updateJumpButton(!wasAtBottom && root.scrollHeight > root.clientHeight && root.scrollTop < root.scrollHeight - root.clientHeight - 48);
  renderMinimap();
  if (currentSnapshot) renderLeftProgress(currentSnapshot);
}

function condensedMessages(source: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = [];
  for (const message of source) {
    const role = String(message.role ?? "");
    if (role === "gate-card" && message.stale === true) continue;
    if (role === "build-status" && message.terminal !== true && String(message.tone ?? "info") === "info" && !String(message.text ?? "").startsWith("/help ·")) {
      const item = { tone: message.tone as Tone | undefined, text: String(message.text ?? ""), ts: Number(message.ts ?? message.timestamp ?? Date.now()) };
      const previous = output.at(-1);
      if (previous?.role === "activity-group") {
        const items = Array.isArray(previous.items) ? previous.items : [];
        previous.items = [...items, item];
      } else output.push({ role: "activity-group", items: [item], ts: item.ts });
      continue;
    }
    if (role === "model-stream" || role === "model-thinking") {
      const content = String(message.content ?? message.text ?? "");
      const previous = output.at(-1);
      if (previous && previous.role === role && (!previous.nodeId || !message.nodeId || previous.nodeId === message.nodeId)) {
        previous.content = `${String(previous.content ?? "")}${content}`;
        previous.ts = message.ts ?? previous.ts;
      } else {
        output.push({ ...message, content, streamKey: `${role}-${String(message.nodeId ?? "main")}-${output.length}` });
      }
    } else output.push(message);
  }
  const runs: Array<Record<string, unknown>> = [];
  let current: RunGroupMessage | null = null;
  for (const message of output) {
    if (message.role === "user") {
      if (current) runs.push(current as unknown as Record<string, unknown>);
      const userTimestamp = String(message.ts ?? message.timestamp ?? "");
      const userContent = String(message.content ?? "").slice(0, 120);
      current = { role: "run-group", user: message, items: [], expanded: false, groupId: `run-${userTimestamp}-${userContent}` };
    } else if (current) current.items.push(message);
    else runs.push(message);
  }
  if (current) runs.push(current as unknown as Record<string, unknown>);
  const groupIndexes = runs.map((item, index) => item.role === "run-group" ? index : -1).filter((index) => index >= 0);
  const latest = groupIndexes.at(-1);
  for (const index of groupIndexes) (runs[index] as unknown as RunGroupMessage).expanded = index === latest;
  return runs;
}

function pushMessage(message: Record<string, unknown>): void {
  // SceneFlow：持久化终态进度卡与 live 卡按 runId 合并——保留 live 卡的过程明细
  //（narration/steps/sources），用持久卡补 finishedAt，避免出现两张同 run 卡。
  if ((message as { role?: string }).role === "progress-card") {
    const card = message as unknown as ProgressCardMessage;
    const existing = findProgressCard(card.runId);
    if (existing) {
      existing.finishedAt = card.finishedAt ?? existing.finishedAt;
      if (card.line && !existing.line) existing.line = card.line;
      if (card.startedAt) existing.startedAt = existing.startedAt || card.startedAt;
      rememberProgressCard(existing);
      updateProgressDom(existing);
      renderChat();
      return;
    }
  }
  if (message.role !== "model-stream" && message.role !== "model-thinking") {
    // A non-stream event is the protocol boundary for the previous model
    // response. Persisting this bit locally keeps the caret from blinking on
    // completed responses, including after a reconnect snapshot.
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role !== "model-stream" && messages[index]?.role !== "model-thinking") break;
      messages[index] = { ...messages[index], streaming: false };
    }
  }
  messages.push(message);
  // R3 审计：长会话内存上限——超限裁掉最旧的普通消息（保留 model-stream
  // 连续段由 normalize 逻辑处理；裁剪只从数组头部移除已完成消息）
  if (messages.length > 500) {
    let excess = messages.length - 500;
    for (let index = 0; index < messages.length && excess > 0; index += 1) {
      const role = String(messages[index]?.role ?? "");
      if (role === "model-stream" || role === "model-thinking") continue;
      messages.splice(index, 1);
      excess -= 1;
      index -= 1;
    }
  }
  scheduleChatRender();
}

function normalizeChatMessages(source: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = [];
  let streamStart = -1;
  for (const message of source) {
    const role = String(message.role ?? "");
    if (role === "model-stream" || role === "model-thinking") {
      if (streamStart < 0) streamStart = output.length;
      output.push({ ...message, streaming: true });
      continue;
    }
    if (streamStart >= 0) {
      for (let index = streamStart; index < output.length; index += 1) output[index] = { ...output[index], streaming: false };
      streamStart = -1;
    }
    output.push({ ...message });
  }
  return output;
}

function updateJumpButton(show: boolean): void {
  const button = $("jump-latest");
  if (!button) return;
  button.classList.toggle("hidden", !show);
  button.setAttribute("aria-hidden", String(!show));
  button.setAttribute("aria-label", show ? "跳转到最新消息" : "已在最新消息");
}

function sendPayload(payload: unknown): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) { pushMessage({ role: "build-status", tone: "err", text: "面板尚未连接，请稍后再试。" }); return false; }
  const raw = payload as Record<string, unknown>;
  const requestId = typeof raw?.requestId === "string" ? raw.requestId : `ui-${Date.now()}-${++requestSequence}`;
  const type = typeof raw?.type === "string" ? raw.type : "unknown";
  const gate = type === "gate-decision" && typeof raw.decision === "object" && raw.decision !== null ? Number((raw.decision as { gate?: unknown }).gate) : undefined;
  pendingActions.set(requestId, { type, ...(Number.isFinite(gate) ? { gate } : {}) });
  try {
    ws.send(JSON.stringify({ ...raw, requestId }));
    return true;
  } catch {
    pendingActions.delete(requestId);
    pushMessage({ role: "build-status", tone: "err", text: "面板连接刚刚断开，请稍后再试。" });
    setConnection(false);
    return false;
  }
}


function activeLongRun(): LongRunSummary | undefined {
  if (!currentSnapshot) return undefined;
  return currentSnapshot.longRuns.find((run) => run.id === currentSnapshot?.run.runId)
    ?? currentSnapshot.longRuns.find((run) => run.sessionId === currentSnapshot?.sessionId && ["queued", "running", "paused"].includes(run.status));
}

function sendRunControl(action: "pause" | "resume" | "stop"): void {
  const longRun = activeLongRun();
  if (longRun && ["queued", "running", "paused"].includes(longRun.status)) {
    sendPayload({ type: "control-long-run", longRunId: longRun.id, action });
    return;
  }
  sendPayload({ type: "control", action: action === "stop" ? "terminate" : action });
}

function setMode(mode: PanelMode): void {
  if (busy) return;
  // A mode change starts a different intent. Never let a long-run choice from
  // the new-session dialog silently carry into a later build/work request.
  pendingLongRunConfig = null;
  if (sendPayload({ type: "set-mode", mode })) { applyMode(mode); renderChat(); }
}

function startRun(): void {
  const input = $("req-input") as HTMLTextAreaElement | null;
  const requirement = input?.value.trim() ?? "";
  if (requirement.length < 2) return;
  if (busy) {
    if (requirement.startsWith("/")) {
      if (sendPayload({ type: "run-command", input: requirement })) {
        if (input) input.value = "";
        input?.dispatchEvent(new Event("input", { bubbles: true }));
      }
      return;
    }
    if (sendPayload({ type: "guide-run", instruction: requirement })) {
      if (input) input.value = "";
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    }
    return;
  }
  inputHistory.push(requirement); if (inputHistory.length > 30) inputHistory.shift(); inputHistoryIndex = -1;
  if (requirement.startsWith("/")) {
    if (sendPayload({ type: "run-command", input: requirement })) {
      if (input) input.value = "";
      renderCommandMenu("");
    }
    return;
  }
  const slots: Record<string, string> = {};
  document.querySelectorAll<HTMLInputElement>("[data-slot-name]").forEach((input) => { if (input.value.trim()) slots[input.dataset.slotName ?? ""] = input.value.trim(); });
  chatNeedsInitialScroll = true;
  const longRun = pendingLongRunForSession(pendingLongRunConfig, currentSnapshot?.sessionId, currentSnapshot?.activeScenarioId);
  const payload = longRun
    ? { type: "create-long-run", requirement, scenarioId: longRun.scenarioId, maxRounds: longRun.maxRounds, ...(longRun.projectId ? { projectId: longRun.projectId } : {}), ...(Object.keys(slots).length ? { slots } : {}) }
    : { type: "start-build", requirement, mode: panelMode, ...(currentSnapshot?.activeScenarioId ? { scenarioId: currentSnapshot.activeScenarioId } : {}), ...(Object.keys(slots).length ? { slots } : {}) };
  if (!sendPayload(payload)) { chatNeedsInitialScroll = false; return; }
  setBusy(true);
  if (input) input.value = "";
}

function decide(gate: number, action: "approve" | "reject" | "edit" | "pin" | "rerun" | "discard"): void {
  if (pendingDecisions.has(gate)) return;
  const comment = (document.getElementById(`gate-comment-${gate}`) as HTMLInputElement | null)?.value.trim() || undefined;
  const targets: Record<number, string> = { 1: "parsing", 2: "planning", 3: "retrieving", 4: "assembling", 5: "planning" };
  const decision: Record<string, unknown> = { gate, action: action === "pin" || action === "discard" ? "approve" : action === "rerun" ? "reject" : action };
  if (action === "pin" || action === "rerun" || action === "discard") decision.choice = action;
  if (action === "edit") {
    const area = document.getElementById(`gate-edit-${gate}`) as HTMLTextAreaElement | null;
    if (gate === 1 && area) {
      try {
        const original = JSON.parse(area.value) as { kind: "intent"; intent: { goal?: string; domain?: string; slots?: Array<{ name: string; value: string }>; keywords?: string[] } };
        const goal = (document.getElementById("gate-goal-1") as HTMLInputElement | null)?.value.trim() || original.intent.goal || "";
        const domain = (document.getElementById("gate-domain-1") as HTMLInputElement | null)?.value.trim() || original.intent.domain || "general";
        const slots = (original.intent.slots ?? []).map((slot) => ({ name: slot.name, value: (document.getElementById(`gate-slot-1-${slot.name}`) as HTMLInputElement | null)?.value ?? slot.value }));
        decision.edit = { kind: "intent", intent: { goal, domain, slots, keywords: original.intent.keywords ?? [], via: "llm" } };
      } catch { pushMessage({ role: "build-status", tone: "err", text: "结构修改不是有效 JSON。" }); return; }
    } else if (gate === 2 && area) {
      try {
        const original = JSON.parse(area.value) as { kind: "dag"; dag: { nodes: Array<{ id: string; title: string; deps?: string[]; expectedOutput?: string }> } };
        decision.edit = { kind: "dag", dag: { nodes: original.dag.nodes.map((item) => ({ ...item, title: (document.querySelector<HTMLInputElement>(`[data-gate2-node="${CSS.escape(item.id)}"]`)?.value.trim() || item.title), deps: (document.querySelector<HTMLInputElement>(`[data-gate2-deps="${CSS.escape(item.id)}"]`)?.value ?? (item.deps ?? []).map((dep) => `第 ${nodeNumberForUi(dep)} 步`).join(", ")).split(",").map((dep) => normalizeDependencyInput(dep)).filter(Boolean) })) } };
      } catch { pushMessage({ role: "build-status", tone: "err", text: "任务节点表单无效，请检查高级 JSON。" }); return; }
    } else if (gate === 3 && area) {
      try {
        const original = JSON.parse(area.value) as { kind: "selections"; selections: Array<{ nodeId: string; capabilityId: string; rationale?: string }> };
        decision.edit = { kind: "selections", selections: original.selections.map((item) => ({ ...item, capabilityId: document.querySelector<HTMLSelectElement | HTMLInputElement>(`[data-gate3-selection="${CSS.escape(item.nodeId)}"]`)?.value.trim() || item.capabilityId })) };
      } catch { pushMessage({ role: "build-status", tone: "err", text: "能力选型表单无效，请检查高级 JSON。" }); return; }
    } else if (gate === 4 && area) {
      try {
        const original = JSON.parse(area.value) as { kind: "acceptance"; acceptance: Array<{ layer: string; passed: boolean; detail?: unknown; at?: string }> };
        decision.edit = { kind: "acceptance", acceptance: original.acceptance.map((item, index) => ({ ...item, passed: document.querySelector<HTMLInputElement>(`[data-gate4-acceptance="${index}"]`)?.checked ?? item.passed })) };
      } catch { pushMessage({ role: "build-status", tone: "err", text: "验收表单无效，请检查高级 JSON。" }); return; }
    } else {
      try { decision.edit = JSON.parse(area?.value ?? ""); } catch { pushMessage({ role: "build-status", tone: "err", text: "结构修改不是有效 JSON。" }); return; }
    }
  }
  if (action === "reject" || action === "rerun") { decision.targetPhase = targets[gate] ?? "planning"; if (comment) decision.comment = comment; }
  pendingDecisions.add(gate);
  const sent = sendPayload({ type: "gate-decision", decision });
  if (!sent) pendingDecisions.delete(gate);
}

function bindTabs(): void {
  const tabs = [...document.querySelectorAll<HTMLButtonElement>(".side-tab")];
  tabs.forEach((button) => button.addEventListener("click", () => {
    tabs.forEach((item) => {
      const active = item === button;
      item.classList.toggle("active", active);
      item.setAttribute("aria-selected", String(active));
      item.tabIndex = active ? 0 : -1;
    });
    const memory = $("tab-memory");
    const scenarios = $("tab-scenarios");
    const memoryActive = button.dataset.tab === "memory";
    memory?.classList.toggle("hidden", !memoryActive);
    scenarios?.classList.toggle("hidden", memoryActive);
  }));
  tabs.forEach((button, index) => button.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : event.key === "ArrowRight" ? (index + 1) % tabs.length : (index - 1 + tabs.length) % tabs.length;
    tabs[nextIndex]?.focus();
    tabs[nextIndex]?.click();
  }));
  tabs.forEach((button) => {
    const active = button.classList.contains("active");
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
}

function connect(): void {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${protocol}://${location.host}/ws`);
  ws.addEventListener("open", () => { setConnection(true); if (!messages.length) pushMessage({ role: "build-status", tone: "info", text: "已连接。工作模式会先复用场景，构建模式会生成新场景。" }); });
  ws.addEventListener("error", () => setConnection(false));
  ws.addEventListener("open", () => { reconnectAttempts = 0; setConnection(true); if (!messages.length) pushMessage({ role: "build-status", tone: "info", text: "已连接。工作模式会先复用场景，构建模式会生成新场景。" }); });
  ws.addEventListener("error", () => setConnection(false));
  // R3 审计：指数退避重连（1s 起、×2、封顶 30s），避免服务器重启期间的重连风暴
  ws.addEventListener("close", () => {
    setConnection(false);
    if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
    const delay = Math.min(1000 * 2 ** reconnectAttempts, RECONNECT_MAX_DELAY_MS);
    reconnectAttempts += 1;
    reconnectTimer = window.setTimeout(connect, delay);
  });
  ws.addEventListener("message", (event) => {
    let payload: Record<string, unknown>; try { payload = JSON.parse(String(event.data)) as Record<string, unknown>; } catch { return; }
    if (payload.kind === "snapshot") {
      const nextSnapshot = payload.snapshot as PanelSnapshot;
      const nextMessageCount = Array.isArray(nextSnapshot.chat) ? nextSnapshot.chat.length : 0;
      chatNeedsInitialScroll = shouldResetChatScroll(hasReceivedSnapshot, snapshotSessionId, nextSnapshot.sessionId, messages.length, nextMessageCount);
      snapshotSessionId = nextSnapshot.sessionId;
      hasReceivedSnapshot = true;
      currentSnapshot = nextSnapshot;
      panelMode = currentSnapshot.mode ?? panelMode; applyMode(panelMode); renderRight(currentSnapshot);
      messages = normalizeChatMessages(Array.isArray(currentSnapshot.chat) ? currentSnapshot.chat : []);
      // SceneFlow：进度卡不在服务端聊天历史里，快照重建后按 runId 挂回
      reattachProgressCards();
      renderChat();
      setBusy(currentSnapshot.busy);
    } else if (payload.kind === "chat") {
      const message = payload.message as Record<string, unknown>;
      if (message.role === "gate-card") pendingDecisions.delete(Number(message.gate));
      pushMessage(message);
       if (message.role === "ui-command" && message.command === "settings") $("settings-modal")?.classList.remove("hidden");
       if (message.role === "ui-command" && message.command === "file-picker") ($("file-picker") as HTMLInputElement | null)?.click();
       if (message.role === "ui-command" && message.command === "connectors") $("connector-modal")?.classList.remove("hidden");
       if (message.role === "ui-command" && message.command === "memory") $("memory-modal")?.classList.remove("hidden");
       if (message.role === "ui-command" && message.command === "export-session") {
         const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), sessionId: currentSnapshot?.sessionId, messages }, null, 2)], { type: "application/json" });
         const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `scenario-session-${currentSnapshot?.sessionId ?? "export"}.json`; anchor.click(); URL.revokeObjectURL(url);
       }
       if (message.role === "ui-command" && message.command === "export-workspace") {
         fetch("/api/workspace/export").then(async (response) => { if (!response.ok) throw new Error("export failed"); const blob = new Blob([await response.text()], { type: "application/json" }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `scenario-workspace-${currentSnapshot?.workspace?.id ?? "export"}.json`; anchor.click(); URL.revokeObjectURL(url); }).catch(() => pushMessage({ role: "build-status", tone: "err", text: "工作区导出失败。" }));
       }
      if ((message as unknown as BuildStatusMessage).terminal) setBusy(false);
    } else if (payload.kind === "action-result") {
      const requestId = typeof payload.requestId === "string" ? payload.requestId : undefined;
      const meta = requestId ? pendingActions.get(requestId) : undefined;
      if (requestId) pendingActions.delete(requestId);
      const ok = Boolean(payload.ok);
      if (!ok) {
        if (meta?.gate !== undefined) pendingDecisions.delete(meta.gate);
        if (meta?.type === "new-session") { pendingLongRunConfig = null; const button = $("create-new-session") as HTMLButtonElement | null; if (button) { button.disabled = false; button.textContent = "开始对话"; } }
        if (meta?.type === "choose-project-folder") { const hint = $("new-session-folder-hint"); if (hint) hint.textContent = String(payload.error ?? "未绑定文件夹，当前项目没有变化。"); }
        setBusy(false); pushMessage({ role: "build-status", tone: "err", text: String(payload.error ?? "操作失败") });
      }
      else if (meta?.type === "test-settings") { const result = $("settings-result"); if (result) result.textContent = "模型连接验证成功。"; }
      else if (meta?.type === "choose-project-folder") { const data = payload.data as { rootPath?: string; fileCount?: number } | undefined; const hint = $("new-session-folder-hint"); if (hint) hint.textContent = `已绑定真实文件夹${data?.rootPath ? `：${data.rootPath}` : ""}，扫描 ${data?.fileCount ?? 0} 个文件。`; if (currentSnapshot) renderNewSessionDialog(currentSnapshot); }
      else if (meta?.type === "update-settings") { const result = $("settings-result"); if (result) result.textContent = "设置已保存，后续新运行会使用新配置。"; }
      else if (meta?.type === "create-share") { const token = (payload.data as { token?: string } | undefined)?.token; if (token) { void copyText(token); pushMessage({ role: "build-status", tone: "ok", text: `分享令牌已创建并复制：${token}` }); } }
      else if (meta?.type === "create-identity") { const token = (payload.data as { token?: string } | undefined)?.token; if (token) { void copyText(token); const result = $("identity-result"); if (result) result.textContent = `身份已创建，令牌已复制：${token}`; } }
      else if (["create-memory", "update-memory", "delete-memory"].includes(meta?.type ?? "")) { $("memory-modal")?.classList.add("hidden"); }
        else if (meta?.type === "new-session") {
          // The server broadcasts the new-session snapshot before its action
          // result. Bind the selected long-run choice to that new session only;
          // a later history/project/mode navigation clears it.
          const newSessionData = payload.data as { projectId?: string | null } | undefined;
          if (pendingLongRunConfig && currentSnapshot?.sessionId) pendingLongRunConfig = { ...pendingLongRunConfig, sessionId: currentSnapshot.sessionId, projectId: newSessionData?.projectId ?? currentSnapshot.projectId };
          $("new-session-modal")?.classList.add("hidden"); const button = $("create-new-session") as HTMLButtonElement | null; if (button) { button.disabled = false; button.textContent = "开始对话"; } ($("req-input") as HTMLTextAreaElement | null)?.focus();
        }
      else if (meta?.type === "create-long-run") { pendingLongRunConfig = null; }
    } else if (payload.kind === "run-error") { setBusy(false); pushMessage({ role: "build-status", tone: "err", text: String(payload.message ?? "运行失败") }); }
    else if (payload.kind === "progress") { applyProgress(payload); }
    else if (payload.kind === "progress-delta") { applyProgressDelta(payload); }
  });
}

// ── SceneFlow 进度卡：服务端 pushProgress/progress-delta 原地更新那一张卡 ──

const PROGRESS_PHASE_LABELS: Record<string, string> = {
  parsing: "意图",
  planning: "任务清单",
  retrieving: "能力选型",
  assembling: "装配",
  verifying: "校验",
  executing: "执行",
  distilling: "固化",
};

function findProgressCard(runId: string): ProgressCardMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const item = messages[i] as unknown as ProgressCardMessage;
    if (item?.role === "progress-card" && item.runId === runId) return item;
  }
  return undefined;
}

/** 进度卡独立于聊天历史持久（服务端快照不含进度事件，重建后按 runId 重新挂回） */
const progressCardStore = new Map<string, ProgressCardMessage>();

function rememberProgressCard(card: ProgressCardMessage): void {
  progressCardStore.delete(card.runId);
  progressCardStore.set(card.runId, card);
  while (progressCardStore.size > 30) {
    const oldest = progressCardStore.keys().next().value;
    if (oldest === undefined) break;
    progressCardStore.delete(oldest);
  }
}

/** 快照重建后把存储中的进度卡（按插入序）挂回消息流 */
function reattachProgressCards(): void {
  for (const card of progressCardStore.values()) {
    if (!findProgressCard(card.runId)) messages.push(card as unknown as Record<string, unknown>);
  }
}

function applyProgress(payload: Record<string, unknown>): void {
  const runId = String(payload.runId ?? "");
  if (!runId) return;
  let card = findProgressCard(runId);
  const line = typeof payload.line === "string" ? payload.line : undefined;
  if (!card) {
    card = { role: "progress-card", runId, phase: null, line: line ?? "", narration: "", sources: [], sourcesTotal: 0, steps: [], startedAt: Date.now(), finishedAt: null, ts: Date.now() };
    pushMessage(card as unknown as Record<string, unknown>);
  }
  rememberProgressCard(card);
  if (typeof payload.phase === "string") card.phase = payload.phase;
  // 工作模式节点级事件：按 nodeId 原地合并（同一节点状态变化不新增行）
  if (payload.node && typeof payload.node === "object") {
    const nd = payload.node as { nodeId?: string; title?: string; status?: string; seconds?: number };
    if (nd.nodeId) {
      const at = typeof payload.ts === "number" ? payload.ts : Date.now();
      const status = nd.status === "running" || nd.status === "ok" || nd.status === "err" ? nd.status : "ok";
      const title = nd.title ?? nd.nodeId;
      const text = status === "running"
        ? `执行中 · ${title}`
        : status === "err"
          ? `失败 · ${title}${nd.seconds ? `（用时 ${nd.seconds} 秒）` : ""}`
          : `${title}${nd.seconds ? ` · 用时 ${nd.seconds} 秒` : ""}`;
      const existing = card.steps.find((s) => s.nodeId === nd.nodeId);
      if (existing) { existing.status = status; existing.text = text; existing.at = at; }
      else card.steps.push({ at, text, nodeId: nd.nodeId, status });
      card.line = text;
    }
  }
  if (line) {
    card.line = line;
    // 时间线去重：同一行不重复记录
    if (card.steps.length === 0 || card.steps[card.steps.length - 1]?.text !== line) {
      card.steps.push({ at: typeof payload.ts === "number" ? payload.ts : Date.now(), text: line });
    }
  }
  if (payload.source && typeof payload.source === "object") {
    const source = payload.source as { id?: string; ok?: boolean };
    if (source.id) {
      const existing = card.sources.find((s) => s.id === source.id);
      const entry = { id: source.id, ok: source.ok !== false, done: true };
      if (existing) card.sources[card.sources.indexOf(existing)] = entry;
      else card.sources.push(entry);
    }
  }
  if (typeof payload.sourcesTotal === "number") card.sourcesTotal = payload.sourcesTotal;
  if (payload.finished === true) card.finishedAt = typeof payload.ts === "number" ? payload.ts : Date.now();
  // 已存在的卡走定点 DOM 更新：避免整流重渲染（滚动跳动 + 动画重播）
  if (!updateProgressDom(card)) renderChat();
}

function applyProgressDelta(payload: Record<string, unknown>): void {
  const runId = String(payload.runId ?? "");
  const delta = typeof payload.delta === "string" ? payload.delta : "";
  if (!runId || !delta) return;
  let card = findProgressCard(runId);
  if (!card) {
    card = { role: "progress-card", runId, phase: null, line: "", narration: "", sources: [], sourcesTotal: 0, steps: [], startedAt: Date.now(), finishedAt: null, ts: Date.now() };
    pushMessage(card as unknown as Record<string, unknown>);
  }
  rememberProgressCard(card);
  card.narration += delta;
  // 流式增量走定点 DOM 更新：不整列表重渲染，打字机手感顺滑
  updateProgressDom(card, true);
}

/** 定点更新进度卡 DOM。返回 false 表示 DOM 中无此卡，需要全量渲染。 */
function updateProgressDom(card: ProgressCardMessage, deltaOnly = false): boolean {
  const root = document.querySelector<HTMLElement>(`.progress-card[data-run-id="${CSS.escape(card.runId)}"]`);
  if (!root) return false;
  if (deltaOnly) {
    const narrationEl = root.querySelector<HTMLElement>(".progress-narration");
    if (narrationEl) narrationEl.textContent = card.narration;
    return true;
  }
  const done = card.finishedAt !== null;
  const phaseEl = root.querySelector<HTMLElement>(".progress-phase");
  if (phaseEl) phaseEl.textContent = done ? "完成" : card.phase ? (PROGRESS_PHASE_LABELS[card.phase] ?? card.phase) : "准备中";
  const headEl = root.querySelector<HTMLElement>(".progress-card-head");
  if (headEl) headEl.style.display = done ? "" : "none";
  const lineEl = root.querySelector<HTMLElement>(".progress-line");
  if (lineEl) {
    if (card.line && !done && card.steps.length === 0) { lineEl.textContent = card.line; lineEl.style.display = ""; }
    else lineEl.style.display = "none";
  }
  const narrationEl = root.querySelector<HTMLElement>(".progress-narration");
  if (narrationEl) narrationEl.textContent = card.narration;
  const countEl = root.querySelector<HTMLElement>(".progress-source-count");
  if (countEl) countEl.textContent = card.sourcesTotal > 0 ? `${card.sources.filter((s) => s.done).length} / ${card.sourcesTotal} 源` : "";
  const chipsEl = root.querySelector<HTMLElement>(".progress-source-chips");
  if (chipsEl) {
    chipsEl.replaceChildren(...card.sources.map((s) => {
      const chip = document.createElement("span");
      chip.className = `progress-source-chip ${s.ok ? "ok" : "err"}`;
      chip.textContent = s.id;
      return chip;
    }));
  }
  const stepsEl = root.querySelector<HTMLElement>(".progress-steps");
  if (stepsEl) {
    stepsEl.replaceChildren(...card.steps.map((step, index) => buildStepRow(card, step)));
  }
  const cardEl = root.querySelector<HTMLElement>(".progress-card");
  if (cardEl) {
    cardEl.classList.toggle("finished", done);
    cardEl.classList.toggle("live", !done);
  }
  // DeepSeek 行为：完成即折叠 + 摘要行更新；进行中保持展开并刷步数
  const summaryEl = root.querySelector<HTMLElement>(".progress-details-summary");
  if (summaryEl) summaryEl.textContent = done ? progressDoneSummary(card) : progressLiveSummary(card);
  const detailsEl = root.querySelector<HTMLDetailsElement>(".progress-details");
  if (detailsEl) detailsEl.open = !done;
  const phaseTextEl = root.querySelector<HTMLElement>(".progress-phase");
  if (phaseTextEl) phaseTextEl.textContent = done ? "完成" : card.phase ? (PROGRESS_PHASE_LABELS[card.phase] ?? card.phase) : "准备中";
  // DeepSeek 式减层保持一致：title/source-count/head 由 renderProgressCard 常驻隐藏
  const titleEl = root.querySelector<HTMLElement>(".progress-title");
  if (titleEl) { titleEl.textContent = ""; titleEl.style.display = "none"; }
  const headEl2 = root.querySelector<HTMLElement>(".progress-card-head");
  if (headEl2) headEl2.style.display = done ? "" : "none";
  const countEl2 = root.querySelector<HTMLElement>(".progress-source-count");
  if (countEl2) { countEl2.textContent = ""; countEl2.style.display = "none"; }
  root.classList.toggle("finished", done);
  return true;
}

function mount(): void {
  document.documentElement.dataset.panelMounted = "true";
  initializeTheme();
  $("toggle-theme")?.addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
  installModalAccessibility();
  $("jump-latest")?.addEventListener("click", () => {
    const root = $("chat-root"); if (!root) return;
    root.scrollTo({ top: root.scrollHeight, behavior: "smooth" });
    updateJumpButton(false);
  });
  $("chat-root")?.addEventListener("scroll", () => {
    const root = $("chat-root"); if (!root) return;
    updateJumpButton(root.scrollHeight - root.scrollTop - root.clientHeight > 48);
    updateMinimapActive();
  }, { passive: true });
  $("open-inspector")?.addEventListener("click", (event) => {
    event.stopPropagation();
    const inspector = document.querySelector<HTMLElement>(".inspector"); if (!inspector) return;
    setInspectorOpen(!inspector.classList.contains("open"));
  });
  $("open-rail")?.addEventListener("click", (event) => {
    event.stopPropagation();
    const rail = document.querySelector<HTMLElement>(".rail");
    setRailOpen(!rail?.classList.contains("responsive-open"));
  });
  $("rail-backdrop")?.addEventListener("click", () => setRailOpen(false));
  $("inspector-backdrop")?.addEventListener("click", () => setInspectorOpen(false));
  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (!target.closest(".step-actions")) {
      document.querySelectorAll(".step-redo-menu.open").forEach((m) => m.classList.remove("open"));
    }
  });
  $("open-more")?.addEventListener("click", (event) => {
    event.stopPropagation();
    const menu = $("utility-menu"); if (!menu) return;
    setUtilityMenuOpen(menu.classList.contains("hidden"));
  });
  $("utility-menu")?.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-utility-target]");
    const id = target?.dataset.utilityTarget; if (!id) return;
    // The menu item dispatches a second click on the real opener below. Stop
    // this original event from reaching the document-level outside-click
    // handler, otherwise the newly opened responsive inspector is immediately
    // treated as an outside click and closes again.
    event.stopPropagation();
    setUtilityMenuOpen(false, false);
    // The menu is hidden before the target opens its drawer/modal. Move focus
    // to the visible opener first so the target's focus trap records a valid
    // restoration point instead of a hidden menu item.
    $("open-more")?.focus();
    $(id)?.click();
  });
  $("utility-menu")?.addEventListener("keydown", (event) => {
    const menu = $("utility-menu"); if (!menu) return;
    const items = [...menu.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not([disabled])")];
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") { event.preventDefault(); setUtilityMenuOpen(false); return; }
    if (!items.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : event.key === "ArrowDown" ? (current + 1 + items.length) % items.length : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  });
  document.addEventListener("click", (event) => {
    const menu = $("utility-menu"); const target = event.target as Node;
    if (menu && !menu.classList.contains("hidden") && !menu.contains(target) && target !== $("open-more")) setUtilityMenuOpen(false);
    const inspector = document.querySelector<HTMLElement>(".inspector");
    if (inspector?.classList.contains("responsive-open") && !inspector.contains(target) && target !== $("open-inspector")) setInspectorOpen(false);
    const rail = document.querySelector<HTMLElement>(".rail");
    if (rail?.classList.contains("responsive-open") && !rail.contains(target) && target !== $("open-rail")) setRailOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Tab") {
      // Responsive rail/inspector drawers sit above the chat surface. Keep
      // keyboard focus inside the visible drawer until the user closes it;
      // otherwise one Tab from the last action silently lands behind the
      // backdrop and the next keyboard action appears to do nothing.
      const drawer = [
        document.querySelector<HTMLElement>(".rail.responsive-open"),
        document.querySelector<HTMLElement>(".inspector.responsive-open"),
      ].find((candidate): candidate is HTMLElement => Boolean(candidate));
      if (drawer) {
        const items = Array.from(drawer.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex=\"-1\"])")).filter(isVisibleElement);
        if (items.length) {
          const first = items[0]!;
          const last = items.at(-1)!;
          if (!drawer.contains(document.activeElement)) { event.preventDefault(); first.focus(); return; }
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); return; }
          if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); return; }
        }
      }
      return;
    }
    if (event.key !== "Escape") return;
    const rail = document.querySelector<HTMLElement>(".rail");
    if (rail?.classList.contains("responsive-open")) { setRailOpen(false); $("open-rail")?.focus(); return; }
    const inspector = document.querySelector<HTMLElement>(".inspector");
    if (inspector?.classList.contains("responsive-open")) setInspectorOpen(false);
    const menu = $("utility-menu");
    if (menu && !menu.classList.contains("hidden")) setUtilityMenuOpen(false);
  });
  // Bind the global entry points before rendering dynamic panels. A malformed
  // persisted snapshot must never make settings/search/task controls inert.
  $("open-search")?.addEventListener("click", () => { $("search-modal")?.classList.remove("hidden"); focusModalControl("search-modal", "search-query"); });
  $("open-context")?.addEventListener("click", async () => { $("context-modal")?.classList.remove("hidden"); if (currentSnapshot) renderContexts(currentSnapshot); focusModalControl("context-modal", "context-origin"); try { const response = await fetch("/api/host-context/info"); const info = await response.json() as { endpoint: string; token: string; kinds: string[] }; const bridge = $("host-bridge-info"); if (bridge) bridge.textContent = `${info.endpoint} · 支持 ${info.kinds.join(", ")}`; const copy = $("copy-host-bridge"); if (copy) { copy.dataset.bridge = JSON.stringify(info); } } catch { const bridge = $("host-bridge-info"); if (bridge) bridge.textContent = "Host Bridge 不可用"; } });
  $("open-shares")?.addEventListener("click", () => { $("shares-modal")?.classList.remove("hidden"); if (currentSnapshot) renderShares(currentSnapshot); focusModalControl("shares-modal", "share-resource"); });
  $("close-shares")?.addEventListener("click", () => $("shares-modal")?.classList.add("hidden"));
  $("close-context")?.addEventListener("click", () => $("context-modal")?.classList.add("hidden"));
  $("paste-context")?.addEventListener("click", async () => { const result = $("context-result"); try { const text = await navigator.clipboard.readText(); const content = $("context-content") as HTMLTextAreaElement | null; if (content) content.value = text; if (result) result.textContent = "已读取剪贴板内容，请确认后保存。"; } catch { if (result) result.textContent = "无法读取剪贴板，请手动粘贴。"; } });
  $("copy-host-bridge")?.addEventListener("click", async () => { const info = ($("copy-host-bridge") as HTMLButtonElement | null)?.dataset.bridge; if (!info) return; try { await navigator.clipboard.writeText(info); const result = $("context-result"); if (result) result.textContent = "Host Bridge 接入信息已复制。"; } catch { const result = $("context-result"); if (result) result.textContent = "无法写入剪贴板，请手动复制。"; } });
  $("open-settings")?.addEventListener("click", () => { $("settings-modal")?.classList.remove("hidden"); if (currentSnapshot) renderSettings(currentSnapshot); focusModalControl("settings-modal", "setting-base-url"); });
  $("open-connectors")?.addEventListener("click", () => { $("connector-modal")?.classList.remove("hidden"); if (currentSnapshot) renderConnectors(currentSnapshot); focusModalControl("connector-modal", "connector-name"); });
  $("open-runs")?.addEventListener("click", () => { $("runs-modal")?.classList.remove("hidden"); if (currentSnapshot) renderRuns(currentSnapshot); focusModalControl("runs-modal", "close-runs"); });
  $("open-tasks")?.addEventListener("click", () => { $("tasks-modal")?.classList.remove("hidden"); if (currentSnapshot) renderTasks(currentSnapshot); focusModalControl("tasks-modal", "task-requirement"); });
  applyMode(panelMode);
  const modeButtons = [...document.querySelectorAll<HTMLButtonElement>(".mode-btn")];
  modeButtons.forEach((button, index) => {
    button.addEventListener("click", () => setMode(button.dataset.mode as PanelMode));
    button.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
      event.preventDefault();
      const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? modeButtons.length - 1 : event.key === "ArrowRight" ? (index + 1) % modeButtons.length : (index - 1 + modeButtons.length) % modeButtons.length;
      const next = modeButtons[nextIndex];
      if (!next) return;
      next.focus();
      setMode(next.dataset.mode as PanelMode);
    });
  });
  syncModeLabels();
  window.addEventListener("resize", syncModeLabels, { passive: true });
  $("req-go")?.addEventListener("click", startRun);
  const input = $("req-input") as HTMLTextAreaElement | null;
  const resizeComposer = () => {
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(132, Math.max(46, input.scrollHeight))}px`;
    // The latest-message affordance is absolutely positioned over the chat
    // panel. Keep it above the composer even when a long mobile draft grows
    // the textarea, instead of letting it cover the send control.
    const composer = input.closest<HTMLElement>(".composer-wrap");
    const panel = $("chat-panel");
    if (composer && panel) panel.style.setProperty("--composer-height", `${Math.max(58, composer.offsetHeight)}px`);
  };
  input?.addEventListener("input", () => { const send = $("req-go") as HTMLButtonElement | null; if (send) send.disabled = !input.value.trim(); commandIndex = 0; resizeComposer(); renderCommandMenu(input.value); });
  resizeComposer();
  window.addEventListener("resize", resizeComposer, { passive: true });
  input?.addEventListener("compositionstart", () => { composerComposing = true; });
  input?.addEventListener("compositionend", () => { composerComposing = false; composerCompositionEndedAt = performance.now(); });
  input?.addEventListener("beforeinput", (event) => {
    // WebKit can emit insertParagraph immediately after compositionend when
    // Enter confirmed a CJK candidate. Swallow that synthetic line break;
    // the next real Enter remains available after the short guard window.
    if (composerComposing || (performance.now() - composerCompositionEndedAt < 500 && (event as InputEvent).inputType === "insertParagraph")) event.preventDefault();
  }, true);
  input?.addEventListener("keydown", (event) => {
    if (event.isComposing || composerComposing || event.keyCode === 229 || performance.now() - composerCompositionEndedAt < 500) return;
    const suggestions = commandSuggestions(input.value);
    if (suggestions.length && event.key === "ArrowDown") { event.preventDefault(); commandIndex = (commandIndex + 1) % suggestions.length; renderCommandMenu(input.value); return; }
    if (suggestions.length && event.key === "ArrowUp") { event.preventDefault(); commandIndex = (commandIndex - 1 + suggestions.length) % suggestions.length; renderCommandMenu(input.value); return; }
    if (suggestions.length && event.key === "Tab") { event.preventDefault(); input.value = suggestions[commandIndex]?.usage ?? input.value; renderCommandMenu(input.value); return; }
    if (!suggestions.length && event.key === "ArrowUp" && inputHistory.length) { event.preventDefault(); inputHistoryIndex = Math.min(inputHistory.length - 1, inputHistoryIndex < 0 ? inputHistory.length - 1 : inputHistoryIndex - 1); input.value = inputHistory[inputHistoryIndex] ?? ""; input.dispatchEvent(new Event("input", { bubbles: true })); return; }
    if (!suggestions.length && event.key === "ArrowDown" && inputHistoryIndex >= 0) { event.preventDefault(); inputHistoryIndex = Math.min(inputHistory.length, inputHistoryIndex + 1); input.value = inputHistory[inputHistoryIndex] ?? ""; input.dispatchEvent(new Event("input", { bubbles: true })); return; }
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); startRun(); }
  });
  input?.addEventListener("dragover", (event) => { event.preventDefault(); input.classList.add("drop-active"); });
  input?.addEventListener("dragleave", () => input.classList.remove("drop-active"));
  input?.addEventListener("drop", async (event) => {
    event.preventDefault(); input.classList.remove("drop-active");
    for (const file of Array.from(event.dataTransfer?.files ?? [])) { const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); sendPayload({ type: "upload-file", name: file.name, mediaType: file.type || "application/octet-stream", contentBase64: btoa(binary) }); }
  });
  $("run-stop")?.addEventListener("click", () => { sendRunControl("stop"); });
  $("run-pause")?.addEventListener("click", () => sendRunControl("pause"));
  $("run-resume")?.addEventListener("click", () => sendRunControl("resume"));
  $("compact-run-stop")?.addEventListener("click", () => { sendRunControl("stop"); setUtilityMenuOpen(false); });
  $("compact-run-pause")?.addEventListener("click", () => { sendRunControl("pause"); setUtilityMenuOpen(false); });
  $("compact-run-resume")?.addEventListener("click", () => { sendRunControl("resume"); setUtilityMenuOpen(false); });
  $("new-session")?.addEventListener("click", () => {
    // Opening the dialog starts a new intent. Do not carry an abandoned
    // scenario/long-run choice into the next conversation and surprise the
    // user with a long-run execution they did not explicitly select this time.
    const project = $("new-session-project") as HTMLSelectElement | null;
    if (project && currentSnapshot) project.value = currentSnapshot.projectId ?? "";
    const scenario = $("new-session-scenario") as HTMLSelectElement | null;
    if (scenario) scenario.value = "";
    const longToggle = $("new-session-long-run") as HTMLInputElement | null;
    if (longToggle) longToggle.checked = false;
    const rounds = $("new-session-max-rounds") as HTMLInputElement | null;
    if (rounds) rounds.value = "3";
    pendingLongRunConfig = null;
    if (currentSnapshot) renderNewSessionDialog(currentSnapshot);
    $("new-session-result")!.textContent = "";
    $("new-session-modal")?.classList.remove("hidden");
    setRailOpen(false);
  });
  $("close-new-session")?.addEventListener("click", () => $("new-session-modal")?.classList.add("hidden"));
  $("new-session-project")?.addEventListener("change", () => {
    const scenario = $("new-session-scenario") as HTMLSelectElement | null;
    if (scenario) scenario.value = "";
    if (currentSnapshot) renderNewSessionDialog(currentSnapshot);
  });
  $("choose-session-folder")?.addEventListener("click", () => {
    const hint = $("new-session-folder-hint");
    if (hint) hint.textContent = "正在打开系统文件夹选择器…";
    sendPayload({ type: "choose-project-folder" });
  });
  $("new-session-scenario")?.addEventListener("change", () => { if (currentSnapshot) renderNewSessionDialog(currentSnapshot); });
  $("new-session-long-run")?.addEventListener("change", () => { if (currentSnapshot) renderNewSessionDialog(currentSnapshot); });
  $("create-new-session")?.addEventListener("click", () => {
    const scenarioId = (($("new-session-scenario") as HTMLSelectElement | null)?.value ?? "").trim() || null;
    const longRunEnabled = Boolean(($("new-session-long-run") as HTMLInputElement | null)?.checked);
    const maxRounds = Math.max(1, Math.min(50, Number(($("new-session-max-rounds") as HTMLInputElement | null)?.value || 3)));
    if (longRunEnabled && !scenarioId) { const result = $("new-session-result"); if (result) result.textContent = "长程运行需要先选择一个场景。"; return; }
    if (longRunEnabled && (currentSnapshot?.settings?.temporarySession || currentSnapshot?.settings?.useHistory === false)) { const result = $("new-session-result"); if (result) result.textContent = "临时会话不支持长程运行，请先关闭临时会话设置。"; return; }
    const projectId = (($("new-session-project") as HTMLSelectElement | null)?.value ?? "").trim() || null;
    pendingLongRunConfig = longRunEnabled && scenarioId ? { scenarioId, maxRounds, sessionId: null, projectId } : null;
    const button = $("create-new-session") as HTMLButtonElement | null;
    if (button) { button.disabled = true; button.textContent = "正在创建…"; }
    if (!sendPayload({ type: "new-session", scenarioId, projectId })) {
      pendingLongRunConfig = null;
      if (button) { button.disabled = false; button.textContent = "开始对话"; }
    }
  });
  $("open-scenarios")?.addEventListener("click", () => { $("scenario-modal")?.classList.remove("hidden"); if (currentSnapshot) renderScenarios(currentSnapshot); setRailOpen(false); });
  $("close-scenarios")?.addEventListener("click", () => $("scenario-modal")?.classList.add("hidden"));
  $("new-project")?.addEventListener("click", () => { editingProjectId = null; const title = $("project-title"); if (title) title.textContent = "新建项目"; const save = $("save-project"); if (save) save.textContent = "创建项目"; const projectProvider = $("project-provider") as HTMLSelectElement | null; if (projectProvider) { projectProvider.replaceChildren(new Option("默认设置", ""), ...(currentSnapshot?.providers ?? []).map((item) => new Option(`${item.name} · ${item.model}`, item.id))); projectProvider.value = ""; } $("project-modal")?.classList.remove("hidden"); ($("project-name") as HTMLInputElement | null)?.focus(); });
  $("import-workspace")?.addEventListener("click", () => ($("workspace-picker") as HTMLInputElement | null)?.click());
  $("workspace-picker")?.addEventListener("change", async () => {
    const picker = $("workspace-picker") as HTMLInputElement | null;
    const file = picker?.files?.[0];
    if (file) {
      try {
        const response = await fetch("/api/workspace/import", { method: "POST", headers: { "content-type": "application/json" }, body: await file.text() });
        const result = await response.json() as { ok?: boolean; error?: string };
        if (!response.ok || !result.ok) pushMessage({ role: "build-status", tone: "err", text: result.error ?? "工作区导入失败。" });
      } catch { pushMessage({ role: "build-status", tone: "err", text: "工作区导入失败，请检查面板连接。" }); }
    }
    if (picker) picker.value = "";
  });
  $("add-file")?.addEventListener("click", () => {
    if (!currentSnapshot?.projectId) { pushMessage({ role: "build-status", tone: "err", text: "请先选择项目。" }); return; }
    ($("file-picker") as HTMLInputElement | null)?.click();
  });
  $("file-picker")?.addEventListener("change", async () => {
    const picker = $("file-picker") as HTMLInputElement | null;
    for (const file of Array.from(picker?.files ?? [])) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      sendPayload({ type: "upload-file", name: file.name, mediaType: file.type || "application/octet-stream", contentBase64: btoa(binary) });
    }
    if (picker) picker.value = "";
  });
  $("file-list")?.addEventListener("click", (event) => {
    const preview = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-file-path]");
    if (preview?.dataset.filePath) {
      if (/^(application\/pdf|image\/)/.test(preview.dataset.fileMedia ?? "")) { window.open("/api/project-file?path=" + encodeURIComponent(preview.dataset.filePath), "_blank", "noopener"); return; }
      fetch("/api/project-file?path=" + encodeURIComponent(preview.dataset.filePath)).then(async (response) => { $("file-preview-title")!.textContent = preview.dataset.fileName ?? "文件预览"; $("file-preview-content")!.textContent = response.ok ? await response.text() : "读取失败"; $("file-modal")?.classList.remove("hidden"); }).catch(() => { $("file-preview-title")!.textContent = "文件预览"; $("file-preview-content")!.textContent = "读取失败，请检查面板连接"; $("file-modal")?.classList.remove("hidden"); });
      return;
    }
    const index = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-file-index-id]");
    if (index?.dataset.fileIndexId) { sendPayload({ type: "index-file", fileId: index.dataset.fileIndexId }); return; }
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-file-id]");
    if (button?.dataset.fileId && window.confirm("删除该项目文件？")) sendPayload({ type: "delete-file", fileId: button.dataset.fileId, confirm: true });
  });
  $("memory-tree")?.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-memory-action]");
    if (button?.dataset.memoryId) sendPayload({ type: "toggle-memory", memoryId: button.dataset.memoryId, enabled: button.dataset.enabled !== "true" });
  });
  $("delete-selected-memory")?.addEventListener("click", () => { const ids = [...document.querySelectorAll<HTMLInputElement>("input[data-memory-select]:checked")].map((input) => input.dataset.memoryId).filter((id): id is string => Boolean(id)); if (ids.length && window.confirm(`删除 ${ids.length} 条 Memory？`)) sendPayload({ type: "delete-memories", memoryIds: ids, confirm: true }); });
  $("close-project")?.addEventListener("click", () => $("project-modal")?.classList.add("hidden"));
  $("save-project")?.addEventListener("click", () => {
    const name = ($("project-name") as HTMLInputElement | null)?.value.trim() ?? "";
    const description = ($("project-description") as HTMLTextAreaElement | null)?.value.trim() ?? "";
    const instructions = ($("project-instructions") as HTMLTextAreaElement | null)?.value.trim() ?? "";
    const result = $("project-result");
    if (!name) { if (result) result.textContent = "请填写项目名称。"; return; }
    const providerId = ($("project-provider") as HTMLSelectElement | null)?.value || null;
    const payload = editingProjectId ? { type: "update-project", projectId: editingProjectId, name, description, instructions, providerId } : { type: "create-project", name, description };
    if (sendPayload(payload)) {
      if (result) result.textContent = editingProjectId ? "项目已保存。" : "项目已创建。";
      if ($("project-name")) ($("project-name") as HTMLInputElement).value = "";
      if ($("project-description")) ($("project-description") as HTMLTextAreaElement).value = "";
      if ($("project-instructions")) ($("project-instructions") as HTMLTextAreaElement).value = "";
      editingProjectId = null;
      window.setTimeout(() => $("project-modal")?.classList.add("hidden"), 350);
    }
  });
  $("project-list")?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const actionButton = target.closest<HTMLButtonElement>("button[data-project-action]");
    if (actionButton?.dataset.projectId) {
      const project = currentSnapshot?.projects.find((item) => item.id === actionButton.dataset.projectId);
      if (!project) return;
      if (actionButton.dataset.projectAction === "edit") {
        editingProjectId = project.id;
        const title = $("project-title"); if (title) title.textContent = "编辑项目";
        const save = $("save-project"); if (save) save.textContent = "保存项目";
        const name = $("project-name") as HTMLInputElement | null; if (name) name.value = project.name;
        const description = $("project-description") as HTMLTextAreaElement | null; if (description) description.value = project.description;
        const instructions = $("project-instructions") as HTMLTextAreaElement | null; if (instructions) instructions.value = project.instructions;
        const projectProvider = $("project-provider") as HTMLSelectElement | null; if (projectProvider) { projectProvider.replaceChildren(new Option("默认设置", ""), ...(currentSnapshot?.providers ?? []).map((item) => new Option(`${item.name} · ${item.model}`, item.id))); projectProvider.value = project.providerId ?? ""; }
        $("project-modal")?.classList.remove("hidden");
        setRailOpen(false);
      } else if (actionButton.dataset.projectAction === "share") {
        if (sendPayload({ type: "create-share", resourceType: "project", resourceId: project.id, role: "viewer" })) setRailOpen(false);
      } else if (actionButton.dataset.projectAction === "pin") {
        if (sendPayload({ type: "pin-project", projectId: project.id, pinned: !project.pinned })) setRailOpen(false);
      } else if (actionButton.dataset.projectAction === "archive") {
        if (sendPayload({ type: "archive-project", projectId: project.id })) setRailOpen(false);
      } else if (actionButton.dataset.projectAction === "restore") {
        if (sendPayload({ type: "restore-project", projectId: project.id })) setRailOpen(false);
      } else if (actionButton.dataset.projectAction === "delete" && window.confirm("删除项目后会移除项目上下文和文件索引。确定删除吗？")) {
        if (sendPayload({ type: "delete-project", projectId: project.id, confirm: true })) setRailOpen(false);
      }
      return;
    }
    const button = target.closest<HTMLButtonElement>("button[data-project-id]");
    if (button?.dataset.projectId) {
      pendingLongRunConfig = null;
      if (sendPayload({ type: "select-project", projectId: button.dataset.projectId })) setRailOpen(false);
    }
  });
  $("session-list")?.addEventListener("click", sessionAction);
  $("command-menu")?.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-command]");
    if (!button || !input) return;
    input.value = button.dataset.command ?? "";
    input.focus();
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  $("open-settings")?.addEventListener("click", () => { $("settings-modal")?.classList.remove("hidden"); if (currentSnapshot) renderSettings(currentSnapshot); });
  $("close-settings")?.addEventListener("click", () => $("settings-modal")?.classList.add("hidden"));
  $("open-connectors")?.addEventListener("click", () => { $("connector-modal")?.classList.remove("hidden"); if (currentSnapshot) renderConnectors(currentSnapshot); });
  $("close-connectors")?.addEventListener("click", () => $("connector-modal")?.classList.add("hidden"));
  $("open-runs")?.addEventListener("click", () => { $("runs-modal")?.classList.remove("hidden"); if (currentSnapshot) renderRuns(currentSnapshot); });
  $("close-runs")?.addEventListener("click", () => $("runs-modal")?.classList.add("hidden"));
  $("run-list")?.addEventListener("click", async (event) => {
    const checkbox = (event.target as HTMLInputElement).closest<HTMLInputElement>("input[data-run-select]");
    if (checkbox?.dataset.runSelect) { if (checkbox.checked) selectedRunIds.add(checkbox.dataset.runSelect); else selectedRunIds.delete(checkbox.dataset.runSelect); event.stopPropagation(); return; }
    const longRow = (event.target as HTMLElement).closest<HTMLElement>("[data-long-run-id]");
    if (longRow?.dataset.longRunId) {
      const record = currentSnapshot?.longRuns.find((run) => run.id === longRow.dataset.longRunId);
      if (!record) return;
      selectedRunId = null;
      const detail = $("run-detail-content"); if (detail) detail.textContent = JSON.stringify({ kind: "long-run", ...record }, null, 2);
      const retry = $("retry-run-detail") as HTMLButtonElement | null; if (retry) retry.disabled = true;
      const branch = $("branch-run-detail") as HTMLButtonElement | null; if (branch) branch.disabled = true;
      const commentBody = $("run-comment-body") as HTMLTextAreaElement | null; if (commentBody) commentBody.disabled = true;
      const saveComment = $("save-run-comment") as HTMLButtonElement | null; if (saveComment) saveComment.disabled = true;
      const comments = $("run-comments"); if (comments) comments.replaceChildren(textBlock("长程记录支持暂停、继续和停止；重试与分支请从新建长程对话开始。", "status-card"));
      $("run-detail-modal")?.classList.remove("hidden");
      return;
    }
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-run-id]");
    if (!row?.dataset.runId) return;
    selectedRunId = row.dataset.runId;
    const active = ["queued", "running", "waiting-approval", "paused"].includes(row.dataset.runStatus ?? "");
    const retry = $("retry-run-detail") as HTMLButtonElement | null; if (retry) retry.disabled = active;
    const branch = $("branch-run-detail") as HTMLButtonElement | null; if (branch) branch.disabled = active;
    const commentBody = $("run-comment-body") as HTMLTextAreaElement | null; if (commentBody) commentBody.disabled = false;
    const saveComment = $("save-run-comment") as HTMLButtonElement | null; if (saveComment) saveComment.disabled = false;
    const detail = $("run-detail-content"); if (!detail) return;
    try { const response = await fetch(`/api/runs/${encodeURIComponent(row.dataset.runId)}`); detail.textContent = response.ok ? JSON.stringify(await response.json(), null, 2) : "读取运行详情失败"; } catch { detail.textContent = "读取运行详情失败"; }
    const comments = $("run-comments"); if (comments && currentSnapshot) { comments.replaceChildren(); for (const comment of currentSnapshot.comments.filter((item) => item.resourceType === "run" && item.resourceId === row.dataset.runId)) comments.append(textBlock(`${comment.resolved ? "✓ " : ""}${comment.author} · ${new Date(comment.createdAt).toLocaleString()}\n${comment.body}`, "status-card")); }
    $("run-detail-modal")?.classList.remove("hidden");
  });
  $("run-list")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const target = event.target as HTMLElement;
    if (target.closest("input, button, a, select, textarea")) return;
    const row = target.closest<HTMLElement>("[data-long-run-id], [data-run-id]");
    if (!row) return;
    event.preventDefault();
    row.click();
  });
  $("close-run-detail")?.addEventListener("click", () => $("run-detail-modal")?.classList.add("hidden"));
  $("retry-run-detail")?.addEventListener("click", () => { if (selectedRunId) { sendPayload({ type: "retry-run", runId: selectedRunId }); $("run-detail-modal")?.classList.add("hidden"); } });
  $("branch-run-detail")?.addEventListener("click", () => { if (selectedRunId) { sendPayload({ type: "branch-run", runId: selectedRunId }); $("run-detail-modal")?.classList.add("hidden"); } });
  $("save-run-comment")?.addEventListener("click", () => { const body = ($("run-comment-body") as HTMLTextAreaElement | null)?.value.trim() ?? ""; if (selectedRunId && body) { sendPayload({ type: "create-comment", resourceType: "run", resourceId: selectedRunId, body }); ($("run-comment-body") as HTMLTextAreaElement).value = ""; } });
  $("compare-runs")?.addEventListener("click", async () => { const ids = [...selectedRunIds]; const result = $("run-compare-result"); if (ids.length !== 2 || !result) { if (result) result.textContent = "请选择两个运行记录。"; result?.classList.remove("hidden"); return; } try { const response = await fetch(`/api/runs/compare?left=${encodeURIComponent(ids[0]!)}&right=${encodeURIComponent(ids[1]!)}`); result.textContent = response.ok ? JSON.stringify(await response.json(), null, 2) : "运行对比失败"; } catch { result.textContent = "运行对比失败"; } result.classList.remove("hidden"); });
  $("open-tasks")?.addEventListener("click", () => { $("tasks-modal")?.classList.remove("hidden"); if (currentSnapshot) renderTasks(currentSnapshot); });
  $("close-tasks")?.addEventListener("click", () => $("tasks-modal")?.classList.add("hidden"));
  $("open-search")?.addEventListener("click", () => { $("search-modal")?.classList.remove("hidden"); ($("search-query") as HTMLInputElement | null)?.focus(); });
  $("close-search")?.addEventListener("click", () => $("search-modal")?.classList.add("hidden"));
  $("close-file")?.addEventListener("click", () => $("file-modal")?.classList.add("hidden"));
  $("run-search")?.addEventListener("click", () => {
    const query = ($("search-query") as HTMLInputElement | null)?.value.trim() ?? "";
    if (!query) { const result = $("search-result"); if (result) result.textContent = "请填写搜索关键词。"; return; }
    sendPayload({ type: "search", query });
    const result = $("search-result"); if (result) result.textContent = "搜索结果会同步显示在对话流中。";
  });
  $("context-list")?.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-context-action]");
    if (!button?.dataset.contextId) return;
    const context = currentSnapshot?.contexts.find((item) => item.id === button.dataset.contextId);
    if (button.dataset.contextAction === "toggle") sendPayload({ type: "toggle-context", contextId: button.dataset.contextId, enabled: !context?.enabled });
    else if (button.dataset.contextAction === "delete" && window.confirm("删除这条桌面上下文？")) sendPayload({ type: "delete-context", contextId: button.dataset.contextId, confirm: true });
  });
  $("save-context")?.addEventListener("click", () => {
    const kind = ($("context-kind") as HTMLSelectElement | null)?.value ?? "note";
    const origin = ($("context-origin") as HTMLInputElement | null)?.value.trim() ?? "";
    const label = ($("context-label") as HTMLInputElement | null)?.value.trim() ?? "";
    const content = ($("context-content") as HTMLTextAreaElement | null)?.value.trim() ?? "";
    const result = $("context-result");
    if (!origin || !label || !content) { if (result) result.textContent = "请填写来源、名称和内容。"; return; }
    sendPayload({ type: "create-context", kind, origin, label, content });
  });
  $("shares-list")?.addEventListener("click", (event) => { const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-share-id]"); if (button?.dataset.shareId && window.confirm("撤销此分享令牌？")) sendPayload({ type: "delete-share", shareId: button.dataset.shareId, confirm: true }); });
  $("create-share")?.addEventListener("click", () => { const resourceType = ($("share-type") as HTMLSelectElement | null)?.value ?? "workspace"; const resourceId = ($("share-resource") as HTMLInputElement | null)?.value.trim() ?? ""; const role = ($("share-role") as HTMLSelectElement | null)?.value ?? "viewer"; const result = $("share-result"); if (!resourceId) { if (result) result.textContent = "请填写资源 ID。"; return; } sendPayload({ type: "create-share", resourceType, resourceId, role }); });
  $("connector-list")?.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-connector-action]");
    if (!button?.dataset.connectorId) return;
    if (button.dataset.connectorAction === "test") sendPayload({ type: "test-connector", connectorId: button.dataset.connectorId });
    if (button.dataset.connectorAction === "toggle") {
      const connector = currentSnapshot?.connectors.find((item) => item.id === button.dataset.connectorId);
      sendPayload({ type: "toggle-connector", connectorId: button.dataset.connectorId, enabled: connector?.status !== "enabled" });
    }
    if (button.dataset.connectorAction === "delete") {
      if (!window.confirm("删除连接器后将移除它的配置和权限记录。确定删除吗？")) return;
      sendPayload({ type: "delete-connector", connectorId: button.dataset.connectorId, confirm: true });
    }
  });
  $("save-policy")?.addEventListener("click", () => {
    const patch: Record<string, unknown> = {};
    for (const scope of ["read", "write", "install", "network", "send"]) patch[scope] = Boolean(($(`policy-${scope}`) as HTMLInputElement | null)?.checked);
    patch.approvalMode = ($("policy-approval") as HTMLSelectElement | null)?.value ?? "ask";
    sendPayload({ type: "update-policy", patch });
  });
  $("provider-list")?.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-provider-action]");
    if (!button?.dataset.providerId) return;
    if (button.dataset.providerAction === "toggle") {
      const provider = currentSnapshot?.providers.find((item) => item.id === button.dataset.providerId);
      sendPayload({ type: "toggle-provider", providerId: button.dataset.providerId, enabled: !provider?.enabled });
    } else if (button.dataset.providerAction === "delete" && window.confirm("删除此 Provider 配置？")) {
      sendPayload({ type: "delete-provider", providerId: button.dataset.providerId, confirm: true });
    }
  });
  $("task-list")?.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-task-action]");
    if (!button?.dataset.taskId) return;
    if (button.dataset.taskAction === "toggle") {
      const task = currentSnapshot?.tasks.find((item) => item.id === button.dataset.taskId);
      sendPayload({ type: "toggle-task", taskId: button.dataset.taskId, enabled: !task?.enabled });
    } else if (button.dataset.taskAction === "edit") {
      const task = currentSnapshot?.tasks.find((item) => item.id === button.dataset.taskId); if (!task) return;
      editingTaskId = task.id; const requirement = $("task-requirement") as HTMLInputElement | null; const schedule = $("task-schedule") as HTMLInputElement | null; if (requirement) requirement.value = task.requirement; if (schedule) schedule.value = task.schedule; $("tasks-modal")?.classList.remove("hidden");
    } else if (button.dataset.taskAction === "delete" && window.confirm("删除此后台任务？")) {
      sendPayload({ type: "delete-task", taskId: button.dataset.taskId, confirm: true });
    } else if (button.dataset.taskAction === "run") {
      sendPayload({ type: "run-task", taskId: button.dataset.taskId });
    }
  });
  $("artifact-list")?.addEventListener("click", (event) => {
    const expand = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-artifacts-expand]");
    if (expand) { artifactsExpanded = expand.dataset.artifactsExpand === "true"; if (currentSnapshot) renderArtifacts(currentSnapshot); return; }
    const version = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-artifact-version-id]");
    if (version?.dataset.artifactVersionId) { sendPayload({ type: "version-artifact", artifactId: version.dataset.artifactVersionId }); return; }
    const diff = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-artifact-diff-id]");
    if (diff?.dataset.artifactDiffId) { fetch(`/api/artifact/diff?id=${encodeURIComponent(diff.dataset.artifactDiffId)}&from=${Math.max(1, Number(diff.dataset.artifactVersion ?? "1") - 1)}&to=${diff.dataset.artifactVersion}`).then(async (response) => { $("file-preview-title")!.textContent = "Artifact 版本差异"; $("file-preview-content")!.textContent = response.ok ? await response.text() : "读取差异失败"; $("file-modal")?.classList.remove("hidden"); }).catch(() => { $("file-preview-title")!.textContent = "Artifact 版本差异"; $("file-preview-content")!.textContent = "读取差异失败"; $("file-modal")?.classList.remove("hidden"); }); return; }
    const share = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-artifact-share-id]");
    if (share?.dataset.artifactShareId) { sendPayload({ type: "create-share", resourceType: "artifact", resourceId: share.dataset.artifactShareId, role: "viewer" }); return; }
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-artifact-id]");
    if (button?.dataset.artifactId && window.confirm("删除此产物记录？")) sendPayload({ type: "delete-artifact", artifactId: button.dataset.artifactId, confirm: true });
  });
  $("save-connector")?.addEventListener("click", () => {
    const name = ($("connector-name") as HTMLInputElement | null)?.value.trim() ?? "";
    const endpoint = ($("connector-endpoint") as HTMLInputElement | null)?.value.trim() ?? "";
    const kind = ($("connector-kind") as HTMLSelectElement | null)?.value ?? "mcp-remote";
    if (!name || !endpoint) { const result = $("connector-result"); if (result) result.textContent = "请填写名称和地址。"; return; }
    const permissionScopes = (["read", "network", "write", "install", "send"] as const).filter((scope) => Boolean(($(`connector-scope-${scope}`) as HTMLInputElement | null)?.checked));
    const secret = ($("connector-secret") as HTMLInputElement | null)?.value ?? "";
    const source = ($("connector-source") as HTMLSelectElement | null)?.value ?? "user";
    const trustEvidenceRef = ($("connector-evidence") as HTMLInputElement | null)?.value.trim() ?? "";
    sendPayload({ type: "create-connector", name, endpoint, kind, permissionScopes, hasSecret: Boolean(secret), source, ...(trustEvidenceRef ? { trustEvidenceRef } : {}), ...(secret ? { secret } : {}) });
  });
  $("save-provider")?.addEventListener("click", () => {
    const name = ($("provider-name") as HTMLInputElement | null)?.value.trim() ?? "";
    const baseUrl = ($("provider-base-url") as HTMLInputElement | null)?.value.trim() ?? "";
    const model = ($("provider-model") as HTMLInputElement | null)?.value.trim() ?? "";
    const kind = ($("provider-kind") as HTMLSelectElement | null)?.value ?? "openai-compatible";
    const secret = ($("provider-secret") as HTMLInputElement | null)?.value ?? "";
    if (!name || !baseUrl || !model) { const result = $("provider-result"); if (result) result.textContent = "请填写名称、地址和模型。"; return; }
    sendPayload({ type: "create-provider", name, baseUrl, model, kind, hasSecret: Boolean(secret), ...(secret ? { secret } : {}) });
  });
  $("identity-list")?.addEventListener("click", (event) => { const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-identity-id]"); if (button?.dataset.identityId && window.confirm("撤销此本地身份？")) sendPayload({ type: "revoke-identity", identityId: button.dataset.identityId, confirm: true }); });
  $("save-identity")?.addEventListener("click", () => { const displayName = ($("identity-name") as HTMLInputElement | null)?.value.trim() ?? ""; const role = ($("identity-role") as HTMLSelectElement | null)?.value ?? "viewer"; if (!displayName) { const result = $("identity-result"); if (result) result.textContent = "请填写显示名称。"; return; } sendPayload({ type: "create-identity", displayName, role }); });
  $("save-task")?.addEventListener("click", () => {
    const requirement = ($("task-requirement") as HTMLInputElement | null)?.value.trim() ?? "";
    const schedule = ($("task-schedule") as HTMLInputElement | null)?.value.trim() ?? "";
    if (!requirement || !schedule) { const result = $("task-result"); if (result) result.textContent = "请填写任务和触发计划。"; return; }
    if (editingTaskId) { sendPayload({ type: "update-task", taskId: editingTaskId, requirement, schedule }); editingTaskId = null; }
    else sendPayload({ type: "create-task", requirement, schedule, projectId: currentSnapshot?.projectId ?? null, scenarioId: currentSnapshot?.activeScenarioId ?? null });
  });
  const readSettingsPatch = (): Record<string, unknown> => {
    const baseUrl = ($("setting-base-url") as HTMLInputElement | null)?.value.trim();
    const model = ($("setting-model") as HTMLInputElement | null)?.value.trim();
    const plannerModel = ($("setting-planner-model") as HTMLInputElement | null)?.value.trim() || null;
    const fallbackModel = ($("setting-fallback-model") as HTMLInputElement | null)?.value.trim() || null;
    const temperature = Number(($('setting-temperature') as HTMLInputElement | null)?.value ?? "0.1");
    const maxTokensRaw = ($('setting-max-tokens') as HTMLInputElement | null)?.value.trim() ?? "";
    const maxTokens = maxTokensRaw ? Number(maxTokensRaw) : null;
    const apiKey = ($("setting-api-key") as HTMLInputElement | null)?.value;
    const syncToken = ($("setting-sync-token") as HTMLInputElement | null)?.value.trim() ?? "";
    const timeoutMs = Number(($('setting-timeout') as HTMLInputElement | null)?.value ?? "45000");
     return { baseUrl, model, plannerModel, fallbackModel, temperature, maxTokens, timeoutMs, providerId: ($('setting-provider') as HTMLSelectElement | null)?.value || null, useHistory: Boolean(($('setting-use-history') as HTMLInputElement | null)?.checked), autoMemory: Boolean(($('setting-auto-memory') as HTMLInputElement | null)?.checked), temporarySession: Boolean(($('setting-temporary') as HTMLInputElement | null)?.checked), streaming: Boolean(($('setting-streaming') as HTMLInputElement | null)?.checked), syncEndpoint: ($('setting-sync-endpoint') as HTMLInputElement | null)?.value.trim() || null, ...(apiKey ? { apiKey } : {}), ...(syncToken ? { syncToken } : {}) };
  };
  $("save-settings")?.addEventListener("click", () => sendPayload({ type: "update-settings", settings: readSettingsPatch() }));
  $("test-settings")?.addEventListener("click", () => { const result = $("settings-result"); if (result) result.textContent = "正在验证 models + chat completion……"; sendPayload({ type: "test-settings", settings: readSettingsPatch(), full: true }); });
  $("sync-preview")?.addEventListener("click", () => { const result = $("settings-result"); if (result) result.textContent = "正在读取远端同步 revision……"; sendPayload({ type: "sync-preview" }); });
  $("sync-apply")?.addEventListener("click", () => { if (!window.confirm("同步会把当前工作区项目和场景发送到已配置端点，默认不包含 Memory。继续吗？")) return; const result = $("settings-result"); if (result) result.textContent = "正在应用同步……"; sendPayload({ type: "sync-apply", includeMemory: false }); });
  $("import-scenario")?.addEventListener("click", () => ($("scenario-picker") as HTMLInputElement | null)?.click());
  $("scenario-filter")?.addEventListener("input", () => { if (currentSnapshot) renderScenarios(currentSnapshot); });
  $("scenario-detail")?.addEventListener("click", async (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-scenario-compare-id]");
    if (!button?.dataset.scenarioCompareId || !button.dataset.scenarioCompareVersion) return;
    const detail = $("scenario-detail"); if (!detail) return;
    try {
      const response = await fetch(`/api/scenario/compare?id=${encodeURIComponent(button.dataset.scenarioCompareId)}&version=${encodeURIComponent(button.dataset.scenarioCompareVersion)}`);
      const comparison = response.ok ? await response.json() as { added?: string[]; removed?: string[] } : undefined;
      detail.append(textBlock(`对比结果：新增能力 ${comparison?.added?.length ?? 0} 个，移除能力 ${comparison?.removed?.length ?? 0} 个。`, "status-card"));
    } catch { detail.append(textBlock("版本对比读取失败。", "status-card err")); }
  });
  $("scenario-picker")?.addEventListener("change", async () => {
    const picker = $("scenario-picker") as HTMLInputElement | null; const file = picker?.files?.[0]; if (!file) return;
    sendPayload({ type: "import-scenario", content: await file.text() }); if (picker) picker.value = "";
  });
  $("new-memory")?.addEventListener("click", () => {
    editingMemoryPath = null;
    editingMemoryId = undefined;
    const nameInput = $("memory-name") as HTMLInputElement | null; if (nameInput) nameInput.value = "";
    const contentInput = $("memory-content") as HTMLTextAreaElement | null; if (contentInput) contentInput.value = "";
    $("memory-modal")?.classList.remove("hidden");
  });
  $("close-memory")?.addEventListener("click", () => $("memory-modal")?.classList.add("hidden"));
  $("save-memory")?.addEventListener("click", () => {
    const name = ($("memory-name") as HTMLInputElement | null)?.value.trim() ?? "";
    const content = ($("memory-content") as HTMLTextAreaElement | null)?.value.trim() ?? "";
    const result = $("memory-result");
    if (!content) { if (result) result.textContent = "请填写内容。"; return; }
     if (editingMemoryPath) sendPayload({ type: "update-memory", path: editingMemoryPath, memoryId: editingMemoryId, content });
    else if (name) sendPayload({ type: "create-memory", scope: ($("memory-scope") as HTMLSelectElement | null)?.value ?? "global", name, content });
    else if (result) result.textContent = "请填写标题。";
  });
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (input) { input.focus(); input.value = "/"; renderCommandMenu("/"); }
    }
  });
  document.getElementById("chat-root")?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const messageAction = target.closest<HTMLButtonElement>("button[data-message-action]");
    if (messageAction?.dataset.messageAction === "edit") {
      const input = $("req-input") as HTMLTextAreaElement | null;
      if (input) { input.value = messageAction.dataset.messageContent ?? ""; input.dispatchEvent(new Event("input", { bubbles: true })); input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
      return;
    }
    if (messageAction?.dataset.messageAction === "retry") { if (!busy) sendPayload({ type: "run-command", input: "/run retry" }); return; }
    const awaitingAction = target.closest<HTMLButtonElement>("button[data-awaiting-action]");
    if (awaitingAction?.dataset.awaitingAction === "submit") {
      const runId = awaitingAction.dataset.runId;
      if (!runId) return;
      const values: Record<string, string> = {};
      awaitingAction.closest(".awaiting-user-card")?.querySelectorAll<HTMLInputElement>("input[data-awaiting-input]").forEach((input) => { values[input.dataset.awaitingInput ?? input.name] = input.value.trim(); });
      if (!Object.values(values).some(Boolean)) { pushMessage({ role: "build-status", tone: "err", text: "请先填写需要补充的输入。" }); return; }
      if (sendPayload({ type: "answer-run", runId, values })) awaitingAction.disabled = true;
      return;
    }
    const statusAction = target.closest<HTMLButtonElement>("button[data-status-action]");
    if (statusAction?.dataset.statusAction === "switch-to-build") {
      const requirement = statusAction.dataset.requirement?.trim() ?? "";
      if (busy) return;
      setMode("build");
      const input = $("req-input") as HTMLTextAreaElement | null;
      if (input && requirement) {
        input.value = requirement;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
      statusAction.disabled = true;
      statusAction.textContent = "已切换，确认需求后发送";
      return;
    }
    const button = target.closest<HTMLButtonElement>("button[data-action]"); if (button) decide(Number(button.dataset.gate), button.dataset.action as "approve" | "reject" | "edit" | "pin" | "rerun" | "discard");
    const copy = target.closest<HTMLButtonElement>("button[data-copy-text]");
    if (copy?.dataset.copyText) {
      copy.disabled = true;
      void copyText(copy.dataset.copyText).then((ok) => {
        copy.textContent = ok ? "已复制" : "复制失败";
        window.setTimeout(() => { copy.textContent = "复制"; copy.disabled = false; }, 1400);
      });
    }
    const proposal = target.closest<HTMLButtonElement>("button[data-memory-proposal]"); if (proposal?.dataset.memoryProposal === "save") sendPayload({ type: "save-memory-proposal", name: proposal.dataset.memoryName ?? "运行记录", content: proposal.dataset.memoryContent ?? "" });
    if (proposal?.dataset.memoryProposal === "discard") proposal.closest(".message")?.remove();
  });
  document.getElementById("scenario-cards")?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const lifecycle = target.closest<HTMLButtonElement>("button[data-scenario-action]");
    if (lifecycle?.dataset.scenarioId) {
      event.stopPropagation();
      if (lifecycle.dataset.scenarioAction === "export") {
        fetch("/api/scenario?id=" + encodeURIComponent(lifecycle.dataset.scenarioId)).then(async (response) => { if (!response.ok) throw new Error("export failed"); const blob = new Blob([await response.text()], { type: "application/json" }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `scenario-${lifecycle.dataset.scenarioId}.json`; anchor.click(); URL.revokeObjectURL(url); }).catch(() => pushMessage({ role: "build-status", tone: "err", text: "场景导出失败。" }));
        setRailOpen(false); $("scenario-modal")?.classList.add("hidden"); return;
      }
      if (lifecycle.dataset.scenarioAction === "share") { if (sendPayload({ type: "create-share", resourceType: "scenario", resourceId: lifecycle.dataset.scenarioId, role: "viewer" })) { setRailOpen(false); $("scenario-modal")?.classList.add("hidden"); } return; }
      if (lifecycle.dataset.scenarioAction === "test") { if (sendPayload({ type: "test-scenario", scenarioId: lifecycle.dataset.scenarioId })) { setRailOpen(false); $("scenario-modal")?.classList.add("hidden"); } return; }
      if (lifecycle.dataset.scenarioAction === "delete" && !window.confirm("删除场景后不会影响已有运行记录，但将无法继续复用。确定删除吗？")) return;
      if (lifecycle.dataset.scenarioAction === "delete") { if (sendPayload({ type: "delete-scenario", scenarioId: lifecycle.dataset.scenarioId, confirm: true })) { setRailOpen(false); $("scenario-modal")?.classList.add("hidden"); } }
      else if (lifecycle.dataset.scenarioAction === "restore") { if (sendPayload({ type: "restore-scenario", scenarioId: lifecycle.dataset.scenarioId })) { setRailOpen(false); $("scenario-modal")?.classList.add("hidden"); } }
      else if (sendPayload({ type: "archive-scenario", scenarioId: lifecycle.dataset.scenarioId })) { setRailOpen(false); $("scenario-modal")?.classList.add("hidden"); }
      return;
    }
    const button = target.closest<HTMLButtonElement>("button[data-scenario-use]");
    if (!button) return;
    event.stopPropagation();
    const item = currentSnapshot?.scenarios.find((scenario) => scenario.id === button.dataset.scenarioUse);
    if (item) {
      // Scenario management must not silently mutate the current
      // conversation. Route the user through the same new-session flow used
      // by the sidebar, with this scenario preselected.
      ($("new-session") as HTMLButtonElement | null)?.click();
      const select = $("new-session-scenario") as HTMLSelectElement | null;
      if (select) {
        renderNewSessionDialog(currentSnapshot!);
        select.value = item.id;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
      $("scenario-modal")?.classList.add("hidden");
      setRailOpen(false);
    }
  });
  document.documentElement.dataset.panelBindings = "complete";
  bindTabs(); renderChat(); connect();
}

function installModalAccessibility(): void {
  const previousFocus = new Map<HTMLElement, HTMLElement | null>();
  const focusables = (modal: HTMLElement): HTMLElement[] => Array.from(modal.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex=\"-1\"])")).filter((element) => !element.closest("[hidden], .hidden, details:not([open])"));
  const sync = (modal: HTMLElement): void => {
    const open = !modal.classList.contains("hidden");
    modal.setAttribute("aria-hidden", String(!open));
    if (open) {
      if (!previousFocus.has(modal)) {
        const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const candidates = modal.id === "new-session-modal" ? [$("new-session"), $("open-rail")] : [$("open-more"), $("open-scenarios"), $("open-rail")];
        const fallback = candidates.find((candidate): candidate is HTMLElement => isVisibleElement(candidate));
        previousFocus.set(modal, isVisibleElement(active) ? active : (fallback ?? null));
      }
      // Some open handlers deliberately focus the first meaningful field (for
      // example search or project name). Do not clobber that focus with the
      // dialog's close button when the mutation observer runs.
      window.setTimeout(() => {
        if (!modal.classList.contains("hidden") && !modal.contains(document.activeElement)) focusables(modal)[0]?.focus();
      }, 0);
    } else {
      const restore = previousFocus.get(modal);
      const target = restore ?? null;
      if (isVisibleElement(target)) target.focus();
      previousFocus.delete(modal);
    }
  };
  document.querySelectorAll<HTMLElement>(".settings-modal").forEach((modal) => {
    sync(modal);
    new MutationObserver(() => sync(modal)).observe(modal, { attributes: true, attributeFilter: ["class"] });
    modal.addEventListener("click", (event) => {
      if (event.target === modal) modal.classList.add("hidden");
    });
    modal.addEventListener("keydown", (event) => {
      if (event.key !== "Tab") return;
      const items = focusables(modal); if (!items.length) return;
      const first = items[0]!; const last = items.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const open = Array.from(document.querySelectorAll<HTMLElement>(".settings-modal")).reverse().find((modal) => !modal.classList.contains("hidden"));
    if (open) { open.classList.add("hidden"); event.preventDefault(); }
  });
}

if (typeof window !== "undefined") window.addEventListener("DOMContentLoaded", mount);

export type { AgentMessage };
