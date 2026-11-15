import { WebSocketServer, type WebSocket } from "ws";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, realpath, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Dirent } from "node:fs";
import { z } from "zod";
import { GateDecisionSchema } from "@/orchestrator/state-machine.js";
import type { Orchestrator } from "@/orchestrator/state-machine.js";
import type { WorkMissingInput } from "@/panel/work-execution.js";
import type { BuildContext, BuildClarification } from "@/orchestrator/context.js";
import { renderGateView } from "@/gates/views.js";
import { classifyGateDecision, type GateProposalDraft } from "@/panel/gate-classify.js";
import { memoryTree, type MemoryTreeNode } from "@/memory/memory.js";
import { ScenarioRecordSchema, scenarioMatchesScope, scenarioNameFromRequirement, type ScenarioLibrary, type ScenarioRecord } from "@/scenario/library.js";
import { proposeConstraint, recordRunOutcome, stripNegationPrefix, applyOutputCorrection, ensureLedger as ensureLedgerOf, activeConstraints, pendingConstraints, confirmConstraints, retireConstraint, evaluateLifecycle, netGain, mergeConstraintGuarded, type ScenarioLedger, type RevisionProposal } from "@/scenario/ledger.js";
import { resolveConstraints, readTeamConstraints } from "@/scenario/team-ledger.js";
import { confidence, tierOfLedger } from "@/scenario/confidence.js";
import { inputDigest } from "@/scenario/digest.js";
import { computeOutputDiff, blocksToProposals } from "@/panel/outputdiff.js";
import type { GoalLoop, LoopEvent } from "@/execution/loop.js";
import type { ClusterEvent } from "@/execution/cluster.js";
import type { RunController } from "@/execution/repair.js";
import type { HostExecutionStatus } from "@/execution/capability-runtime.js";
import { PanelSettingsPatchSchema, type PanelSettingsStore, type PublicPanelSettings } from "@/panel/settings.js";
import type { PanelHistory, PanelSessionSummary } from "@/panel/history.js";
import { COMMANDS, parseCommand } from "@/panel/commands.js";
import type { ConnectorRepository, WorkspaceRepository, ProjectFile } from "@/product/repository.js";
import type { RunRepository, RunSummary } from "@/product/runs.js";
import type { ArtifactRepository, ArtifactSummary } from "@/product/artifacts.js";
import type { ProviderProfileRepository, ProviderProfileSummary } from "@/product/providers.js";
import type { ScheduledTaskRepository } from "@/product/tasks.js";
import type { LongRunRepository } from "@/product/long-runs.js";
import type { LongRun } from "@/product/contracts.js";
import type { MemoryRepository } from "@/product/memory.js";
import type { AuditRepository, AuditRecord } from "@/product/audit.js";
import type { SecretRepository } from "@/product/secrets.js";
import type { DesktopContextRepository } from "@/product/contexts.js";
import type { PermissionPolicyRepository, PermissionPolicy } from "@/product/policy.js";
import type { ShareLinkRepository } from "@/product/shares.js";
import type { CommentRepository, Comment } from "@/product/comments.js";
import type { IdentityRepository, Identity } from "@/product/identities.js";
import { DesktopContextInputSchema, validateDesktopContext } from "@/product/desktop-adapters.js";
import { WorkspaceSyncClient, type RemoteSyncEnvelope } from "@/product/sync-client.js";
import { MemoryItemSchema, ProjectSchema, type ProviderProfile, type Workspace } from "@/product/contracts.js";
import { PanelEventSchema, eventId, type PanelEvent } from "@/product/events.js";

const execFileAsync = promisify(execFile);

function sendRouteFailure(res: ServerResponse, error: unknown): void {
  if (res.headersSent) return;
  // Keep persistence/parser details out of HTTP responses while making sure
  // every async route terminates instead of leaving the client waiting.
  void error;
  res.writeHead(500, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify({ ok: false, error: "面板读取失败，请稍后重试。" }));
}

async function parseJsonResponse(response: Response, label: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(`${label}返回了无效 JSON`);
  }
}

function hasUsableCompletion(value: unknown, allowToolCall = false): boolean {
  if (!value || typeof value !== "object") return false;
  const body = value as { error?: unknown; choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown[] } }> };
  if (body.error || !Array.isArray(body.choices) || body.choices.length === 0) return false;
  const message = body.choices[0]?.message;
  if (!message || typeof message !== "object") return false;
  if (typeof message.content === "string" && message.content.trim()) return true;
  return allowToolCall && Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
}

/**
 * Workspace bundles are portable files and are often shared outside the
 * machine that produced them.  Keep URL metadata useful while removing
 * credentials that may have been embedded in an endpoint by mistake.
 */
function redactUrlCredentials(value: string | null | undefined): string | null | undefined {
  if (value === null || value === undefined) return value;
  try {
    const url = new URL(value);
    if (!url.username && !url.password) return value;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    // Connector CLI commands and other non-URL endpoints are intentionally
    // preserved; their secrets belong in the encrypted secret repository,
    // which is never included in an export bundle.
    return value;
  }
}

function redactPortableReference(value: string): string {
  if (/^(?:[A-Za-z]:[\\/]|\\\\|\/|~[\\/])/.test(value)) return "local://redacted";
  return redactUrlCredentials(value) ?? value;
}

async function chooseNativeFolder(): Promise<string | null> {
  if (process.platform !== "win32") return null;
  const script = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Windows.Forms; $dialog=New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description='选择要绑定到新对话的项目文件夹'; $dialog.ShowNewFolderButton=$false; if($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){ [Console]::Write($dialog.SelectedPath) }";
  try {
    const result = await execFileAsync("powershell.exe", ["-NoProfile", "-STA", "-Command", script], { windowsHide: false, maxBuffer: 20_000 });
    const selected = result.stdout.trim();
    if (!selected) return null;
    const resolved = await realpath(selected);
    const info = await stat(resolved);
    return info.isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

async function scanBoundFolder(root: string, limit = 500): Promise<Array<{ name: string; path: string; mediaType: string; size: number }>> {
  const files: Array<{ name: string; path: string; mediaType: string; size: number }> = [];
  const walk = async (dir: string): Promise<void> => {
    if (files.length >= limit) return;
    let entries: Dirent[] = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= limit || entry.name === ".git" || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!entry.isFile()) continue;
      try {
        const info = await stat(full);
        const relative = path.relative(root, full).split(path.sep).join("/");
        files.push({ name: relative, path: full, mediaType: "application/octet-stream", size: info.size });
      } catch { /* ignore files removed while scanning */ }
    }
  };
  await walk(root);
  return files;
}

function isCanonicalBase64(value: string): boolean {
  return value.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

/**
 * 8.1 面板服务：HTTP（页面 + 快照 API）+ WS（快照推送与增量事件、决策/控制动作上行）。
 * 前端三栏（8.2）：对话流 / 流水线+集群 / 注册表+Memory+场景库。
 */

export interface PanelSnapshot {
  mode: "work" | "build";
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
  gateView: { gate: number; title: string; lines: string[]; editSeed?: unknown; canPin?: boolean } | null;
  dag: unknown;
  trace: unknown[];
  cluster: ClusterEvent[];
  loop: LoopEvent[];
  scenarios: Array<{ id: string; name: string; goal: string; projectId: string | null; uses: number; successes: number; degraded: boolean; version: number; status: string; historyCount: number; versionHistory: Array<{ version: number; capabilityIds: string[]; createdAt: string; reason: string }>; slotDefs: Array<{ name: string; type?: string; required?: boolean; description?: string }>; capabilityCount: number; source: string; ledger?: { tier: "replay" | "spot" | "full"; confidence: number; activeCount: number; pendingCount: number; constraints: Array<{ id: string; clause: string; kind: string; hits: number; confirmed: boolean; active: boolean; supersededBy: string | null }>; curve: Array<{ at: string; total: number }>; runStats: { runs: number; accepted: number; rejected: number; corrected: number; consecutiveClean: number } } }>;
  availableScenarios: PanelSnapshot["scenarios"];
  memoryTree: MemoryTreeNode | null;
  memoryItems: Array<{ id: string; name: string; scope: string; enabled: boolean; sourceType: string; sourceId: string | null; path: string | null; updatedAt: string }>;
  sessions: PanelSessionSummary[];
  sessionId: string | null;
  settings: PublicPanelSettings | null;
  hostExecution: HostExecutionStatus;
  busy: boolean;
  run: { kind: "idle" | "work" | "build"; status: "idle" | "running" | "waiting-gate" | "waiting-user" | "paused" | "succeeded" | "failed" | "cancelled"; runId?: string; scenarioId?: string; text?: string };
  awaitingUser: { runId: string; question: string; inputs: WorkMissingInput[] } | null;
  runs: RunSummary[];
  workspace: { id: string; name: string } | null;
  projectId: string | null;
  projects: Array<{ id: string; name: string; rootPath: string | null; description: string; instructions: string; pinned: boolean; providerId: string | null; status: string; sessionCount: number; fileCount: number; memoryCount: number; scenarioCount: number }>;
  files: ProjectFile[];
  connectors: Array<{ id: string; name: string; kind: string; status: string; endpoint: string | null; permissionScopes: string[]; hasSecret: boolean; source: string; trustStatus: string; trustScore: number; trustEvidenceCount: number; lastHealthAt: string | null; lastError: string | null }>;
  artifacts: ArtifactSummary[];
  providers: ProviderProfileSummary[];
  tasks: Array<{ id: string; requirement: string; schedule: string; enabled: boolean; projectId: string | null; scenarioId: string | null; lastRunId: string | null; lastRunAt: string | null; lastRunStatus: string | null; lastError: string | null; failureCount: number; runCount: number; maxRuns: number | null; timeoutMs: number; createdAt: string; updatedAt: string }>;
  longRuns: Array<Pick<LongRun, "id" | "workspaceId" | "projectId" | "sessionId" | "scenarioId" | "goal" | "maxRounds" | "nextRound" | "completedRounds" | "status" | "terminalReason" | "nextInstruction" | "lastRound" | "lastSummary" | "lastMetrics" | "lastError" | "pauseRequested" | "revision" | "startedAt" | "finishedAt" | "createdAt" | "updatedAt">>;
  audit: Array<Pick<AuditRecord, "id" | "actor" | "action" | "resourceType" | "resourceId" | "summary" | "createdAt">>;
  contexts: Array<{ id: string; kind: string; origin: string; label: string; enabled: boolean; projectId: string | null; updatedAt: string }>;
  policy: Pick<PermissionPolicy, "read" | "write" | "install" | "network" | "send" | "approvalMode"> | null;
  shares: Array<{ id: string; resourceType: string; resourceId: string; role: string; tokenMasked: string; expiresAt: string | null; createdAt: string }>;
  comments: Array<Pick<Comment, "id" | "resourceType" | "resourceId" | "author" | "body" | "resolved" | "createdAt" | "updatedAt">>;
  identities: Array<Omit<Identity, "tokenHash">>;
  revision: number;
  updatedAt: string;
}

export const PanelActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("new-session"), scenarioId: z.string().min(1).nullable().optional(), projectId: z.string().min(1).nullable().optional() }),
  z.object({ type: z.literal("open-session"), sessionId: z.string().min(1) }),
  z.object({ type: z.literal("archive-session"), sessionId: z.string().min(1) }),
  z.object({ type: z.literal("restore-session"), sessionId: z.string().min(1) }),
  z.object({ type: z.literal("delete-session"), sessionId: z.string().min(1), confirm: z.literal(true) }),
  z.object({ type: z.literal("rename-session"), sessionId: z.string().min(1), title: z.string().min(1).max(120) }),
  z.object({ type: z.literal("update-settings"), settings: PanelSettingsPatchSchema }),
  z.object({ type: z.literal("test-settings"), settings: PanelSettingsPatchSchema, full: z.boolean().default(true) }),
  z.object({ type: z.literal("run-command"), input: z.string().min(1).max(500) }),
  z.object({ type: z.literal("search"), query: z.string().min(1).max(200) }),
  z.object({ type: z.literal("create-project"), name: z.string().min(1).max(120), description: z.string().max(500).optional() }),
  z.object({ type: z.literal("choose-project-folder") }),
  z.object({ type: z.literal("select-project"), projectId: z.string().min(1) }),
  z.object({ type: z.literal("update-project"), projectId: z.string().min(1), name: z.string().min(1).max(120).optional(), description: z.string().max(500).optional(), instructions: z.string().max(20_000).optional(), pinned: z.boolean().optional(), providerId: z.string().nullable().optional() }),
  z.object({ type: z.literal("pin-project"), projectId: z.string().min(1), pinned: z.boolean() }),
  z.object({ type: z.literal("archive-project"), projectId: z.string().min(1) }),
  z.object({ type: z.literal("restore-project"), projectId: z.string().min(1) }),
  z.object({ type: z.literal("delete-project"), projectId: z.string().min(1), confirm: z.literal(true) }),
  z.object({ type: z.literal("add-file"), name: z.string().min(1).max(240), path: z.string().min(1), mediaType: z.string().min(1), size: z.number().int().min(0).optional() }),
  z.object({ type: z.literal("upload-file"), name: z.string().min(1).max(240), relativePath: z.string().max(2_000).optional(), mediaType: z.string().min(1), contentBase64: z.string().min(1).max(8_000_000) }),
  z.object({ type: z.literal("delete-file"), fileId: z.string().min(1), confirm: z.literal(true) }),
  z.object({ type: z.literal("index-file"), fileId: z.string().min(1) }),
  z.object({ type: z.literal("create-connector"), name: z.string().min(1).max(120), kind: z.enum(["mcp-local", "mcp-remote", "cli", "http", "skill"]), endpoint: z.string().min(1).max(1000).optional(), permissionScopes: z.array(z.enum(["read", "write", "install", "network", "send"])).default([]), hasSecret: z.boolean().default(false), secret: z.string().max(20_000).optional(), source: z.enum(["user", "catalog", "imported", "host"]).default("user"), trustEvidenceRef: z.string().max(1000).optional() }),
  z.object({ type: z.literal("toggle-connector"), connectorId: z.string().min(1), enabled: z.boolean() }),
  z.object({ type: z.literal("delete-connector"), connectorId: z.string().min(1), confirm: z.literal(true) }),
  z.object({ type: z.literal("test-connector"), connectorId: z.string().min(1) }),
  z.object({ type: z.literal("create-artifact"), name: z.string().min(1).max(200), mediaType: z.string().min(1), path: z.string().min(1), runId: z.string().nullable().optional() }),
  z.object({ type: z.literal("delete-artifact"), artifactId: z.string().min(1), confirm: z.literal(true) }),
  z.object({ type: z.literal("version-artifact"), artifactId: z.string().min(1) }),
  z.object({ type: z.literal("create-provider"), name: z.string().min(1).max(120), kind: z.enum(["openai-compatible", "anthropic", "openrouter", "local"]), baseUrl: z.string().url(), model: z.string().min(1), timeoutMs: z.number().int().min(1_000).max(180_000).optional(), hasSecret: z.boolean().default(false), secret: z.string().max(20_000).optional() }),
  z.object({ type: z.literal("toggle-provider"), providerId: z.string().min(1), enabled: z.boolean() }),
  z.object({ type: z.literal("delete-provider"), providerId: z.string().min(1), confirm: z.literal(true) }),
  z.object({ type: z.literal("create-task"), requirement: z.string().min(2).max(500), schedule: z.string().min(1).max(120), projectId: z.string().nullable().optional(), scenarioId: z.string().nullable().optional(), maxRuns: z.number().int().positive().nullable().optional(), timeoutMs: z.number().int().min(1_000).max(180_000).optional() }),
  z.object({ type: z.literal("update-task"), taskId: z.string().min(1), requirement: z.string().min(2).max(500), schedule: z.string().min(1).max(120) }),
  z.object({ type: z.literal("toggle-task"), taskId: z.string().min(1), enabled: z.boolean() }),
  z.object({ type: z.literal("delete-task"), taskId: z.string().min(1), confirm: z.literal(true) }),
  z.object({ type: z.literal("run-task"), taskId: z.string().min(1) }),
  z.object({ type: z.literal("create-long-run"), scenarioId: z.string().min(1), requirement: z.string().min(2).max(500), maxRounds: z.number().int().min(1).max(50), projectId: z.string().nullable().optional(), slots: z.record(z.string(), z.string()).optional() }),
  z.object({ type: z.literal("control-long-run"), longRunId: z.string().min(1), action: z.enum(["pause", "resume", "stop"]) }),
  z.object({ type: z.literal("trigger-event"), name: z.string().min(1).max(120) }),
  z.object({ type: z.literal("retry-run"), runId: z.string().min(1) }),
  z.object({ type: z.literal("branch-run"), runId: z.string().min(1) }),
  z.object({
    type: z.literal("step-action"),
    runId: z.string().min(1),
    stepId: z.string().min(1),
    action: z.enum(["edit", "redo-single", "redo-cascade"]),
    updatedTitle: z.string().max(200).optional(),
    updatedInstruction: z.string().max(5000).optional(),
  }),
  z.object({ type: z.literal("create-memory"), scope: z.enum(["global", "project", "session", "scenario"]), name: z.string().min(1).max(120), content: z.string().min(1).max(100_000) }),
  z.object({ type: z.literal("update-memory"), path: z.string().min(1), content: z.string().min(1).max(100_000), memoryId: z.string().optional() }),
  z.object({ type: z.literal("delete-memory"), path: z.string().min(1), confirm: z.literal(true), memoryId: z.string().optional() }),
  z.object({ type: z.literal("delete-memories"), memoryIds: z.array(z.string().min(1)).min(1).max(100), confirm: z.literal(true) }),
  z.object({ type: z.literal("toggle-memory"), memoryId: z.string().min(1), enabled: z.boolean() }),
  z.object({ type: z.literal("save-memory-proposal"), name: z.string().min(1).max(160), content: z.string().min(1).max(100_000) }),
  z.object({ type: z.literal("create-context"), kind: z.enum(["local-file", "clipboard", "terminal", "browser", "note"]), origin: z.string().min(1).max(500), label: z.string().min(1).max(160), content: z.string().max(100_000) }),
  z.object({ type: z.literal("toggle-context"), contextId: z.string().min(1), enabled: z.boolean() }),
  z.object({ type: z.literal("delete-context"), contextId: z.string().min(1), confirm: z.literal(true) }),
  z.object({ type: z.literal("update-policy"), patch: z.object({ read: z.boolean().optional(), write: z.boolean().optional(), install: z.boolean().optional(), network: z.boolean().optional(), send: z.boolean().optional(), approvalMode: z.enum(["ask", "always-allow", "always-deny"]).optional() }) }),
  z.object({ type: z.literal("create-share"), resourceType: z.enum(["workspace", "project", "scenario", "artifact"]), resourceId: z.string().min(1), role: z.enum(["viewer", "user", "editor", "publisher", "admin"]) }),
  z.object({ type: z.literal("delete-share"), shareId: z.string().min(1), confirm: z.literal(true) }),
  // Exported bundles contain base64 file bodies; keep a bounded but usable
  // envelope so a normal multi-file export can be imported again.
  z.object({ type: z.literal("import-workspace"), content: z.string().min(2).max(50_000_000) }),
  z.object({ type: z.literal("create-comment"), resourceType: z.enum(["run", "scenario", "artifact", "project"]), resourceId: z.string().min(1), body: z.string().min(1).max(10_000) }),
  z.object({ type: z.literal("resolve-comment"), commentId: z.string().min(1), resolved: z.boolean() }),
  z.object({ type: z.literal("create-identity"), displayName: z.string().min(1).max(120), role: z.enum(["viewer", "user", "editor", "publisher", "admin"]) }),
  z.object({ type: z.literal("update-identity"), identityId: z.string().min(1), displayName: z.string().min(1).max(120).optional(), role: z.enum(["viewer", "user", "editor", "publisher", "admin"]).optional() }),
  z.object({ type: z.literal("revoke-identity"), identityId: z.string().min(1), confirm: z.literal(true) }),
  z.object({ type: z.literal("sync-preview") }),
  z.object({ type: z.literal("sync-apply"), includeMemory: z.boolean().default(false) }),
  z.object({ type: z.literal("set-mode"), mode: z.enum(["work", "build"]) }),
  z.object({ type: z.literal("select-scenario"), scenarioId: z.string().nullable() }),
  z.object({ type: z.literal("test-scenario"), scenarioId: z.string().min(1) }),
  z.object({ type: z.literal("archive-scenario"), scenarioId: z.string().min(1) }),
  z.object({ type: z.literal("restore-scenario"), scenarioId: z.string().min(1) }),
  z.object({ type: z.literal("delete-scenario"), scenarioId: z.string().min(1), confirm: z.literal(true) }),
  z.object({ type: z.literal("import-scenario"), content: z.string().min(2).max(2_000_000) }),
  z.object({ type: z.literal("gate-decision"), decision: GateDecisionSchema, /** 闸5 签约面：用户取消勾选的提案 tempId（不签约，留 pendingConfirm） */ excludeProposals: z.array(z.string().min(1).max(60)).max(50).optional() }),
  z.object({ type: z.literal("feedback-run"), runId: z.string().min(1), verdict: z.enum(["up", "down"]), reason: z.string().min(1).max(8_000).optional() }),
  z.object({ type: z.literal("revise-output"), runId: z.string().min(1), content: z.string().min(1).max(200_000) }),
  z.object({ type: z.literal("retire-constraint"), scenarioId: z.string().min(1), constraintId: z.string().min(1) }),
  z.object({ type: z.literal("confirm-constraints"), scenarioId: z.string().min(1), ids: z.array(z.string().min(1).max(60)).min(1).max(50) }),
  z.object({ type: z.literal("control"), action: z.enum(["pause", "resume", "terminate"]) }),
  z.object({ type: z.literal("answer-run"), runId: z.string().min(1), values: z.record(z.string(), z.string().max(20_000)) }),
  z.object({ type: z.literal("guide-run"), instruction: z.string().min(2).max(8_000) }),
  z.object({ type: z.literal("start-build"), requirement: z.string().min(2).max(500), mode: z.enum(["work", "build"]).default("build"), scenarioId: z.string().optional(), projectId: z.string().optional(), slots: z.record(z.string(), z.string()).optional(), retryCount: z.number().int().nonnegative().optional(), source: z.enum(["user", "task"]).optional() }),
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
  history?: PanelHistory;
  settings?: PanelSettingsStore;
  repository?: WorkspaceRepository;
  connectors?: ConnectorRepository;
  runs?: RunRepository;
  artifacts?: ArtifactRepository;
  providers?: ProviderProfileRepository;
  tasks?: ScheduledTaskRepository;
  longRuns?: LongRunRepository;
  memories?: MemoryRepository;
  audit?: AuditRepository;
  secrets?: SecretRepository;
  contexts?: DesktopContextRepository;
  policy?: PermissionPolicyRepository;
  shares?: ShareLinkRepository;
  comments?: CommentRepository;
  identities?: IdentityRepository;
  projectRoot?: string;
  /** Directory for run outputs that are not attached to a project. */
  artifactRoot?: string;
  onSettingsChanged?: (settings: Awaited<ReturnType<PanelSettingsStore["get"]>>) => Promise<void>;
  /** 面板发起构建（launcher 注入：装配真实联邦检索/执行/固化） */
  onStartBuild?: (requirement: string, mode: "work" | "build", scenarioId?: string, slots?: Record<string, string>, projectId?: string, source?: "user" | "task") => Promise<{ ok: boolean; error?: string }>;
  /** Resume a construction build after a model-originated clarification. */
  onAnswerBuild?: (runId: string, values: Record<string, string>) => Promise<{ ok: boolean; error?: string }>;
  onStartLongRun?: (run: LongRun) => Promise<{ ok: boolean; error?: string }>;
  onControlLongRun?: (run: LongRun, action: "pause" | "resume" | "stop") => Promise<{ ok: boolean; error?: string }>;
  hostExecution?: HostExecutionStatus;
  /** 反应窗时长（§12 沉默超时默认 10 分钟；测试注入缩短） */
  feedbackWindowMs?: number;
  onTestScenario?: (scenarioId: string) => Promise<{ passed: boolean; skipped?: boolean; reason?: string; attempts: Array<{ inputs: Record<string, string>; passed: boolean; error?: string }> }>;
  /** SceneFlow 步骤级操作：单步编辑、独立重做当前步、级联重做后续依赖步骤 */
  onStepAction?: (payload: { runId: string; stepId: string; action: "edit" | "redo-single" | "redo-cascade"; updatedTitle?: string; updatedInstruction?: string }) => Promise<{ ok: boolean; error?: string }>;
}

export class PanelServer {
  private readonly events = new EventEmitter();
  private readonly clusterEvents: ClusterEvent[] = [];
  private readonly loopEvents: LoopEvent[] = [];
  private server: Server | undefined;
  private wss: WebSocketServer | undefined;
  private readonly clients = new Set<WebSocket>();
  private activeMode: "work" | "build" = "work";
  private activeScenarioId: string | null = null;
  private sessionId: string | null = null;
  private sessionTitle = "新对话";
  private sessionLocked = false;
  private run: PanelSnapshot["run"] = { kind: "idle", status: "idle" };
  private workspace: Workspace | null = null;
  private projectId: string | null = null;
  private projectProviderId: string | null = null;
  private projectRootPath: string | null = null;
  private readonly pendingRunGuidance: Array<{ runId: string; instruction: string }> = [];
  private pendingRunInput?: { runId: string; question: string; inputs: WorkMissingInput[]; resolve: (values: Record<string, string>) => void; reject: (error: Error) => void };
  private pendingBuildInput?: { runId: string; request: BuildClarification };
  /** Serialize asynchronous build clarification writes so a fast answer
   * cannot be overwritten by the earlier waiting-user persistence. */
  private buildStatusPersistence: Promise<void> = Promise.resolve();
  private persistenceQueue: Promise<void> = Promise.resolve();
  private revision = 0;
  /** R1 审计#2：DNS rebinding 防御——listen 后记录合法 Host 形态 */
  private allowedHostPorts: string[] = [];
  private readonly eventLog: PanelEvent[] = [];
  /** Idempotency results are bound to the socket that first used the ID.
   * Sharing a global requestId result with another socket could leak one-shot
   * data such as share or identity tokens to a guessed request ID. */
  private readonly requestResults = new Map<string, { owner: WebSocket; result: { ok: boolean; error?: string; data?: unknown } }>();
  /**
   * Requests can be retried by a client while the first invocation is still
   * running (for example after a transient WebSocket disconnect). Keep the
   * in-flight promise keyed by requestId so the action is executed once and
   * every socket that retries receives the same result.
   */
  private readonly pendingRequests = new Map<string, { owner: WebSocket; promise: Promise<{ ok: boolean; error?: string; data?: unknown }> }>();
  /** Serialize long-run creation so two retried WS actions cannot both pass
   * the sessionLocked/activeForSession check before either durable row exists. */
  private longRunCreationQueue: Promise<void> = Promise.resolve();
  private readonly hostBridgeToken = randomBytes(24).toString("base64url");
  private interactiveBuild = true;
  /** 保留最近一次构建的最终上下文，避免终态事件与刷新之间丢失 DAG/trace。 */
  private lastBuildContext: BuildContext | undefined;
  /** 分寸账本（PR-signal-build）：本次构建期间闸门产生的分寸提案（闸5 签约后入新场景账本） */
  private buildLedgerProposals: Array<GateProposalDraft & { at: string; runId: string | null }> = [];
  /** 闸5 签约面：用户取消勾选的提案 tempId */
  private excludedProposalIds: string[] = [];
  /** 最近各闸门载荷（闸3 候选名 → 分寸条款人话化） */
  private readonly gatePayloads = new Map<number, unknown>();
  /** 抽查态闸门（§16）：本轮构建关联的既有场景账本（重规划时由 launcher 绑定） */
  private buildLedgerScenarioId: string | null = null;
  /** 已在本构建内自动通过的闸门（一次性防循环） */
  private readonly autoPassedGates = new Set<number>();
  /** §7 步骤行编辑计数（runId:stepId → 次数；第二次改写升级分寸提案） */
  private readonly stepEditCounts = new Map<string, number>();
  /** 分寸账本（PR-signal-run）：run 元数据（digest/attended/场景绑定），收尾结算用 */
  private readonly runLedgerMeta = new Map<string, { scenarioId: string | null; digest: string; attended: boolean; mode: "work" | "build" }>();
  /** 有人值守成功的反应窗（§12 沉默超时 10min，先到先得） */
  private readonly pendingFeedback = new Map<string, { timer: ReturnType<typeof setTimeout>; scenarioId: string; digest: string; attended: boolean }>();
  /** 运行中引导（guide-run）按 runId 归集：收尾 corrected + 提案 */
  private readonly runGuidanceNotes = new Map<string, string[]>();
  readonly bus = new EventEmitter();

  /** Pause a work run at a missing required scenario input until the user
   * supplies values. The promise is owned by the launcher and is resolved by
   * the explicit answer-run action, so a browser refresh cannot accidentally
   * continue with guessed data. */
  waitForRunInput(runId: string, inputs: WorkMissingInput[]): Promise<Record<string, string>> {
    if (this.pendingRunInput) return Promise.reject(new Error("已有运行正在等待输入"));
    const question = `开始前还需要补充：${inputs.map((input) => input.name).join("、")}。填写后会从头校验并继续。`;
    this.pendingRunInput = { runId, question, inputs, resolve: () => undefined, reject: () => undefined };
    this.sessionLocked = true;
    this.run = { ...this.run, kind: "work", runId, status: "waiting-user", text: question };
    void (async () => {
      const longRun = this.deps.longRuns ? await this.deps.longRuns.get(runId) : undefined;
      if (longRun) {
        if (["queued", "running", "waiting-user"].includes(longRun.status)) {
          await this.deps.longRuns!.update(runId, { status: "waiting-user", awaitingUser: { question, inputs } }, longRun.revision);
        }
        return;
      }
      const runs = this.deps.runs;
      if (runs && await runs.get(runId)) await runs.update(runId, { status: "waiting-user", error: question });
    })().catch(() => undefined);
    this.pushChat({ role: "awaiting-user", tone: "info", runId, question, inputs, ts: Date.now() });
    void this.pushSnapshot();
    return new Promise<Record<string, string>>((resolve, reject) => {
      if (!this.pendingRunInput || this.pendingRunInput.runId !== runId) { reject(new Error("运行输入请求已失效")); return; }
      this.pendingRunInput.resolve = resolve;
      this.pendingRunInput.reject = reject;
    });
  }

  /** Mirror a model clarification from a construction orchestrator. Unlike
   * work-run input this is durable: the BuildContext and RunProduct remain
   * waiting until the explicit answer callback resumes the same build. */
  notifyBuildAwaitingUser(runId: string, request: BuildClarification): void {
    this.pendingBuildInput = { runId, request };
    this.sessionLocked = true;
    this.run = { ...this.run, kind: "build", runId, status: "waiting-user", text: request.question };
    this.buildStatusPersistence = this.buildStatusPersistence.then(async () => {
      const current = this.deps.runs ? await this.deps.runs.get(runId) : undefined;
      if (current && ["queued", "running", "waiting-user"].includes(current.status)) {
        await this.deps.runs!.update(runId, { status: "waiting-user", error: request.question, details: { ...(current.details ?? {}), awaitingUser: request } });
      }
    }).catch(() => undefined);
    this.pushChat({ role: "awaiting-user", tone: "info", runId, question: request.question, inputs: request.inputs, ts: Date.now() });
    void this.pushSnapshot();
  }

  private hasPendingBuildInput(runId: string): boolean {
    return this.pendingBuildInput?.runId === runId;
  }

  private async answerRun(runId: string, values: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
    const pending = this.pendingRunInput;
    const pendingBuild = this.pendingBuildInput;
    const longRun = this.deps.longRuns ? await this.deps.longRuns.get(runId) : undefined;
    if (pendingBuild?.runId === runId) {
      const missing = pendingBuild.request.inputs.filter((input) => !String(values[input.name] ?? "").trim());
      if (missing.length) return { ok: false, error: `仍缺少：${missing.map((input) => input.name).join("、")}` };
      if (!this.deps.onAnswerBuild) return { ok: false, error: "面板未接入构建恢复器" };
      const normalized = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value).trim()]));
      // Clear the answered request before invoking the asynchronous resume.
      // If the resumed model immediately asks a second clarification, its
      // user:pending event must be allowed to install the new request.
      this.pendingBuildInput = undefined;
      this.run = { ...this.run, status: "running", text: "正在应用补充输入" };
      // The clarification event persists its waiting state asynchronously;
      // wait for that write before clearing it so the old state cannot land
      // after the answer and resurrect the stale form on refresh.
      await this.buildStatusPersistence;
      const beforeResume = this.deps.runs ? await this.deps.runs.get(runId) : undefined;
      if (beforeResume?.status === "waiting-user") await this.deps.runs!.update(runId, { status: "running", error: null, details: { ...(beforeResume.details ?? {}), awaitingUser: null, clarificationAnswers: { ...((beforeResume.details as Record<string, unknown> | null)?.clarificationAnswers as Record<string, string> ?? {}), ...normalized } } });
      const result = await this.deps.onAnswerBuild(runId, normalized);
      if (!result.ok) {
        this.pendingBuildInput = pendingBuild;
        this.run = { ...this.run, status: "waiting-user", text: pendingBuild.request.question };
        const failedResume = this.deps.runs ? await this.deps.runs.get(runId) : undefined;
        if (failedResume) await this.deps.runs!.update(runId, { status: "waiting-user", error: result.error ?? pendingBuild.request.question, details: { ...(failedResume.details ?? {}), awaitingUser: pendingBuild.request } });
        await this.pushSnapshot();
        return result;
      }
      // A new clarification may have arrived while the resume callback was
      // starting the model. Do not overwrite it with a stale running state.
      if (this.hasPendingBuildInput(runId)) {
        await this.persistSession();
        await this.pushSnapshot();
        return result;
      }
      this.pushChat({ role: "build-status", tone: "info", text: "已收到补充输入，继续构建。", runId, ts: Date.now() });
      await this.persistSession();
      await this.pushSnapshot();
      return { ok: true };
    }
    const expectedInputs = pending?.runId === runId ? pending.inputs : longRun?.awaitingUser?.inputs;
    if (!expectedInputs) return { ok: false, error: "当前没有等待输入的运行" };
    const missing = expectedInputs.filter((input) => !String(values[input.name] ?? "").trim());
    if (missing.length) return { ok: false, error: `仍缺少：${missing.map((input) => input.name).join("、")}` };
    const normalized = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.trim()]));
    if (!pending && longRun?.status === "waiting-user" && this.deps.onStartLongRun && this.deps.longRuns) {
      const queued = await this.deps.longRuns.update(runId, { status: "queued", slots: { ...longRun.slots, ...normalized }, awaitingUser: null, lastError: null }, longRun.revision);
      this.setLongRunState(queued);
      const started = await this.deps.onStartLongRun(queued);
      if (!started.ok) {
        const failed = await this.deps.longRuns.update(runId, { status: "failed", lastError: started.error ?? "长程运行恢复失败", finishedAt: new Date().toISOString() }, queued.revision);
        this.setLongRunState(failed);
        return { ok: false, error: started.error ?? "长程运行恢复失败" };
      }
      this.pushChat({ role: "build-status", tone: "info", text: "已恢复长程运行，继续当前轮。", runId, ts: Date.now() });
      await this.pushSnapshot();
      return { ok: true };
    }
    if (!pending || pending.runId !== runId) return { ok: false, error: "当前没有等待输入的运行" };
    this.pendingRunInput = undefined;
    pending.resolve(normalized);
    if (longRun && this.deps.longRuns) {
      const current = await this.deps.longRuns.get(runId);
      if (current?.status === "waiting-user") await this.deps.longRuns.update(runId, { status: "running", slots: { ...current.slots, ...normalized }, awaitingUser: null, lastError: null }, current.revision);
    }
    this.run = { ...this.run, status: "running", text: "已收到补充输入，继续运行" };
    void (async () => {
      const runs = this.deps.runs;
      if (runs && await runs.get(runId)) await runs.update(runId, { status: "running", error: null });
    })().catch(() => undefined);
    this.pushChat({ role: "build-status", tone: "info", text: "已收到补充输入，重新校验后继续运行。", runId, ts: Date.now() });
    void this.pushSnapshot();
    return { ok: true };
  }

  constructor(private deps: PanelDeps = {}) {}

  /** Provider ids are workspace-scoped data. Never resolve a profile or its
   * secret through a caller supplied id without checking the active workspace. */
  private async currentProvider(providerId: string | null | undefined): Promise<ProviderProfile | undefined> {
    if (!providerId || !this.deps.providers || !this.workspace) return undefined;
    const provider = await this.deps.providers.get(providerId);
    return provider?.workspaceId === this.workspace.id ? provider : undefined;
  }

  /** Scenario records are folder-scoped in the panel. Legacy null-scoped
   * records remain visible everywhere for backwards compatibility; a record
   * carrying an owner can only be used by that workspace/project. */
  private scenarioInScope(scenario: Pick<ScenarioRecord, "workspaceId" | "projectId">, projectId = this.projectId): boolean {
    return scenarioMatchesScope(scenario, { workspaceId: this.workspace?.id ?? null, projectId });
  }

  /** Memory visibility follows the same folder/session boundary as runtime context. */
  private async visibleMemories() {
    if (!this.workspace || !this.deps.memories) return [];
    return await this.deps.memories.listVisible(this.workspace.id, {
      projectId: this.projectId,
      sessionId: this.sessionId,
      scenarioId: this.activeScenarioId,
    });
  }

  private filterMemoryTree(tree: MemoryTreeNode | null, visiblePaths: Set<string>, ownedPaths: Set<string>): MemoryTreeNode | null {
    if (!tree) return null;
    if (tree.kind === "file") {
      const resolved = path.resolve(tree.path);
      // Files created before metadata tracking are legacy workspace-level
      // Memory. Keep them visible; known records from another project stay
      // hidden because their metadata gives us an authoritative owner.
      return (!ownedPaths.has(resolved) || visiblePaths.has(resolved)) ? tree : null;
    }
    const children = (tree.children ?? []).map((child) => this.filterMemoryTree(child, visiblePaths, ownedPaths)).filter((child): child is MemoryTreeNode => Boolean(child));
    return { ...tree, children };
  }

  /** 执行底座事件接入（集群监控视图 8.5） */
  attachClusterEvents(subscribe: (h: (e: ClusterEvent) => void) => void): void {
    subscribe((e) => {
      // R3 审计#11：上限 500 条，防长跑内存膨胀
      this.clusterEvents.push(e);
      if (this.clusterEvents.length > 500) this.clusterEvents.splice(0, this.clusterEvents.length - 500);
      this.broadcast({ kind: "cluster", event: e });
    });
  }

  /** 目标模式时间线接入（8.8） */
  attachLoopEvents(loop: GoalLoop): void {
    this.deps.loop = loop;
    loop.on((e) => {
      // R3 审计#11：上限 500 条，防长跑内存膨胀
      this.loopEvents.push(e);
      if (this.loopEvents.length > 500) this.loopEvents.splice(0, this.loopEvents.length - 500);
      this.broadcast({ kind: "loop", event: e });
    });
  }

  /** 挂接编排器：状态/闸门事件镜像为聊天消息（每次新构建由 launcher 调用） */
  attachOrchestrator(orch: Orchestrator, options: { interactive?: boolean } = {}): void {
    this.deps.orchestrator = orch;
    this.interactiveBuild = options.interactive ?? true;
    // 新构建 = 新一页分寸（§2 数据流：闸门 reject/edit/guide 都是本构建的信号源）
    this.buildLedgerProposals = [];
    this.excludedProposalIds = [];
    this.gatePayloads.clear();
    this.autoPassedGates.clear();
    this.buildLedgerScenarioId = null;
    // Capture ownership when the orchestrator is attached. Reading the
    // mutable current run inside callbacks would retag a late event from an
    // old session as the newer run after navigation.
    const orchestratorRunId = this.run.runId;
    const owned = (message: Record<string, unknown>): Record<string, unknown> => orchestratorRunId ? { ...message, runId: orchestratorRunId } : message;
    const exposeBuildClarification = (request: { question: string; inputs: Array<{ name: string; type?: string; description?: string }> }): void => {
      const runId = orchestratorRunId ?? this.run.runId;
      const inputs: WorkMissingInput[] = request.inputs.map((input) => ({
        name: input.name,
        description: input.description ?? "",
        type: input.type === "path" ? "path" : input.type === "url" ? "url" : input.type === "number" ? "number" : "string",
      }));
      this.sessionLocked = true;
      this.run = { ...this.run, kind: "build", status: "waiting-user", ...(runId ? { runId } : {}), text: request.question };
      this.pushChat(owned({ role: "awaiting-user", tone: "info", runId, question: request.question, inputs, ts: Date.now() }));
      void this.pushSnapshot();
    };
    orch.on("run:done", ({ context }) => {
      this.lastBuildContext = context;
      void this.pushSnapshot();
    });
    // R1 审计#7：user:pending 的两张卡片去重——notifyBuildAwaitingUser 是唯一
    // 澄清入口（run 状态 + awaiting-user 卡 + 持久化）；expose 仅处理恢复场景
    // 的 restore（经 restoredClarification 显式调用，不重复注册 handler）。
    const restoredClarification = orch.ctx.awaitingUser;
    if (restoredClarification) exposeBuildClarification(restoredClarification);
    orch.on("state:enter", ({ to }) => {
      if (to !== "done" && this.interactiveBuild) this.pushChat(owned({ role: "build-status", tone: "info", text: phaseProgressText(to), ts: Date.now() }));
      void this.pushSnapshot();
    });
    orch.on("gate:pending", ({ request }) => {
      this.run = { ...this.run, kind: "build", status: this.interactiveBuild ? "waiting-gate" : "running" };
      this.gatePayloads.set(request.gate, request.payload);
      if (!this.interactiveBuild) {
        void this.pushSnapshot();
        return;
      }
      // 抽查态闸门（§16 spot/full）：账本统计足够的闸门自动通过，不重复打扰
      void handleGatePending(request);
    });

    const handleGatePending = async (request: { gate: 1 | 2 | 3 | 4 | 5; payload: unknown; context: BuildContext }): Promise<void> => {
      const gateKey = String(request.gate);
      if (!this.autoPassedGates.has(request.gate) && this.deps.library && this.buildLedgerScenarioId) {
        const routingMode = (await this.deps.settings?.get().catch(() => undefined))?.routingMode ?? "legacy";
        if (routingMode !== "legacy") {
          const record = await this.deps.library.get(this.buildLedgerScenarioId).catch(() => undefined);
          const stat = record?.ledger ? record.ledger.gateStats[gateKey] : undefined;
          if (stat && stat.passes >= 3 && stat.rejects === 0 && stat.edits === 0) {
            this.autoPassedGates.add(request.gate);
            try {
              await orch.decide({ gate: request.gate, action: "approve" });
              this.pushChat(owned({ role: "build-status", tone: "info", text: `闸门${request.gate} 已按账本自动通过（历史通过 ${stat.passes} 次，无打回）。`, ts: Date.now() }));
              await this.pushSnapshot();
              return;
            } catch {
              /* 自动通过失败 → 落回人工卡片 */
            }
          }
        }
      }
      // §14 签约面下半：已生效条款（重规划场景才有账本）——hits 可见，可退役
      let ledgerExisting: Array<{ id: string; clause: string; kind: string; hits: number }> | undefined;
      let ledgerExistingScenarioId: string | undefined;
      if (request.gate === 5 && this.buildLedgerScenarioId && this.deps.library) {
        const record = await this.deps.library.get(this.buildLedgerScenarioId).catch(() => undefined);
        const active = record?.ledger ? activeConstraints(record.ledger) : [];
        if (active.length) {
          ledgerExisting = active.slice(0, 12).map((c) => ({ id: c.id, clause: c.clause, kind: c.kind, hits: c.hits }));
          ledgerExistingScenarioId = this.buildLedgerScenarioId ?? undefined;
        }
      }
      const view = (() => {
        try {
          return renderGateView(request.gate, request.payload);
        } catch {
          // 载荷畸形（恢复/异常路径）也不能让闸门流程失联
          return { title: `闸门${request.gate}`, lines: ["（闸门内容渲染失败，可直接批准或驳回）"] };
        }
      })();
      // 闸5 签约面（§14）：把本轮构建攒下的分寸提案带给卡片（勾选清单由客户端渲染）
      const ledgerProposals = request.gate === 5 && this.buildLedgerProposals.length
        ? this.buildLedgerProposals.map((p) => ({ tempId: p.tempId, clause: p.clause, scope: p.scope, kind: p.kind, ...(p.conflictWith ? { conflictWith: p.conflictWith } : {}) }))
        : undefined;
      this.pushChat(owned({
        role: "gate-card",
        gate: request.gate,
        title: `闸门${request.gate} · ${view.title}`,
        lines: view.lines.filter((l) => !l.startsWith("[")),
        editSeed: editSeedFor(request.gate, request.context),
        canPin: request.gate !== 5 || canPinBuild(request.context),
        approvalIndex: request.context.approvals.length,
        ...(ledgerProposals ? { ledgerProposals } : {}),
        ...(ledgerExisting ? { ledgerExisting, ledgerExistingScenarioId } : {}),
        decided: undefined,
        ts: Date.now(),
      }));
      await this.pushSnapshot();
    };
    orch.on("user:pending", ({ request, context }) => {
      const runId = orchestratorRunId ?? context.id;
      this.notifyBuildAwaitingUser(runId, request);
    });
    // 决策状态行由 handleAction 统一推送（此处不再重复）
  }

  /** 构建完成后强制推送最新快照（场景库/Memory 生长可见） */
  async refresh(): Promise<void> {
    await this.pushSnapshot();
  }

  /** 闸3 候选载荷 → capabilityId → 人话名（分寸条款用，缺名回落 id） */
  private capabilityNameMap(gate: number): Record<string, string> {
    const payload = this.gatePayloads.get(gate) as Array<{ nodeId: string; candidates: Array<{ id: string; name: string }> }> | undefined;
    if (!Array.isArray(payload)) return {};
    const map: Record<string, string> = {};
    for (const set of payload) for (const candidate of set.candidates ?? []) map[candidate.id] = candidate.name;
    return map;
  }

  /**
   * 分寸提案交接（§2 唯一写入点在 finishBuild）：launcher 在闸5 固化场景时取走
   * 本轮攒下的提案（含排除清单过滤），拿去 propose+confirm 进新场景账本。取走即清空。
   */
  drainBuildLedgerProposals(): Array<GateProposalDraft & { at: string; runId: string | null }> {
    const excluded = new Set(this.excludedProposalIds);
    const seeds = this.buildLedgerProposals.filter((p) => !excluded.has(p.tempId));
    const keptPending = this.buildLedgerProposals.filter((p) => excluded.has(p.tempId));
    // 未签约的提案保留在 pending 侧（30 天未确认自动过期，§15），但不能再次入库——
    // 这里交给调用方决定；面板侧只保留本次未签约清单供后续构建继续累积确认语义。
    this.buildLedgerProposals = keptPending;
    this.excludedProposalIds = [];
    return seeds;
  }

  /** 抽查态闸门：launcher 在 match 命中重规划时绑定既有场景账本 */
  setBuildLedgerScenarioId(scenarioId: string | null): void {
    this.buildLedgerScenarioId = scenarioId;
  }

  /** launcher 在决定用哪个场景执行时绑定（match 命中路径 start-build 无 scenarioId） */
  bindRunScenario(runId: string, scenarioId: string, digest?: string): void {
    const meta = this.runLedgerMeta.get(runId);
    if (meta) this.runLedgerMeta.set(runId, { ...meta, scenarioId, ...(digest ? { digest } : {}) });
  }

  /**
   * 工作运行收尾（§5/§9/§12）：run 收尾一个事务。
   * failed → rejected（失败自证，无人值守同样记）；cancelled → 不记（中止非验证）；
   * 运行中有 guide → corrected + 提案；无人值守成功 → 只 runs++；
   * 有人值守成功 → 10 分钟反应窗（👍/👎/guide/编辑先到先得，沉默超时 = 弱 accepted）。
   */
  private settleWorkRunLedgerOutcome(runId: string, terminalStatus: "succeeded" | "failed" | "cancelled"): void {
    const meta = this.runLedgerMeta.get(runId);
    // 保留 meta（供事后产出修订定位场景），只做 FIFO 封顶
    if (this.runLedgerMeta.size > 100) {
      const oldest = this.runLedgerMeta.keys().next().value;
      if (oldest) this.runLedgerMeta.delete(oldest);
    }
    if (!meta || meta.mode !== "work" || !meta.scenarioId || !this.deps.library) return;
    const scenarioId = meta.scenarioId;
    if (terminalStatus === "cancelled") return;
    // suspected（自检仍违规）：不进反应窗、不记 accepted——断连胜且两侧计数都不动（§10）
    if (this.suspectedRuns.has(runId)) {
      this.suspectedRuns.delete(runId);
      void this.recordScenarioOutcome(scenarioId, { runId, attended: meta.attended, outcome: "suspected", digest: meta.digest });
      return;
    }
    if (terminalStatus === "failed") {
      void this.recordScenarioOutcome(scenarioId, { runId, attended: meta.attended, outcome: "rejected", digest: meta.digest });
      return;
    }
    const guides = this.runGuidanceNotes.get(runId) ?? [];
    this.runGuidanceNotes.delete(runId);    if (guides.length) {
      void this.recordScenarioOutcome(scenarioId, { runId, attended: meta.attended, outcome: "corrected", digest: meta.digest, guides });
      return;
    }
    if (!meta.attended) {
      void this.recordScenarioOutcome(scenarioId, { runId, attended: false, outcome: "unattended-success", digest: meta.digest });
      return;
    }
    const windowMs = this.deps.feedbackWindowMs ?? 10 * 60 * 1000;
    const timer = setTimeout(() => {
      this.pendingFeedback.delete(runId);
      void this.recordScenarioOutcome(scenarioId, { runId, attended: true, outcome: "silent-accepted", digest: meta.digest });
    }, windowMs);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
    this.pendingFeedback.set(runId, { timer, scenarioId, digest: meta.digest, attended: true });
  }

  /** 账本结算：recordRunOutcome 原子事务 + guide 文本转 pendingConfirm 提案（§4 原话即条款） */
  private async recordScenarioOutcome(
    scenarioId: string,
    params: { runId: string; attended: boolean; outcome: "accepted" | "rejected" | "corrected" | "silent-accepted" | "unattended-success" | "suspected"; digest: string; guides?: string[] },
  ): Promise<void> {
    const library = this.deps.library;
    if (!library) return;
    const at = new Date().toISOString();
    // 两角色模型：从注入元数据读取本 run 的归因对象和 holdout 标记
    const injection = this.runInjectionMeta.get(params.runId);
    this.runInjectionMeta.delete(params.runId);
    await library
      .updateLedger(scenarioId, (ledger) => {
        let next = recordRunOutcome(ledger, {
          runId: params.runId,
          attended: params.attended,
          outcome: params.outcome,
          digest: params.digest,
          at,
          interventions: { gatesAnswered: 0, questionsAnswered: 0, correctionsGiven: params.guides?.length ?? 0 },
          injectedConstraints: injection?.injected,
          holdout: injection?.holdout,
        });
        for (const guide of params.guides ?? []) {
          const merged = mergeConstraintGuarded(next, { clause: stripNegationPrefix(guide), scope: "output", origin: { type: "guide", text: guide, at, runId: params.runId } });
          next = merged.ledger;
        }
        // 两角色模型：结算事务尾部跑生命周期自动评估（自动转正/退役）
        const { ledger: evaluated, changes } = evaluateLifecycle(next);
        for (const change of changes) {
          this.pushChat({ role: "build-status", tone: change.action === "retire" ? "info" : "ok", text: `分寸账本自动${change.action === "retire" ? "退役" : "转正"}条款「${change.clause.slice(0, 30)}」（${change.reason}）。`, ts: Date.now() });
        }
        return evaluated as ScenarioLedger;
      })
      .catch(() => undefined);
    // §12 步骤08：结算落账后广播快照——sparkline/曲线/条款即时刷新
    await this.pushSnapshot();
  }

  /**
   * 反应窗主动撤销（PR-edit-accept 的 revise-output 复用）：沉默 accepted 未落账时
   * 先到先得——编辑优先于沉默（§7 竞态表）。返回 false = 窗口已关（沉默已入账）。
   */
  cancelFeedbackWindow(runId: string): { scenarioId: string; digest: string } | null {
    const pending = this.pendingFeedback.get(runId);
    if (!pending) return null;
    clearTimeout(pending.timer);
    this.pendingFeedback.delete(runId);
    return { scenarioId: pending.scenarioId, digest: pending.digest };
  }

  /** 反馈窗口是否开着（客户端决定是否渲染 👍/👎 行） */
  feedbackWindowOpen(runId: string): boolean {
    return this.pendingFeedback.has(runId);
  }

  /** 自检仍违规（§10）：run 标 suspected——断连胜但不写 accepted/rejected/corrected */
  private readonly suspectedRuns = new Set<string>();
  markRunSuspected(runId: string): void {
    this.suspectedRuns.add(runId);
  }

  /** 两角色模型：本 run 注入了哪些条款 + 是否 holdout（结算时传给 recordRunOutcome 归因） */
  private readonly runInjectionMeta = new Map<string, { injected: string[]; holdout: boolean }>();
  markRunInjection(runId: string, injected: string[], holdout: boolean): void {
    this.runInjectionMeta.set(runId, { injected, holdout });
  }

  /** 聊天历史（左栏对话；重连经快照恢复） */
  private readonly chatHistory: Array<Record<string, unknown>> = [];
  /** Full session history for persistence; chatHistory is only the render window. */
  private readonly persistedChatHistory: Array<Record<string, unknown>> = [];
  private streamPersistTimer: ReturnType<typeof setTimeout> | undefined;
  private historyPersistenceError: string | null = null;
  private static readonly MAX_PERSISTED_MESSAGES = 500;

  /**
   * SceneFlow 进度通道：构建过程叙述/分源检索/流式叙述增量都走这里——
   * 只广播不入聊天历史，客户端按 runId 原地更新那一张进度卡。
   * 聊天流最终形态：用户消息 → 进度卡(1) → 闸门卡片 → 终态卡。
   */
  pushProgress(runId: string | null, payload: Record<string, unknown>): void {
    this.broadcast({ kind: "progress", runId: runId ?? null, ...payload, ts: Date.now() });
  }

  /** 编排器阶段迁移 → 进度卡步进器（phase key + 人话行） */
  pushPhaseProgress(runId: string | null, phase: string): void {
    this.pushProgress(runId, { phase, line: phaseProgressText(phase) });
  }

  pushChat(message: Record<string, unknown>): void {
    // A worker can finish after the user has switched sessions (termination
    // deliberately unlocks navigation before every provider callback settles).
    // Run-scoped events must never be appended to whichever session happens
    // to be current at callback time. User/command/system messages without a
    // runId remain intentionally unscoped.
    const messageRunId = typeof message.runId === "string" ? message.runId : undefined;
    const messageSessionId = typeof message.sessionId === "string" ? message.sessionId : undefined;
    // Durable LongRun terminal cards are allowed to reach the chat even when
    // there is no corresponding RunProduct row (the two IDs intentionally
    // live in separate stores).  A producer that knows its session must still
    // be rejected after the user has navigated elsewhere.
    const orphanLongRunTerminal = Boolean(message.terminal === true && messageRunId?.startsWith("long-run-") && (!messageSessionId || messageSessionId === this.sessionId));
    // Task-canvas settlement: a finished progress-card belongs to the session
    // it ran in. The run binding is already unlocked by the time the settle
    // callback fires, so scope it by sessionId instead of this.run.
    const canvasSettlement = Boolean(message.role === "progress-card" && message.finished === true && messageSessionId && messageSessionId === this.sessionId);
    if (messageRunId && messageRunId !== this.run.runId && !orphanLongRunTerminal && !canvasSettlement) return;
    this.persistedChatHistory.push(message);
    if (this.persistedChatHistory.length > PanelServer.MAX_PERSISTED_MESSAGES) {
      this.persistedChatHistory.splice(0, this.persistedChatHistory.length - PanelServer.MAX_PERSISTED_MESSAGES);
    }
    this.chatHistory.push(message);
    if (this.chatHistory.length > 200) this.chatHistory.shift();
    this.broadcast({ kind: "chat", message });
    if (message.role === "user" && this.sessionTitle === "新对话") {
      const content = String(message.content ?? "").trim();
      if (content) this.sessionTitle = content.slice(0, 36);
    }
    if (message.terminal === true) {
      // Terminal notifications can arrive after a user has switched away
      // from a completed run (or after an old async launcher finally settles).
      // Only the currently locked run may mutate the authoritative inspector;
      // the chat message itself is still retained as history.
      const ownsCurrentRun = messageRunId ? messageRunId === this.run.runId : this.sessionLocked;
      if (!ownsCurrentRun) {
        if (message.role === "model-stream") this.scheduleStreamPersistence();
        else void this.persistSession();
        return;
      }
      this.sessionLocked = false;
      const tone = String(message.tone ?? "");
      const requestedStatus = String(message.runStatus ?? "");
      const terminalStatus: "succeeded" | "failed" | "cancelled" = requestedStatus === "succeeded" || requestedStatus === "cancelled" || requestedStatus === "failed" ? requestedStatus : tone === "ok" ? "succeeded" : "failed";
      const terminalError = typeof message.error === "string" ? message.error : String(message.text ?? "");
      // A terminate action is authoritative for the current run. A late
      // success/failure event from the worker must not resurrect it after the
      // user has already stopped it.
      if (this.run.status === "cancelled" && terminalStatus !== "cancelled") {
        if (message.role === "model-stream") this.scheduleStreamPersistence();
        else void this.persistSession();
        return;
      }
      this.run = { ...this.run, status: terminalStatus, text: String(message.text ?? "") };
      const terminalRunId = this.run.runId;
      const terminalContext = this.deps.orchestrator?.ctx;
      // 分寸账本（PR-signal-run）：工作运行收尾一个事务——失败自证记 rejected，
      // 有人值守成功进反应窗（沉默超时=弱 accepted），无人值守成功只 runs++（§9）。
      if (terminalRunId && this.run.kind === "work") this.settleWorkRunLedgerOutcome(terminalRunId, terminalStatus);
      if (this.deps.runs && terminalRunId) {
        void (async () => {
          const stored = await this.deps.runs?.get(terminalRunId);
          // LongRun terminal messages use the durable LongRun id, which is
          // intentionally separate from RunProduct rows. A late terminal
          // chat event must never crash the panel by updating a missing run.
          if (!stored) return;
          const finishedAt = new Date().toISOString();
          const context = terminalContext;
          await this.deps.runs?.update(terminalRunId, { status: terminalStatus, finishedAt, durationMs: stored ? Math.max(0, Date.parse(finishedAt) - Date.parse(stored.startedAt)) : null, error: terminalStatus === "succeeded" ? null : terminalError, details: context ? { id: context.id, requirement: context.requirement, phase: context.phase, executionMode: context.executionMode, intent: context.intent, dag: context.dag, candidates: context.candidates, selections: context.selections, assembly: context.assembly, trace: context.trace, acceptance: context.acceptance, approvals: context.approvals, outcome: context.outcome, planner: context.planner, runtimeContext: context.runtimeContext, distilled: context.distilled } : stored?.details ?? null });
        })().catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.historyPersistenceError = `运行记录保存失败：${message.slice(0, 240)}`;
        });
      }
    }
    if (message.role === "model-stream") this.scheduleStreamPersistence();
    else void this.persistSession();
  }

  private scheduleStreamPersistence(): void {
    if (this.streamPersistTimer) clearTimeout(this.streamPersistTimer);
    this.streamPersistTimer = setTimeout(() => {
      this.streamPersistTimer = undefined;
      void this.persistSession();
    }, 250);
  }

  private clearChatHistory(): void {
    this.chatHistory.length = 0;
    this.persistedChatHistory.length = 0;
  }

  private setChatHistory(messages: Array<Record<string, unknown>>): void {
    this.persistedChatHistory.length = 0;
    this.persistedChatHistory.push(...messages.slice(-PanelServer.MAX_PERSISTED_MESSAGES));
    this.chatHistory.length = 0;
    this.chatHistory.push(...messages.slice(-200));
  }

  /** 闸门决策落到聊天历史中的对应卡片（重连后仍显示已决状态） */
  markGateCardDecided(gate: number, action: "approve" | "reject" | "edit", targetPhase?: string): void {
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
    // `lastBuildContext` is an in-memory convenience for the current build,
    // while history navigation can restore a different durable run.  Never
    // let a context from the previous session appear in the newly opened
    // session's inspector; reconstruct that run from its own durable details
    // below when the IDs do not match.
    const matchingLastBuild = this.lastBuildContext && (!this.run.runId || this.lastBuildContext.id === this.run.runId) ? this.lastBuildContext : undefined;
    let ctx = this.run.status === "idle" ? orch?.ctx : this.run.kind === "build" ? (matchingLastBuild ?? orch?.ctx) : undefined;
    if (!ctx && this.run.kind === "build" && this.run.runId && this.deps.runs) {
      const stored = await this.deps.runs.get(this.run.runId);
      const details = stored?.details as Record<string, unknown> | null | undefined;
      if (stored && details) {
        ctx = {
          id: stored.id,
          phase: (details.phase as BuildContext["phase"]) ?? "done",
          pendingGate: null,
          requirement: stored.requirement,
          clarificationAnswers: (details.clarificationAnswers as BuildContext["clarificationAnswers"]) ?? {},
          awaitingUser: (details.awaitingUser as BuildContext["awaitingUser"]) ?? null,
          executionMode: (details.executionMode as BuildContext["executionMode"]) ?? "run",
          runtimeContext: (details.runtimeContext as BuildContext["runtimeContext"]) ?? null,
          planner: (details.planner as BuildContext["planner"]) ?? null,
          intent: (details.intent as BuildContext["intent"]) ?? null,
          dag: (details.dag as BuildContext["dag"]) ?? null,
          candidates: (details.candidates as BuildContext["candidates"]) ?? [],
          selections: (details.selections as BuildContext["selections"]) ?? [],
          assembly: (details.assembly as BuildContext["assembly"]) ?? null,
          acceptance: (details.acceptance as BuildContext["acceptance"]) ?? [],
          trace: (details.trace as BuildContext["trace"]) ?? [],
          approvals: (details.approvals as BuildContext["approvals"]) ?? [],
          finalizeChoice: null,
          outcome: (details.outcome as BuildContext["outcome"]) ?? (stored.status === "succeeded" ? "completed" : "failed"),
          distilled: (details.distilled as BuildContext["distilled"]) ?? null,
          skillNotes: [],
          createdAt: stored.startedAt,
          updatedAt: stored.finishedAt ?? stored.startedAt,
        } as BuildContext;
        this.lastBuildContext = ctx;
      }
    }
    let gateView: PanelSnapshot["gateView"] = null;
    if (ctx?.pendingGate) {
      const view = renderGateView(ctx.pendingGate as 1 | 2 | 3 | 4 | 5, gatePayloadFor(ctx.pendingGate as 1 | 2 | 3 | 4 | 5, ctx));
      gateView = {
        gate: ctx.pendingGate,
        title: view.title,
        lines: view.lines,
        editSeed: editSeedFor(ctx.pendingGate as 1 | 2 | 3 | 4 | 5, ctx),
        canPin: ctx.pendingGate !== 5 || canPinBuild(ctx),
      };
    }
    const allScenarioRecords = this.deps.library ? await this.deps.library.list() : [];
    const scenarioSummary = (s: ScenarioRecord): PanelSnapshot["scenarios"][number] => ({
        id: s.id,
        name: s.name,
        goal: s.goal,
        projectId: s.projectId ?? null,
        uses: s.stats.uses,
        successes: s.stats.successes,
        degraded: s.degraded,
        version: s.pinnedVersion,
        status: s.status,
        historyCount: s.versionHistory.length,
        versionHistory: s.versionHistory.map((version) => ({ version: version.version, capabilityIds: version.capabilityIds, createdAt: version.createdAt, reason: version.reason })),
        slotDefs: (s.distilled.slotDefs as Array<{ name?: unknown; type?: unknown; required?: unknown; description?: unknown }>).map((slot) => ({ name: String(slot.name ?? "slot"), type: typeof slot.type === "string" ? slot.type : undefined, required: typeof slot.required === "boolean" ? slot.required : true, description: typeof slot.description === "string" ? slot.description : undefined })),
        capabilityCount: s.capabilityIds.length,
        source: s.source,
        // 分寸账本摘要（PR-curve）：tier/置信度/条款/介入曲线（北极星）
        ledger: (() => {
          const ledger = ensureLedgerOf(s);
          return {
            tier: tierOfLedger(ledger),
            confidence: Math.round(confidence(ledger) * 100) / 100,
            activeCount: activeConstraints(ledger).length,
            pendingCount: pendingConstraints(ledger).length,
            constraints: ledger.constraints.slice(-30).map((c) => ({ id: c.id, clause: c.clause, kind: c.kind, hits: c.hits, confirmed: c.confirmedAt !== null, active: c.active, supersededBy: c.supersededBy, layer: c.layer })),
            curve: ledger.interventions.slice(-30).map((i) => ({ at: i.at, total: i.total })),
            runStats: ledger.runStats,
            attribution: ledger.attribution,
          };
        })(),
      });
    const scenarios = allScenarioRecords.filter((s) => this.scenarioInScope(s)).map(scenarioSummary);
    const availableScenarios = allScenarioRecords
      .filter((s) => s.workspaceId === null || s.workspaceId === this.workspace?.id)
      .map(scenarioSummary);
    let tree: MemoryTreeNode | null = null;
    const allWorkspaceMemories = this.workspace && this.deps.memories ? await this.deps.memories.list(this.workspace.id) : [];
    const memoryItems = await this.visibleMemories();
    if (this.deps.memoryRoot) {
      const rawTree = await memoryTree({ root: this.deps.memoryRoot, sessions: "", scenarios: "", knowledge: "" });
      // The filesystem tree is workspace-wide, while metadata carries the
      // project/session/scenario owner. Hide files without a visible metadata
      // record so switching projects cannot reveal another project's Memory.
      tree = this.filterMemoryTree(
        rawTree,
        new Set(memoryItems.filter((item) => item.path).map((item) => path.resolve(item.path!))),
        new Set(allWorkspaceMemories.filter((item) => item.path).map((item) => path.resolve(item.path!))),
      );
    }
    // The sidebar groups sessions by project, so keep enough history in the
    // snapshot for every project folder instead of truncating at the old
    // recent-only window.
    const sessions = this.deps.history ? await this.deps.history.list(200) : [];
    const settings = this.deps.settings ? await this.deps.settings.public() : null;
    const projects = this.workspace && this.deps.repository
      ? await this.deps.repository.listProjects(this.workspace.id)
      : [];
    const projectSessions = new Map<string, Set<string>>();
    for (const session of sessions) {
      if (!session.projectId) continue;
      const owned = projectSessions.get(session.projectId) ?? new Set<string>();
      owned.add(session.id);
      projectSessions.set(session.projectId, owned);
    }
    const projectStats = await Promise.all(projects.map(async (project) => {
      const sessionIds = projectSessions.get(project.id) ?? new Set<string>();
      const projectScenarios = allScenarioRecords.filter((scenario) => scenario.workspaceId === this.workspace?.id && scenario.projectId === project.id);
      const fileCount = this.deps.repository ? (await this.deps.repository.listFiles(project.id)).length : 0;
      const memoryCount = allWorkspaceMemories.filter((item) => item.projectId === project.id || (item.sessionId !== null && sessionIds.has(item.sessionId)) || (item.scenarioId !== null && projectScenarios.some((scenario) => scenario.id === item.scenarioId))).length;
      return { sessionCount: sessionIds.size, fileCount, memoryCount, scenarioCount: projectScenarios.length };
    }));
    const projectStatsById = new Map(projects.map((project, index) => [project.id, projectStats[index]!]));
    const files = this.projectId && this.deps.repository
      ? await this.deps.repository.listFiles(this.projectId)
      : [];
    const connectors = this.workspace && this.deps.connectors ? await this.deps.connectors.list(this.workspace.id) : [];
    const runs = this.workspace && this.deps.runs ? await this.deps.runs.listForWorkspace(this.workspace.id) : [];
    const artifacts = this.workspace && this.deps.artifacts ? await this.deps.artifacts.list(this.workspace.id, this.projectId) : [];
    const providers = this.workspace && this.deps.providers ? await this.deps.providers.list(this.workspace.id) : [];
    const tasks = this.workspace && this.deps.tasks ? await this.deps.tasks.list(this.workspace.id) : [];
    const longRuns = this.workspace && this.deps.longRuns ? await this.deps.longRuns.list(this.workspace.id) : [];
    const durableAwaiting = longRuns.find((item) => item.sessionId === this.sessionId && item.status === "waiting-user" && item.awaitingUser);
    const audit = this.workspace && this.deps.audit ? await this.deps.audit.list(this.workspace.id, 100) : [];
    const contexts = this.workspace && this.deps.contexts ? await this.deps.contexts.list(this.workspace.id, this.projectId) : [];
    const policy = this.workspace && this.deps.policy ? await this.deps.policy.get(this.workspace.id) : null;
    const shares = this.workspace && this.deps.shares ? await this.deps.shares.list(this.workspace.id) : [];
    const comments = this.workspace && this.deps.comments ? await this.deps.comments.list(this.workspace.id) : [];
    const identities = this.workspace && this.deps.identities ? await this.deps.identities.list(this.workspace.id) : [];
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
      context: { projectInstructions: ctx?.runtimeContext?.projectInstructions ?? "", fileCount: ctx?.runtimeContext?.files.length ?? 0, memoryCount: ctx?.runtimeContext?.memories.length ?? 0, connectorCount: ctx?.runtimeContext?.connectors.filter((connector) => connector.status === "enabled").length ?? 0, desktopContextCount: ctx?.runtimeContext?.desktopContexts.length ?? 0, providerModel: ctx?.runtimeContext?.provider?.model ?? null },
      planner: ctx?.planner ?? null,
      selections,
      acceptance: (ctx?.acceptance ?? []).map((a) => {
        const detail = (a as { detail?: Record<string, unknown> }).detail ?? {};
        return { layer: (a as { layer: string }).layer, passed: (a as { passed: boolean }).passed, verified: detail.source !== "construction" && detail.mode !== "construction" };
      }).slice(-6),
    };
    // 闸门卡片回填已决状态。回退重跑时同一个 gate 编号会出现多张卡片，
    // 不能只按编号消费旧审批，否则当前等待中的卡片会被错误地锁死。
    const latestPendingGateCard = ctx?.pendingGate
      ? [...this.chatHistory].reduce((latest, message, index) => {
        const item = message as { role?: string; gate?: number };
        return item.role === "gate-card" && item.gate === ctx.pendingGate ? index : latest;
      }, -1)
      : -1;
    const chat = this.chatHistory.map((m, index) => {
      const mm = m as { role?: string; gate?: number; decided?: unknown; approvalIndex?: unknown };
      if (mm.role === "gate-card" && mm.decided === undefined && mm.gate !== undefined) {
        const approvalIndex = typeof mm.approvalIndex === "number" ? mm.approvalIndex : undefined;
        const rec = approvalIndex !== undefined
          ? ctx?.approvals?.[approvalIndex]
          : index === latestPendingGateCard
            ? undefined
            : [...(ctx?.approvals ?? [])].reverse().find((a) => (a as { gate: number }).gate === mm.gate);
        if (rec && (rec as { gate: number }).gate !== mm.gate) return m;
        if (!rec && ctx?.pendingGate === mm.gate && index !== latestPendingGateCard) return { ...m, stale: true };
        if (rec) {
          const r = rec as { action: string; targetPhase?: string };
          return { ...m, decided: { action: r.action, targetPhase: r.targetPhase } };
        }
      }
      return m;
    });
    return {
      mode: this.activeMode,
      activeScenarioId: this.activeScenarioId,
      chat,
      preview,
      buildId: ctx?.id ?? null,
      phase: ctx?.id ? ctx.phase : "idle",
      pendingGate: ctx?.pendingGate ?? null,
      gateView,
      dag: ctx?.dag ?? null,
      trace: (ctx?.trace ?? []) as unknown[],
      cluster: this.clusterEvents,
      loop: this.loopEvents,
      scenarios,
      availableScenarios,
      memoryTree: tree,
      memoryItems: memoryItems.map((item) => ({ id: item.id, name: item.name, scope: item.scope, enabled: item.enabled, sourceType: item.sourceType, sourceId: item.sourceId, path: item.path, updatedAt: item.updatedAt })),
      sessions,
      sessionId: this.sessionId,
      settings,
      hostExecution: this.deps.hostExecution ?? {
        enabled: false,
        allowedCommands: [],
        workspaceRoot: null,
        installRoot: null,
        maxTimeoutMs: null,
        maxOutputBytes: null,
        error: "host execution disabled: launcher did not provide a host policy",
      },
      busy: this.sessionLocked,
      run: this.run,
      awaitingUser: this.pendingRunInput
        ? { runId: this.pendingRunInput.runId, question: this.pendingRunInput.question, inputs: this.pendingRunInput.inputs }
        : this.pendingBuildInput ? { runId: this.pendingBuildInput.runId, question: this.pendingBuildInput.request.question, inputs: this.pendingBuildInput.request.inputs }
        : ctx?.awaitingUser && this.run.runId ? { runId: this.run.runId, question: ctx.awaitingUser.question, inputs: ctx.awaitingUser.inputs }
        : durableAwaiting?.awaitingUser ? { runId: durableAwaiting.id, question: durableAwaiting.awaitingUser.question, inputs: durableAwaiting.awaitingUser.inputs } : null,
      workspace: this.workspace ? { id: this.workspace.id, name: this.workspace.name } : null,
      projectId: this.projectId,
      projects: projects.map((project) => ({ id: project.id, name: project.name, rootPath: project.rootPath ?? null, description: project.description, instructions: project.instructions, pinned: project.pinned, providerId: project.providerId, status: project.status, ...(projectStatsById.get(project.id) ?? { sessionCount: 0, fileCount: 0, memoryCount: 0, scenarioCount: 0 }) })),
      files,
      connectors: connectors.map((connector) => ({ id: connector.id, name: connector.name, kind: connector.kind, status: connector.status, endpoint: connector.endpoint, permissionScopes: connector.permissionScopes, hasSecret: connector.hasSecret, source: connector.source, trustStatus: connector.trustStatus, trustScore: connector.trustScore, trustEvidenceCount: connector.trustEvidence.length, lastHealthAt: connector.lastHealthAt, lastError: connector.lastError })),
      runs,
      artifacts,
      providers,
      tasks,
      longRuns,
      audit: audit.map(({ id, actor, action, resourceType, resourceId, summary, createdAt }) => ({ id, actor, action, resourceType, resourceId, summary, createdAt })),
      contexts: contexts.map((context) => ({ id: context.id, kind: context.kind, origin: context.origin, label: context.label, enabled: context.enabled, projectId: context.projectId, updatedAt: context.updatedAt })),
      policy: policy ? { read: policy.read, write: policy.write, install: policy.install, network: policy.network, send: policy.send, approvalMode: policy.approvalMode } : null,
      shares: shares.map(({ id, resourceType, resourceId, role, tokenHash, expiresAt, createdAt }) => ({ id, resourceType, resourceId, role, tokenMasked: `${tokenHash.slice(0, 4)}…${tokenHash.slice(-4)}`, expiresAt, createdAt })),
      comments: comments.map(({ id, resourceType, resourceId, author, body, resolved, createdAt, updatedAt }) => ({ id, resourceType, resourceId, author, body, resolved, createdAt, updatedAt })),
      identities,
      revision: this.revision,
      updatedAt: new Date().toISOString(),
    };
  }

  /** 8.4 Web 闸门操作 / 8.3 控制动作（与 TUI 决策协议同 schema） */
  async handleAction(raw: unknown): Promise<{ ok: boolean; error?: string; data?: unknown }> {
    const parsed = PanelActionSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: `invalid action: ${parsed.error.issues[0]?.message ?? "unknown"}` };
    }
    const action = parsed.data;
    if (action.type === "new-session") {
      if (this.sessionLocked) return { ok: false, error: "当前运行尚未结束，不能新建对话" };
      const targetProjectId = action.projectId === undefined ? this.projectId : action.projectId;
      if (targetProjectId) {
        const targetProject = this.deps.repository && this.workspace ? await this.deps.repository.getProject(targetProjectId) : undefined;
        if (!targetProject || targetProject.workspaceId !== this.workspace?.id || targetProject.status !== "active") return { ok: false, error: "所选项目不存在或不可用" };
      }
      const selectedScenario = action.scenarioId ? await this.deps.library?.get(action.scenarioId) : undefined;
      if (action.scenarioId && (!selectedScenario || !this.scenarioInScope(selectedScenario, targetProjectId) || selectedScenario.status !== "active")) return { ok: false, error: "所选场景不存在或已归档" };
      await this.persistenceQueue;
      await this.saveCurrentSession();
      const settings = await this.deps.settings?.get();
      const persistHistory = !settings || (settings.useHistory && !settings.temporarySession);
      const session = persistHistory && this.deps.history
        ? await this.deps.history.create("work", "新对话", targetProjectId)
        : { id: null, title: "临时对话", activeScenarioId: null };
      this.projectId = targetProjectId;
      const targetProject = targetProjectId && this.deps.repository ? await this.deps.repository.getProject(targetProjectId) : undefined;
      this.projectProviderId = targetProject?.providerId ?? null;
      this.projectRootPath = targetProject?.rootPath ?? null;
      this.sessionId = session.id;
      this.sessionTitle = session.title;
      this.clearChatHistory();
      this.deps.orchestrator = undefined;
      this.activeMode = "work";
      this.activeScenarioId = action.scenarioId ?? null;
      await this.syncActiveScenarioScope(this.projectId);
      if (persistHistory && this.deps.history && session.id && action.scenarioId) {
        session.activeScenarioId = action.scenarioId;
        await this.deps.history.save(session);
      }
      this.run = { kind: "idle", status: "idle" };
      await this.pushSnapshot();
      return { ok: true, data: { projectId: this.projectId, scenarioId: this.activeScenarioId, scenarioName: selectedScenario?.name ?? null } };
    }
    if (action.type === "open-session") {
      if (this.sessionLocked) return { ok: false, error: "当前运行尚未结束，不能切换历史对话" };
      const session = await this.deps.history?.get(action.sessionId);
      if (!session) return { ok: false, error: "历史对话不存在" };
      if (session.archived) return { ok: false, error: "对话已归档，请先恢复" };
      await this.persistenceQueue;
      await this.saveCurrentSession();
      this.sessionId = session.id;
      this.sessionTitle = session.title;
      this.activeMode = session.mode;
      this.activeScenarioId = session.activeScenarioId;
      await this.applySessionProject(session.projectId);
      await this.syncActiveScenarioScope(this.projectId);
      this.run = { kind: "idle", status: "idle" };
      this.clearChatHistory();
      this.deps.orchestrator = undefined;
      this.setChatHistory(session.messages);
      await this.restoreRunForSession(session.id);
      await this.pushSnapshot();
      return { ok: true };
    }
    if (action.type === "archive-session" || action.type === "restore-session") {
      if (this.sessionLocked) return { ok: false, error: "当前运行尚未结束，不能归档或恢复对话" };
      const session = await this.deps.history?.get(action.sessionId);
      if (!session) return { ok: false, error: "历史对话不存在" };
      if (action.type === "archive-session" && session.archived) return { ok: false, error: "对话已经归档" };
      if (action.type === "restore-session" && !session.archived) return { ok: false, error: "对话当前处于活动状态" };
      if (action.type === "archive-session" && await this.sessionHasActiveRun(action.sessionId)) return { ok: false, error: "该对话仍有运行，不能归档" };
      if (action.type === "archive-session" && action.sessionId === this.sessionId) {
        await this.persistenceQueue;
        await this.saveCurrentSession();
        await this.deps.history?.setArchived(action.sessionId, true);
        const replacement = this.deps.history ? await this.deps.history.create("work", "新对话", this.projectId) : { id: null, title: "新对话", activeScenarioId: null };
        this.sessionId = replacement.id;
        this.sessionTitle = replacement.title;
        this.activeMode = "work";
        this.activeScenarioId = null;
        this.deps.orchestrator = undefined;
        this.clearChatHistory();
        this.run = { kind: "idle", status: "idle" };
        await this.persistSession();
      } else if (action.type === "restore-session") {
        // Restoring a conversation from the collapsed archive is an explicit
        // navigation intent in the UI.  Merely flipping the archived flag
        // leaves the user looking at the old conversation, which feels like
        // a no-op and makes the restored row hard to find.  Restore and open
        // the conversation atomically so the rail and chat always agree.
        await this.persistenceQueue;
        await this.saveCurrentSession();
        const restored = await this.deps.history?.setArchived(action.sessionId, false);
        if (!restored) return { ok: false, error: "历史对话不存在" };
        this.sessionId = restored.id;
        this.sessionTitle = restored.title;
        this.activeMode = restored.mode;
        this.activeScenarioId = restored.activeScenarioId;
        await this.applySessionProject(restored.projectId);
        await this.syncActiveScenarioScope(this.projectId);
        this.deps.orchestrator = undefined;
        this.clearChatHistory();
        this.setChatHistory(restored.messages);
        await this.restoreRunForSession(restored.id);
      } else {
        await this.deps.history?.setArchived(action.sessionId, true);
      }
      await this.pushSnapshot();
      return { ok: true };
    }
    if (action.type === "delete-session") {
      if (this.sessionLocked) return { ok: false, error: "当前运行尚未结束，不能删除对话" };
      if (!this.deps.history) return { ok: false, error: "历史记录未接入" };
      const exists = await this.deps.history.get(action.sessionId);
      if (!exists) return { ok: false, error: "历史对话不存在" };
      if (await this.sessionHasActiveRun(action.sessionId)) return { ok: false, error: "该对话仍有运行，不能删除" };
      await this.persistenceQueue;
      if (action.sessionId === this.sessionId) await this.saveCurrentSession();
      await this.deps.history.delete(action.sessionId);
      if (action.sessionId === this.sessionId) {
        const replacement = await this.deps.history.create("work", "新对话", this.projectId);
        this.sessionId = replacement.id;
        this.sessionTitle = replacement.title;
        this.activeMode = "work";
        this.activeScenarioId = null;
        this.deps.orchestrator = undefined;
        this.clearChatHistory();
        this.run = { kind: "idle", status: "idle" };
        await this.persistSession();
      }
      await this.pushSnapshot();
      return { ok: true };
    }
    if (action.type === "rename-session") {
      if (!this.deps.history) return { ok: false, error: "历史记录未接入" };
      const session = await this.deps.history.get(action.sessionId);
      if (!session) return { ok: false, error: "历史对话不存在" };
      session.title = action.title.trim(); session.updatedAt = new Date().toISOString(); await this.deps.history.save(session);
      if (this.sessionId === session.id) this.sessionTitle = session.title;
      await this.pushSnapshot(); return { ok: true };
    }
    if (action.type === "update-settings") {
      if (this.sessionLocked) return { ok: false, error: "当前运行中不能修改设置" };
      if (!this.deps.settings) return { ok: false, error: "设置存储未接入" };
      if (action.settings.providerId) {
        const provider = await this.currentProvider(action.settings.providerId);
        if (!provider) return { ok: false, error: "Provider 不存在或不属于当前工作区" };
      }
      const settings = await this.deps.settings.update(action.settings);
      await this.deps.onSettingsChanged?.(settings);
      await this.pushSnapshot();
      return { ok: true };
    }
    if (action.type === "test-settings") {
      if (!this.deps.settings) return { ok: false, error: "设置存储未接入" };
      const current = await this.deps.settings.get();
      const candidate = { ...current, ...action.settings };
      try {
        const selectedProvider = candidate.providerId ? await this.currentProvider(candidate.providerId) : undefined;
        if (candidate.providerId && !selectedProvider) return { ok: false, error: "Provider 不存在或不属于当前工作区" };
        const providerSecret = selectedProvider && this.deps.secrets ? await this.deps.secrets.get("provider", selectedProvider.id) : undefined;
        const targetBaseUrl = selectedProvider?.baseUrl ?? candidate.baseUrl;
        const targetModel = selectedProvider?.model ?? candidate.model;
        const targetTimeout = selectedProvider?.timeoutMs ?? candidate.timeoutMs;
        const targetApiKey = providerSecret ?? candidate.apiKey;
        const response = await fetch(`${targetBaseUrl.replace(/\/$/, "")}/models`, {
          headers: targetApiKey ? { authorization: `Bearer ${targetApiKey}` } : {},
          signal: AbortSignal.timeout(Math.min(targetTimeout, 15_000)),
        });
        if (!response.ok) return { ok: false, error: `模型服务返回 HTTP ${response.status}` };
        // A proxy can return 200 for a health route while serving an HTML
        // error page or an empty body for the actual API. Consume and validate
        // the JSON envelope so “health OK” cannot be shown as usable model
        // configuration.
        let modelsBody: unknown;
        try { modelsBody = await response.json(); } catch { return { ok: false, error: "模型服务健康检查返回了无效 JSON" }; }
        if (!modelsBody || typeof modelsBody !== "object" || !Array.isArray((modelsBody as { data?: unknown }).data)) return { ok: false, error: "模型服务健康检查缺少 models 数据" };
        if (action.full) {
          const completion = await fetch(`${targetBaseUrl.replace(/\/$/, "")}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...(targetApiKey ? { authorization: `Bearer ${targetApiKey}` } : {}) }, body: JSON.stringify({ model: targetModel, temperature: 0, ...tokenBudgetForModel(targetModel, 1), messages: [{ role: "user", content: "Reply with OK" }] }), signal: AbortSignal.timeout(Math.min(targetTimeout, 15_000)) });
          if (!completion.ok) return { ok: false, error: `聊天验证返回 HTTP ${completion.status}` };
          const completionBody = await parseJsonResponse(completion, "聊天验证");
          if (!hasUsableCompletion(completionBody)) return { ok: false, error: "聊天验证没有返回有效模型内容" };
          const toolProbe = await fetch(`${targetBaseUrl.replace(/\/$/, "")}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...(targetApiKey ? { authorization: `Bearer ${targetApiKey}` } : {}) }, body: JSON.stringify({ model: targetModel, temperature: 0, ...tokenBudgetForModel(targetModel, 4), messages: [{ role: "user", content: "Use the available tool if supported; otherwise reply OK." }], tools: [{ type: "function", function: { name: "scenario_healthcheck", description: "Health check", parameters: { type: "object", properties: { ok: { "type": "boolean" } }, required: ["ok"] } } }] }), signal: AbortSignal.timeout(Math.min(targetTimeout, 15_000)) });
          if (!toolProbe.ok) return { ok: false, error: `工具调用验证返回 HTTP ${toolProbe.status}` };
          const toolProbeBody = await parseJsonResponse(toolProbe, "工具调用验证");
          if (!hasUsableCompletion(toolProbeBody, true)) return { ok: false, error: "工具调用验证没有返回有效模型内容" };
        }
        return { ok: true, data: { model: targetModel, baseUrl: targetBaseUrl } };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    if (action.type === "create-project") {
      if (this.sessionLocked) return { ok: false, error: "当前运行中不能切换项目" };
      if (!this.deps.repository || !this.workspace) return { ok: false, error: "工作区未准备好" };
      const project = await this.deps.repository.createProject(this.workspace.id, action.name.trim(), action.description?.trim() ?? "");
      this.projectId = project.id;
      this.projectProviderId = project.providerId;
      this.projectRootPath = project.rootPath ?? null;
      await this.syncActiveScenarioScope(this.projectId);
      await this.persistSession();
      await this.pushSnapshot();
      return { ok: true, data: { projectId: project.id } };
    }
    if (action.type === "choose-project-folder") {
      if (this.sessionLocked) return { ok: false, error: "当前运行中不能切换项目" };
      if (!this.deps.repository || !this.workspace) return { ok: false, error: "工作区未准备好" };
      const selectedRoot = await chooseNativeFolder();
      if (!selectedRoot) return { ok: false, error: "未选择文件夹，项目没有变化" };
      const name = path.basename(selectedRoot) || selectedRoot;
      const project = await this.deps.repository.createProject(this.workspace.id, name, `绑定本地文件夹：${selectedRoot}`, selectedRoot);
      const files = await scanBoundFolder(selectedRoot);
      for (const file of files) {
        try {
          const added = await this.deps.repository.addFile({ workspaceId: this.workspace.id, projectId: project.id, name: file.name, path: file.path, mediaType: file.mediaType, size: file.size });
          await this.deps.repository.setFileIndexed(added.id, true);
        } catch { /* one unreadable file must not discard the folder binding */ }
      }
      this.projectId = project.id;
      this.projectProviderId = project.providerId;
      this.projectRootPath = selectedRoot;
      await this.syncActiveScenarioScope(this.projectId);
      await this.persistSession();
      await this.pushSnapshot();
      return { ok: true, data: { projectId: project.id, rootPath: selectedRoot, fileCount: files.length } };
    }
    if (action.type === "select-project") {
      // The active project is part of the execution contract for a running
      // job.  Switching it while the launcher is still producing artifacts
      // would make the inspector point at one project while the run row is
      // bound to another, and late callbacks could write metadata to the
      // newly selected project.  Keep project navigation transactional with
      // the run just like session/mode navigation.
      if (this.sessionLocked) return { ok: false, error: "当前运行中不能切换项目" };
      if (!this.deps.repository || !this.workspace) return { ok: false, error: "工作区未准备好" };
      const project = await this.deps.repository.getProject(action.projectId);
      if (!project || project.workspaceId !== this.workspace.id || project.status !== "active") return { ok: false, error: "项目不存在或不可用" };
      this.projectId = project.id;
      this.projectProviderId = project.providerId;
      this.projectRootPath = project.rootPath ?? null;
      await this.syncActiveScenarioScope(this.projectId);
      await this.persistSession();
      await this.pushSnapshot();
      return { ok: true };
    }
    if (action.type === "update-project") {
      if (this.sessionLocked) return { ok: false, error: "当前运行中不能编辑项目" };
      if (!this.deps.repository || !this.workspace) return { ok: false, error: "工作区未准备好" };
      const project = await this.deps.repository.getProject(action.projectId);
      if (!project || project.workspaceId !== this.workspace.id || project.status === "deleted") return { ok: false, error: "项目不存在" };
      if (action.providerId) {
        const provider = await this.currentProvider(action.providerId);
        if (!provider) return { ok: false, error: "Provider 不存在或不属于当前工作区" };
      }
      await this.deps.repository.updateProject(action.projectId, { name: action.name ?? project.name, description: action.description ?? project.description, instructions: action.instructions ?? project.instructions, pinned: action.pinned ?? project.pinned, providerId: action.providerId === undefined ? project.providerId : action.providerId });
      if (this.projectId === project.id && action.providerId !== undefined) this.projectProviderId = action.providerId;
      await this.pushSnapshot();
      return { ok: true };
    }
    if (action.type === "pin-project") {
      if (this.sessionLocked || !this.deps.repository) return { ok: false, error: "当前运行中不能修改项目" };
      const project = await this.deps.repository.getProject(action.projectId);
      if (!project || !this.workspace || project.workspaceId !== this.workspace.id || project.status !== "active") return { ok: false, error: "项目不存在或不可用" };
      await this.deps.repository.updateProject(action.projectId, { pinned: action.pinned });
      await this.pushSnapshot(); return { ok: true };
    }
    if (action.type === "archive-project") {
      if (this.sessionLocked) return { ok: false, error: "当前运行中不能归档项目" };
      if (!this.deps.repository || !this.workspace) return { ok: false, error: "工作区未准备好" };
      const project = await this.deps.repository.getProject(action.projectId);
      if (!project || project.workspaceId !== this.workspace.id || project.status !== "active") return { ok: false, error: "项目不存在或不可用" };
      await this.deps.repository.archiveProject(action.projectId);
      if (this.projectId === action.projectId) {
        const projects = (await this.deps.repository.listProjects(this.workspace.id)).filter((item) => item.status === "active");
        const replacement = projects.find((item) => item.pinned) ?? projects[0];
        this.projectId = replacement?.id ?? null;
        this.projectProviderId = replacement?.providerId ?? null;
        this.projectRootPath = replacement?.rootPath ?? null;
        await this.syncActiveScenarioScope(this.projectId);
        await this.persistSession();
      }
      await this.pushSnapshot();
      return { ok: true };
    }
    if (action.type === "restore-project") {
      if (this.sessionLocked) return { ok: false, error: "当前运行中不能恢复项目" };
      if (!this.deps.repository || !this.workspace) return { ok: false, error: "工作区未准备好" };
      const project = await this.deps.repository.getProject(action.projectId);
      if (!project || project.workspaceId !== this.workspace.id || project.status !== "archived") return { ok: false, error: "项目不存在或不可恢复" };
      await this.deps.repository.restoreProject(action.projectId);
      await this.pushSnapshot();
      return { ok: true };
    }
    if (action.type === "delete-project") {
      if (this.sessionLocked) return { ok: false, error: "当前运行中不能删除项目" };
      if (!this.deps.repository || !this.workspace) return { ok: false, error: "工作区未准备好" };
      const project = await this.deps.repository.getProject(action.projectId);
      if (!project || project.workspaceId !== this.workspace.id || project.status === "deleted") return { ok: false, error: "项目不存在" };
      if (!(await this.deps.repository.deleteProject(action.projectId))) return { ok: false, error: "项目不存在" };
      if (this.projectId === action.projectId) {
        const projects = this.workspace ? (await this.deps.repository.listProjects(this.workspace.id)).filter((project) => project.status === "active") : [];
        const replacement = projects.find((project) => project.pinned) ?? projects[0];
        this.projectId = replacement?.id ?? null;
        this.projectProviderId = replacement?.providerId ?? null;
        this.projectRootPath = replacement?.rootPath ?? null;
        await this.syncActiveScenarioScope(this.projectId);
        await this.persistSession();
      }
      await this.pushSnapshot();
      return { ok: true };
    }
    if (action.type === "add-file") {
      if (!this.deps.repository || !this.workspace || !this.projectId) return { ok: false, error: "请先选择项目" };
      const project = await this.deps.repository.getProject(this.projectId);
      if (!project || project.workspaceId !== this.workspace.id || project.status !== "active") return { ok: false, error: "项目不存在或不可用" };
      const projectRoot = this.currentProjectRoot() ? path.resolve(this.currentProjectRoot()!) : "";
      const requested = path.resolve(action.path);
      const relative = projectRoot ? path.relative(projectRoot, requested) : "..";
      if (!projectRoot || relative.startsWith("..") || path.isAbsolute(relative)) return { ok: false, error: "文件路径超出当前项目工作区" };
      // A path that is lexically inside the project can still be a symlink to
      // another project (or an arbitrary host file).  Canonicalize both sides
      // before persisting the file record so later execution/export cannot
      // inherit an unsafe path.
      if (!(await this.canonicalPathWithin(projectRoot, requested))) return { ok: false, error: "文件路径不在当前项目工作区" };
      await this.deps.repository.addFile({ workspaceId: this.workspace.id, projectId: this.projectId, name: action.name, path: requested, mediaType: action.mediaType, size: action.size });
      await this.pushSnapshot();
      return { ok: true };
    }
    if (action.type === "upload-file") {
      if (!this.deps.repository || !this.workspace || !this.projectId || !this.currentProjectRoot()) return { ok: false, error: "请先选择项目" };
      const project = await this.deps.repository.getProject(this.projectId);
      if (!project || project.workspaceId !== this.workspace.id || project.status !== "active") return { ok: false, error: "项目不存在或不可用" };
      if (!isCanonicalBase64(action.contentBase64)) return { ok: false, error: "文件内容不是有效 Base64" };
      const requestedRelative = (action.relativePath ?? action.name).replace(/\\/g, "/").replace(/^\/+/, "");
      const requestedParts = requestedRelative.split("/").filter(Boolean);
      if (!requestedParts.length || requestedParts.some((part) => part === "." || part === "..")) return { ok: false, error: "文件相对路径无效" };
      const safeParts = requestedParts.map((part) => path.basename(part).replace(/[^\w.\-\u4e00-\u9fff ]/g, "_") || "uploaded-file");
      const baseName = safeParts.at(-1) ?? "uploaded-file";
      const relativeDir = safeParts.slice(0, -1);
      const existingNames = new Set((await this.deps.repository.listFiles(this.projectId)).map((file) => file.name));
      const extension = path.extname(baseName);
      const stem = extension ? baseName.slice(0, -extension.length) : baseName;
      let safeName = [...relativeDir, baseName].join("/");
      for (let suffix = 2; existingNames.has(safeName); suffix += 1) safeName = [...relativeDir, `${stem}（${suffix}）${extension}`].join("/");
      const projectDir = this.currentProjectRoot()!;
      const target = path.join(projectDir, safeName);
      const targetRelative = path.relative(projectDir, target);
      if (targetRelative.startsWith("..") || path.isAbsolute(targetRelative)) return { ok: false, error: "文件路径超出当前项目" };
      await mkdir(path.dirname(target), { recursive: true });
      const content = Buffer.from(action.contentBase64, "base64");
      if (content.length > 6 * 1024 * 1024) return { ok: false, error: "文件超过 6MB 限制" };
      try {
        await writeFile(target, content);
        await this.deps.repository.addFile({ workspaceId: this.workspace.id, projectId: this.projectId, name: safeName, path: target, mediaType: action.mediaType, size: content.length });
      } catch (error) {
        await (await import("node:fs/promises")).rm(target, { force: true }).catch(() => undefined);
        throw error;
      }
      await this.pushSnapshot();
      return { ok: true };
    }
    if (action.type === "delete-file") {
      if (this.sessionLocked) return { ok: false, error: "当前运行中不能删除文件" };
      if (!this.deps.repository || !this.workspace) return { ok: false, error: "工作区未准备好" };
      const file = await this.deps.repository.getFile(action.fileId);
      // A file is project-scoped.  Requiring an active project here prevents
      // an archived/no-project panel from deleting another project's record
      // through the old `(this.projectId && ...)` short-circuit.
      if (!file || file.workspaceId !== this.workspace.id || !this.projectId || file.projectId !== this.projectId) return { ok: false, error: "文件不存在" };
      const root = this.currentProjectRoot() ? path.resolve(this.currentProjectRoot()!) : "";
      const resolved = path.resolve(file.path);
      const relative = path.relative(root, resolved);
      if (!root || relative.startsWith("..") || path.isAbsolute(relative) || !(await this.canonicalPathWithin(root, resolved))) return { ok: false, error: "文件路径不在当前项目工作区" };
      await (await import("node:fs/promises")).rm(resolved, { force: true });
      await this.deps.repository.deleteFile(file.id);
      await this.recordAudit("delete", "file", file.id, `删除项目文件 ${file.name}`);
      await this.pushSnapshot();
      return { ok: true };
    }
    if (action.type === "index-file") {
      if (!this.deps.repository || !this.workspace) return { ok: false, error: "工作区未准备好" };
      const file = await this.deps.repository.getFile(action.fileId);
      if (!file || file.workspaceId !== this.workspace.id || file.projectId !== this.projectId) return { ok: false, error: "文件不存在" };
      await this.deps.repository.setFileIndexed(file.id, true);
      await this.recordAudit("index", "file", file.id, `索引项目文件 ${file.name}`);
      await this.pushSnapshot(); return { ok: true };
    }
    if (action.type === "create-connector") {
      if (!this.deps.connectors || !this.workspace) return { ok: false, error: "连接器中心未准备好" };
      if (action.kind === "mcp-remote" || action.kind === "http") {
        try { const endpoint = new URL(action.endpoint ?? ""); if (!["http:", "https:"].includes(endpoint.protocol)) return { ok: false, error: "远程连接器只支持 HTTP/HTTPS 地址" }; } catch { return { ok: false, error: "连接器地址无效" }; }
      }
      const connector = await this.deps.connectors.create({ workspaceId: this.workspace.id, name: action.name.trim(), kind: action.kind, endpoint: action.endpoint, permissionScopes: action.permissionScopes, hasSecret: Boolean(action.secret) || action.hasSecret, source: action.source, trustEvidence: action.trustEvidenceRef ? [{ kind: "manual", ref: action.trustEvidenceRef, summary: "用户提供的来源证据，尚未由服务端独立验证", verifiedAt: new Date().toISOString() }] : [] });
      if (action.secret && this.deps.secrets) await this.deps.secrets.set(this.workspace.id, "connector", connector.id, action.secret);
      await this.recordAudit("create", "connector", action.name.trim(), `添加连接器 ${action.name.trim()}`, { kind: action.kind, permissionScopes: action.permissionScopes, hasSecret: action.hasSecret });
      await this.pushSnapshot();
      return { ok: true };
    }
    if (action.type === "toggle-connector") {
      if (!this.deps.connectors) return { ok: false, error: "连接器中心未准备好" };
      const connector = await this.deps.connectors.get(action.connectorId);
      if (!connector || !this.workspace || connector.workspaceId !== this.workspace.id) return { ok: false, error: "连接器不存在" };
      await this.deps.connectors.setStatus(connector.id, action.enabled ? "enabled" : "disabled", null);
      await this.recordAudit(action.enabled ? "enable" : "disable", "connector", connector.id, `${action.enabled ? "启用" : "停用"}连接器 ${connector.name}`);
      await this.pushSnapshot();
      return { ok: true };
    }
    if (action.type === "delete-connector") {
      if (this.sessionLocked) return { ok: false, error: "当前运行中不能删除连接器" };
      if (!this.deps.connectors) return { ok: false, error: "连接器中心未准备好" };
      const connector = await this.deps.connectors.get(action.connectorId);
      if (!connector || !this.workspace || connector.workspaceId !== this.workspace.id) return { ok: false, error: "连接器不存在" };
      if (!(await this.deps.connectors.delete(action.connectorId))) return { ok: false, error: "连接器不存在" };
      await this.deps.secrets?.delete("connector", action.connectorId);
      await this.recordAudit("delete", "connector", action.connectorId, "删除连接器");
      await this.pushSnapshot();
      return { ok: true };
    }
    if (action.type === "test-connector") {
      if (!this.deps.connectors) return { ok: false, error: "连接器中心未准备好" };
      const connector = await this.deps.connectors.get(action.connectorId);
      if (!connector || !this.workspace || connector.workspaceId !== this.workspace.id) return { ok: false, error: "连接器不存在" };
      if (!connector.endpoint) return { ok: false, error: "连接器没有远程地址，需由宿主执行探活" };
      if (!connector.permissionScopes.includes("network")) {
        await this.recordAudit("healthcheck-denied", "connector", connector.id, `连接器探活被权限策略拒绝 ${connector.name}`, { required: "network" });
        return { ok: false, error: "连接器未授予 network 权限" };
      }
      if (this.workspace && this.deps.policy && !(await this.deps.policy.get(this.workspace.id)).network) {
        await this.recordAudit("healthcheck-denied", "connector", connector.id, `工作区策略拒绝连接器探活 ${connector.name}`, { required: "network" });
        return { ok: false, error: "工作区权限策略未允许 network" };
      }
      try {
        const isMcp = connector.kind === "mcp-remote";
        const secret = await this.deps.secrets?.get("connector", connector.id);
        const headers = { ...(secret ? { authorization: `Bearer ${secret}` } : {}), ...(isMcp ? { "content-type": "application/json", accept: "application/json" } : {}) };
        const response = await fetch(connector.endpoint, { method: isMcp ? "POST" : "GET", headers, ...(isMcp ? { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) } : {}), signal: AbortSignal.timeout(8_000) });
        if (!response.ok) { await this.deps.connectors.setStatus(connector.id, "error", `HTTP ${response.status}`); await this.deps.connectors.recordTrustEvidence(connector.id, { kind: "healthcheck", ref: connector.endpoint, summary: `探活返回 HTTP ${response.status}`, verifiedAt: new Date().toISOString() }, "warning", 0); return { ok: false, error: `连接器返回 HTTP ${response.status}` }; }
        await this.deps.connectors.setStatus(connector.id, "enabled", null);
        await this.deps.connectors.recordTrustEvidence(connector.id, { kind: "healthcheck", ref: connector.endpoint, summary: `探活成功（HTTP ${response.status}，不代表业务权限已验证）`, verifiedAt: new Date().toISOString() }, "verified", connector.endpoint.startsWith("https:") ? 0.7 : 0.5);
        await this.recordAudit("healthcheck", "connector", connector.id, `连接器探活成功 ${connector.name}`, { status: response.status });
        await this.pushSnapshot();
        return { ok: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.deps.connectors.setStatus(connector.id, "error", message);
        await this.deps.connectors.recordTrustEvidence(connector.id, { kind: "healthcheck", ref: connector.endpoint, summary: `探活失败：${message.slice(0, 420)}`, verifiedAt: new Date().toISOString() }, "warning", 0);
        await this.recordAudit("healthcheck-failed", "connector", connector.id, `连接器探活失败 ${connector.name}`, { error: message.slice(0, 200) });
        await this.pushSnapshot();
        return { ok: false, error: message };
      }
    }
    if (action.type === "create-artifact") {
      if (!this.deps.artifacts || !this.workspace) return { ok: false, error: "产物中心未准备好" };
      const requested = path.resolve(action.path);
      const allowedRoots = [
        this.currentProjectRoot() ? path.resolve(this.currentProjectRoot()!) : undefined,
        this.deps.artifactRoot ? path.resolve(this.deps.artifactRoot) : undefined,
      ].filter((value): value is string => Boolean(value));
      const allowed = allowedRoots.some((root) => {
        const relative = path.relative(root, requested);
        return !relative.startsWith("..") && !path.isAbsolute(relative);
      });
      if (!allowed) return { ok: false, error: "产物路径超出当前项目或产物工作区" };
      if (action.runId && this.deps.runs) {
        const run = await this.deps.runs.get(action.runId);
        if (!run || run.workspaceId !== this.workspace.id) return { ok: false, error: "产物运行记录不存在" };
      }
      await this.deps.artifacts.create({
        id: `artifact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        workspaceId: this.workspace.id,
        projectId: this.projectId,
        sessionId: this.sessionId,
        runId: action.runId ?? this.run.runId ?? null,
        name: action.name,
        mediaType: action.mediaType,
        path: requested,
        version: 1,
        status: "ready",
      });
      await this.pushSnapshot();
      return { ok: true };
    }
    if (action.type === "delete-artifact") {
      if (this.sessionLocked) return { ok: false, error: "当前运行中不能删除产物" };
      if (!this.deps.artifacts || !this.workspace) return { ok: false, error: "产物中心未准备好" };
      const artifact = await this.deps.artifacts.get(action.artifactId);
      if (!artifact || artifact.workspaceId !== this.workspace.id || artifact.status === "deleted") return { ok: false, error: "产物不存在" };
      if (!(await this.deps.artifacts.softDelete(action.artifactId))) return { ok: false, error: "产物不存在" };
      await this.pushSnapshot();
      return { ok: true };
    }
    if (action.type === "version-artifact") {
      if (!this.deps.artifacts || !this.workspace) return { ok: false, error: "产物中心未准备好" };
      const artifact = await this.deps.artifacts.get(action.artifactId);
      if (!artifact || artifact.workspaceId !== this.workspace.id || artifact.status === "deleted") return { ok: false, error: "产物不存在" };
      let content: string | undefined;
      try { if (artifact.mediaType.startsWith("text/") || /json|csv|markdown/.test(artifact.mediaType)) content = await readFile(artifact.path, "utf8"); } catch { content = undefined; }
      await this.deps.artifacts.createVersion(action.artifactId, content === undefined ? undefined : { content, checksum: createHash("sha256").update(content).digest("hex") });
      // §7 产出编辑点位：版本快照即"用户认可的历史版本"——与当前正文的差异是最强分寸信号
      if (content !== undefined && artifact.runId && this.deps.library) {
        const lastVersion = [...artifact.versions].sort((a, b) => b.version - a.version)[0]?.content;
        if (lastVersion !== undefined) {
          const blocks = computeOutputDiff(lastVersion, content);
          const proposals: RevisionProposal[] = blocksToProposals(blocks).map((p) => ({
            clause: p.clause,
            scope: p.scope,
            kind: p.kind,
            pattern: p.pattern,
            upgradePattern: p.kind_source === "added" && p.addedText && p.addedText.length <= 60 && !/\n/.test(p.addedText) ? p.addedText : undefined,
            origin: { type: "artifact-edit", text: `版本对比: ${p.clause}`, at: new Date().toISOString(), runId: artifact.runId },
          }));
          const scenarioId = this.runLedgerMeta.get(artifact.runId)?.scenarioId ?? null;
          if (scenarioId && proposals.length) {
            await this.deps.library
              .updateLedger(scenarioId, (ledger) => applyOutputCorrection(ledger, { runId: artifact.runId!, proposals, at: new Date().toISOString() }))
              .catch(() => undefined);
          }
        }
      }
      await this.pushSnapshot(); return { ok: true };
    }
    if (action.type === "create-provider") {
      if (!this.deps.providers || !this.workspace) return { ok: false, error: "Provider 中心未准备好" };
      const provider = await this.deps.providers.create({ id: `provider-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, workspaceId: this.workspace.id, name: action.name.trim(), kind: action.kind, baseUrl: action.baseUrl, model: action.model.trim(), enabled: true, hasSecret: Boolean(action.secret) || action.hasSecret, timeoutMs: action.timeoutMs ?? 45_000 });
      if (action.secret && this.deps.secrets) await this.deps.secrets.set(this.workspace.id, "provider", provider.id, action.secret);
      await this.pushSnapshot();
      return { ok: true };
    }
    if (action.type === "toggle-provider") {
      if (!this.deps.providers || !this.workspace) return { ok: false, error: "Provider 中心未准备好" };
      const provider = await this.deps.providers.get(action.providerId);
      if (!provider || provider.workspaceId !== this.workspace.id) return { ok: false, error: "Provider 不存在" };
      await this.deps.providers.update(action.providerId, { enabled: action.enabled });
      await this.pushSnapshot();
      return { ok: true };
    }
    if (action.type === "delete-provider") {
      if (this.sessionLocked) return { ok: false, error: "当前运行中不能删除 Provider" };
      if (!this.deps.providers || !this.workspace) return { ok: false, error: "Provider 中心未准备好" };
      const provider = await this.deps.providers.get(action.providerId);
      if (!provider || provider.workspaceId !== this.workspace.id) return { ok: false, error: "Provider 不存在" };
      if (!(await this.deps.providers.delete(action.providerId))) return { ok: false, error: "Provider 不存在" };
      await this.deps.secrets?.delete("provider", action.providerId);
      await this.pushSnapshot();
      return { ok: true };
    }
    if (action.type === "create-task") {
      if (!this.deps.tasks || !this.workspace) return { ok: false, error: "任务中心未准备好" };
      const taskProjectId = action.projectId ?? this.projectId;
      if (taskProjectId && this.deps.repository) {
        const project = await this.deps.repository.getProject(taskProjectId);
        if (!project || project.workspaceId !== this.workspace.id || project.status !== "active") return { ok: false, error: "任务项目不存在或不可用" };
      }
      if (action.scenarioId) {
        const scenario = this.deps.library ? await this.deps.library.get(action.scenarioId) : undefined;
        if (!scenario || !this.scenarioInScope(scenario, taskProjectId)) return { ok: false, error: "任务场景不存在" };
        if (scenario.status !== "active") return { ok: false, error: "任务场景已归档" };
      }
      await this.deps.tasks.create({ id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, workspaceId: this.workspace.id, projectId: taskProjectId, scenarioId: action.scenarioId ?? null, requirement: action.requirement.trim(), schedule: action.schedule.trim(), enabled: true, lastRunId: null, lastRunAt: null, runCount: 0, maxRuns: action.maxRuns ?? null, timeoutMs: action.timeoutMs ?? 120_000 });
      await this.pushSnapshot();
      return { ok: true };
    }
    if (action.type === "update-task") {
      if (!this.deps.tasks || !this.workspace) return { ok: false, error: "任务中心未准备好" };
      const task = await this.deps.tasks.get(action.taskId);
      if (!task || task.workspaceId !== this.workspace.id) return { ok: false, error: "任务不存在" };
      await this.deps.tasks.update(action.taskId, { requirement: action.requirement.trim(), schedule: action.schedule.trim() });
      await this.pushSnapshot(); return { ok: true };
    }
    if (action.type === "toggle-task") {
      if (!this.deps.tasks || !this.workspace) return { ok: false, error: "任务中心未准备好" };
      const task = await this.deps.tasks.get(action.taskId);
      if (!task || task.workspaceId !== this.workspace.id) return { ok: false, error: "任务不存在" };
      await this.deps.tasks.update(action.taskId, { enabled: action.enabled });
      await this.pushSnapshot();
      return { ok: true };
    }
    if (action.type === "delete-task") {
      if (this.sessionLocked) return { ok: false, error: "当前运行中不能删除任务" };
      if (!this.deps.tasks || !this.workspace) return { ok: false, error: "任务中心未准备好" };
      const task = await this.deps.tasks.get(action.taskId);
      if (!task || task.workspaceId !== this.workspace.id) return { ok: false, error: "任务不存在" };
      if (!(await this.deps.tasks.delete(action.taskId))) return { ok: false, error: "任务不存在" };
      await this.pushSnapshot();
      return { ok: true };
    }
    if (action.type === "run-task") {
      if (this.sessionLocked) return { ok: false, error: "当前运行尚未结束" };
      const task = this.deps.tasks ? await this.deps.tasks.get(action.taskId) : undefined;
      if (!task || !this.workspace || task.workspaceId !== this.workspace.id) return { ok: false, error: "任务不存在" };
      if (task.projectId && this.deps.repository) {
        const project = await this.deps.repository.getProject(task.projectId);
        if (!project || project.workspaceId !== this.workspace.id || project.status !== "active") return { ok: false, error: "任务项目不存在或不可用" };
      }
      if (task.scenarioId && this.deps.library) {
        const scenario = await this.deps.library.get(task.scenarioId);
        if (!scenario || !this.scenarioInScope(scenario, task.projectId)) return { ok: false, error: "任务场景不存在" };
        if (scenario.status !== "active") return { ok: false, error: "任务场景已归档" };
      }
      if (!this.deps.onStartBuild) return { ok: false, error: "面板未接入构建器" };
      this.pushChat({ role: "task-notification", tone: "info", text: `后台任务已触发：${task.requirement}`, ts: Date.now() });
      return await this.handleAction({ type: "start-build", requirement: task.requirement, mode: "work", scenarioId: task.scenarioId ?? undefined, projectId: task.projectId ?? undefined, source: "task" });
    }
    if (action.type === "create-long-run") {
      const previousCreation = this.longRunCreationQueue;
      let releaseCreation!: () => void;
      const creationGate = new Promise<void>((resolve) => { releaseCreation = resolve; });
      this.longRunCreationQueue = previousCreation.then(() => creationGate);
      await previousCreation;
      try {
        if (this.sessionLocked) return { ok: false, error: "当前运行尚未结束" };
      if (!this.deps.longRuns || !this.workspace || !this.sessionId) return { ok: false, error: "长程运行中心未准备好" };
      const longRuns = this.deps.longRuns;
      if (!this.deps.library) return { ok: false, error: "场景库未接入" };
      const scenario = await this.deps.library.get(action.scenarioId);
      const projectId = action.projectId ?? this.projectId;
      if (!scenario || !this.scenarioInScope(scenario, projectId) || scenario.status !== "active") return { ok: false, error: "所选场景不存在或已归档" };
      if (projectId && this.deps.repository) {
        const project = await this.deps.repository.getProject(projectId);
        if (!project || project.workspaceId !== this.workspace.id || project.status !== "active") return { ok: false, error: "长程运行项目不存在" };
      }
      const existing = await this.deps.longRuns.activeForSession(this.workspace.id, this.sessionId);
      if (existing) return { ok: false, error: "当前对话已有长程运行，请先完成或停止它" };
      // A long-run may be launched from the new-session dialog with an
      // explicit project different from the session's current selection. Keep
      // the conversation context in lockstep with the durable run binding so
      // the inspector, subsequent work, and history all read the same files,
      // Memory, provider and policy scope. Do this only after the duplicate
      // active-run guard so a rejected retry has no selection side effect.
      await this.applySessionProject(projectId);
      const run = await this.deps.longRuns.create({
        id: `long-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        workspaceId: this.workspace.id,
        projectId: projectId ?? null,
        sessionId: this.sessionId,
        scenarioId: scenario.id,
        goal: action.requirement.trim(),
        slots: action.slots ?? {},
        maxRounds: action.maxRounds,
        nextRound: 1,
        completedRounds: 0,
        status: "queued",
        terminalReason: null,
        nextInstruction: null,
        pendingRound: null,
        pendingResult: null,
        lastRound: null,
        lastSummary: null,
        lastMetrics: {},
        lastError: null,
        pauseRequested: false,
        startedAt: null,
        finishedAt: null,
      });
      this.sessionLocked = true;
      this.activeMode = "work";
      this.activeScenarioId = scenario.id;
      this.run = { kind: "work", status: "running", runId: run.id, scenarioId: scenario.id, text: `长程场景：${scenario.name}` };
      // §9 无人值守规则：长程运行按触发源打标——沉默绝不推连胜
      this.runLedgerMeta.set(run.id, { scenarioId: scenario.id, digest: inputDigest(run.goal, run.slots ?? {}), attended: false, mode: "work" });
      // Long-run creation bypasses the ordinary start-build path, so echo
      // the user's requirement explicitly. Without this message the chat
      // stream starts with AI progress, the session remains titled “新对话",
      // and history loses the user's actual goal.
      this.pushChat({ role: "user", content: action.requirement.trim(), timestamp: Date.now() });
      this.pushChat({ role: "build-status", tone: "info", text: `长程场景已启动：${scenario.name}，最多 ${action.maxRounds} 轮。`, runId: run.id, ts: Date.now() });
      await this.pushSnapshot();
      if (!this.deps.onStartLongRun) {
        const failed = await longRuns.update(run.id, { status: "failed", lastError: "面板未接入长程执行器", finishedAt: new Date().toISOString() }, run.revision);
        this.setLongRunState(failed);
        this.pushChat({ role: "build-status", tone: "err", runStatus: "failed", text: failed.lastError ?? "长程执行器未接入。", runId: failed.id, sessionId: failed.sessionId ?? undefined, terminal: true, ts: Date.now() });
        return { ok: false, error: "面板未接入长程执行器" };
      }
      void this.deps.onStartLongRun(run).then(async (result) => {
        if (!result.ok) {
          const current = await longRuns.get(run.id);
          if (current && ["queued", "running"].includes(current.status) && !current.pauseRequested) {
            const failed = await longRuns.update(run.id, { status: "failed", lastError: (result.error ?? "长程执行器启动失败").slice(0, 2_000), finishedAt: new Date().toISOString() }, current.revision);
            this.setLongRunState(failed);
            this.pushChat({ role: "build-status", tone: "err", runStatus: "failed", text: failed.lastError ?? "长程执行器启动失败。", runId: failed.id, sessionId: failed.sessionId ?? undefined, terminal: true, ts: Date.now() });
          }
        }
      }).catch(async (error: unknown) => {
        try {
          const current = await longRuns.get(run.id);
          if (current && ["queued", "running"].includes(current.status) && !current.pauseRequested) {
            const failed = await longRuns.update(run.id, { status: "failed", lastError: (error instanceof Error ? error.message : String(error)).slice(0, 2_000), finishedAt: new Date().toISOString() }, current.revision);
            this.setLongRunState(failed);
            this.pushChat({ role: "build-status", tone: "err", runStatus: "failed", text: failed.lastError ?? "长程执行器启动失败。", runId: failed.id, sessionId: failed.sessionId ?? undefined, terminal: true, ts: Date.now() });
          }
        } catch (secondary: unknown) {
          // R1 审计#1：善后自身失败（磁盘满/revision 冲突）不得再抛无处理 rejection
          this.pushChat({ role: "build-status", tone: "err", text: `长程运行善后出错：${secondary instanceof Error ? secondary.message : String(secondary)}`, terminal: true, ts: Date.now() });
        }
      });
        return { ok: true, data: { longRunId: run.id, scenarioId: scenario.id } };
      } finally {
        releaseCreation();
      }
    }
    if (action.type === "control-long-run") {
      if (!this.deps.longRuns || !this.workspace) return { ok: false, error: "长程运行中心未准备好" };
      const run = await this.deps.longRuns.get(action.longRunId);
      if (!run || run.workspaceId !== this.workspace.id) return { ok: false, error: "长程运行不存在" };
      if (run.sessionId !== this.sessionId) return { ok: false, error: "长程运行不属于当前对话" };
      if (!this.deps.onControlLongRun) return { ok: false, error: "面板未接入长程控制器" };
      const result = await this.deps.onControlLongRun(run, action.action);
      if (!result.ok) return result;
      const updated = await this.deps.longRuns.get(run.id);
      if (updated) this.setLongRunState(updated);
      return { ok: true };
    }
    if (action.type === "trigger-event") {
      const tasks = this.workspace && this.deps.tasks ? await this.deps.tasks.list(this.workspace.id) : [];
      const matches = tasks.filter((task) => task.enabled && task.schedule.trim().toLowerCase() === `event:${action.name.trim().toLowerCase()}`);
      if (!matches.length) return { ok: false, error: "没有匹配的事件任务" };
      // One PanelServer owns one interactive run lock and one inspector.
      // Starting several matching tasks in parallel would partially trigger
      // the event: the first task wins while the others fail. Reject the
      // ambiguous fan-out before any side effect.
      if (matches.length > 1) return { ok: false, error: "同一事件匹配多个任务；当前面板一次只允许触发一个任务" };
      return await this.handleAction({ type: "run-task", taskId: matches[0]!.id });
    }
    if (action.type === "retry-run") {
      if (this.sessionLocked) return { ok: false, error: "当前运行尚未结束" };
      const previous = this.deps.runs ? await this.deps.runs.get(action.runId) : undefined;
      if (!previous || !this.workspace || previous.workspaceId !== this.workspace.id) return { ok: false, error: "运行记录不存在" };
      if (["queued", "running", "waiting-approval", "paused"].includes(previous.status)) return { ok: false, error: "该运行尚未结束，不能重试" };
      if (previous.sessionId !== this.sessionId) return { ok: false, error: "运行不属于当前对话，不能重试" };
      return await this.handleAction({ type: "start-build", requirement: previous.requirement, mode: previous.mode, scenarioId: previous.scenarioId ?? undefined, projectId: previous.projectId ?? undefined, retryCount: previous.retryCount + 1 });
    }
    if (action.type === "branch-run") {
      if (this.sessionLocked) return { ok: false, error: "当前运行尚未结束" };
      const previous = this.deps.runs ? await this.deps.runs.get(action.runId) : undefined;
      if (!previous || !this.workspace || previous.workspaceId !== this.workspace.id) return { ok: false, error: "运行记录不存在" };
      if (["queued", "running", "waiting-approval", "paused"].includes(previous.status)) return { ok: false, error: "该运行尚未结束，不能创建分支" };
      if (previous.sessionId !== this.sessionId) return { ok: false, error: "运行不属于当前对话，不能创建分支" };
      return await this.handleAction({ type: "start-build", requirement: previous.requirement, mode: previous.mode, scenarioId: previous.scenarioId ?? undefined, projectId: previous.projectId ?? undefined, retryCount: 0 });
    }
    if (action.type === "step-action") {
      if (!this.deps.onStepAction) return { ok: false, error: "步骤操作未接入" };
      // §7 其余编辑点位：指令措辞变 = 缓存更新（onStepAction 内）；
      // 同一步骤第二次人工改写 → 升级 capability 偏好提案（教学→分寸的升级线）
      if (action.action === "edit") {
        const editKey = `${action.runId}:${action.stepId}`;
        const count = (this.stepEditCounts.get(editKey) ?? 0) + 1;
        this.stepEditCounts.set(editKey, count);
        if (count >= 2 && action.updatedInstruction && this.deps.library) {
          const scenarioId = this.runLedgerMeta.get(action.runId)?.scenarioId ?? this.run.scenarioId ?? null;
          if (scenarioId) {
            const clause = stripNegationPrefix(action.updatedInstruction.trim().split(/\r?\n/)[0]!.slice(0, 120));
            await this.deps.library
              .updateLedger(scenarioId, (ledger) => {
                const merged = mergeConstraintGuarded(ledger, { clause: `步骤「${action.stepId}」应按此方式执行：${clause}`, scope: "capability", origin: { type: "gate-edit", text: action.updatedInstruction!.slice(0, 300), at: new Date().toISOString(), runId: action.runId } });
                return merged.ledger;
              })
              .catch(() => undefined);
          }
        }
      }
      return await this.deps.onStepAction(action);
    }
    if (action.type === "create-memory") {
      if (!this.deps.memoryRoot) return { ok: false, error: "Memory 未接入" };
      // A scoped memory without its owning context is effectively global in
      // the runtime resolver (projectId === null is treated as reusable by
      // every project).  Reject that shape at the write boundary instead of
      // creating an item that silently leaks into unrelated runs.
      if (action.scope === "project") {
        if (!this.projectId || !this.workspace || !this.deps.repository) return { ok: false, error: "请先选择项目" };
        const project = await this.deps.repository.getProject(this.projectId);
        if (!project || project.workspaceId !== this.workspace.id || project.status !== "active") return { ok: false, error: "项目不存在或不可用" };
      }
      if (action.scope === "scenario") {
        if (!this.activeScenarioId || !this.deps.library) return { ok: false, error: "请先选择场景" };
        const scenario = await this.deps.library.get(this.activeScenarioId);
        if (!scenario || scenario.status !== "active") return { ok: false, error: "场景不存在或不可用" };
      }
      const folder = action.scope === "session" ? "sessions" : action.scope === "scenario" ? "scenarios" : "knowledge";
      const safeName = path.basename(action.name).replace(/[^\w.\-\u4e00-\u9fff ]/g, "_").replace(/\.md$/i, "") + ".md";
      // R1 审计#13：同名写入会静默覆盖旧文件并留下两条指向同一路径的
      // Memory 记录；按内容哈希短缀命名，确保唯一
      const contentHash = createHash("sha256").update(action.content).digest("hex").slice(0, 8);
      const target = path.join(this.deps.memoryRoot, folder, `${action.scope}-${safeName.replace(/\.md$/, `-${contentHash}.md`)}`);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, action.content, "utf8");
      if (this.deps.memories && this.workspace) {
        await this.deps.memories.create({
          id: `memory-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          workspaceId: this.workspace.id,
          projectId: action.scope === "project" ? this.projectId : null,
          sessionId: action.scope === "session" ? this.sessionId : null,
          scenarioId: action.scope === "scenario" ? this.activeScenarioId : null,
          scope: action.scope,
          name: action.name,
          content: action.content,
          path: target,
          sourceType: "user",
          sourceId: null,
          enabled: true,
        });
      }
      await this.pushSnapshot();
      return { ok: true };
    }
    if (action.type === "update-memory" || action.type === "delete-memory") {
      if (!this.deps.memoryRoot) return { ok: false, error: "Memory 未接入" };
      let ownedMemoryId: string | undefined;
      if (this.deps.memories && this.workspace) {
        const owned = await this.visibleMemories();
        const ownedItem = owned.find((item) => item.path && path.resolve(item.path) === path.resolve(action.path));
        if (!ownedItem) return { ok: false, error: "Memory 不存在" };
        ownedMemoryId = ownedItem.id;
      }
      if (action.memoryId && this.deps.memories && this.workspace) {
        const item = await this.deps.memories.get(action.memoryId);
        if (!item || !(await this.visibleMemories()).some((visible) => visible.id === item.id)) return { ok: false, error: "Memory 不存在" };
        // Metadata is authoritative for ID-addressed edits. Do not let a
        // caller pair a valid local path with another workspace's record.
        if (item.path && path.resolve(item.path) !== path.resolve(action.path)) return { ok: false, error: "Memory 路径与记录不匹配" };
      }
      const target = await this.safeMemoryFile(action.path);
      if (!target) return { ok: false, error: "Memory 文件路径无效" };
      if (action.type === "update-memory") {
        await writeFile(target, action.content, "utf8");
        if (this.deps.memories && (action.memoryId ?? ownedMemoryId)) await this.deps.memories.update(action.memoryId ?? ownedMemoryId!, { content: action.content });
      } else {
        await (await import("node:fs/promises")).rm(target, { force: true });
        if (this.deps.memories && (action.memoryId ?? ownedMemoryId)) await this.deps.memories.delete(action.memoryId ?? ownedMemoryId!);
      }
      await this.pushSnapshot();
      return { ok: true };
    }
    if (action.type === "delete-memories") {
      if (!this.deps.memories || !this.workspace) return { ok: false, error: "Memory 元数据未接入" };
      const items = await Promise.all(action.memoryIds.map((id) => this.deps.memories!.get(id)));
      const visibleIds = new Set((await this.visibleMemories()).map((item) => item.id));
      if (items.some((item) => !item || !visibleIds.has(item.id))) return { ok: false, error: "Memory 不存在" };
      for (const item of items) { if (item?.path) { const target = await this.safeMemoryFile(item.path); if (target) await (await import("node:fs/promises")).rm(target, { force: true }); } if (item) await this.deps.memories.delete(item.id); }
      await this.pushSnapshot(); return { ok: true };
    }
    if (action.type === "toggle-memory") {
      if (!this.deps.memories || !this.workspace) return { ok: false, error: "Memory 元数据未接入" };
      const item = await this.deps.memories.get(action.memoryId);
      if (!item || !(await this.visibleMemories()).some((visible) => visible.id === item.id)) return { ok: false, error: "Memory 不存在" };
      await this.deps.memories.update(action.memoryId, { enabled: action.enabled });
      await this.recordAudit(action.enabled ? "enable" : "disable", "memory", action.memoryId, `${action.enabled ? "启用" : "停用"} Memory`);
      await this.pushSnapshot();
      return { ok: true };
    }
    if (action.type === "save-memory-proposal") {
      const result = await this.handleAction({ type: "create-memory", scope: "session", name: action.name, content: action.content });
      if (result.ok) this.pushChat({ role: "build-status", tone: "ok", text: `Memory 已保存：${action.name}`, ts: Date.now() });
      return result;
    }
    if (action.type === "create-context") {
      if (!this.deps.contexts || !this.workspace) return { ok: false, error: "桌面上下文未接入" };
      if (action.kind === "local-file" && !this.currentProjectRoot()) return { ok: false, error: "请先选择项目" };
      const contextValidation = validateDesktopContext(action, { allowedRoot: this.currentProjectRoot(), allowBrowser: true });
      if (!contextValidation.ok) return contextValidation;
      if (action.kind === "local-file" && this.currentProjectRoot()) { const root = path.resolve(this.currentProjectRoot()!); const candidate = path.resolve(action.origin); const relative = path.relative(root, candidate); if (relative.startsWith("..") || path.isAbsolute(relative)) return { ok: false, error: "本地文件不在当前项目安全范围内" }; }
      if (action.kind === "browser") { try { const url = new URL(action.origin); if (!["http:", "https:"].includes(url.protocol)) return { ok: false, error: "浏览器上下文只接受 HTTP/HTTPS 地址" }; } catch { return { ok: false, error: "浏览器来源地址无效" }; } }
      const context = await this.deps.contexts.create({ id: `context-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, workspaceId: this.workspace.id, projectId: this.projectId, kind: action.kind, origin: action.origin, label: action.label, content: action.content, enabled: true });
      await this.recordAudit("create", "desktop-context", context.id, `导入桌面上下文 ${context.label}`, { kind: context.kind, origin: context.origin });
      await this.pushSnapshot(); return { ok: true };
    }
    if (action.type === "toggle-context") {
      if (!this.deps.contexts || !this.workspace) return { ok: false, error: "桌面上下文未接入" };
      const context = await this.deps.contexts.get(action.contextId);
      if (!context || context.workspaceId !== this.workspace.id) return { ok: false, error: "上下文不存在" };
      await this.deps.contexts.update(action.contextId, { enabled: action.enabled });
      await this.pushSnapshot(); return { ok: true };
    }
    if (action.type === "delete-context") {
      if (this.sessionLocked) return { ok: false, error: "当前运行中不能删除上下文" };
      if (!this.deps.contexts || !this.workspace) return { ok: false, error: "桌面上下文未接入" };
      const context = await this.deps.contexts.get(action.contextId);
      if (!context || context.workspaceId !== this.workspace.id) return { ok: false, error: "上下文不存在" };
      if (!(await this.deps.contexts.delete(action.contextId))) return { ok: false, error: "上下文不存在" };
      await this.pushSnapshot(); return { ok: true };
    }
    if (action.type === "update-policy") {
      if (!this.deps.policy || !this.workspace) return { ok: false, error: "权限策略未接入" };
      await this.deps.policy.update(this.workspace.id, action.patch);
      await this.recordAudit("policy-update", "permission-policy", this.workspace.id, "更新工作区权限策略", action.patch);
      await this.pushSnapshot(); return { ok: true };
    }
    if (action.type === "create-share") {
      if (!this.deps.shares || !this.workspace) return { ok: false, error: "分享中心未接入" };
      if (action.resourceType === "workspace" && action.resourceId !== this.workspace.id) return { ok: false, error: "工作区不存在" };
      if (action.resourceType === "project" && this.deps.repository) {
        const project = await this.deps.repository.getProject(action.resourceId);
        if (!project || project.workspaceId !== this.workspace.id || project.status === "deleted") return { ok: false, error: "项目不存在" };
      }
      if (action.resourceType === "scenario" && this.deps.library) {
        const scenario = await this.deps.library.get(action.resourceId);
        if (!scenario || !this.scenarioInScope(scenario) || scenario.status === "deleted") return { ok: false, error: "场景不存在" };
      }
      if (action.resourceType === "artifact" && this.deps.artifacts) {
        const artifact = await this.deps.artifacts.get(action.resourceId);
        if (!artifact || artifact.workspaceId !== this.workspace.id || artifact.status === "deleted") return { ok: false, error: "产物不存在或不属于当前工作区" };
      }
      // R1 审计#15：token 只存哈希，原值仅在创建时通过一次性 action-result 返回
      const { token: shareToken } = await this.deps.shares.create({ id: `share-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, workspaceId: this.workspace.id, resourceType: action.resourceType, resourceId: action.resourceId, role: action.role, expiresAt: null });
      await this.pushSnapshot(); return { ok: true, data: { token: shareToken, role: "granted" } };
    }
    if (action.type === "delete-share") {
      if (!this.deps.shares || !this.workspace) return { ok: false, error: "分享中心未接入" };
      const share = (await this.deps.shares.list(this.workspace.id)).find((item) => item.id === action.shareId);
      if (!share || !(await this.deps.shares.delete(action.shareId))) return { ok: false, error: "分享不存在" };
      await this.pushSnapshot(); return { ok: true };
    }
    if (action.type === "import-workspace") {
      if (this.sessionLocked || !this.workspace) return { ok: false, error: "当前运行中不能导入工作区" };
      let bundle: unknown; try { bundle = JSON.parse(action.content); } catch { return { ok: false, error: "工作区文件不是有效 JSON" }; }
      if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) return { ok: false, error: "工作区文件格式无效" };
      const data = bundle as { workspace?: unknown; projects?: Array<{ id?: string; name?: string; description?: string; instructions?: string; pinned?: boolean }>; files?: Array<{ projectId?: string; name?: string; mediaType?: string; contentBase64?: string | null }>; scenarios?: unknown[]; memories?: unknown[]; contexts?: unknown[]; connectors?: unknown[]; providers?: unknown[]; tasks?: unknown[]; artifacts?: unknown[] };
      if (!Array.isArray(data.projects) && !Array.isArray(data.scenarios)) return { ok: false, error: "工作区文件缺少 projects/scenarios" };
      const conflicts: string[] = [];
      const importWarnings: string[] = [];
      if (Object.prototype.hasOwnProperty.call(data, "workspace") && data.workspace) importWarnings.push("工作区元信息未导入");
      if (data.projects !== undefined && !Array.isArray(data.projects)) importWarnings.push("项目格式无效，未导入");
      if (data.scenarios !== undefined && !Array.isArray(data.scenarios)) importWarnings.push("场景格式无效，未导入");
      for (const [label, items] of [["Memory", data.memories], ["桌面上下文", data.contexts], ["连接器", data.connectors], ["Provider（密钥不会随导出保存）", data.providers], ["后台任务", data.tasks], ["产物文件", data.artifacts]] as const) {
        if (items !== undefined && !Array.isArray(items)) importWarnings.push(`${label} 格式无效，未导入`);
        else if (Array.isArray(items) && items.length > 0) importWarnings.push(`${label} ${items.length} 条未导入`);
      }
      if (data.files !== undefined && !Array.isArray(data.files)) importWarnings.push("项目文件格式无效，未导入");
      if (Array.isArray(data.projects) && data.projects.length > 100) importWarnings.push(`项目超过 100 条，超出部分未导入（${data.projects.length - 100} 条）`);
      if (Array.isArray(data.files) && data.files.length > 200) importWarnings.push(`项目文件超过 200 条，超出部分未导入（${data.files.length - 200} 条）`);
      if (Array.isArray(data.scenarios) && data.scenarios.length > 100) importWarnings.push(`场景超过 100 条，超出部分未导入（${data.scenarios.length - 100} 条）`);
      if (Array.isArray(data.projects) && !this.deps.repository) importWarnings.push(`项目 ${data.projects.length} 条未导入（项目存储未接入）`);
      if (Array.isArray(data.files) && (!this.deps.repository || !this.deps.projectRoot)) importWarnings.push(`项目文件 ${data.files.length} 条未导入（文件存储未接入）`);
      if (Array.isArray(data.scenarios) && !this.deps.library) importWarnings.push(`场景 ${data.scenarios.length} 条未导入（场景库未接入）`);
      const importedProjects = new Map<string, string>();
      let invalidProjects = 0;
      let failedProjects = 0;
      if (this.deps.repository && Array.isArray(data.projects)) {
        const existing = await this.deps.repository.listProjects(this.workspace.id);
        for (const project of data.projects.slice(0, 100)) {
          if (typeof project.name !== "string" || !project.name.trim()) { invalidProjects++; continue; }
          try {
            const conflict = existing.some((item) => item.name === project.name);
            if (conflict) conflicts.push(`项目：${project.name}`);
            const created = await this.deps.repository.createProject(this.workspace.id, conflict ? `${project.name}（导入冲突）` : `${project.name}（导入）`, typeof project.description === "string" ? project.description : "");
            importedProjects.set(project.id ?? project.name, created.id);
            await this.deps.repository.updateProject(created.id, { instructions: typeof project.instructions === "string" ? project.instructions : "", pinned: Boolean(project.pinned) });
          } catch { failedProjects++; }
        }
      }
      if (invalidProjects > 0) importWarnings.push(`项目 ${invalidProjects} 条格式无效，未导入`);
      if (failedProjects > 0) importWarnings.push(`项目 ${failedProjects} 条写入失败，未导入`);
       if (this.deps.repository && this.deps.projectRoot && Array.isArray(data.files)) {
         const importedNames = new Map<string, Set<string>>();
         let invalidFiles = 0;
         for (const file of data.files.slice(0, 200)) {
           const projectId = file.projectId ? importedProjects.get(file.projectId) : undefined;
           if (!projectId || typeof file.name !== "string" || !file.name.trim() || typeof file.contentBase64 !== "string" || !isCanonicalBase64(file.contentBase64)) { invalidFiles++; continue; }
           try {
             const baseName = path.basename(file.name).replace(/[^\w.\-\u4e00-\u9fff ]/g, "_") || "imported-file";
             const names = importedNames.get(projectId) ?? new Set<string>();
             let safeName = baseName;
             const extension = path.extname(baseName);
             const stem = extension ? baseName.slice(0, -extension.length) : baseName;
             let suffix = 2;
             while (names.has(safeName)) safeName = `${stem}（${suffix++}）${extension}`;
             names.add(safeName); importedNames.set(projectId, names);
             const content = Buffer.from(file.contentBase64, "base64");
             if (content.length > 6 * 1024 * 1024) { conflicts.push(`文件：${safeName}（超过大小限制）`); continue; }
             const target = path.join(this.deps.projectRoot, projectId, safeName);
             await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content);
             try {
               await this.deps.repository.addFile({ workspaceId: this.workspace.id, projectId, name: safeName, path: target, mediaType: file.mediaType ?? "application/octet-stream", size: content.length });
             } catch (error) {
               await rm(target, { force: true }).catch(() => undefined);
               throw error;
             }
           } catch { conflicts.push(`文件：${file.name}（导入失败）`); }
         }
         if (invalidFiles > 0) importWarnings.push(`项目文件 ${invalidFiles} 条格式无效或找不到所属项目，未导入`);
       }
       let invalidScenarios = 0;
       let failedScenarios = 0;
       if (this.deps.library && Array.isArray(data.scenarios)) { const existing = await this.deps.library.list(); for (const scenario of data.scenarios.slice(0, 100)) { const parsed = ScenarioRecordSchema.safeParse(scenario); if (!parsed.success) { invalidScenarios++; continue; } try { const conflict = existing.some((item) => item.id === parsed.data.id || item.name === parsed.data.name); if (conflict) conflicts.push(`场景：${parsed.data.name}`); await this.deps.library.save({ ...parsed.data, workspaceId: this.workspace.id, projectId: parsed.data.projectId ? (importedProjects.get(parsed.data.projectId) ?? null) : null, id: `${parsed.data.id}-import-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }); } catch { failedScenarios++; } } }
       if (invalidScenarios > 0) importWarnings.push(`场景 ${invalidScenarios} 条格式无效，未导入`);
       if (failedScenarios > 0) importWarnings.push(`场景 ${failedScenarios} 条写入失败，未导入`);
       const warningText = importWarnings.length ? `；导入提示：${importWarnings.join("、")}。` : "";
      this.pushChat({ role: "build-status", tone: conflicts.length || importWarnings.length ? "info" : "ok", text: conflicts.length ? `工作区导入完成，已保留本地数据并生成冲突副本：${conflicts.join("、")}${warningText}` : `工作区导入完成${warningText}`, ts: Date.now() });
      await this.recordAudit("import", "workspace", this.workspace.id, "导入工作区包"); await this.pushSnapshot(); return { ok: true };
    }
    if (action.type === "create-comment") {
      if (!this.deps.comments || !this.workspace) return { ok: false, error: "评论中心未接入" };
      if (action.resourceType === "project" && this.deps.repository) {
        const project = await this.deps.repository.getProject(action.resourceId);
        if (!project || project.workspaceId !== this.workspace.id || project.status === "deleted") return { ok: false, error: "评论资源不存在" };
      }
      if (action.resourceType === "scenario" && this.deps.library) {
        const scenario = await this.deps.library.get(action.resourceId);
        if (!scenario || !this.scenarioInScope(scenario) || scenario.status === "deleted") return { ok: false, error: "评论资源不存在" };
      }
      if (action.resourceType === "artifact" && this.deps.artifacts) {
        const artifact = await this.deps.artifacts.get(action.resourceId);
        if (!artifact || artifact.workspaceId !== this.workspace.id || artifact.status === "deleted") return { ok: false, error: "评论资源不存在" };
      }
      if (action.resourceType === "run" && this.deps.runs) {
        const run = await this.deps.runs.get(action.resourceId);
        if (!run || run.workspaceId !== this.workspace.id) return { ok: false, error: "评论资源不存在" };
      }
      await this.deps.comments.create({ id: `comment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, workspaceId: this.workspace.id, resourceType: action.resourceType, resourceId: action.resourceId, author: "local-user", body: action.body, resolved: false });
      await this.pushSnapshot(); return { ok: true };
    }
    if (action.type === "resolve-comment") {
      if (!this.deps.comments || !this.workspace) return { ok: false, error: "评论中心未接入" };
      const comments = await this.deps.comments.list(this.workspace.id);
      if (!comments.some((comment) => comment.id === action.commentId)) return { ok: false, error: "评论不存在" };
      await this.deps.comments.resolve(action.commentId, action.resolved);
      await this.pushSnapshot(); return { ok: true };
    }
    if (action.type === "create-identity") {
      if (!this.deps.identities || !this.workspace) return { ok: false, error: "身份中心未接入" };
      const created = await this.deps.identities.create({ id: `identity-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, workspaceId: this.workspace.id, displayName: action.displayName, role: action.role });
      await this.recordAudit("create", "identity", created.identity.id, `创建本地身份 ${created.identity.displayName}`, { role: created.identity.role });
      await this.pushSnapshot(); return { ok: true, data: { identityId: created.identity.id, token: created.token, role: created.identity.role } };
    }
    if (action.type === "update-identity") {
      if (!this.deps.identities || !this.workspace) return { ok: false, error: "身份中心未接入" };
      const identity = (await this.deps.identities.list(this.workspace.id)).find((item) => item.id === action.identityId);
      if (!identity) return { ok: false, error: "身份不存在" };
      await this.deps.identities.update(action.identityId, { ...(action.displayName ? { displayName: action.displayName } : {}), ...(action.role ? { role: action.role } : {}) });
      await this.pushSnapshot(); return { ok: true };
    }
    if (action.type === "revoke-identity") {
      if (!this.deps.identities || !this.workspace) return { ok: false, error: "身份中心未接入" };
      const identity = (await this.deps.identities.list(this.workspace.id)).find((item) => item.id === action.identityId);
      if (!identity) return { ok: false, error: "身份不存在" };
      await this.deps.identities.revoke(action.identityId); await this.pushSnapshot(); return { ok: true };
    }
    if (action.type === "sync-preview") {
      if (!this.workspace || !this.deps.settings) return { ok: false, error: "同步上下文未准备好" };
      const settings = await this.deps.settings.get();
      if (!settings.syncEndpoint) return { ok: false, error: "请先在设置中填写同步端点" };
      try {
         const remote = await new WorkspaceSyncClient({ endpoint: settings.syncEndpoint, workspaceId: this.workspace.id, token: settings.syncToken }).pull();
        this.pushChat({ role: "build-status", tone: "info", text: `同步预览：远端 revision ${remote.revision}，${remote.entities.length} 个实体。应用同步前会保留冲突副本。`, ts: Date.now() });
        return { ok: true };
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    }
    if (action.type === "sync-apply") {
      if (!this.workspace || !this.deps.settings) return { ok: false, error: "同步上下文未准备好" };
      const settings = await this.deps.settings.get();
      if (!settings.syncEndpoint) return { ok: false, error: "请先在设置中填写同步端点" };
      try {
         const client = new WorkspaceSyncClient({ endpoint: settings.syncEndpoint, workspaceId: this.workspace.id, token: settings.syncToken });
         const remote = await client.pull();
         const projects = this.deps.repository ? await this.deps.repository.listProjects(this.workspace.id) : [];
         const scenarios = this.deps.library ? (await this.deps.library.list()).filter((scenario) => scenario.workspaceId === null || scenario.workspaceId === this.workspace?.id) : [];
         const memories = action.includeMemory && this.deps.memories ? await this.deps.memories.list(this.workspace.id) : [];
         const localEntities = [...projects.map((item) => ({ id: item.id, updatedAt: item.updatedAt, type: "project", data: item })), ...scenarios.map((item) => ({ id: item.id, updatedAt: item.createdAt, type: "scenario", data: item })), ...memories.map((item) => ({ id: item.id, updatedAt: item.updatedAt, type: "memory", data: item }))];
         // Only these entity types are currently understood by this panel.
         // Keep memory rows when the user opted out, and preserve any
         // unknown/future rows verbatim so applying sync cannot silently
         // delete data written by a newer client.
         const syncableRemoteEntities = remote.entities.filter((entity) => entity.type === "project" || entity.type === "scenario" || (entity.type === "memory" && action.includeMemory));
         const passthroughRemoteEntities = remote.entities.filter((entity) => !syncableRemoteEntities.includes(entity));
         const remoteEntities = syncableRemoteEntities;
         const filteredRemote = { ...remote, entities: remoteEntities };
         const plan = WorkspaceSyncClient.plan(localEntities, filteredRemote);
         if (plan.conflicts.length) return { ok: false, error: `同步存在 ${plan.conflicts.length} 个冲突，请先处理冲突副本` };
         const remoteById = new Map(remoteEntities.map((entity) => [entity.id, entity]));
         for (const id of [...plan.remoteOnly, ...plan.update]) {
           const entity = remoteById.get(id);
           if (!entity) continue;
           if (entity.type === "project" && this.deps.repository) {
             const parsed = ProjectSchema.safeParse(entity.data);
             if (!parsed.success || parsed.data.workspaceId !== this.workspace.id) return { ok: false, error: `远端项目 ${id} 数据无效或不属于当前工作区` };
             await this.deps.repository.upsertProject(parsed.data);
           } else if (entity.type === "scenario" && this.deps.library) {
             const parsed = ScenarioRecordSchema.safeParse(entity.data);
             if (!parsed.success) return { ok: false, error: `远端场景 ${id} 数据无效` };
             // R1 审计#3：强制归属当前工作区；sync-apply 无项目导入流程，
             // 远端 projectId 一律置 null（防越权注入任意作用域）
             await this.deps.library.save({ ...parsed.data, workspaceId: this.workspace.id, projectId: null });
           } else if (entity.type === "memory" && action.includeMemory && this.deps.memories) {
             const parsed = MemoryItemSchema.safeParse(entity.data);
             if (!parsed.success || parsed.data.workspaceId !== this.workspace.id) return { ok: false, error: `远端 Memory ${id} 数据无效或不属于当前工作区` };
             await this.deps.memories.upsert(parsed.data);
           }
         }
         const mergedProjects = this.deps.repository ? await this.deps.repository.listProjects(this.workspace.id) : [];
         const mergedScenarios = this.deps.library ? await this.deps.library.list() : [];
         const mergedMemories = action.includeMemory && this.deps.memories ? await this.deps.memories.list(this.workspace.id) : [];
         const mergedEntities = [...passthroughRemoteEntities, ...mergedProjects.map((item) => ({ id: item.id, updatedAt: item.updatedAt, type: "project", data: item })), ...mergedScenarios.map((item) => ({ id: item.id, updatedAt: item.createdAt, type: "scenario", data: item })), ...mergedMemories.map((item) => ({ id: item.id, updatedAt: item.updatedAt, type: "memory", data: item }))];
         const envelope: RemoteSyncEnvelope = { schemaVersion: 1, workspaceId: this.workspace.id, revision: new Date().toISOString(), entities: mergedEntities };
         await client.push(envelope);
         this.pushChat({ role: "build-status", tone: "ok", text: `同步完成：合并 ${mergedEntities.length} 个实体，未发送 Secret。`, ts: Date.now() });
        return { ok: true };
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    }
    if (action.type === "run-command") {
      return await this.runCommand(action.input);
    }
    if (action.type === "search") {
      const query = action.query.trim().toLowerCase();
      const results: string[] = [];
      const sessions = this.deps.history ? await this.deps.history.list(100) : [];
      for (const item of sessions) if (`${item.title} ${item.mode}`.toLowerCase().includes(query)) results.push(`对话 · ${item.title} · ${item.mode}`);
      for (const item of (this.deps.library ? await this.deps.library.list() : [])) if (`${item.name} ${item.goal} ${item.tags.join(" ")}`.toLowerCase().includes(query)) results.push(`场景 · ${item.name} · v${item.pinnedVersion}`);
      if (this.workspace && this.deps.memories) for (const item of await this.deps.memories.search(this.workspace.id, query)) results.push(`Memory · ${item.name} · ${item.scope}`);
      if (this.projectId && this.deps.repository) for (const item of await this.deps.repository.listFiles(this.projectId)) if (`${item.name} ${item.mediaType}`.toLowerCase().includes(query)) results.push(`文件 · ${item.name}`);
      for (const item of (this.workspace && this.deps.runs ? await this.deps.runs.listForWorkspace(this.workspace.id, 100) : [])) if (item.requirement.toLowerCase().includes(query)) results.push(`运行 · ${item.requirement} · ${item.status}`);
      for (const item of (this.workspace && this.deps.artifacts ? await this.deps.artifacts.list(this.workspace.id, this.projectId) : [])) if (item.name.toLowerCase().includes(query)) results.push(`产物 · ${item.name} · ${item.status}`);
      this.pushChat({ role: "search-result", query: action.query, text: results.length ? `搜索“${action.query}”命中：\n${results.slice(0, 40).join("\n")}` : `搜索“${action.query}”没有命中。`, ts: Date.now() });
      // 弹窗内联结果：命中 0 条时给可行动的空态提示，而不是让用户自己去对话流里找
      return { ok: true, data: { query: action.query, results: results.slice(0, 40) } };
    }
    if (action.type === "set-mode") {
      if (this.sessionLocked) return { ok: false, error: "当前运行中不能切换模式" };
      const changed = action.mode !== this.activeMode;
      this.activeMode = action.mode;
      this.activeScenarioId = null;
      // A completed/failed run belongs to the previous mode. Keep its chat
      // history and run center record, but clear the live inspector so a mode
      // switch never looks like the new mode is still failing or running.
      if (changed && this.run.status !== "idle") {
        this.run = { kind: "idle", status: "idle" };
        this.lastBuildContext = undefined;
        // The old orchestrator still owns its terminal context. Detach it so
        // snapshot() cannot repopulate the inspector from a run in the mode
        // the user just left.
        this.deps.orchestrator = undefined;
      }
      await this.persistSession();
      await this.pushSnapshot();
      return { ok: true };
    }
    if (action.type === "select-scenario") {
      if (this.sessionLocked) return { ok: false, error: "当前运行中不能切换场景" };
      if (action.scenarioId && this.deps.library) {
        const scenario = await this.deps.library.get(action.scenarioId);
        if (!scenario || !this.scenarioInScope(scenario)) return { ok: false, error: "场景不存在" };
        if (scenario.status !== "active") return { ok: false, error: "场景已归档，不能选择" };
      }
      this.activeScenarioId = action.scenarioId;
      await this.persistSession();
      await this.pushSnapshot();
      return { ok: true };
    }
    if (action.type === "test-scenario") {
      if (this.sessionLocked) return { ok: false, error: "当前运行尚未结束" };
      const scenario = this.deps.library ? await this.deps.library.get(action.scenarioId) : undefined;
      if (!scenario || !this.scenarioInScope(scenario)) return { ok: false, error: "场景不存在" };
      if (scenario.status !== "active") return { ok: false, error: "场景已归档，不能测试" };
      if (!this.deps.onTestScenario) return { ok: false, error: "场景测试器未接入" };
      const report = await this.deps.onTestScenario(action.scenarioId);
      const passed = report.passed;
      this.pushChat({ role: "build-status", tone: passed ? "ok" : "err", text: report.skipped ? `场景 ${scenario.name} 没有可替换槽位，泛化测试跳过。` : passed ? `场景 ${scenario.name} 泛化测试通过：${report.attempts.length} 组换参均完成。` : `场景 ${scenario.name} 泛化测试失败：${report.attempts.find((item) => !item.passed)?.error ?? "至少一组换参未通过"}`, ts: Date.now() });
      await this.pushSnapshot();
      return { ok: passed, data: report, ...(passed ? {} : { error: "泛化测试未通过" }) };
    }
    if (action.type === "archive-scenario" || action.type === "restore-scenario" || action.type === "delete-scenario") {
      if (this.sessionLocked) return { ok: false, error: "当前运行中不能修改场景库" };
      if (!this.deps.library) return { ok: false, error: "场景库未接入" };
      const existingScenario = await this.deps.library.get(action.scenarioId);
      if (!existingScenario || !this.scenarioInScope(existingScenario)) return { ok: false, error: "场景不存在" };
      const ok = action.type === "archive-scenario" ? await this.deps.library.archive(action.scenarioId) : action.type === "restore-scenario" ? await this.deps.library.restore(action.scenarioId) : await this.deps.library.delete(action.scenarioId);
      if (!ok) return { ok: false, error: "场景不存在" };
      if (this.activeScenarioId === action.scenarioId && action.type !== "restore-scenario") this.activeScenarioId = null;
      await this.recordAudit(action.type.replace("-scenario", ""), "scenario", action.scenarioId, `${action.type === "archive-scenario" ? "归档" : action.type === "restore-scenario" ? "恢复" : "删除"}场景`);
      await this.pushSnapshot();
      return { ok: true };
    }
    if (action.type === "import-scenario") {
      if (this.sessionLocked) return { ok: false, error: "当前运行中不能导入场景" };
      if (!this.deps.library) return { ok: false, error: "场景库未接入" };
      let record: unknown;
      try { record = JSON.parse(action.content); } catch { return { ok: false, error: "场景文件不是有效 JSON" }; }
      const parsedRecord = ScenarioRecordSchema.safeParse(record);
      if (!parsedRecord.success) return { ok: false, error: "场景文件结构不符合当前版本" };
      // A standalone import belongs to the selected folder. Do not preserve a
      // source project's owner and accidentally expose it in this project.
      const existing = await this.deps.library.list();
      const sameId = existing.some((item) => item.id === parsedRecord.data.id);
      const sameName = existing.some((item) => item.name === parsedRecord.data.name && this.scenarioInScope(item));
      const importedId = sameId ? `${parsedRecord.data.id}-import-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` : parsedRecord.data.id;
      const importedName = sameName ? scenarioNameFromRequirement(parsedRecord.data.goal || parsedRecord.data.name, existing.filter((item) => this.scenarioInScope(item)).map((item) => item.name)) : parsedRecord.data.name;
      await this.deps.library.save({ ...parsedRecord.data, id: importedId, name: importedName, workspaceId: this.workspace?.id ?? null, projectId: this.projectId });
      await this.recordAudit("import", "scenario", importedId, `导入场景 ${importedName}`);
      await this.pushSnapshot();
      return { ok: true };
    }
    if (action.type === "start-build") {
      // The browser disables the composer while a run is active, but the WS
      // protocol must enforce the same invariant for double-clicks, retries,
      // multiple tabs, and scheduler races.
      if (this.sessionLocked || ["running", "waiting-gate", "waiting-user", "paused"].includes(this.run.status)) {
        return { ok: false, error: "当前运行尚未结束" };
      }
      if (!this.deps.onStartBuild) return { ok: false, error: "面板未接入构建器" };
      const executionProjectId = action.projectId ?? this.projectId;
      if (action.projectId) {
        const project = this.deps.repository && this.workspace ? await this.deps.repository.getProject(action.projectId) : undefined;
        if (!project || project.workspaceId !== this.workspace?.id || project.status !== "active") return { ok: false, error: "运行项目不存在或不可用" };
      }
      // Validate the scenario against the execution folder before creating a
      // durable run or acquiring the session lock. A scenario from another
      // project must fail as a normal boundary error and leave no side effect.
      const selectedScenario = action.scenarioId && this.deps.library ? await this.deps.library.get(action.scenarioId) : undefined;
      if (action.scenarioId && this.deps.library && selectedScenario && !this.scenarioInScope(selectedScenario, executionProjectId)) return { ok: false, error: "场景不存在" };
      // Resolve the provider before acquiring the run lock. A stale or
      // cross-workspace provider reference must fail without leaving the
      // inspector permanently busy.
      const providerSettings = await this.deps.settings?.get();
      const executionProject = executionProjectId && this.deps.repository ? await this.deps.repository.getProject(executionProjectId) : undefined;
      const executionProviderId = executionProject?.providerId ?? (executionProjectId === this.projectId ? this.projectProviderId : null) ?? providerSettings?.providerId;
      const selectedProvider = executionProviderId ? await this.currentProvider(executionProviderId) : undefined;
      if (executionProviderId && !selectedProvider) return { ok: false, error: "Provider 不存在或不属于当前工作区" };
      // Scheduler/task runs share the panel's transport so their progress can
      // be observed, but they must not rewrite the user's current conversation
      // context. Otherwise a task bound to another scenario silently changes
      // the scenario used by the next human message after the task finishes.
      const isBackgroundTask = action.source === "task";
      this.sessionLocked = true;
      if (!isBackgroundTask) {
        this.activeMode = action.mode;
        this.activeScenarioId = action.scenarioId ?? null;
      }
      this.run = { kind: action.mode, status: "running", scenarioId: action.scenarioId };
      this.pendingBuildInput = undefined;
      this.lastBuildContext = undefined;
      // A build run is driven by the planner; a work run is driven by the
      // execution model. Keep the run center honest so troubleshooting does
      // not attribute a planner request to the worker model (or vice versa).
      const runModel = selectedProvider?.model ?? (action.mode === "build" ? providerSettings?.plannerModel ?? providerSettings?.model : providerSettings?.model) ?? "local-template";
      const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.run.runId = runId;
      // 分寸账本（§6/§9）：digest 用于重放路由命中；attended 按触发源打标（task=无人值守）
      this.runLedgerMeta.set(runId, { scenarioId: action.scenarioId ?? null, digest: inputDigest(action.requirement, action.slots ?? {}), attended: (action.source ?? "user") !== "task", mode: action.mode });
      await this.deps.runs?.create({ id: runId, workspaceId: this.workspace?.id ?? "workspace-local", projectId: executionProjectId, sessionId: this.sessionId, mode: action.mode, scenarioId: action.scenarioId ?? null, providerId: selectedProvider?.id ?? providerSettings?.providerId ?? null, model: runModel, status: "running", requirement: action.requirement.trim(), startedAt: new Date().toISOString(), finishedAt: null, error: null, retryCount: action.retryCount ?? 0, details: { source: action.source ?? "user" } });
      if (this.workspace && this.deps.memories) {
        const enabledMemoryCount = (await this.visibleMemories()).filter((item) => item.enabled).length;
        // SceneFlow：上下文提示进进度卡，聊天流只留 用户消息/进度卡/闸门/终态
        if (enabledMemoryCount > 0) this.pushProgress(runId, { line: `当前上下文包含 ${enabledMemoryCount} 条启用 Memory，运行记录会保留来源。`, phase: "parsing" });
      }
      if (action.scenarioId && this.deps.library && !selectedScenario) {
        this.sessionLocked = false;
        await this.deps.runs?.update(runId, { status: "failed", finishedAt: new Date().toISOString(), error: "场景不存在" });
        this.pushChat({ role: "build-status", tone: "err", runStatus: "failed", error: "场景不存在", text: "指定场景不存在或已被删除。", terminal: true, runId, ts: Date.now() });
        await this.pushSnapshot();
        return { ok: false, error: "场景不存在" };
      }
      if (action.scenarioId && selectedScenario && selectedScenario.status !== "active") {
        this.sessionLocked = false;
        await this.deps.runs?.update(runId, { status: "failed", finishedAt: new Date().toISOString(), error: "场景已归档" });
        this.pushChat({ role: "build-status", tone: "err", runStatus: "failed", error: "场景已归档", text: "指定场景已归档，不能启动运行。", terminal: true, runId, ts: Date.now() });
        await this.pushSnapshot();
        return { ok: false, error: "场景已归档" };
      }
      if (!isBackgroundTask) await this.persistSession();
      await this.pushSnapshot();
      // Starting a run is an asynchronous job boundary. Do not keep the WS
      // action pending until a slow model finishes; snapshots, chat terminal
      // events, and the persisted run record carry the eventual outcome.
      void this.deps.onStartBuild(action.requirement.trim(), action.mode, action.scenarioId, action.slots, executionProjectId ?? undefined, action.source ?? "user")
        .then(async (result) => {
          // A launcher may resolve after it already emitted a terminal event.
          // Guard the run id as well as status so a late failure from an old
          // job cannot flip a newer run back to failed.
          if (!result.ok && this.run.runId === runId && this.run.status === "running") {
            this.sessionLocked = false;
            const message = result.error ?? "运行未启动";
            await this.deps.runs?.update(runId, { status: "failed", finishedAt: new Date().toISOString(), error: message });
            this.pushChat({ role: "build-status", tone: "err", runStatus: "failed", error: message, text: `运行失败：${message}`, terminal: true, runId, ts: Date.now() });
            await this.pushSnapshot();
          }
        })
        .catch(async (error: unknown) => {
          // A launcher may reject after it already emitted a terminal event
          // (for example a late provider cleanup error). Once the inspector
          // is terminal, that rejection must not resurrect the run as failed.
          if (this.run.runId !== runId || this.run.status !== "running") return;
          this.sessionLocked = false;
          const message = error instanceof Error ? error.message : String(error);
          await this.deps.runs?.update(runId, { status: "failed", finishedAt: new Date().toISOString(), error: message });
          this.pushChat({ role: "build-status", tone: "err", runStatus: "failed", error: message, text: `运行失败：${message}`, terminal: true, runId, ts: Date.now() });
          await this.pushSnapshot();
        })
        // R1 审计#1：catch 回调自身的 await（runs.update/pushSnapshot）若抛出
        // （磁盘满/store 冲突），会形成无处理 rejection 崩溃面板进程
        .catch(async (secondary: unknown) => {
          try {
            this.pushChat({ role: "build-status", tone: "err", text: `运行失败善后出错：${secondary instanceof Error ? secondary.message : String(secondary)}`, terminal: true, runId, ts: Date.now() });
            await this.pushSnapshot();
          } catch {
            /* 兜底失败只能放弃 */
          }
        });
      return { ok: true };
    }
    if (action.type === "feedback-run") {
      // §12 反应窗先到先得；§18 矩阵：👎 无 reason→400 / 重复 runId→409 幂等
      if (action.verdict === "down" && !action.reason?.trim()) return { ok: false, error: "400: 👎 需要告诉它哪里不对（原因必填）" };
      const pending = this.pendingFeedback.get(action.runId);
      if (!pending) return { ok: false, error: "409: 该运行的反馈已处理或反应窗已关闭" };
      clearTimeout(pending.timer);
      this.pendingFeedback.delete(action.runId);
      const at = new Date().toISOString();
      await this.recordScenarioOutcome(pending.scenarioId, { runId: action.runId, attended: pending.attended, outcome: action.verdict === "up" ? "accepted" : "rejected", digest: pending.digest });
      if (action.verdict === "down" && this.deps.library) {
        // 👎+原因 = 分寸提案（output scope，pendingConfirm；签约面/过期机制同构建侧）
        await this.deps.library
          .updateLedger(pending.scenarioId, (ledger) => {
            const merged = mergeConstraintGuarded(ledger, { clause: stripNegationPrefix(action.reason!.trim()), scope: "output", origin: { type: "feedback", text: action.reason!.trim(), at, runId: action.runId } });
            return merged.ledger;
          })
          .catch(() => undefined);
      }
      this.pushChat({
        role: "build-status",
        tone: action.verdict === "up" ? "ok" : "info",
        text: action.verdict === "up" ? "已记录：这次结果通过。" : `已记录打回${action.reason ? `：「${action.reason.trim()}」` : ""}，连击清零；这条原因会沉淀为分寸候选。`,
        ts: Date.now(),
      });
      await this.pushSnapshot();
      return { ok: true };
    }
    if (action.type === "retire-constraint") {
      // §14：退役 = active=false（不删，可溯）；同时运行生命周期自动评估（自动转正/退役）
      if (!this.deps.library) return { ok: false, error: "场景库未准备好" };
      await this.deps.library.updateLedger(action.scenarioId, (ledger) => {
        const retired = retireConstraint(ledger, action.constraintId);
        const { ledger: evaluated, changes } = evaluateLifecycle(retired);
        for (const change of changes) {
          this.pushChat({ role: "build-status", tone: change.action === "retire" ? "info" : "ok", text: `分寸账本自动${change.action === "retire" ? "退役" : "转正"}条款「${change.clause.slice(0, 30)}」（${change.reason}）。`, ts: Date.now() });
        }
        return evaluated;
      }).catch((error: unknown) => ({ error }));
      await this.pushSnapshot();
      return { ok: true };
    }
    if (action.type === "confirm-constraints") {
      // §14：签约 = 批量填 confirmedAt（工作模式 pendingConfirm 的确认通道）；签约后也跑生命周期评估
      if (!this.deps.library) return { ok: false, error: "场景库未准备好" };
      await this.deps.library.updateLedger(action.scenarioId, (ledger) => {
        const confirmed = confirmConstraints(ledger, action.ids);
        const { ledger: evaluated, changes } = evaluateLifecycle(confirmed);
        for (const change of changes) {
          this.pushChat({ role: "build-status", tone: change.action === "retire" ? "info" : "ok", text: `分寸账本自动${change.action === "retire" ? "退役" : "转正"}条款「${change.clause.slice(0, 30)}」（${change.reason}）。`, ts: Date.now() });
        }
        return evaluated;
      }).catch((error: unknown) => ({ error }));
      this.pushChat({ role: "build-status", tone: "ok", text: `已签约 ${action.ids.length} 条分寸，下次运行自检生效。`, ts: Date.now() });
      await this.pushSnapshot();
      return { ok: true };
    }
    if (action.type === "revise-output") {
      // §7 Edit-to-Accept：最强信号——用户亲手改产出。原子三件事：
      // ① diff → pendingConfirm 提案 ② corrected++/断连胜 ③ interventions 记 1 次纠正
      const artifacts = this.deps.artifacts;
      if (!artifacts || !this.workspace) return { ok: false, error: "产物中心未准备好" };
      const listed = await artifacts.list(this.workspace.id).catch(() => []);
      const artifact = listed.find((item) => item.runId === action.runId && item.status !== "deleted");
      if (!artifact) return { ok: false, error: "找不到该运行的产出文件" };
      let original = "";
      try {
        original = await readFile(artifact.path, "utf8");
      } catch {
        return { ok: false, error: "产出文件不可读" };
      }
      const blocks = computeOutputDiff(original, action.content);
      if (!blocks.length) return { ok: false, error: "没有检测到改动" };
      const proposals: RevisionProposal[] = blocksToProposals(blocks).map((p) => ({
        clause: p.clause,
        scope: p.scope,
        kind: p.kind,
        pattern: p.pattern,
        upgradePattern: p.kind_source === "added" && p.addedText && p.addedText.length <= 60 && !/\n/.test(p.addedText) ? p.addedText : undefined,
        origin: { type: "artifact-edit", text: `${p.kind_source}: ${p.clause}`, at: new Date().toISOString(), runId: action.runId },
      }));
      // 竞态（§7 表）：沉默窗内编辑 → 撤销 pending 沉默，改记 corrected（先到先得，编辑优先）
      const cancelled = this.cancelFeedbackWindow(action.runId);
      const metaScenario = (cancelled?.scenarioId ?? this.runLedgerMeta.get(action.runId)?.scenarioId ?? null);
      let scenarioId = metaScenario;
      if (!scenarioId && this.deps.runs) {
        const run = await this.deps.runs.get(action.runId).catch(() => undefined);
        scenarioId = run?.scenarioId ?? null;
      }
      if (scenarioId && this.deps.library) {
        const digest = cancelled?.digest ?? this.runLedgerMeta.get(action.runId)?.digest;
        await this.deps.library
          .updateLedger(scenarioId, (ledger) => applyOutputCorrection(ledger, { runId: action.runId, digest, proposals }))
          .catch(() => undefined);
      }
      // 产出落地为改后版本（正文写回文件 + 版本留痕，原文可溯）
      try {
        await writeFile(artifact.path, action.content, "utf8");
        await artifacts.createVersion(artifact.id, { content: action.content, checksum: createHash("sha256").update(action.content).digest("hex") });
      } catch {
        /* 版本化失败不阻塞修订（正文已写不进账本原文） */
      }
      this.pushChat({
        role: "build-status",
        tone: "info",
        text: `已由你修订产出（${blocks.length} 处改动${proposals.length ? `，沉淀 ${proposals.length} 条分寸候选` : ""}）。连击已清零。`,
        runId: action.runId,
        ts: Date.now(),
      });
      await this.pushSnapshot();
      return { ok: true, data: { blocks: blocks.length, proposals: proposals.length } };
    }
    if (action.type === "gate-decision") {
      const orch = this.deps.orchestrator;
      if (!orch) return { ok: false, error: "no orchestrator attached" };
      // 分类在 decide 之前做：需要决策前的选型/验收快照做 diff（§4）
      const classifyContext = {
        previousSelections: orch.ctx.selections.map((s) => ({ nodeId: s.nodeId, capabilityId: s.capabilityId })),
        previousAcceptance: orch.ctx.acceptance.map((a) => ({ layer: a.layer, passed: a.passed })),
        nodeTitles: Object.fromEntries(((orch.ctx.dag as { nodes?: Array<{ id?: string; title?: string }> } | null)?.nodes ?? []).map((n) => [String(n.id ?? ""), String(n.title ?? n.id ?? "")])),
        capabilityNames: this.capabilityNameMap(3),
      };
      const classification = classifyGateDecision(action.decision, classifyContext);
      const at = new Date().toISOString();
      const runId = this.run.runId ?? null;
      for (const draft of classification.proposals) this.buildLedgerProposals.push({ ...draft, at, runId });
      if (action.decision.gate === 5 && action.excludeProposals) this.excludedProposalIds = [...action.excludeProposals];
      try {
        await orch.decide(action.decision);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      if (classification.proposals.length) {
        this.pushChat({
          role: "build-status",
          tone: "info",
          text: `已记下 ${classification.proposals.length} 条分寸候选：${classification.proposals.map((p) => `「${p.clause}」`).join("、")}。保存场景时可在闸门5确认。`,
          ts: Date.now(),
        });
      }
      if (action.decision.action !== "edit") {
        this.markGateCardDecided(action.decision.gate, action.decision.action, action.decision.targetPhase);
      }
      this.pushChat({
        role: "build-status",
        tone: action.decision.action === "approve" ? "ok" : action.decision.action === "edit" ? "info" : "err",
        text:
          action.decision.action === "approve"
            ? `✓ 闸门${action.decision.gate} 已批准${action.decision.choice ? `（${action.decision.choice}）` : ""}${action.decision.comment ? `（${action.decision.comment}）` : ""}`
            : action.decision.action === "edit"
              ? `↻ 闸门${action.decision.gate} 已更新，等待再次确认`
              : `✗ 闸门${action.decision.gate} 已驳回 → ${action.decision.targetPhase}${action.decision.comment ? `（${action.decision.comment}）` : ""}`,
        ts: Date.now(),
      });
      this.bus.emit("gate-decision", action.decision);
      return { ok: true };
    }
    if (action.type === "answer-run") {
      if (!this.sessionLocked || this.run.runId !== action.runId) return { ok: false, error: "当前没有等待输入的运行" };
      const buildOrchestrator = this.deps.orchestrator;
      // A live model clarification is mirrored into pendingBuildInput by the
      // orchestrator event listener. Route it through answerRun so the
      // durable awaiting request, RunProduct details and failure rollback are
      // updated together. Only a clarification restored after a restart has
      // ctx.awaitingUser without the in-memory pending request; that path uses
      // the launcher resume callback below.
      if (this.run.kind === "build" && buildOrchestrator?.ctx.awaitingUser && !this.pendingBuildInput) {
        if (!this.deps.onAnswerBuild) return { ok: false, error: "面板未接入构建恢复器" };
        const normalized = Object.fromEntries(Object.entries(action.values).map(([key, value]) => [key, String(value).trim()]));
        const result = await this.deps.onAnswerBuild(action.runId, normalized);
        if (result.ok) {
          this.run = { ...this.run, status: "running", text: "已收到补充输入，继续构建" };
          const current = this.deps.runs ? await this.deps.runs.get(action.runId) : undefined;
          if (current?.status === "waiting-user") {
            await this.deps.runs!.update(action.runId, {
              status: "running",
              error: null,
              details: { ...(current.details ?? {}), awaitingUser: null, clarificationAnswers: { ...((current.details as Record<string, unknown> | null)?.clarificationAnswers as Record<string, string> ?? {}), ...normalized } },
            });
          }
          await this.persistSession();
          await this.pushSnapshot();
        }
        return result;
      }
      const result = await this.answerRun(action.runId, action.values);
      if (result.ok) await this.persistSession();
      return result;
    }
    if (action.type === "guide-run") {
      if (!this.sessionLocked || !this.run.runId || this.run.kind === "idle") return { ok: false, error: "当前没有可引导的运行" };
      if (this.run.kind === "build") return { ok: false, error: "场景构建的任务图已经冻结；请先停止构建，再用修正后的需求重新构建" };
      const instruction = action.instruction.trim();
      const longRun = this.deps.longRuns ? await this.deps.longRuns.get(this.run.runId) : undefined;
      if (longRun) this.pendingRunGuidance.push({ runId: this.run.runId, instruction });
      else {
        const currentRun = this.deps.runs ? await this.deps.runs.get(this.run.runId) : undefined;
        if ((currentRun?.details as { source?: string } | null | undefined)?.source === "task") return { ok: false, error: "后台任务运行不接受当前对话引导" };
        if (!this.deps.controller) return { ok: false, error: "运行控制器未接入" };
        this.deps.controller.guide(instruction);
      }
      this.pushChat({ role: "user", content: instruction, guidance: true, timestamp: Date.now() });
      // 分寸账本（§8）：guide-run 纠正 = corrected 信号 + 提案素材（run 收尾入账）
      const notes = this.runGuidanceNotes.get(this.run.runId) ?? [];
      notes.push(instruction);
      this.runGuidanceNotes.set(this.run.runId, notes);
      this.pushChat({ role: "build-status", tone: "info", text: "已收到运行中引导，将从下一个可执行步骤开始生效；当前正在执行的模型调用不会被篡改。", ts: Date.now(), runId: this.run.runId });
      await this.persistSession();
      await this.pushSnapshot();
      return { ok: true };
    }
    const ctl = this.deps.controller;
    if (!ctl) return { ok: false, error: "no controller attached" };
    if (!this.sessionLocked || !this.run.runId || this.run.kind === "idle") return { ok: false, error: "当前没有可控制的运行" };
    if (action.action === "pause") {
      if (this.run.status !== "running") return { ok: false, error: "当前运行不在可暂停状态" };
      ctl.pause(); this.run = { ...this.run, status: "paused", text: "已暂停" }; if (this.run.runId && this.deps.runs && await this.deps.runs.get(this.run.runId)) await this.deps.runs.update(this.run.runId, { status: "paused" }); await this.pushSnapshot();
    }
    else if (action.action === "resume") {
      if (this.run.status !== "paused") return { ok: false, error: "当前运行不在暂停状态" };
      ctl.resume(); this.run = { ...this.run, status: "running", text: "继续运行" }; if (this.run.runId && this.deps.runs && await this.deps.runs.get(this.run.runId)) await this.deps.runs.update(this.run.runId, { status: "running" }); await this.pushSnapshot();
    }
    else {
      if (!["running", "paused", "waiting-gate", "waiting-user"].includes(this.run.status)) return { ok: false, error: "当前没有可终止的运行" };
      ctl.terminate();
      this.pendingRunInput?.reject(new Error("运行已终止"));
      this.pendingRunInput = undefined;
      this.deps.orchestrator?.abort();
      this.run = { ...this.run, status: "cancelled", text: "已终止" };
      if (this.run.runId && this.deps.runs && await this.deps.runs.get(this.run.runId)) await this.deps.runs.update(this.run.runId, { status: "cancelled", finishedAt: new Date().toISOString(), error: "已终止" });
      this.sessionLocked = false;
      await this.pushSnapshot();
    }
    return { ok: true };
  }

  private async runCommand(input: string): Promise<{ ok: boolean; error?: string }> {
    const parsed = parseCommand(input);
    if (!parsed) return { ok: false, error: "不是有效的斜杠命令" };
      const previousUser = [...this.persistedChatHistory].reverse().find((message) => message.role === "user");
    this.pushChat({ role: "user", content: input, timestamp: Date.now() });
    switch (parsed.name) {
      case "/help":
        this.pushChat({ role: "build-status", tone: "info", text: COMMANDS.map((command) => `${command.usage} · ${command.description}`).join("\n"), terminal: true, ts: Date.now() });
        return { ok: true };
      case "/work":
        return await this.handleAction({ type: "set-mode", mode: "work" });
      case "/build":
        return await this.handleAction({ type: "set-mode", mode: "build" });
      case "/new":
        return await this.handleAction({ type: "new-session" });
      case "/archive":
        if (!this.sessionId) return { ok: false, error: "当前没有活动会话" };
        return await this.handleAction({ type: "archive-session", sessionId: this.sessionId });
      case "/rename": {
        if (!this.sessionId) return { ok: false, error: "当前没有活动会话" };
        const title = parsed.args.join(" ").trim();
        if (!title) return { ok: false, error: "请提供新的对话标题" };
        return await this.handleAction({ type: "rename-session", sessionId: this.sessionId, title });
      }
      case "/export":
        this.pushChat({ role: "ui-command", command: parsed.args[0] === "workspace" ? "export-workspace" : "export-session", ts: Date.now() });
        return { ok: true };
      case "/search": {
        const query = parsed.args.join(" ").trim();
        if (!query) return { ok: false, error: "请提供搜索关键词" };
        return await this.handleAction({ type: "search", query });
      }
      case "/settings":
        this.pushChat({ role: "ui-command", command: "settings", ts: Date.now() });
        return { ok: true };
      case "/model":
        this.pushChat({ role: "ui-command", command: "settings", ts: Date.now() });
        return { ok: true };
      case "/connect":
        this.pushChat({ role: "ui-command", command: "connectors", ts: Date.now() });
        return { ok: true };
      case "/files add":
        this.pushChat({ role: "ui-command", command: "file-picker", ts: Date.now() });
        return { ok: true };
      case "/files list":
        this.pushChat({ role: "build-status", tone: "info", text: this.projectId && this.deps.repository ? ((await this.deps.repository.listFiles(this.projectId)).map((file) => `${file.name} · ${file.mediaType} · ${file.size} bytes`).join("\n") || "当前项目没有文件") : "请先选择项目。", terminal: true, ts: Date.now() });
        return { ok: true };
      case "/scenario list": {
        const scenarios = this.deps.library ? (await this.deps.library.list()).filter((scenario) => this.scenarioInScope(scenario)) : [];
        this.pushChat({ role: "build-status", tone: "info", text: scenarios.length ? scenarios.map((scenario) => `${scenario.id} · ${scenario.name} · v${scenario.pinnedVersion}`).join("\n") : "场景库为空", terminal: true, ts: Date.now() });
        return { ok: true };
      }
      case "/scenario inspect": {
        const id = parsed.args[0];
        const scenario = id && this.deps.library ? await this.deps.library.get(id) : undefined;
        if (!scenario || !this.scenarioInScope(scenario)) return { ok: false, error: "场景不存在，请先使用 /scenario list" };
        this.pushChat({ role: "build-status", tone: "info", text: `${scenario.name}\n版本 v${scenario.pinnedVersion} · 使用 ${scenario.stats.uses} 次 · 成功 ${scenario.stats.successes} 次\n能力数 ${scenario.capabilityIds.length} · 槽位数 ${scenario.distilled.slotDefs.length}`, terminal: true, ts: Date.now() });
        return { ok: true };
      }
      case "/scenario version": {
        const id = parsed.args[0];
        const scenario = id && this.deps.library ? await this.deps.library.get(id) : undefined;
        if (!scenario || !this.scenarioInScope(scenario)) return { ok: false, error: "场景不存在，请先使用 /scenario list" };
        this.pushChat({ role: "build-status", tone: "info", text: `${scenario.name} 当前发布版本 v${scenario.pinnedVersion}，构建 ${scenario.distilled.buildId}，创建于 ${scenario.createdAt}`, terminal: true, ts: Date.now() });
        return { ok: true };
      }
      case "/scenario test": {
        const id = parsed.args[0];
        const scenario = id && this.deps.library ? await this.deps.library.get(id) : undefined;
        if (!scenario || !this.scenarioInScope(scenario)) return { ok: false, error: "场景不存在，请先使用 /scenario list" };
        if (this.sessionLocked) return { ok: false, error: "当前运行尚未结束" };
        return await this.handleAction({ type: "start-build", requirement: scenario.goal || scenario.name, mode: "work", scenarioId: scenario.id });
      }
      case "/use": {
        const id = parsed.args[0];
        const scenario = id && this.deps.library ? await this.deps.library.get(id) : undefined;
        if (!scenario || !this.scenarioInScope(scenario)) return { ok: false, error: "场景不存在，请先使用 /scenario list" };
        return await this.handleAction({ type: "set-mode", mode: "work" }).then(async (result) => {
          if (!result.ok) return result;
          return await this.handleAction({ type: "select-scenario", scenarioId: id });
        });
      }
      case "/memory remember":
        this.pushChat({ role: "ui-command", command: "memory", ts: Date.now() });
        return { ok: true };
      case "/memory list":
        this.pushChat({ role: "build-status", tone: "info", text: "Memory 已在右侧面板显示；切换到 Memory 标签可浏览会话、场景和知识文件。", terminal: true, ts: Date.now() });
        return { ok: true };
      case "/memory search": {
        const keyword = parsed.args.join(" ");
        if (!keyword) return { ok: false, error: "请提供 Memory 搜索关键词" };
        if (this.deps.memories && this.workspace) {
          const needle = keyword.trim().toLowerCase();
          const records = (await this.visibleMemories()).filter((item) => `${item.name}\n${item.content}`.toLowerCase().includes(needle));
          this.pushChat({ role: "build-status", tone: "info", text: records.length ? `Memory 搜索“${keyword}”命中：\n${records.slice(0, 20).map((item) => `${item.name} · ${item.scope}`).join("\n")}` : `Memory 中没有找到“${keyword}”。`, terminal: true, ts: Date.now() });
          return { ok: true };
        }
        const tree = this.deps.memoryRoot ? await memoryTree({ root: this.deps.memoryRoot, sessions: "", scenarios: "", knowledge: "" }) : null;
        const matches: string[] = [];
        const walk = (node: MemoryTreeNode): void => {
          if (node.kind === "file" && node.name.toLowerCase().includes(keyword.toLowerCase())) matches.push(node.path);
          for (const child of node.children ?? []) walk(child);
        };
        if (tree) walk(tree);
        this.pushChat({ role: "build-status", tone: "info", text: matches.length ? `Memory 搜索“${keyword}”命中：\n${matches.slice(0, 20).join("\n")}` : `Memory 中没有找到“${keyword}”。`, ts: Date.now() });
        return { ok: true };
      }
      case "/memory forget": {
        const requested = parsed.args.join(" ").trim();
        if (!requested) return { ok: false, error: "请提供 Memory 路径" };
        const target = await this.safeMemoryFile(requested);
        if (!target) return { ok: false, error: "Memory 文件路径无效" };
        if (this.workspace && this.deps.memories) {
          const owned = await this.visibleMemories();
          const ownedItem = owned.find((item) => item.path && path.resolve(item.path) === path.resolve(target));
          if (!ownedItem) return { ok: false, error: "Memory 不存在" };
        }
        await (await import("node:fs/promises")).rm(target, { force: true });
        if (this.workspace && this.deps.memories) {
          for (const item of await this.visibleMemories()) if (item.path && path.resolve(item.path) === path.resolve(target)) await this.deps.memories.delete(item.id);
        }
        await this.pushSnapshot();
        return { ok: true };
      }
      case "/run pause":
        return await this.handleAction({ type: "control", action: "pause" });
      case "/run resume":
        return await this.handleAction({ type: "control", action: "resume" });
      case "/task trigger": {
        const name = parsed.args.join(" ").trim();
        if (!name) return { ok: false, error: "请提供事件名" };
        return await this.handleAction({ type: "trigger-event", name });
      }
      case "/run stop":
        return await this.handleAction({ type: "control", action: "terminate" });
      case "/run retry": {
        if (this.sessionLocked) return { ok: false, error: "当前运行尚未结束" };
        const requirement = String(previousUser?.content ?? "").trim();
        if (!requirement || requirement.startsWith("/")) return { ok: false, error: "没有可重试的用户需求" };
        // Retry metadata belongs to the conversation that is currently open.
        // Looking at the workspace-global newest run leaks another history
        // session's retry count into this one after a user switches history.
        // Use a session-scoped query rather than the bounded workspace list;
        // an old conversation must still recover its full project binding
        // after the workspace has accumulated more than 100 runs.
        const previousRun = this.deps.runs && this.sessionId
          ? await this.deps.runs.latestForSession(this.sessionId)
          : undefined;
        // Replaying a run must preserve its execution context even when the
        // user changed the globally selected project or scenario after the
        // failed attempt.  Fall back to the current selection only when this
        // conversation has no durable run yet.
        return await this.handleAction({
          type: "start-build",
          requirement,
          mode: previousRun?.mode ?? this.activeMode,
          scenarioId: previousRun?.scenarioId ?? this.activeScenarioId ?? undefined,
          projectId: previousRun?.projectId ?? undefined,
          retryCount: (previousRun?.retryCount ?? 0) + 1,
        });
      }
      default:
        return { ok: false, error: `未知命令 ${parsed.name}，使用 /help 查看可用命令` };
    }
  }

  async start(port = 0): Promise<number> {
    await this.deps.settings?.load();
    // Hydrate the workspace before the session.  Session recovery needs the
    // workspace to restore an active long run, and new sessions need the
    // selected project so their context is persisted from the first message.
    if (this.deps.repository) {
      this.workspace = await this.deps.repository.getDefaultWorkspace();
      const projects = (await this.deps.repository.listProjects(this.workspace.id)).filter((project) => project.status === "active");
      this.projectId = projects.find((project) => project.pinned)?.id ?? projects[0]?.id ?? null;
      const initialProject = projects.find((project) => project.id === this.projectId);
      this.projectProviderId = initialProject?.providerId ?? null;
      this.projectRootPath = initialProject?.rootPath ?? null;
    }
    await this.hydrateSession();
    this.server = createServer((req, res) => {
      // R1 审计#2：DNS rebinding 防御——面板全部 API 零鉴权（设计为仅本机使用），
      // 恶意网页可通过 rebinding 把 Host 指向本机端口从而全权操作面板
      // （start-build/settings/secrets/host-context）。校验 Host 头必须为本机回环形态。
      const hostHeader = (req.headers.host ?? "").toLowerCase();
      const allowedHosts = this.allowedHostPorts;
      if (allowedHosts.length > 0 && !allowedHosts.includes(hostHeader)) {
        res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "forbidden host（面板仅接受本机回环访问）" }));
        return;
      }
      const requestPath = (req.url ?? "").split("?", 1)[0] ?? "";
      if (req.url === "/api/sessions" && req.method === "GET") {
        void (this.deps.history ? this.deps.history.list() : Promise.resolve([])).then((items) => {
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify(items));
        }).catch((error: unknown) => sendRouteFailure(res, error));
        return;
      }
      if (req.url === "/api/settings" && req.method === "GET") {
        void (this.deps.settings ? this.deps.settings.public() : Promise.resolve(null)).then((value) => {
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify(value));
        }).catch((error: unknown) => sendRouteFailure(res, error));
        return;
      }
      if (req.url === "/api/settings" && (req.method === "PUT" || req.method === "PATCH")) {
        void readJsonBody(req).then((body) => this.handleAction({ type: "update-settings", settings: body })).then((result) => {
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.statusCode = result.ok ? 200 : 400;
          res.end(JSON.stringify(result));
        }).catch((error: unknown) => {
          res.writeHead(400, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
        });
        return;
      }
      if (requestPath === "/api/workspace/import" && req.method === "POST") {
        void readTextBody(req, 50_000_000).then((content) => this.handleAction({ type: "import-workspace", content })).then((result) => {
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.statusCode = result.ok ? 200 : 400;
          res.end(JSON.stringify(result));
        }).catch((error: unknown) => {
          res.writeHead(400, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
        });
        return;
      }
      if (requestPath === "/api/host-context/info" && req.method === "GET") {
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ endpoint: "/api/host-context", token: this.hostBridgeToken, kinds: ["local-file", "clipboard", "terminal", "browser", "note"], projectId: this.projectId }));
        return;
      }
      if (requestPath === "/api/host-context" && req.method === "POST") {
        if (req.headers["x-scenario-host-token"] !== this.hostBridgeToken) { res.writeHead(401).end(); return; }
        void readJsonBody(req).then(async (raw) => {
          const parsed = DesktopContextInputSchema.safeParse(raw);
          if (!parsed.success || !this.workspace || !this.deps.contexts) return { ok: false, error: "桌面上下文请求无效" };
          if (parsed.data.kind === "local-file" && !this.currentProjectRoot()) return { ok: false, error: "请先选择项目" };
          const validation = validateDesktopContext(parsed.data, { allowedRoot: this.currentProjectRoot(), allowBrowser: true });
          if (!validation.ok) return validation;
          const context = await this.deps.contexts.create({ id: `context-host-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, workspaceId: this.workspace.id, projectId: this.projectId, ...parsed.data, enabled: true });
          await this.recordAudit("create", "desktop-context", context.id, `Host Bridge 导入上下文 ${context.label}`, { kind: context.kind, origin: context.origin });
          await this.pushSnapshot();
          return { ok: true, contextId: context.id };
        }).then((result) => { res.setHeader("content-type", "application/json; charset=utf-8"); res.statusCode = result.ok ? 200 : 400; res.end(JSON.stringify(result)); }).catch((error: unknown) => { res.writeHead(400, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })); });
        return;
      }
      if (req.url === "/api/snapshot") {
        void this.snapshot().then((snap) => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(snap));
        }).catch((error: unknown) => sendRouteFailure(res, error));
        return;
      }
      if (req.url?.startsWith("/api/events") && req.method === "GET") {
        const after = Number(new URL(req.url, "http://127.0.0.1").searchParams.get("after") ?? "0");
        const events = Number.isFinite(after) ? this.eventLog.filter((event) => event.revision > after) : [];
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ revision: this.revision, events }));
        return;
      }
      if (req.url === "/api/audit" && req.method === "GET") {
        void (this.workspace && this.deps.audit ? this.deps.audit.list(this.workspace.id) : Promise.resolve([])).then((items) => {
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify(items.map(({ details: _details, ...item }) => item)));
        }).catch((error: unknown) => sendRouteFailure(res, error));
        return;
      }
      if (req.url === "/api/workspace/export" && req.method === "GET") {
        void (async () => {
          if (!this.workspace) return { workspace: null };
          const projects = this.deps.repository ? await this.deps.repository.listProjects(this.workspace.id) : [];
          const files = this.deps.repository ? (await Promise.all(projects.map((project) => this.deps.repository!.listFiles(project.id)))).flat() : [];
          // Paths are local implementation details.  Export only the fields
          // needed to restore a project file, otherwise a shared bundle leaks
          // the producer's home/workspace layout.
          const fileBundles = await Promise.all(files.map(async (file) => ({
            id: file.id,
            projectId: file.projectId,
            name: file.name,
            mediaType: file.mediaType,
            size: file.size,
            indexed: file.indexed,
            contentBase64: await readFile(file.path).then((content) => content.toString("base64")).catch(() => null),
          })));
          const scenarios = this.deps.library ? (await this.deps.library.list()).filter((scenario) => scenario.workspaceId === null || scenario.workspaceId === this.workspace?.id) : [];
          const memories = this.deps.memories ? (await this.deps.memories.list(this.workspace.id)).map((memory) => ({ ...memory, path: null })) : [];
          const contexts = this.deps.contexts ? (await this.deps.contexts.list(this.workspace.id)).map((context) => ({ ...context, origin: context.kind === "local-file" ? "local-file://redacted" : redactUrlCredentials(context.origin) ?? context.origin })) : [];
          const connectors = this.deps.connectors ? (await this.deps.connectors.list(this.workspace.id)).map((connector) => ({ ...connector, endpoint: connector.endpoint === null ? null : (connector.kind === "http" || connector.kind === "mcp-remote" ? redactUrlCredentials(connector.endpoint) : "endpoint://redacted"), trustEvidence: connector.trustEvidence.map((evidence) => ({ ...evidence, ref: redactPortableReference(evidence.ref) })) })) : [];
          const providers = this.deps.providers ? (await this.deps.providers.list(this.workspace.id)).map((provider) => ({ ...provider, baseUrl: redactUrlCredentials(provider.baseUrl) ?? provider.baseUrl })) : [];
          const tasks = this.deps.tasks ? await this.deps.tasks.list(this.workspace.id) : [];
          const artifacts = this.deps.artifacts ? (await this.deps.artifacts.list(this.workspace.id)).map(({ path: _path, ...artifact }) => artifact) : [];
          return { exportedAt: new Date().toISOString(), workspace: this.workspace, projects, files: fileBundles, scenarios, memories, contexts, connectors, providers, tasks, artifacts };
        })().then((bundle) => { res.setHeader("content-type", "application/json; charset=utf-8"); res.end(JSON.stringify(bundle)); }).catch((error: unknown) => sendRouteFailure(res, error));
        return;
      }
      if (requestPath.startsWith("/api/share/") && req.method === "GET") {
        const token = requestPath.slice("/api/share/".length);
        void (this.deps.shares ? this.deps.shares.getByToken(token) : Promise.resolve(undefined)).then(async (share) => {
          // Share links are workspace-scoped. A token from another local
          // workspace must never be able to resolve against this panel's
          // current workspace (especially for workspace shares, which use the
          // current workspace object below).
          if (!share || !this.workspace || share.workspaceId !== this.workspace.id) { res.writeHead(404).end(); return; }
          let resource: unknown = null;
          if (share.resourceType === "scenario") {
            const scenario = await this.deps.library?.get(share.resourceId);
            if (!scenario || !this.scenarioInScope(scenario) || scenario.status === "deleted") { res.writeHead(404).end(); return; }
            resource = scenario;
          }
          else if (share.resourceType === "workspace") {
            if (share.resourceId !== this.workspace.id) { res.writeHead(404).end(); return; }
            resource = { workspace: this.workspace, projects: this.deps.repository && this.workspace ? await this.deps.repository.listProjects(this.workspace.id) : [] };
          } else if (share.resourceType === "project") {
            const project = this.deps.repository ? await this.deps.repository.getProject(share.resourceId) : undefined;
            if (!project || project.workspaceId !== this.workspace.id || project.status === "deleted") { res.writeHead(404).end(); return; }
            resource = project;
          } else if (share.resourceType === "artifact") {
            const artifact = this.deps.artifacts ? await this.deps.artifacts.get(share.resourceId) : undefined;
            if (!artifact || artifact.workspaceId !== this.workspace.id || artifact.status === "deleted") { res.writeHead(404).end(); return; }
            // Artifact paths are local filesystem details.  A share token may
            // be opened outside this process, so never expose either the
            // current absolute path or historical version paths through the
            // public resource endpoint.  Keep the rest of the version
            // metadata (including optional text snapshots) available to the
            // read-only share view.
            const publicArtifact = Object.fromEntries(Object.entries(artifact).filter(([key]) => key !== "path"));
            resource = {
              ...publicArtifact,
              versions: artifact.versions.map((version) => Object.fromEntries(Object.entries(version).filter(([key]) => key !== "path"))),
            };
          }
          res.setHeader("content-type", "application/json; charset=utf-8"); res.end(JSON.stringify({ share: { resourceType: share.resourceType, role: share.role, expiresAt: share.expiresAt }, resource }));
        }).catch((error: unknown) => sendRouteFailure(res, error));
        return;
      }
      if (requestPath === "/api/runs/compare" && req.method === "GET") {
        const query = new URL(req.url ?? "", "http://127.0.0.1").searchParams;
        void Promise.all([this.deps.runs?.get(query.get("left") ?? ""), this.deps.runs?.get(query.get("right") ?? "")]).then(([left, right]) => {
          if (!left || !right || !this.workspace || left.workspaceId !== this.workspace.id || right.workspaceId !== this.workspace.id) { res.writeHead(404).end(); return; }
          const leftDetails = (left.details ?? {}) as { trace?: unknown[]; acceptance?: Array<{ passed: boolean }> };
          const rightDetails = (right.details ?? {}) as { trace?: unknown[]; acceptance?: Array<{ passed: boolean }> };
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ left: { id: left.id, status: left.status, model: left.model, durationMs: left.durationMs, tokenCount: left.tokenCount, cost: left.cost, traceCount: leftDetails.trace?.length ?? 0, passed: leftDetails.acceptance?.filter((item) => item.passed).length ?? 0 }, right: { id: right.id, status: right.status, model: right.model, durationMs: right.durationMs, tokenCount: right.tokenCount, cost: right.cost, traceCount: rightDetails.trace?.length ?? 0, passed: rightDetails.acceptance?.filter((item) => item.passed).length ?? 0 } }));
        }).catch((error: unknown) => sendRouteFailure(res, error));
        return;
      }
      if (requestPath.startsWith("/api/runs/") && req.method === "GET") {
        const runId = requestPath.slice("/api/runs/".length);
        void (this.deps.runs ? this.deps.runs.get(runId) : Promise.resolve(undefined)).then((run) => {
          if (!run || !this.workspace || run.workspaceId !== this.workspace.id) { res.writeHead(404).end(); return; }
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify(run));
        }).catch((error: unknown) => sendRouteFailure(res, error));
        return;
      }
      if (req.url?.startsWith("/api/scenario?") && req.method === "GET") {
        const id = new URL(req.url, "http://127.0.0.1").searchParams.get("id") ?? "";
        void (this.deps.library?.get(id) ?? Promise.resolve(undefined)).then((scenario) => {
          if (!scenario || !this.scenarioInScope(scenario) || scenario.status === "deleted") { res.writeHead(404).end(); return; }
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify(scenario));
        }).catch((error: unknown) => sendRouteFailure(res, error));
        return;
      }
      if (requestPath === "/api/ledger-report" && req.method === "GET") {
        // 两角色模型 §6.2：信任报告——seller 拿去对客户/上级说话的证据
        const query = new URL(req.url ?? "", "http://127.0.0.1").searchParams;
        const scenarioId = query.get("scenarioId") ?? "";
        void (this.deps.library?.get(scenarioId) ?? Promise.resolve(undefined)).then((scenario) => {
          if (!scenario || !this.scenarioInScope(scenario) || scenario.status === "deleted") { res.writeHead(404).end(); return; }
          const ledger = ensureLedgerOf(scenario);
          const tierLabel = { replay: "重放", spot: "抽查", full: "全开" }[tierOfLedger(ledger)];
          const curve = ledger.interventions.slice(-30);
          const totalInterventions = curve.reduce((sum, i) => sum + i.total, 0);
          const sparkline = curve.map((i) => `${i.at.slice(5, 16)}  介入 ${i.total}`).join("\n");
          const constraints = activeConstraints(ledger);
          const constraintLines = constraints.map((c) => {
            const entry = ledger.attribution[c.id];
            const gain = entry ? `帮${entry.helped}害${entry.hurt}` : "无归因";
            return `- [${c.kind === "advisory" ? "偏好" : "标准"}] ${c.clause} · 命中 ${c.hits} · ${gain}`;
          });
          const netGains = constraints.map((c) => netGain(ledger, c.id)).filter((v) => v !== null) as number[];
          const avgGain = netGains.length ? (netGains.reduce((sum, v) => sum + v, 0) / netGains.length).toFixed(2) : null;
          const report = [
            `# SceneFlow 信任报告 · ${scenario.name}`,
            "",
            `> 生成时间 ${new Date().toISOString().slice(0, 16)} · 灰度档位 ${tierLabel} · 场景 v${scenario.pinnedVersion}`,
            "",
            "## 头部数字",
            "",
            `- 运行 ${ledger.runStats.runs} · 通过 ${ledger.runStats.accepted} · 打回 ${ledger.runStats.rejected} · 纠正 ${ledger.runStats.corrected}`,
            `- 连续无干预通过 ${ledger.runStats.consecutiveClean}`,
            `- 生效条款 ${constraints.length} · 置信度 ${Math.round(confidence(ledger) * 100) / 100}`,
            netGains.length ? `- 条款平均净增益 ${avgGain}` : "",
            "",
            "## 人工介入曲线（最近 30 次）",
            "",
            curve.length ? "```text\n" + sparkline + "\n```" : "（暂无数据）",
            "",
            "## 生效条款贡献",
            "",
            constraintLines.length ? constraintLines.join("\n") : "（暂无生效条款）",
            "",
            "---",
            "",
            "诚实脚注：suspected 运行不计入归因；无人值守运行沉默不入账；15% 对照组运行不计入条款归因。",
            "",
          ].filter(Boolean).join("\n");
          res.setHeader("content-type", "text/markdown; charset=utf-8");
          res.setHeader("content-disposition", `attachment; filename="trust-report-${scenarioId.slice(0, 20)}.md"`);
          res.end(report);
        }).catch((error: unknown) => sendRouteFailure(res, error));
        return;
      }
      if (requestPath === "/api/scenario/compare" && req.method === "GET") {
        const query = new URL(req.url ?? "", "http://127.0.0.1").searchParams;
        const id = query.get("id") ?? "";
        const version = Number(query.get("version") ?? "0");
        void (this.deps.library?.get(id) ?? Promise.resolve(undefined)).then((scenario) => {
          if (!scenario || !this.scenarioInScope(scenario) || scenario.status === "deleted" || !Number.isInteger(version) || version < 1) { res.writeHead(404).end(); return; }
          const historical = scenario.versionHistory.find((item) => item.version === version);
          if (!historical) { res.writeHead(404).end(); return; }
          const current = { version: scenario.pinnedVersion, capabilityIds: scenario.capabilityIds };
          const removed = historical.capabilityIds.filter((item) => !current.capabilityIds.includes(item));
          const added = current.capabilityIds.filter((item) => !historical.capabilityIds.includes(item));
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ scenarioId: id, current, historical, added, removed }));
        }).catch((error: unknown) => sendRouteFailure(res, error));
        return;
      }
      if (req.url?.startsWith("/api/memory-file")) {
        const reqPath = new URL(req.url, "http://x").searchParams.get("path") ?? "";
        const root = this.deps.memoryRoot ?? "";
        // 仅允许读取 memoryRoot 下的 .md 文件（路径穿越防护）
        const rootResolved = path.resolve(root);
        const resolved = path.resolve(reqPath);
        const relative = path.relative(rootResolved, resolved);
        if (!root || relative.startsWith("..") || path.isAbsolute(relative) || !resolved.endsWith(".md")) {
          res.writeHead(403).end();
          return;
        }
        Promise.all([realpath(rootResolved), realpath(resolved)])
          .then(([realRoot, realFile]) => {
            const realRelative = path.relative(realRoot, realFile);
            if (realRelative.startsWith("..") || path.isAbsolute(realRelative) || !realFile.endsWith(".md")) throw new Error("forbidden");
            return readFile(realFile, "utf8");
          })
          .then((md) => {
            res.setHeader("content-type", "text/markdown; charset=utf-8");
            res.end(md);
          })
          .catch(() => res.writeHead(404).end());
        return;
      }
      if (requestPath === "/api/artifact/diff" && req.method === "GET") {
        const query = new URL(req.url ?? "", "http://127.0.0.1").searchParams;
        const artifactId = query.get("id") ?? "";
        const from = Number(query.get("from") ?? "1");
        const to = Number(query.get("to") ?? "0");
        void (this.deps.artifacts ? this.deps.artifacts.get(artifactId) : Promise.resolve(undefined)).then(async (artifact) => {
          if (!artifact || !this.workspace || artifact.workspaceId !== this.workspace.id) { res.writeHead(404).end(); return; }
          const fromVersion = artifact.versions.find((version) => version.version === from)?.content ?? "";
          let targetContent = artifact.versions.find((version) => version.version === to)?.content ?? "";
          if (to === artifact.version) {
            const artifactProject = artifact.projectId && this.deps.repository ? await this.deps.repository.getProject(artifact.projectId) : undefined;
            if (artifact.projectId && (!artifactProject || artifactProject.workspaceId !== this.workspace.id)) { res.writeHead(404).end(); return; }
            const roots = [artifactProject?.rootPath ?? (artifactProject && this.deps.projectRoot ? path.join(this.deps.projectRoot, artifactProject.id) : undefined), this.deps.artifactRoot]
              .filter((value): value is string => Boolean(value)).map((value) => path.resolve(value));
            const resolved = path.resolve(artifact.path);
            const lexicalAllowed = roots.some((root) => { const relative = path.relative(root, resolved); return !relative.startsWith("..") && !path.isAbsolute(relative); });
            if (!lexicalAllowed) { res.writeHead(403).end(); return; }
            const [realFile, ...maybeRoots] = await Promise.all([realpath(resolved), ...roots.map(async (root) => { try { return await realpath(root); } catch { return null; } })]);
            const realRoots = maybeRoots.filter((root): root is string => Boolean(root));
            const realAllowed = realRoots.some((root) => { const relative = path.relative(root, realFile); return !relative.startsWith("..") && !path.isAbsolute(relative); });
            if (!realAllowed) { res.writeHead(403).end(); return; }
            targetContent = await readFile(realFile, "utf8");
          }
          res.setHeader("content-type", "text/plain; charset=utf-8");
          res.end(renderTextDiff(fromVersion, targetContent, from, to));
        }).catch(() => res.writeHead(404).end());
        return;
      }
      if (req.url?.startsWith("/api/artifact") && req.method === "GET") {
        const artifactQuery = new URL(req.url, "http://x").searchParams;
        const artifactId = artifactQuery.get("id") ?? "";
        const serveArtifact = async (artifactPath: string): Promise<void> => {
          // Only the selected project is a readable project-file root.  When
          // no project is selected (for example after archiving it), including
          // the parent projectRoot would expose every project's files through
          // this path-oriented endpoint.
          const roots = [this.currentProjectRoot(), this.deps.artifactRoot].filter((value): value is string => Boolean(value)).map((value) => path.resolve(value));
          const resolved = path.resolve(artifactPath);
          const allowed = roots.some((root) => {
            const relative = path.relative(root, resolved);
            return !relative.startsWith("..") && !path.isAbsolute(relative);
          });
          if (!allowed) { res.writeHead(403).end(); return; }
          try {
            const [content, realFile, ...maybeRoots] = await Promise.all([readFile(resolved), realpath(resolved), ...roots.map(async (root) => { try { return await realpath(root); } catch { return null; } })]);
            const realRoots = maybeRoots.filter((root): root is string => Boolean(root));
            if (!realRoots.some((root) => { const relative = path.relative(root, realFile); return !relative.startsWith("..") && !path.isAbsolute(relative); })) { res.writeHead(403).end(); return; }
            res.setHeader("content-type", "application/octet-stream"); res.end(content);
          } catch {
            res.writeHead(404).end();
          }
        };
        if (artifactId && this.deps.artifacts && this.workspace) {
          void this.deps.artifacts.get(artifactId).then(async (artifact) => {
            if (!artifact || artifact.workspaceId !== this.workspace!.id || artifact.status === "deleted") { res.writeHead(404).end(); return; }
            await serveArtifact(artifact.path);
          }).catch((error: unknown) => sendRouteFailure(res, error));
          return;
        }
        // R1 审计#10：裸 path 变体允许读取选中项目根/artifactRoot 下任意文件
        // （含 .env 等敏感文件），且面板零鉴权 + 本机任意进程可达。限制为必须
        // 命中当前工作区已登记且未删除的 artifact 记录；前端仅使用带 id 形式，
        // 裸 path 无记录命中一律 404。
        const barePath = artifactQuery.get("path");
        if (barePath && this.deps.artifacts && this.workspace) {
          const resolvedBare = path.resolve(barePath);
          void this.deps.artifacts.list(this.workspace.id)
            .then((items) => items.find((item) => path.resolve(item.path) === resolvedBare))
            .then(async (listed) => {
              if (!listed) { res.writeHead(404).end(); return; }
              await serveArtifact(listed.path);
            })
            .catch((error: unknown) => sendRouteFailure(res, error));
          return;
        }
        res.writeHead(404).end();
        return;
      }
      if (req.url?.startsWith("/api/project-file") && req.method === "GET") {
        const reqPath = new URL(req.url, "http://x").searchParams.get("path") ?? "";
         const root = this.currentProjectRoot() ? path.resolve(this.currentProjectRoot()!) : "";
        const resolved = path.resolve(reqPath);
        const relative = root ? path.relative(root, resolved) : "..";
        if (!root || relative.startsWith("..") || path.isAbsolute(relative)) { res.writeHead(403).end(); return; }
        Promise.all([realpath(root), realpath(resolved)]).then(async ([realRoot, realFile]) => {
          const realRelative = path.relative(realRoot, realFile);
          if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) throw new Error("forbidden");
          const ext = path.extname(realFile).toLowerCase();
          const binaryType: Record<string, string> = { ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
          if (binaryType[ext]) { res.setHeader("content-type", binaryType[ext]); res.setHeader("content-disposition", "inline"); res.end(await readFile(realFile)); return; }
          res.setHeader("content-type", "text/plain; charset=utf-8"); res.end(await readFile(realFile, "utf8"));
        }).catch(() => res.writeHead(404).end());
        return;
      }
      if (requestPath === "/panel.js") {
        readFile(path.join(process.cwd(), "dist", "panel-chat.js"), "utf8")
          .then((js) => {
            res.setHeader("content-type", "text/javascript; charset=utf-8");
            res.setHeader("cache-control", "no-store, max-age=0");
            res.end(js);
          })
          .catch(() => {
            res.writeHead(404).end("panel client not built; run: npm run panel-client");
          });
        return;
      }
      if (requestPath === "/app.css") {
        readFile(path.join(process.cwd(), "dist", "panel-chat.css"), "utf8")
          .then((css) => {
            res.setHeader("content-type", "text/css; charset=utf-8");
            res.setHeader("cache-control", "no-store, max-age=0");
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
      if (process.env.PANEL_DEBUG_BROADCAST === "1") console.log("[panel][ws-connect] clients=", this.clients.size + 1);
      this.clients.add(ws);
      const sendIfOpen = (payload: unknown): void => {
        if (ws.readyState !== ws.OPEN) return;
        try {
          ws.send(JSON.stringify(payload));
        } catch {
          // A client can close between the readyState check and send(). The
          // socket is already unusable; dropping this one response keeps the
          // action promise from becoming an unhandled rejection.
        }
      };
      // R3 审计#5：初始快照 reject 不得成为 unhandledRejection（Node 15+ 直接崩进程）
      void this.snapshot()
        .then((snap) => sendIfOpen({ kind: "snapshot", snapshot: snap }))
        .catch((err: unknown) => console.error("[panel] initial snapshot failed:", err instanceof Error ? err.message : String(err)));
      ws.on("message", (data) => {
        try {
          const serialized = String(data);
          if (Buffer.byteLength(serialized, "utf8") > 64_000) {
            sendIfOpen({ kind: "action-result", ok: false, error: "消息过大" });
            return;
          }
          const raw = JSON.parse(serialized) as Record<string, unknown>;
          if (raw.type === "resume") {
            const afterRevision = typeof raw.afterRevision === "number" ? raw.afterRevision : 0;
            const events = this.eventLog.filter((event) => event.revision > afterRevision);
            sendIfOpen({ kind: "replay", revision: this.revision, events });
            return;
          }
          const requestId = typeof raw.requestId === "string" ? raw.requestId : undefined;
          if (requestId && requestId.length > 256) {
            sendIfOpen({ kind: "action-result", requestId: requestId.slice(0, 256), ok: false, error: "requestId 过长" });
            return;
          }
          if (requestId) {
            const previous = this.requestResults.get(requestId);
            if (previous) {
              if (previous.owner !== ws) { sendIfOpen({ kind: "action-result", requestId, ok: false, error: "requestId 已被其它连接占用" }); return; }
              sendIfOpen({ kind: "action-result", requestId, ...previous.result }); return;
            }
          }
          const pending = requestId ? this.pendingRequests.get(requestId) : undefined;
          if (pending) {
            if (pending.owner !== ws) { sendIfOpen({ kind: "action-result", requestId, ok: false, error: "requestId 已被其它连接占用" }); return; }
            // R1 审计#1：重放分支必须双兜底——原 promise 的 rejection 经由
            // 此派生链时无人接会形成 unhandledRejection 崩溃面板进程
            void pending.promise.then(
              (result) => sendIfOpen({ kind: "action-result", requestId, ...result }),
              (err: unknown) => sendIfOpen({ kind: "action-result", requestId, ok: false, error: err instanceof Error ? err.message : String(err) }),
            );
            return;
          }
          const actionPromise = this.handleAction(raw);
          if (requestId) this.pendingRequests.set(requestId, { owner: ws, promise: actionPromise });
          void actionPromise
            .then((r) => {
              if (requestId) { this.requestResults.set(requestId, { owner: ws, result: r }); if (this.requestResults.size > 500) this.requestResults.delete(this.requestResults.keys().next().value as string); }
              sendIfOpen({ kind: "action-result", requestId, ...r });
            })
            .catch((err: unknown) => {
              const result = { ok: false, error: err instanceof Error ? err.message : String(err) };
              if (requestId) { this.requestResults.set(requestId, { owner: ws, result }); if (this.requestResults.size > 500) this.requestResults.delete(this.requestResults.keys().next().value as string); }
              sendIfOpen({ kind: "action-result", requestId, ...result });
            })
            .finally(() => {
              if (requestId && this.pendingRequests.get(requestId)?.promise === actionPromise) this.pendingRequests.delete(requestId);
            });
        } catch {
          sendIfOpen({ kind: "action-result", ok: false, error: "malformed JSON" });
        }
      });
      ws.on("close", () => this.clients.delete(ws));
    });
    return await new Promise<number>((resolve, reject) => {
      const rejectOnError = (error: Error): void => {
        this.server?.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        const addr = this.server!.address();
        const boundPort = typeof addr === "object" && addr ? addr.port : 0;
        // 只认回环 Host 形态（IPv4/IPv6/localhost），其余 Host 一律 403
        this.allowedHostPorts = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`];
        resolve(boundPort);
      };
      this.server!.once("error", rejectOnError);
      this.server!.once("listening", onListening);
      this.server!.listen(port, "127.0.0.1");
    });
  }

  async stop(): Promise<void> {
    if (this.streamPersistTimer) {
      clearTimeout(this.streamPersistTimer);
      this.streamPersistTimer = undefined;
      await this.persistSession();
    }
    await this.persistenceQueue;
    for (const ws of this.clients) ws.close();
    this.wss?.close();
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  setController(controller: RunController): void {
    this.deps.controller = controller;
  }

  /** Mirror a durable long-run state into the current session inspector. */
  setLongRunState(run: LongRun): void {
    if (run.sessionId !== this.sessionId) return;
    const terminal = ["succeeded", "failed", "cancelled"].includes(run.status);
    this.sessionLocked = !terminal;
    this.activeMode = "work";
    this.activeScenarioId = run.scenarioId;
    this.run = {
      kind: "work",
      status: run.status === "queued" ? "running" : run.status === "running" ? "running" : run.status === "waiting-user" ? "waiting-user" : run.status === "paused" ? "paused" : run.status === "succeeded" ? "succeeded" : run.status === "cancelled" ? "cancelled" : "failed",
      runId: run.id,
      scenarioId: run.scenarioId,
      text: run.lastError ?? run.lastSummary ?? `长程场景第 ${run.completedRounds} 轮`,
    };
    void this.pushSnapshot();
  }

  /** Reconcile a long-run bound to the hydrated session after process restart. */
  async reconcileLongRunState(): Promise<void> {
    if (!this.sessionId || !this.workspace || !this.deps.longRuns) return;
    const run = await this.deps.longRuns.activeForSession(this.workspace.id, this.sessionId);
    if (run) {
      await this.applySessionProject(run.projectId);
      this.setLongRunState(run);
    }
  }

  /** 恢复持久化中的构建，让重启/刷新后当前闸门仍可继续操作。 */
  resumeBuild(runId?: string): void {
    this.sessionLocked = true;
    this.activeMode = "build";
    this.run = { kind: "build", status: "running", ...(runId ? { runId } : {}), text: "正在恢复上次构建" };
  }

  /**
   * Reconcile the in-memory inspector with the durable run row after startup
   * recovery. The launcher may cancel orphaned worker runs after hydrate, so
   * without this explicit step the UI can show a ghost running state.
   */
  async reconcileRunState(): Promise<void> {
    if (!this.sessionId || !this.deps.runs) return;
    await this.restoreRunForSession(this.sessionId);
    await this.pushSnapshot();
  }

  private async hydrateSession(): Promise<void> {
    if (!this.deps.history) return;
    const settings = await this.deps.settings?.get();
    if (settings && (!settings.useHistory || settings.temporarySession)) {
      this.sessionId = null;
      this.sessionTitle = "临时对话";
      this.activeMode = "work";
      this.activeScenarioId = null;
      this.clearChatHistory();
      return;
    }
    const session = (await this.deps.history.latest()) ?? (await this.deps.history.create("work", "新对话", this.projectId));
    this.sessionId = session.id;
    this.sessionTitle = session.title;
    this.activeMode = session.mode;
    this.activeScenarioId = session.activeScenarioId;
    await this.applySessionProject(session.projectId);
    this.setChatHistory(session.messages);
    await this.restoreRunForSession(session.id);
  }

  /** Apply a conversation's project binding without accepting a project from
   * another workspace or a non-runnable archived/deleted project. Old
   * sessions have `undefined` here and keep the current workspace selection. */
  private async applySessionProject(projectId: string | null | undefined): Promise<void> {
    if (projectId === undefined) return;
    if (!projectId) {
      this.projectId = null;
      this.projectProviderId = null;
      this.projectRootPath = null;
      return;
    }
    const project = this.deps.repository && this.workspace ? await this.deps.repository.getProject(projectId) : undefined;
    if (!project || project.workspaceId !== this.workspace?.id || project.status !== "active") {
      const activeProjects = this.workspace && this.deps.repository
        ? (await this.deps.repository.listProjects(this.workspace.id)).filter((item) => item.status === "active")
        : [];
      const replacement = activeProjects.find((item) => item.pinned) ?? activeProjects[0];
      this.projectId = replacement?.id ?? null;
      this.projectProviderId = replacement?.providerId ?? null;
      this.projectRootPath = replacement?.rootPath ?? null;
      return;
    }
    this.projectId = project.id;
    this.projectProviderId = project.providerId;
    this.projectRootPath = project.rootPath ?? null;
  }

  /** Clear a selected scene when navigation moves the conversation to a
   * folder where that scene is not visible. This prevents the old project’s
   * scene from silently becoming the next run’s default. */
  private async syncActiveScenarioScope(projectId: string | null): Promise<void> {
    if (!this.activeScenarioId || !this.deps.library) return;
    const scenario = await this.deps.library.get(this.activeScenarioId);
    if (!scenario || scenario.status !== "active" || !this.scenarioInScope(scenario, projectId)) this.activeScenarioId = null;
  }

  /** A non-current conversation can still own a worker after a reconnect or
   * a stale browser tab. Keep archive/delete from removing the only control
   * path for that worker. */
  private async sessionHasActiveRun(sessionId: string): Promise<boolean> {
    if (this.workspace && this.deps.runs) {
      const activeStatuses = new Set(["queued", "running", "waiting-approval", "waiting-user", "paused"]);
      const runs = await this.deps.runs.listAllForWorkspace(this.workspace.id);
      if (runs.some((run) => run.sessionId === sessionId && activeStatuses.has(run.status))) return true;
    }
    if (this.workspace && this.deps.longRuns) return Boolean(await this.deps.longRuns.activeForSession(this.workspace.id, sessionId));
    return false;
  }

  private async restoreRunForSession(sessionId: string): Promise<void> {
    // Long runs have their own durable store and intentionally do not create
    // an ordinary RunProduct row.  When the user switches back to a history
    // session that owns an active long run, restore that control-plane state
    // first; otherwise the composer would look idle and could start a second
    // run in the same conversation while the long-run worker is still alive.
    if (this.workspace && this.deps.longRuns) {
      const longRun = await this.deps.longRuns.activeForSession(this.workspace.id, sessionId);
      if (longRun) {
        await this.applySessionProject(longRun.projectId);
        this.setLongRunState(longRun);
        return;
      }
    }
    const recent = this.deps.runs ? await this.deps.runs.latestForSession(sessionId) : undefined;
    if (!recent) {
      this.run = { kind: "idle", status: "idle" };
      this.pendingBuildInput = undefined;
      this.sessionLocked = false;
      return;
    }
    const status: PanelSnapshot["run"]["status"] = recent.status === "succeeded" ? "succeeded" : recent.status === "failed" ? "failed" : recent.status === "cancelled" ? "cancelled" : recent.status === "paused" ? "paused" : recent.status === "waiting-approval" ? "waiting-gate" : recent.status === "waiting-user" ? "waiting-user" : recent.status === "running" || recent.status === "queued" ? "running" : "idle";
    this.run = { kind: recent.mode, status, runId: recent.id, text: recent.requirement };
    if (recent.mode === "build" && recent.status === "waiting-user") {
      const request = (recent.details as Record<string, unknown> | null | undefined)?.awaitingUser as BuildClarification | undefined;
      if (request) this.pendingBuildInput = { runId: recent.id, request };
    } else {
      this.pendingBuildInput = undefined;
    }
    // Keep this check tolerant of the persisted run status union. Older
    // records may restore a waiting-approval state as the UI's waiting-gate
    // state, and the string set avoids narrowing that value away in TypeScript.
    this.sessionLocked = ["running", "paused", "waiting-gate", "waiting-user"].includes(String(status));
  }

  private async saveCurrentSession(): Promise<void> {
    if (!this.deps.history || !this.sessionId) return;
    const settings = await this.deps.settings?.get();
    if (settings && (!settings.useHistory || settings.temporarySession)) return;
    const previous = await this.deps.history.get(this.sessionId);
    await this.deps.history.save({
      id: this.sessionId,
      title: this.sessionTitle,
      mode: this.activeMode,
      projectId: this.projectId,
      activeScenarioId: this.activeScenarioId,
      archived: previous?.archived ?? false,
      messages: [...this.persistedChatHistory],
      createdAt: previous?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    this.historyPersistenceError = null;
  }

  private persistSession(): Promise<void> {
    if (!this.deps.history || !this.sessionId) return this.persistenceQueue;
    this.persistenceQueue = this.persistenceQueue.then(() => this.saveCurrentSession()).catch((error: unknown) => {
      const raw = error instanceof Error ? error.message : String(error);
      const text = `历史对话保存失败：${raw.slice(0, 240)}。当前运行仍在内存中，恢复写盘后会自动重试。`;
      this.historyPersistenceError = text;
      const warning = { role: "build-status", tone: "err", text, ts: Date.now() };
      this.persistedChatHistory.push(warning);
      this.chatHistory.push(warning);
      if (this.chatHistory.length > 200) this.chatHistory.shift();
      this.broadcast({ kind: "chat", message: warning });
    });
    return this.persistenceQueue;
  }

  private async safeMemoryFile(requested: string): Promise<string | undefined> {
    const root = this.deps.memoryRoot;
    if (!root) return undefined;
    const rootResolved = path.resolve(root);
    const resolved = path.resolve(requested);
    const relative = path.relative(rootResolved, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative) || !resolved.endsWith(".md")) return undefined;
    try {
      const [realRoot, realFile] = await Promise.all([realpath(rootResolved), realpath(resolved)]);
      const realRelative = path.relative(realRoot, realFile);
      if (realRelative.startsWith("..") || path.isAbsolute(realRelative) || !realFile.endsWith(".md")) return undefined;
      return realFile;
    } catch {
      return undefined;
    }
  }

  private currentProjectRoot(): string | undefined {
    if (!this.projectId) return undefined;
    return this.projectRootPath ?? (this.deps.projectRoot ? path.join(this.deps.projectRoot, this.projectId) : undefined);
  }

  /** Check lexical and canonical containment for a path that must already exist. */
  private async canonicalPathWithin(root: string, target: string): Promise<boolean> {
    const lexicalRoot = path.resolve(root);
    const lexicalTarget = path.resolve(target);
    const relative = path.relative(lexicalRoot, lexicalTarget);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
    try {
      const [realRoot, realTarget] = await Promise.all([realpath(lexicalRoot), realpath(lexicalTarget)]);
      const realRelative = path.relative(realRoot, realTarget);
      return !realRelative.startsWith("..") && !path.isAbsolute(realRelative);
    } catch {
      return false;
    }
  }

  private async recordAudit(action: string, resourceType: string, resourceId: string, summary: string, details: Record<string, unknown> = {}): Promise<void> {
    if (!this.deps.audit || !this.workspace) return;
    await this.deps.audit.append({ id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, workspaceId: this.workspace.id, actor: "user", action, resourceType, resourceId, summary, details });
  }

  broadcast(payload: unknown): void {
    const raw = (typeof payload === "object" && payload !== null ? payload : { payload }) as Record<string, unknown>;
    this.revision += 1;
    const envelope = {
      ...raw,
      eventId: eventId(),
      revision: this.revision,
      sessionId: this.sessionId,
      runId: this.run.runId ?? null,
      terminal: raw.terminal === true || (typeof raw.message === "object" && raw.message !== null && (raw.message as { terminal?: unknown }).terminal === true),
    };
    const event = PanelEventSchema.parse({ eventId: envelope.eventId, revision: envelope.revision, sessionId: envelope.sessionId, runId: envelope.runId, requestId: typeof raw.requestId === "string" ? raw.requestId : null, terminal: envelope.terminal, kind: String(raw.kind ?? "event"), payload: raw, emittedAt: new Date().toISOString() });
    // R1 审计#6：整份快照（数百 KB × 200 条上限）入 eventLog 会把重放缓存
    // 撑到上百 MB 且 resume 时一次性重放全部快照。快照事件只推给在线客户端，
    // 不入 eventLog；断线客户端 resume 后直接拉 /api/snapshot 即为最新态。
    if (raw.kind !== "snapshot") {
      this.eventLog.push(event);
      if (this.eventLog.length > 500) this.eventLog.splice(0, this.eventLog.length - 500);
    }
    const data = JSON.stringify(envelope);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) {
        try { ws.send(data); } catch { /* the socket may close between readyState and send */ }
      }
    }
  }

  private async pushSnapshot(): Promise<void> {
    // R4 审计P1：snapshot() 内含十余个 await IO（runs/library/memoryTree/history/
    // repository/settings），全仓 ~35 处 `void this.pushSnapshot()` 调用点任一 fs 抖动
    // 都会成为 unhandledRejection 崩掉面板进程。在这里一处兜底，全部调用点同时受保护。
    try {
      const snap = await this.snapshot();
      this.broadcast({ kind: "snapshot", snapshot: snap });
    } catch (err) {
      console.error("[panel] pushSnapshot failed:", err instanceof Error ? err.message : String(err));
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }

  get currentWorkspaceId(): string | null { return this.workspace?.id ?? null; }
  get currentProjectId(): string | null { return this.projectId; }
  get currentProjectProviderId(): string | null { return this.projectProviderId; }
  get currentSessionId(): string | null { return this.sessionId; }
  get currentRunId(): string | null { return this.run.runId ?? null; }
  takeRunGuidance(runId?: string): string[] {
    if (!runId) return [];
    const matching = this.pendingRunGuidance.filter((item) => item.runId === runId).map((item) => item.instruction);
    for (let index = this.pendingRunGuidance.length - 1; index >= 0; index -= 1) if (this.pendingRunGuidance[index]!.runId === runId) this.pendingRunGuidance.splice(index, 1);
    return matching;
  }
}

async function readTextBody(req: IncomingMessage, maxBytes = 64_000): Promise<string> {
  // R1 审计#4：逐 chunk String() 解码会把跨 TCP 分段的 UTF-8 多字节字符
  // （中文/emoji）截成 U+FFFD；收集 Buffer 后整体一次性解码
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buf.length;
    if (total > maxBytes) throw new Error("request body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJsonBody(req: IncomingMessage, maxBytes = 64_000): Promise<unknown> {
  const body = await readTextBody(req, maxBytes);
  if (!body.trim()) return {};
  return JSON.parse(body);
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

function editSeedFor(gate: 1 | 2 | 3 | 4 | 5, ctx: unknown): unknown {
  const c = ctx as { intent?: unknown; dag?: unknown; selections?: unknown; candidates?: unknown; acceptance?: unknown };
  switch (gate) {
    case 1:
      return { kind: "intent", intent: c.intent };
    case 2:
      return { kind: "dag", dag: c.dag };
    case 3:
      return {
        kind: "selections",
        selections: c.selections ?? [],
        candidates: Array.isArray(c.candidates)
          ? (c.candidates as Array<{ nodeId?: unknown; candidates?: Array<{ id?: unknown; name?: unknown }> }>).map((set) => ({
            nodeId: String(set.nodeId ?? ""),
            candidates: (set.candidates ?? []).map((candidate) => ({ id: String(candidate.id ?? ""), name: String(candidate.name ?? candidate.id ?? "能力") })),
          }))
          : [],
      };
    case 4:
      return { kind: "acceptance", acceptance: c.acceptance ?? [] };
    case 5:
      return undefined;
  }
}

function canPinBuild(ctx: { executionMode?: string; acceptance?: Array<{ passed: boolean }>; trace?: Array<{ status: string }> }): boolean {
  const acceptance = ctx.acceptance ?? [];
  const trace = ctx.trace ?? [];
  return acceptance.length > 0
    && acceptance.every((record) => record.passed)
    && trace.every((step) => step.status === "success" || step.status === "skipped" || (ctx.executionMode === "construction" && step.status === "planned"));
}

function phaseProgressText(phase: string): string {
  const copy: Record<string, string> = {
    parsing: "我先把你的目标、输入和限制整理清楚。",
    planning: "接下来我会把这件事拆成几步，并说明每一步会产出什么。",
    retrieving: "我正在寻找能完成这些步骤的可靠能力。",
    assembling: "我正在把选中的能力按顺序组合起来。",
    verifying: "我先检查这些能力是否真的可用。",
    executing: "确认无误后，我会按刚才的步骤执行。",
    distilling: "最后我会把这次成功的做法整理成可复用场景。",
  };
  return copy[phase] ?? `我正在处理“${phase}”这一步。`;
}

function renderTextDiff(before: string, after: string, fromVersion: number, toVersion: number): string {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const rows: string[] = [`--- v${fromVersion}`, `+++ v${toVersion}`];
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) {
    if (a[index] === b[index]) { if (a[index] !== undefined) rows.push(`  ${a[index]}`); }
    else { if (a[index] !== undefined) rows.push(`- ${a[index]}`); if (b[index] !== undefined) rows.push(`+ ${b[index]}`); }
  }
  return rows.join("\n");
}

function tokenBudgetForModel(model: string, maxTokens: number): Record<string, number> {
  return /(?:^|\/)(?:gpt-(?:5|6)|o(?:\d|[-_]))/i.test(model)
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };
}

/** 场景工作台：模式切换、对话流、场景库和运行检查台。 */
export function defaultPageHtml(): string {
  return `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>SceneFlow</title><link rel="stylesheet" href="/app.css?v=sceneflow-d59"></head>
<body>
  <div class="app-shell" data-mode="work">
      <header class="topbar" role="banner">
      <div class="brand"><div class="brand-mark">S</div><div><div class="brand-title">SceneFlow</div><div class="brand-subtitle">一句话构建，处处复用</div></div></div>
       <div class="mode-switch" role="tablist" aria-label="工作模式"><button type="button" class="mode-btn active" data-mode="work" role="tab" aria-selected="true" aria-controls="chat-panel" tabindex="0">工作模式</button><button type="button" class="mode-btn" data-mode="build" role="tab" aria-selected="false" aria-controls="chat-panel" tabindex="-1">场景构建</button></div>
       <div class="topbar-spacer"></div><button id="open-rail" class="ghost-btn responsive-rail-toggle" type="button" aria-expanded="false" aria-controls="workspace-rail" aria-label="打开工作区侧栏">☰</button><button id="open-search" class="ghost-btn" type="button" title="全局搜索：对话、场景、Memory、文件" onclick="document.getElementById('search-modal')?.classList.remove('hidden')">⌕ 搜索</button><button id="open-context" class="ghost-btn" type="button" title="桌面上下文与 Host Bridge">⌁ 上下文</button><button id="open-shares" class="ghost-btn" type="button" title="分享令牌管理">⇧ 分享</button><button id="open-runs" class="ghost-btn" type="button" title="运行记录" onclick="document.getElementById('runs-modal')?.classList.remove('hidden')">▶ 运行记录</button><button id="open-inspector" class="ghost-btn responsive-inspector-toggle" type="button" aria-expanded="false" aria-controls="workspace-inspector">▣ 任务详情</button><button id="open-tasks" class="ghost-btn" type="button" title="定时任务" onclick="document.getElementById('tasks-modal')?.classList.remove('hidden')">◷ 任务</button><button id="open-connectors" class="ghost-btn" type="button" onclick="document.getElementById('connector-modal')?.classList.remove('hidden')">⌘ 连接器</button><button id="open-settings" class="ghost-btn" type="button" title="运行设置" onclick="document.getElementById('settings-modal')?.classList.remove('hidden')">⚙ 设置</button><button id="toggle-theme" class="ghost-btn theme-toggle" type="button" aria-label="切换到暗色主题" title="切换主题">☾</button><button id="open-more" class="ghost-btn utility-more" type="button" aria-expanded="false">⋯ 更多</button><div class="connection"><span class="connection-dot" id="connection-dot" aria-hidden="true"></span><span id="connection-text" role="status" aria-live="polite">正在连接</span></div><div id="run-phase" class="run-phase" role="status" aria-live="polite">空闲</div>
    </header>
    <div id="utility-menu" class="utility-menu hidden" role="menu"><button type="button" data-utility-target="open-context" role="menuitem">⌁ 上下文</button><button type="button" data-utility-target="open-shares" role="menuitem">⇧ 分享</button><button type="button" data-utility-target="open-runs" role="menuitem">▶ 运行记录</button><button type="button" data-utility-target="open-tasks" role="menuitem">◷ 任务</button><button type="button" data-utility-target="open-connectors" role="menuitem">⌘ 连接器</button><button type="button" data-utility-target="open-inspector" role="menuitem">▣ 任务详情</button><span class="utility-divider" aria-hidden="true"></span><button id="compact-run-pause" class="hidden" type="button" role="menuitem">暂停当前运行</button><button id="compact-run-resume" class="hidden" type="button" role="menuitem">继续当前运行</button><button id="compact-run-stop" class="hidden utility-danger" type="button">停止当前运行</button></div>
     <div id="rail-backdrop" class="rail-backdrop hidden" aria-hidden="true"></div><main class="workspace-grid">
        <aside id="workspace-rail" class="rail" aria-label="工作区侧栏">
         <section class="rail-section rail-workspace-section">
          <div class="rail-section-head"><div><div class="rail-eyebrow">工作区</div><div class="rail-section-title">项目文件夹</div></div><button id="new-project" class="rail-icon-btn" type="button" aria-label="新建项目文件夹" title="新建项目文件夹">＋</button></div>
          <div class="rail-context-label">当前项目</div><div id="project-list" class="project-list" role="list" aria-label="项目文件夹"></div>
          <details class="rail-secondary"><summary>项目工具</summary><div class="project-actions"><button id="add-file" class="ghost-btn" type="button">添加文件</button><button id="import-workspace" class="ghost-btn" type="button">导入工作区</button><input id="file-picker" type="file" multiple hidden><input id="workspace-picker" type="file" accept="application/json,.json" hidden></div><button id="open-scenarios" class="ghost-btn project-library-action" type="button" aria-label="打开场景库">场景库 <span aria-hidden="true">→</span></button></details>
         </section>
         <section class="rail-section rail-conversation-section">
          <div class="rail-section-head"><div><div class="rail-eyebrow">会话</div><div class="rail-section-title">对话</div></div><button id="new-session" class="rail-new-btn" type="button"><span aria-hidden="true">＋</span> 新建</button></div>
          <p id="mode-copy" class="rail-copy">描述你要完成的工作，我会优先加载合适的场景。</p><div id="session-list" class="session-list"></div>
         </section>
      </aside>
         <section id="chat-panel" class="chat-panel" data-pane="chat" aria-label="对话区">
         <div id="chat-left-progress" class="chat-left-progress" aria-label="阶段进度"></div>
         <div class="chat-head"><div id="chat-kicker" class="chat-kicker">WORKSPACE / WORK</div><div id="chat-title" class="chat-title">今天要完成什么？</div><div id="chat-description" class="chat-description">我会先判断是否有现成场景可用，需要新能力时再带你进入构建流程。</div><div id="chat-context-strip" class="chat-context-strip" aria-label="当前运行上下文"></div></div>
         <div id="chat-root" class="chat-stream" role="log" aria-live="polite" aria-atomic="false" aria-relevant="additions text"></div><nav id="chat-minimap" class="chat-minimap" aria-label="信息快速跳转"></nav><button id="jump-latest" class="jump-latest hidden" type="button" aria-hidden="true">↓ 查看最新消息</button>
         <div class="composer-wrap"><div id="command-menu" class="command-menu hidden" role="listbox" aria-label="斜杠命令建议"></div><div class="composer"><textarea id="req-input" rows="2" aria-label="需求输入" aria-controls="command-menu" aria-expanded="false" autocomplete="off" placeholder="描述一个要完成的工作，例如：整理 /data/meeting.md 并生成行动项"></textarea><button id="req-go" class="send-btn" type="button" aria-label="发送">↑</button></div><div id="composer-hint" class="composer-hint">回车发送 · 输入 / 查看命令 · Shift + 回车换行</div></div>
      </section>
      <div id="inspector-backdrop" class="inspector-backdrop hidden" aria-hidden="true"></div>
      <aside id="workspace-inspector" class="inspector" data-pane="preview" aria-label="任务详情">
        <div class="inspector-head"><div><div class="inspector-title">任务详情</div><div id="inspector-subtitle" class="inspector-subtitle">等待一个工作需求</div></div><div class="run-controls"><button id="run-pause" class="ghost-btn hidden" type="button">暂停</button><button id="run-resume" class="ghost-btn hidden" type="button">继续</button><button id="run-stop" class="danger-btn hidden" type="button">停止</button></div></div><div id="run-alert" class="run-alert hidden" role="status" aria-live="polite"></div><div id="long-run-summary" class="run-meta hidden" role="status" aria-live="polite"></div>
        <section class="inspector-section"><div class="section-label">本次目标</div><div id="preview-goal" class="goal-card">还没有开始运行</div><div class="progress-track"><span class="progress-step"></span><span class="progress-step"></span><span class="progress-step"></span><span class="progress-step"></span><span class="progress-step"></span></div><div class="progress-caption"><span id="progress-label">等待输入</span><span id="progress-count">0 / 5</span></div></section>
         <section class="inspector-section"><div class="section-label">本次上下文</div><div id="context-view" class="context-view"><div class="inspector-subtitle">运行前会冻结项目指令、文件、Memory、连接器和 Provider</div></div></section><section class="inspector-section"><div class="section-label">任务流程</div><div id="dag-view" class="dag-list"><div class="inspector-subtitle">构建或运行后显示</div></div></section>
        <section class="inspector-section"><div class="section-label">能力选型</div><div id="sel-view" class="selection-list"><div class="inspector-subtitle">尚未选择能力</div></div></section>
        <section class="inspector-section"><div class="section-label">验收结果</div><div id="acc-view" class="acceptance-list"><div class="acceptance-row"><span class="acceptance-icon">—</span><span>等待执行</span></div></div></section>
       <details class="inspector-section inspector-collapsible"><summary class="section-label">项目文件</summary><div id="file-list" class="file-list"><div class="inspector-subtitle">选择项目后添加文件</div></div></details><details class="inspector-section inspector-collapsible"><summary class="section-label">产物</summary><div id="artifact-list" class="file-list"><div class="inspector-subtitle">运行后生成的产物会出现在这里</div></div></details>
        <div class="side-tabs" role="tablist" aria-label="检查台详情"><button id="tab-memory-button" type="button" class="side-tab active" data-tab="memory" role="tab" aria-selected="true" aria-controls="tab-memory" tabindex="0">Memory</button><button id="tab-scenarios-button" type="button" class="side-tab" data-tab="scenarios" role="tab" aria-selected="false" aria-controls="tab-scenarios" tabindex="-1">场景信息</button></div>
        <div id="tab-memory" role="tabpanel" aria-labelledby="tab-memory-button"><div class="memory-actions"><button id="new-memory" class="ghost-btn" type="button">＋ 添加 Memory</button><button id="delete-selected-memory" class="session-action session-delete" type="button">删除选中</button></div><div id="memory-tree" class="memory-tree"></div><div id="memory-viewer" class="memory-viewer hidden"></div></div><div id="tab-scenarios" class="hidden" role="tabpanel" aria-labelledby="tab-scenarios-button"><div id="scenario-detail" class="memory-viewer">选择一个场景查看版本和使用统计。</div></div>
      </aside>
    </main>
  </div>
  <div id="settings-modal" class="settings-modal hidden" role="dialog" aria-modal="true" aria-labelledby="settings-title">
    <div class="settings-card"><div class="settings-head"><div><div id="settings-title" class="inspector-title">运行设置</div><div class="inspector-subtitle">配置规划模型和本地兼容 API</div></div><button id="close-settings" class="ghost-btn" type="button">关闭</button></div>
       <label class="settings-field">Provider<select id="setting-provider"><option value="">默认设置</option></select></label>
       <label class="settings-field">API 地址<input id="setting-base-url" type="url" placeholder="http://127.0.0.1:8317/v1"></label>
        <label class="settings-field">默认模型<input id="setting-model" type="text" placeholder="gpt-6.1-sol"></label>
        <label class="settings-field">规划模型（可选）<input id="setting-planner-model" type="text" placeholder="留空使用默认模型"></label>
        <label class="settings-field">Fallback 模型（可选）<input id="setting-fallback-model" type="text" placeholder="主模型失败时切换"></label>
        <div class="settings-inline"><label class="settings-field">温度<input id="setting-temperature" type="number" min="0" max="2" step="0.1"></label><label class="settings-field">最大输出 Token<input id="setting-max-tokens" type="number" min="1" max="128000" step="1" placeholder="不限制"></label></div>
        <label class="settings-field">同步端点（可选）<input id="setting-sync-endpoint" type="url" placeholder="http://127.0.0.1:4321"></label>
        <label class="settings-field">同步 Token（可选，写入加密凭据库）<input id="setting-sync-token" type="password" autocomplete="new-password" placeholder="自托管同步服务的 Bearer Token"></label>
      <label class="settings-field">API Key<input id="setting-api-key" type="password" placeholder="留空表示保持当前 Key"></label>
       <label class="settings-field">请求超时（毫秒）<input id="setting-timeout" type="number" min="1000" max="180000" step="1000"></label>
       <fieldset class="scope-field"><legend>数据控制</legend><label><input id="setting-use-history" type="checkbox" checked>保存历史对话</label><label><input id="setting-auto-memory" type="checkbox" checked>启用 Memory</label><label><input id="setting-temporary" type="checkbox">临时会话</label><label><input id="setting-streaming" type="checkbox" checked>流式规划</label></fieldset>
       <details class="gate-advanced"><summary>Provider 配置</summary><div id="provider-list" class="connector-list"></div><label class="settings-field">名称<input id="provider-name" type="text" placeholder="例如：本地规划器"></label><label class="settings-field">类型<select id="provider-kind"><option value="openai-compatible">OpenAI Compatible</option><option value="openrouter">OpenRouter</option><option value="anthropic">Anthropic</option><option value="local">本地模型</option></select></label><label class="settings-field">API 地址<input id="provider-base-url" type="url" placeholder="http://127.0.0.1:8317/v1"></label><label class="settings-field">模型<input id="provider-model" type="text" placeholder="gpt-6.1-sol"></label><label class="settings-field">Secret（可选，写入加密凭据库）<input id="provider-secret" type="password" autocomplete="new-password"></label><button id="save-provider" class="primary-btn" type="button">添加 Provider</button><div id="provider-result" class="settings-result"></div></details><details class="gate-advanced"><summary>本地身份与角色</summary><div id="identity-list" class="connector-list"></div><label class="settings-field">显示名称<input id="identity-name" type="text" placeholder="例如：团队成员"></label><label class="settings-field">角色<select id="identity-role"><option value="viewer">查看</option><option value="user">使用</option><option value="editor">编辑</option><option value="publisher">发布</option><option value="admin">管理</option></select></label><button id="save-identity" class="primary-btn" type="button">创建身份</button><div id="identity-result" class="settings-result"></div></details>
       <div id="settings-key-status" class="settings-note"></div><div class="settings-actions"><button id="save-settings" class="primary-btn" type="button">保存设置</button><button id="test-settings" class="ghost-btn" type="button">验证模型连接</button><button id="sync-preview" class="ghost-btn" type="button">同步预览</button><button id="sync-apply" class="ghost-btn" type="button">应用同步</button></div><div id="settings-result" class="settings-result"></div>
    </div>
  </div>
  <div id="search-modal" class="settings-modal hidden" role="dialog" aria-modal="true" aria-labelledby="search-title">
    <div class="settings-card"><div class="settings-head"><div><div id="search-title" class="inspector-title">全局搜索</div><div class="inspector-subtitle">搜索对话、场景、Memory、文件、运行和产物</div></div><button id="close-search" class="ghost-btn" type="button">关闭</button></div><label class="settings-field">关键词<input id="search-query" type="search" placeholder="例如：报告、filesystem、项目名"></label><div class="settings-actions"><button id="run-search" class="primary-btn" type="button">搜索</button></div><div id="search-result" class="search-result"></div></div>
  </div>
  <div id="context-modal" class="settings-modal hidden" role="dialog" aria-modal="true" aria-labelledby="context-title">
    <div class="settings-card"><div class="settings-head"><div><div id="context-title" class="inspector-title">桌面上下文</div><div class="inspector-subtitle">导入当前文件、剪贴板、终端或浏览器中的可控文本</div></div><button id="close-context" class="ghost-btn" type="button">关闭</button></div><div class="context-bridge"><strong>Host Bridge</strong><span id="host-bridge-info">读取接入地址…</span><button id="copy-host-bridge" class="session-action" type="button">复制接入信息</button></div><div id="context-list" class="connector-list"></div><label class="settings-field">类型<select id="context-kind"><option value="note">笔记</option><option value="local-file">本地文件</option><option value="clipboard">剪贴板</option><option value="terminal">终端输出</option><option value="browser">浏览器页面</option></select></label><label class="settings-field">来源<input id="context-origin" type="text" placeholder="文件路径、窗口标题或 URL"></label><label class="settings-field">名称<input id="context-label" type="text" placeholder="例如：当前选中的代码"></label><label class="settings-field">内容<textarea id="context-content" rows="6" placeholder="粘贴或导入需要参与本次运行的内容"></textarea></label><div class="settings-actions"><button id="paste-context" class="ghost-btn" type="button">读取剪贴板</button><button id="save-context" class="primary-btn" type="button">保存上下文</button></div><div id="context-result" class="settings-result"></div></div>
  </div>
  <div id="shares-modal" class="settings-modal hidden" role="dialog" aria-modal="true" aria-labelledby="shares-title">
    <div class="settings-card"><div class="settings-head"><div><div id="shares-title" class="inspector-title">分享中心</div><div class="inspector-subtitle">管理项目、场景和产物分享令牌</div></div><button id="close-shares" class="ghost-btn" type="button">关闭</button></div><div id="shares-list" class="connector-list"></div><label class="settings-field">资源类型<select id="share-type"><option value="workspace">工作区</option><option value="project">项目</option><option value="scenario">场景</option><option value="artifact">产物</option></select></label><label class="settings-field">资源 ID<input id="share-resource" type="text" placeholder="选择资源后自动填写，或手动填写"></label><label class="settings-field">角色<select id="share-role"><option value="viewer">查看</option><option value="user">使用</option><option value="editor">编辑</option><option value="publisher">发布</option><option value="admin">管理</option></select></label><div class="settings-actions"><button id="create-share" class="primary-btn" type="button">创建分享令牌</button></div><div id="share-result" class="settings-result"></div></div>
  </div>
  <div id="project-modal" class="settings-modal hidden" role="dialog" aria-modal="true" aria-labelledby="project-title">
    <div class="settings-card"><div class="settings-head"><div><div id="project-title" class="inspector-title">新建项目</div><div class="inspector-subtitle">项目会成为文件、Memory、场景和运行的上下文边界</div></div><button id="close-project" class="ghost-btn" type="button">关闭</button></div>
      <label class="settings-field">项目名称<input id="project-name" type="text" placeholder="例如：毫米波雷达项目"></label>
       <label class="settings-field">项目说明<textarea id="project-description" rows="3" placeholder="这个项目长期要完成什么"></textarea></label><label class="settings-field">项目默认 Provider<select id="project-provider"><option value="">默认设置</option></select></label><label class="settings-field">项目指令<textarea id="project-instructions" rows="4" placeholder="默认输出格式、语气、约束和必须遵守的规则"></textarea></label>
       <div class="settings-actions"><button id="save-project" class="primary-btn" type="button">创建项目</button></div><div id="project-result" class="settings-result"></div>
    </div>
  </div>
  <div id="new-session-modal" class="settings-modal hidden" role="dialog" aria-modal="true" aria-labelledby="new-session-title">
    <div class="settings-card session-choice-card"><div class="settings-head"><div><div id="new-session-title" class="inspector-title">新建对话</div><div class="inspector-subtitle">先选项目文件夹，再选择要使用的场景；也可以从空白对话开始。</div></div><button id="close-new-session" class="ghost-btn" type="button">关闭</button></div>
      <label class="settings-field work-only">项目文件夹<select id="new-session-project"><option value="">不绑定项目</option></select></label>
      <div class="session-folder-import work-only"><button id="choose-session-folder" class="ghost-btn" type="button">选择并绑定真实文件夹</button><div id="new-session-folder-hint" class="settings-note">选择本地文件夹后直接绑定为项目工作目录，文件不会复制到应用数据目录。</div></div>
      <label class="settings-field">启动场景<select id="new-session-scenario"><option value="">空白对话（自动匹配场景）</option></select></label>
      <div id="new-session-scenario-hint" class="settings-note">选择场景后，发送需求会直接在这段对话里使用它。</div>
      <label class="scope-field"><input id="new-session-long-run" type="checkbox">将下一条需求作为长程场景运行</label>
      <label class="settings-field" id="new-session-rounds-field">轮次上限<input id="new-session-max-rounds" type="number" min="1" max="50" value="3"></label>
      <div class="settings-actions"><button id="create-new-session" class="primary-btn" type="button">开始对话</button></div><div id="new-session-result" class="settings-result"></div>
    </div>
  </div>
  <div id="scenario-modal" class="settings-modal hidden" role="dialog" aria-modal="true" aria-labelledby="scenario-title">
    <div class="settings-card scenario-library-modal"><div class="settings-head"><div><div id="scenario-title" class="inspector-title">场景库</div><div class="inspector-subtitle">管理已固化的长期工作流。新建对话时选择要使用的场景。</div></div><button id="close-scenarios" class="ghost-btn" type="button">关闭</button></div>
      <div class="scenario-toolbar"><input id="scenario-filter" type="search" placeholder="筛选场景、标签或目标" aria-label="筛选场景"><button id="import-scenario" class="ghost-btn" type="button">导入</button><input id="scenario-picker" type="file" accept="application/json,.json" hidden></div><div id="scenario-cards" class="scenario-list"></div>
    </div>
  </div>
  <div id="file-modal" class="settings-modal hidden" role="dialog" aria-modal="true" aria-labelledby="file-preview-title">
    <div class="settings-card file-preview-card"><div class="settings-head"><div><div id="file-preview-title" class="inspector-title">文件预览</div><div class="inspector-subtitle">只读预览项目文件内容</div></div><button id="close-file" class="ghost-btn" type="button">关闭</button></div><pre id="file-preview-content" class="file-preview-content"></pre></div>
  </div>
  <div id="memory-modal" class="settings-modal hidden" role="dialog" aria-modal="true" aria-labelledby="memory-title">
    <div class="settings-card"><div class="settings-head"><div><div id="memory-title" class="inspector-title">添加 Memory</div><div class="inspector-subtitle">保存一条可管理的长期上下文</div></div><button id="close-memory" class="ghost-btn" type="button">关闭</button></div>
      <label class="settings-field">作用域<select id="memory-scope"><option value="global">全局</option><option value="project">项目</option><option value="session">会话</option><option value="scenario">场景</option></select></label>
      <label class="settings-field">标题<input id="memory-name" type="text" placeholder="例如：报告输出偏好"></label>
      <label class="settings-field">内容<textarea id="memory-content" rows="6" placeholder="要长期记住的事实、规则或经验"></textarea></label>
      <div class="settings-actions"><button id="save-memory" class="primary-btn" type="button">保存 Memory</button></div><div id="memory-result" class="settings-result"></div>
    </div>
  </div>
  <div id="connector-modal" class="settings-modal hidden" role="dialog" aria-modal="true" aria-labelledby="connector-title">
    <div class="settings-card"><div class="settings-head"><div><div id="connector-title" class="inspector-title">连接器中心</div><div class="inspector-subtitle">查看已接入能力、权限范围和健康状态</div></div><button id="close-connectors" class="ghost-btn" type="button">关闭</button></div>
      <div id="connector-list" class="connector-list"></div><details class="gate-advanced"><summary>工作区权限策略</summary><div id="policy-list" class="scope-field"></div><div class="settings-actions"><button id="save-policy" class="primary-btn" type="button">保存权限策略</button></div><div id="policy-result" class="settings-result"></div></details>
       <details class="gate-advanced"><summary>添加连接器</summary><label class="settings-field">名称<input id="connector-name" type="text" placeholder="例如：项目 MCP"></label><label class="settings-field">类型<select id="connector-kind"><option value="mcp-remote">远程 MCP</option><option value="mcp-local">本地 MCP</option><option value="cli">CLI 命令</option><option value="http">HTTP API</option><option value="skill">Skill/Knowledge</option></select></label><label class="settings-field">地址或命令<input id="connector-endpoint" type="text" placeholder="https://example.com/mcp 或 node server.js"></label><label class="settings-field">来源<select id="connector-source"><option value="user">用户添加</option><option value="catalog">官方/目录</option><option value="imported">导入</option><option value="host">宿主</option></select></label><label class="settings-field">信任证据链接（可选）<input id="connector-evidence" type="url" placeholder="官方文档或仓库地址"></label><label class="settings-field">Secret（可选，写入加密凭据库）<input id="connector-secret" type="password" autocomplete="new-password"></label><fieldset class="scope-field"><legend>允许的权限</legend><label><input id="connector-scope-read" type="checkbox" checked>读取</label><label><input id="connector-scope-network" type="checkbox" checked>联网</label><label><input id="connector-scope-write" type="checkbox">写入</label><label><input id="connector-scope-install" type="checkbox">安装</label><label><input id="connector-scope-send" type="checkbox">外发</label></fieldset><div class="settings-actions"><button id="save-connector" class="primary-btn" type="button">添加连接器</button></div></details>
      <div id="connector-result" class="settings-result"></div>
    </div>
  </div>
  <div id="runs-modal" class="settings-modal hidden" role="dialog" aria-modal="true" aria-labelledby="runs-title">
    <div class="settings-card"><div class="settings-head"><div><div id="runs-title" class="inspector-title">运行中心</div><div class="inspector-subtitle">查看每次工作和构建的状态、模型和结果</div></div><div class="settings-actions"><button id="compare-runs" class="ghost-btn" type="button">对比选中</button><button id="close-runs" class="ghost-btn" type="button">关闭</button></div></div><div id="run-list" class="run-list"></div><pre id="run-compare-result" class="file-preview-content hidden"></pre><details class="gate-advanced"><summary>审批与权限审计</summary><div id="audit-list" class="run-list"></div></details></div>
  </div>
  <div id="run-detail-modal" class="settings-modal hidden" role="dialog" aria-modal="true" aria-labelledby="run-detail-title">
    <div class="settings-card file-preview-card"><div class="settings-head"><div><div id="run-detail-title" class="inspector-title">运行详情</div><div class="inspector-subtitle">计划、节点、验收、上下文和错误证据</div></div><div class="settings-actions"><button id="retry-run-detail" class="ghost-btn" type="button">重试</button><button id="branch-run-detail" class="ghost-btn" type="button">创建分支</button><button id="close-run-detail" class="ghost-btn" type="button">关闭</button></div></div><pre id="run-detail-content" class="file-preview-content"></pre><label class="settings-field">添加评论<textarea id="run-comment-body" rows="3" placeholder="记录决策、问题或交接说明"></textarea></label><div class="settings-actions"><button id="save-run-comment" class="primary-btn" type="button">保存评论</button></div><div id="run-comments" class="run-list"></div></div>
  </div>
  <div id="tasks-modal" class="settings-modal hidden" role="dialog" aria-modal="true" aria-labelledby="tasks-title">
    <div class="settings-card"><div class="settings-head"><div><div id="tasks-title" class="inspector-title">后台任务</div><div class="inspector-subtitle">管理一次性、周期和事件触发的任务</div></div><button id="close-tasks" class="ghost-btn" type="button">关闭</button></div><div id="task-list" class="run-list"></div><details class="gate-advanced" open><summary>添加任务</summary><label class="settings-field">任务内容<input id="task-requirement" type="text" placeholder="例如：每天整理项目资料并生成摘要"></label><label class="settings-field">触发计划<input id="task-schedule" type="text" placeholder="once / every 1h / 09:00"></label><div class="settings-actions"><button id="save-task" class="primary-btn" type="button">添加任务</button></div><div id="task-result" class="settings-result"></div></details></div>
  </div>
  <script type="module" src="/panel.js?v=sceneflow-d59"></script>
</body>
</html>`;
}
