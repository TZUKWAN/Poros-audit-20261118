import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { WebSocket } from "ws";
import { mkdtemp, rm, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer as createHttpServer } from "node:http";
import { PanelServer, defaultPageHtml, type PanelSnapshot, type PanelDeps } from "@/panel/server";
import { PanelHistory, PanelSessionSchema } from "@/panel/history";
import { PanelSettingsSchema, PanelSettingsStore } from "@/panel/settings";
import { ConnectorRepository, WorkspaceRepository, ProjectFileSchema } from "@/product/repository";
import { ArtifactRepository } from "@/product/artifacts";
import { ProviderProfileRepository } from "@/product/providers";
import { ScheduledTaskRepository } from "@/product/tasks";
import { LongRunRepository } from "@/product/long-runs";
import { MemoryRepository } from "@/product/memory";
import { RunRepository } from "@/product/runs";
import { DesktopContextRepository } from "@/product/contexts";
import { ShareLinkRepository } from "@/product/shares";
import { CommentRepository, CommentSchema } from "@/product/comments";
import { SecretRepository } from "@/product/secrets";
import { ArtifactSchema, ConnectorSchema, LongRunSchema, MemoryItemSchema, ProjectSchema, ProviderProfileSchema, RunProductSchema, ScheduledTaskSchema, WorkspaceSchema } from "@/product/contracts";
import { DesktopContextSchema } from "@/product/contexts";
import { ShareLinkSchema } from "@/product/shares";
import { SecretRecordSchema } from "@/product/secrets";
import { WorkspaceSyncServer } from "@/product/sync-server";
import { RemoteSyncEnvelopeSchema } from "@/product/sync-client";
import { createOrchestrator } from "@/orchestrator/runner";
import { memoryBuildStore } from "@/orchestrator/build-store";
import { RunController } from "@/execution/repair";
import { ScenarioLibrary, ScenarioRecordSchema, recordFromDistilled } from "@/scenario/library";
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

/** WS 客户端测试帮手：收消息到队列，可等特定 kind（+可选谓词），FIFO 匹配 */
class WsClient {
  private queue: Array<Record<string, unknown>> = [];
  private waiters: Array<{ kind: string; predicate?: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void }> = [];
  private ws: WebSocket;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("message", (data) => {
      const msg = JSON.parse(String(data)) as Record<string, unknown>;
      const idx = this.waiters.findIndex((w) => this.match(w, msg));
      if (idx >= 0) {
        const [waiter] = this.waiters.splice(idx, 1);
        waiter!.resolve(msg);
      } else {
        this.queue.push(msg);
      }
    });
  }

  private match(w: { kind: string; predicate?: (m: Record<string, unknown>) => boolean }, msg: Record<string, unknown>): boolean {
    if (w.kind !== msg.kind) return false;
    if (!w.predicate) return true;
    try {
      return w.predicate(msg);
    } catch {
      return false;
    }
  }

  async open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
  }

  async waitFor(kind: string, predicate?: (m: Record<string, unknown>) => boolean, timeoutMs = 8000): Promise<Record<string, unknown>> {
    const matchInQueue = (m: Record<string, unknown>): boolean => this.match({ kind, predicate }, m);
    const found = this.queue.find((m) => matchInQueue(m));
    if (found) {
      this.queue = this.queue.filter((m) => m !== found);
      return found;
    }
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting ${kind}`)), timeoutMs);
      this.waiters.push({
        kind,
        predicate,
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
let history: PanelHistory;
let library: ScenarioLibrary;
let settings: PanelSettingsStore;
let repository: WorkspaceRepository;
let projectId: string;
let connectors: ConnectorRepository;
let artifacts: ArtifactRepository;
let providers: ProviderProfileRepository;
let tasks: ScheduledTaskRepository;
let longRuns: LongRunRepository;
let memories: MemoryRepository;
let contexts: DesktopContextRepository;
let runs: RunRepository;
let shares: ShareLinkRepository;
let secrets: SecretRepository;
let comments: CommentRepository;
const controller = new RunController();

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "panel-"));
  for (const p of ["sessions", "scenarios", "knowledge", "runs"]) await mkdir(path.join(dir, p), { recursive: true });
  orch = createOrchestrator({ handlerDeps: deps(), store: memoryBuildStore() });
  library = new ScenarioLibrary({ store: jsonStore({ filePath: path.join(dir, "s.json"), schema: z.unknown() }) });
  history = new PanelHistory(jsonStore({ filePath: path.join(dir, "sessions.json"), schema: PanelSessionSchema }));
  settings = new PanelSettingsStore(jsonStore({ filePath: path.join(dir, "settings.json"), schema: PanelSettingsSchema }), {
    OPENROUTER_BASE_URL: "https://example.test/v1",
    OPENROUTER_MODEL: "test-model",
    OPENROUTER_API_KEY: "secret-key",
  });
  repository = new WorkspaceRepository(
    jsonStore({ filePath: path.join(dir, "workspaces.json"), schema: WorkspaceSchema }),
    jsonStore({ filePath: path.join(dir, "projects.json"), schema: ProjectSchema }),
    jsonStore({ filePath: path.join(dir, "project-files.json"), schema: ProjectFileSchema }),
  );
  connectors = new ConnectorRepository(jsonStore({ filePath: path.join(dir, "connectors.json"), schema: ConnectorSchema }));
  artifacts = new ArtifactRepository(jsonStore({ filePath: path.join(dir, "artifacts.json"), schema: ArtifactSchema }));
  providers = new ProviderProfileRepository(jsonStore({ filePath: path.join(dir, "providers.json"), schema: ProviderProfileSchema }));
  tasks = new ScheduledTaskRepository(jsonStore({ filePath: path.join(dir, "tasks.json"), schema: ScheduledTaskSchema }));
  longRuns = new LongRunRepository(jsonStore({ filePath: path.join(dir, "long-runs.json"), schema: LongRunSchema }));
  memories = new MemoryRepository(jsonStore({ filePath: path.join(dir, "memory-items.json"), schema: MemoryItemSchema }));
  contexts = new DesktopContextRepository(jsonStore({ filePath: path.join(dir, "contexts.json"), schema: DesktopContextSchema }));
  runs = new RunRepository(jsonStore({ filePath: path.join(dir, "runs.json"), schema: RunProductSchema }));
  shares = new ShareLinkRepository(jsonStore({ filePath: path.join(dir, "shares.json"), schema: ShareLinkSchema }));
  secrets = new SecretRepository(jsonStore({ filePath: path.join(dir, "secrets.json"), schema: SecretRecordSchema }));
  comments = new CommentRepository(jsonStore({ filePath: path.join(dir, "comments.json"), schema: CommentSchema }));
  const workspace = await repository.getDefaultWorkspace();
  projectId = (await repository.createProject(workspace.id, "测试项目")).id;
  server = new PanelServer({
    orchestrator: orch,
    library,
    controller,
    history,
    settings,
    repository,
    connectors,
    artifacts,
    providers,
    tasks,
    longRuns,
    memories,
    contexts,
    runs,
    shares,
    secrets,
    comments,
    onTestScenario: async () => ({ passed: true, attempts: [{ inputs: { path: "/a" }, passed: true }] }),
    projectRoot: path.join(dir, "projects"),
    artifactRoot: path.join(dir, "runs"),
    memoryRoot: dir,
    pageHtml: defaultPageHtml(),
    onStartLongRun: async () => ({ ok: true }),
    onControlLongRun: async (run, action) => {
      if (action === "pause") await longRuns.update(run.id, { status: "paused", lastError: "已暂停" }, run.revision);
      if (action === "resume") await longRuns.update(run.id, { status: "queued", lastError: null, pauseRequested: false }, run.revision);
      if (action === "stop") await longRuns.update(run.id, { status: "cancelled", terminalReason: "cancelled", lastError: "已停止", finishedAt: new Date().toISOString() }, run.revision);
      return { ok: true };
    },
  });
  server.attachOrchestrator(orch);
  port = await server.start(0);
});
afterEach(async () => {
  await server.stop();
  await rm(dir, { recursive: true, force: true });
});

describe("8.1 面板服务：连接/快照一致/断线重连", () => {
  it("HTML 双栏骨架（左对话/右预览） + /api/snapshot 可用", async () => {
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    expect(html).toContain('data-pane="chat"');
    expect(html).toContain('id="chat-root"');
    expect(html).toContain('data-pane="preview"');
    expect(html).toContain('data-mode="work"');
    expect(html).toContain('data-mode="build"');
    expect(html).toContain('id="preview-goal"');
    expect(html).toContain('id="scenario-cards"');
    expect(html).toContain('id="memory-tree"');
    expect(html).toContain('id="session-list"');
    expect(html).toContain('id="new-session-modal"');
    expect(html).toContain('id="new-session-project"');
    expect(html).toContain('id="choose-session-folder"');
    expect(html).toContain('id="new-session-scenario"');
    expect(html).toContain('id="new-session-long-run"');
    expect(html).toContain('id="new-session-max-rounds"');
    expect(html).toContain('id="long-run-summary"');
    expect(html).toContain('id="scenario-modal"');
    expect(html).toContain('<details class="rail-secondary"><summary>项目工具</summary>');
    expect(html).toMatch(/<details class="rail-secondary">[\s\S]*id="open-scenarios"[\s\S]*<\/details>/);
    expect(html.match(/id="open-scenarios"/g) ?? []).toHaveLength(1);
    expect(html).not.toContain('class="rail-section rail-library-section"');
    expect(html).toContain('id="settings-modal"');
    expect(html).toContain('id="jump-latest"');
    expect(html).toContain('id="run-alert"');
    expect(html).toContain('role="log"');
    expect(html).toContain('aria-live="polite"');
    const buttonTags = [...html.matchAll(/<button\b[^>]*>/g)].map((match) => match[0]);
    expect(buttonTags.filter((tag) => !/\btype="button"/.test(tag))).toHaveLength(0);
    for (const modal of ["settings", "search", "context", "shares", "project", "file", "memory", "connector", "runs", "run-detail", "tasks"]) {
      expect(html).toContain(`id="${modal}-modal"`);
      const titleId = modal === "run-detail" ? "run-detail-title" : modal === "file" ? "file-preview-title" : `${modal}-title`;
      expect(html).toContain(`aria-labelledby="${titleId}"`);
    }
    const js = await (await fetch(`http://127.0.0.1:${port}/panel.js`)).text();
    expect(js.length).toBeGreaterThan(10_000); // 打包后的 chat client（含 pi-web-ui）
    expect((await fetch(`http://127.0.0.1:${port}/panel.js`)).headers.get("cache-control")).toContain("no-store");
    const workspaceExport = await fetch(`http://127.0.0.1:${port}/api/workspace/export`);
    expect(workspaceExport.status).toBe(200);
    expect((await workspaceExport.json()).workspace.name).toBe("个人工作区");
    const hostInfo = await (await fetch(`http://127.0.0.1:${port}/api/host-context/info`)).json() as { token: string };
    const hostContext = await fetch(`http://127.0.0.1:${port}/api/host-context`, { method: "POST", headers: { "content-type": "application/json", "x-scenario-host-token": hostInfo.token }, body: JSON.stringify({ kind: "clipboard", origin: "clipboard", label: "host smoke", content: "host text" }) });
    expect(hostContext.status).toBe(200);
    expect(((await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json()) as PanelSnapshot).contexts[0]?.label).toBe("host smoke");
    await runs.create({ id: "run-detail", workspaceId: server.currentWorkspaceId!, projectId: null, sessionId: null, mode: "work", scenarioId: null, providerId: null, model: "m", status: "succeeded", requirement: "详情测试", startedAt: "2026-10-03T00:00:00.000Z", finishedAt: "2026-10-03T00:00:01.000Z", error: null, details: { trace: [{ nodeId: "n1", status: "success" }] } });
    const runDetail = await fetch(`http://127.0.0.1:${port}/api/runs/run-detail`);
    expect(runDetail.status).toBe(200);
    expect((await runDetail.json()).details.trace[0].status).toBe("success");
    await runs.create({ id: "run-detail-2", workspaceId: server.currentWorkspaceId!, projectId: null, sessionId: null, mode: "work", scenarioId: null, providerId: null, model: "m2", status: "failed", requirement: "详情测试2", startedAt: "2026-10-03T00:00:00.000Z", finishedAt: "2026-10-03T00:00:02.000Z", error: "x", details: { trace: [], acceptance: [] } });
    const comparison = await fetch(`http://127.0.0.1:${port}/api/runs/compare?left=run-detail&right=run-detail-2`);
    expect(comparison.status).toBe(200);
    expect((await comparison.json()).right.status).toBe("failed");
    const snap = (await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json()) as PanelSnapshot;
    expect(snap.phase).toBe("parsing"); // 初始 BuildContext 即 parsing（尚未 run）
    expect(snap.hostExecution.enabled).toBe(false);
    expect(snap.hostExecution.allowedCommands).toEqual([]);
    expect(snap.revision).toBeGreaterThanOrEqual(0);
    const events = (await (await fetch(`http://127.0.0.1:${port}/api/events?after=0`)).json()) as { revision: number; events: unknown[] };
    expect(events.revision).toBeGreaterThanOrEqual(snap.revision);
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

  it("WS 超大消息在 JSON 解析前被拒绝", async () => {
    const c = new WsClient(`ws://127.0.0.1:${port}/ws`);
    await c.open();
    await c.waitFor("snapshot");
    c.send("x".repeat(64_001));
    await expect(c.waitFor("action-result")).resolves.toMatchObject({ ok: false, error: "消息过大" });
    c.close();
  });

  it("斜杠命令走服务端协议并返回帮助", async () => {
    const c = new WsClient(`ws://127.0.0.1:${port}/ws`);
    await c.open();
    await c.waitFor("snapshot");
    c.send({ type: "run-command", input: "/help" });
    expect((await c.waitFor("action-result")) as { ok: boolean }).toMatchObject({ ok: true });
    const message = await c.waitFor("chat", (value) => String((value.message as { text?: string })?.text ?? "").includes("/scenario list"));
    expect((message.message as { role?: string }).role).toBe("build-status");
    c.close();
  });

  it("WS 动作带 requestId，断线可按 revision 回放事件", async () => {
    const c = new WsClient(`ws://127.0.0.1:${port}/ws`);
    await c.open();
    await c.waitFor("snapshot");
    c.send({ type: "run-command", input: "/help", requestId: "req-1" });
    const result = await c.waitFor("action-result");
    expect(result).toMatchObject({ ok: true, requestId: "req-1" });
    c.send({ type: "resume", afterRevision: 0 });
    const replay = await c.waitFor("replay");
    expect(Number(replay.revision)).toBeGreaterThan(0);
    expect(Array.isArray(replay.events)).toBe(true);
    c.close();
  });

  it("分享令牌只通过一次性 action-result 返回，不进入快照或服务端聊天历史", async () => {
    const c = new WsClient(`ws://127.0.0.1:${port}/ws`);
    await c.open(); await c.waitFor("snapshot");
    c.send({ type: "create-share", resourceType: "project", resourceId: projectId, role: "viewer", requestId: "share-once" });
    const result = await c.waitFor("action-result");
    const token = ((result as { data?: { token?: string } }).data?.token);
    expect(token).toBeTruthy();
    const snapshot = (await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json()) as PanelSnapshot;
    expect(JSON.stringify(snapshot)).not.toContain(token);
    expect(JSON.stringify(snapshot.chat)).not.toContain(token);
    c.close();
  });

  it("requestId 结果不会跨 WebSocket 连接泄露一次性令牌", async () => {
    const c1 = new WsClient(`ws://127.0.0.1:${port}/ws`);
    await c1.open(); await c1.waitFor("snapshot");
    c1.send({ type: "create-share", resourceType: "project", resourceId: projectId, role: "viewer", requestId: "socket-bound-token" });
    const first = await c1.waitFor("action-result");
    expect((first as { ok: boolean }).ok).toBe(true);
    const token = (first as { data?: { token?: string } }).data?.token;
    expect(token).toBeTruthy();
    const c2 = new WsClient(`ws://127.0.0.1:${port}/ws`);
    await c2.open(); await c2.waitFor("snapshot");
    c2.send({ type: "create-share", resourceType: "project", resourceId: projectId, role: "viewer", requestId: "socket-bound-token" });
    expect(await c2.waitFor("action-result")).toMatchObject({ ok: false, error: "requestId 已被其它连接占用" });
    c1.close(); c2.close();
  });

  it("分享中心可以按资源创建、列出和撤销项目令牌", async () => {
    const c = new WsClient(`ws://127.0.0.1:${port}/ws`);
    await c.open(); await c.waitFor("snapshot");
    c.send({ type: "create-share", resourceType: "project", resourceId: projectId, role: "editor", requestId: "share-editor" });
    const result = await c.waitFor("action-result"); expect((result as { ok: boolean }).ok).toBe(true);
    const snapshot = (await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json()) as PanelSnapshot;
    const share = snapshot.shares.find((item) => item.resourceId === projectId); expect(share?.role).toBe("editor"); expect(share?.tokenMasked).not.toContain("id_");
    c.send({ type: "delete-share", shareId: share!.id, confirm: true });
    expect((await c.waitFor("action-result")) as { ok: boolean }).toMatchObject({ ok: true }); c.close();
  });

  it("Artifact 分享不会暴露本机文件路径或历史版本路径", async () => {
    const artifactPath = path.join(dir, "runs", "shared-artifact.md");
    await writeFile(artifactPath, "shared content", "utf8");
    const createdAt = "2026-10-03T00:00:00.000Z";
    await artifacts.create({
      id: "shared-artifact",
      workspaceId: server.currentWorkspaceId!,
      projectId: null,
      sessionId: null,
      runId: null,
      name: "shared-artifact.md",
      mediaType: "text/markdown",
      path: artifactPath,
      version: 2,
      checksum: "current-checksum",
      versions: [{ version: 1, path: path.join(dir, "runs", "old-artifact.md"), checksum: "old-checksum", content: "old content", createdAt }],
      status: "ready",
    });
    const share = await shares.create({ id: "shared-artifact-link", workspaceId: server.currentWorkspaceId!, resourceType: "artifact", resourceId: "shared-artifact", role: "viewer", expiresAt: null });
    const response = await fetch(`http://127.0.0.1:${port}/api/share/${share.token}`);
    expect(response.status).toBe(200);
    const body = await response.json() as { resource?: { path?: string; versions?: Array<{ path?: string; content?: string }> } };
    expect(body.resource?.path).toBeUndefined();
    expect(body.resource?.versions?.[0]?.path).toBeUndefined();
    expect(body.resource?.versions?.[0]?.content).toBe("old content");
    const opaqueOpen = await fetch(`http://127.0.0.1:${port}/api/artifact?id=shared-artifact`);
    expect(opaqueOpen.status).toBe(200);
    expect(await opaqueOpen.text()).toBe("shared content");
  });

  it("已删除产物不会继续被分享、版本化或评论", async () => {
    const artifactPath = path.join(dir, "deleted-artifact.md");
    await writeFile(artifactPath, "deleted content", "utf8");
    await artifacts.create({ id: "deleted-artifact", workspaceId: server.currentWorkspaceId!, projectId: null, sessionId: null, runId: null, name: "deleted.md", mediaType: "text/markdown", path: artifactPath, version: 1, status: "ready" });
    await artifacts.softDelete("deleted-artifact");
    await expect(server.handleAction({ type: "create-share", resourceType: "artifact", resourceId: "deleted-artifact", role: "viewer" })).resolves.toMatchObject({ ok: false, error: "产物不存在或不属于当前工作区" });
    await expect(server.handleAction({ type: "version-artifact", artifactId: "deleted-artifact" })).resolves.toMatchObject({ ok: false, error: "产物不存在" });
    await expect(server.handleAction({ type: "create-comment", resourceType: "artifact", resourceId: "deleted-artifact", body: "should fail" })).resolves.toMatchObject({ ok: false, error: "评论资源不存在" });
    const legacy = await shares.create({ id: "deleted-artifact-link", workspaceId: server.currentWorkspaceId!, resourceType: "artifact", resourceId: "deleted-artifact", role: "viewer", expiresAt: null });
    expect((await fetch(`http://127.0.0.1:${port}/api/share/${legacy.token}`)).status).toBe(404);
  });

  it("不能为其它工作区的产物创建分享令牌", async () => {
    await artifacts.create({ id: "foreign-artifact", workspaceId: "workspace-foreign", projectId: null, sessionId: null, runId: null, name: "foreign.md", mediaType: "text/markdown", path: path.join(dir, "foreign.md"), version: 1, status: "ready" });
    const c = new WsClient(`ws://127.0.0.1:${port}/ws`);
    await c.open(); await c.waitFor("snapshot");
    c.send({ type: "create-share", resourceType: "artifact", resourceId: "foreign-artifact", role: "viewer" });
    expect((await c.waitFor("action-result")) as { ok: boolean; error?: string }).toMatchObject({ ok: false, error: "产物不存在或不属于当前工作区" });
    c.close();
  });

  it("评论不能指向不存在的场景资源", async () => {
    await expect(server.handleAction({ type: "create-comment", resourceType: "scenario", resourceId: "missing-scenario-comment", body: "invalid" })).resolves.toMatchObject({ ok: false, error: "评论资源不存在" });
  });

  it("异常分享记录不能通过资源端点返回其它工作区项目", async () => {
    const current = await repository.getDefaultWorkspace();
    const foreign = await repository.createWorkspace("分享外部工作区");
    const foreignProject = await repository.createProject(foreign.id, "外部项目");
    const malformed = await shares.create({ id: "malformed-project-share", workspaceId: current.id, resourceType: "project", resourceId: foreignProject.id, role: "viewer", expiresAt: null });
    const response = await fetch(`http://127.0.0.1:${port}/api/share/${malformed.token}`);
    expect(response.status).toBe(404);
  });

  it("已删除场景不能新建或继续使用分享链接", async () => {
    await library.save({ id: "deleted-share-scenario", name: "待删除场景", goal: "待删除场景", pinnedVersion: 1, distilled: { slotDefs: [], branches: [], acceptanceTemplates: [], signature: { keywords: ["删除"], embedding: [1, 0], embedVia: "bag-of-words" }, buildId: "deleted-share-build", pinnedVersion: 1 }, capabilityIds: [], source: "test", approvals: [], stats: { uses: 0, successes: 0, lastUsedAt: null, driftCount: 0 }, degraded: false, status: "active", tags: [], versionHistory: [], createdAt: "2026-10-03T00:00:00.000Z" });
    await library.delete("deleted-share-scenario");
    await expect(server.handleAction({ type: "create-share", resourceType: "scenario", resourceId: "deleted-share-scenario", role: "viewer" })).resolves.toMatchObject({ ok: false, error: "场景不存在" });
    const legacy = await shares.create({ id: "deleted-share-legacy", workspaceId: server.currentWorkspaceId!, resourceType: "scenario", resourceId: "deleted-share-scenario", role: "viewer", expiresAt: null });
    expect((await fetch(`http://127.0.0.1:${port}/api/share/${legacy.token}`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/api/scenario?id=deleted-share-scenario`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/api/scenario/compare?id=deleted-share-scenario&version=1`)).status).toBe(404);
  });

  it("所有按 ID 的管理动作都拒绝其它工作区资源，分享链接也不跨工作区解析", async () => {
    const current = await repository.getDefaultWorkspace();
    const foreignWorkspaceId = "workspace-foreign-actions";
    const foreignConnector = await connectors.create({ workspaceId: foreignWorkspaceId, name: "foreign", kind: "http", endpoint: "http://127.0.0.1:1", permissionScopes: ["network"] });
    const foreignProvider = await providers.create({ id: "foreign-provider", workspaceId: foreignWorkspaceId, name: "foreign", kind: "local", baseUrl: "http://127.0.0.1:8317/v1", model: "m", enabled: true, hasSecret: false, timeoutMs: 1000 });
    const foreignTask = await tasks.create({ id: "foreign-task", workspaceId: foreignWorkspaceId, projectId: null, scenarioId: null, requirement: "foreign", schedule: "once", enabled: true, lastRunId: null, lastRunAt: null, runCount: 0, maxRuns: null, timeoutMs: 1000 });
    const foreignMemory = await memories.create({ id: "foreign-memory", workspaceId: foreignWorkspaceId, projectId: null, sessionId: null, scenarioId: null, scope: "global", name: "foreign", content: "foreign", path: path.join(dir, "knowledge", "foreign.md"), sourceType: "user", sourceId: null, enabled: true });
    const foreignContext = await contexts.create({ id: "foreign-context", workspaceId: foreignWorkspaceId, projectId: null, kind: "note", origin: "note", label: "foreign", content: "foreign", enabled: true });
    const foreignShare = await shares.create({ id: "foreign-share", workspaceId: foreignWorkspaceId, resourceType: "workspace", resourceId: current.id, role: "viewer", expiresAt: null });

    await expect(server.handleAction({ type: "toggle-connector", connectorId: foreignConnector.id, enabled: true })).resolves.toMatchObject({ ok: false, error: "连接器不存在" });
    await expect(server.handleAction({ type: "toggle-provider", providerId: foreignProvider.id, enabled: false })).resolves.toMatchObject({ ok: false, error: "Provider 不存在" });
    await expect(server.handleAction({ type: "update-task", taskId: foreignTask.id, requirement: "tamper", schedule: "once" })).resolves.toMatchObject({ ok: false, error: "任务不存在" });
    await expect(server.handleAction({ type: "delete-task", taskId: foreignTask.id, confirm: true })).resolves.toMatchObject({ ok: false, error: "任务不存在" });
    await expect(server.handleAction({ type: "toggle-memory", memoryId: foreignMemory.id, enabled: false })).resolves.toMatchObject({ ok: false, error: "Memory 不存在" });
    await expect(server.handleAction({ type: "update-memory", path: foreignMemory.path, memoryId: foreignMemory.id, content: "tamper" })).resolves.toMatchObject({ ok: false, error: "Memory 不存在" });
    await expect(server.handleAction({ type: "delete-memory", path: foreignMemory.path, memoryId: foreignMemory.id, confirm: true })).resolves.toMatchObject({ ok: false, error: "Memory 不存在" });
    await expect(server.handleAction({ type: "update-memory", path: foreignMemory.path, content: "tamper" })).resolves.toMatchObject({ ok: false, error: "Memory 不存在" });
    await expect(server.handleAction({ type: "delete-memory", path: foreignMemory.path, confirm: true })).resolves.toMatchObject({ ok: false, error: "Memory 不存在" });
    await expect(server.handleAction({ type: "delete-memories", memoryIds: [foreignMemory.id], confirm: true })).resolves.toMatchObject({ ok: false, error: "Memory 不存在" });
    await expect(server.handleAction({ type: "toggle-context", contextId: foreignContext.id, enabled: false })).resolves.toMatchObject({ ok: false, error: "上下文不存在" });
    expect((await connectors.get(foreignConnector.id))?.status).toBe("disabled");
    expect((await providers.get(foreignProvider.id))?.enabled).toBe(true);
    expect((await tasks.get(foreignTask.id))?.requirement).toBe("foreign");
    expect((await memories.get(foreignMemory.id))?.enabled).toBe(true);
    expect((await contexts.get(foreignContext.id))?.enabled).toBe(true);

    const shared = await fetch(`http://127.0.0.1:${port}/api/share/${foreignShare.token}`);
    expect(shared.status).toBe(404);

    await runs.create({ id: "foreign-run", workspaceId: foreignWorkspaceId, projectId: null, sessionId: null, mode: "work", scenarioId: null, providerId: null, model: "m", status: "succeeded", requirement: "foreign", startedAt: "2026-10-03T00:00:00.000Z", finishedAt: "2026-10-03T00:00:01.000Z", error: null, details: { trace: [] } });
    expect((await fetch(`http://127.0.0.1:${port}/api/runs/foreign-run`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/api/runs/compare?left=foreign-run&right=foreign-run`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/api/artifact/diff?id=foreign-artifact&from=1&to=1`)).status).toBe(404);
    const snapshot = await server.snapshot();
    expect(snapshot.runs.some((run) => run.id === "foreign-run")).toBe(false);
    await expect(server.handleAction({ type: "search", query: "foreign" })).resolves.toMatchObject({ ok: true });
    expect((await server.snapshot()).chat.at(-1)?.text).not.toContain("运行 · foreign");
  });

  it("start-build 在前置校验失败或后台拒绝时都收敛为失败终态", async () => {
    const depsRef = (server as unknown as {
      deps: {
        onStartBuild?: (requirement: string, mode: "work" | "build", scenarioId?: string, slots?: Record<string, string>, projectId?: string) => Promise<{ ok: boolean; error?: string }>;
      };
    }).deps;
    depsRef.onStartBuild = async () => ({ ok: false, error: "launcher rejected" });

    const missing = await server.handleAction({ type: "start-build", requirement: "使用不存在场景", mode: "work", scenarioId: "missing-scenario" });
    expect(missing).toMatchObject({ ok: false, error: "场景不存在" });
    expect((await server.snapshot()).run).toMatchObject({ status: "failed" });
    expect((await runs.list(5))[0]).toMatchObject({ status: "failed", error: "场景不存在" });

    await library.save({ id: "archived-scenario", name: "已归档场景", goal: "已归档工作流", pinnedVersion: 1, distilled: { slotDefs: [], branches: [], acceptanceTemplates: [], signature: { keywords: ["归档"], embedding: [1, 0], embedVia: "bag-of-words" }, buildId: "build-archived", pinnedVersion: 1 }, capabilityIds: [], source: "test", approvals: [], stats: { uses: 0, successes: 0, lastUsedAt: null, driftCount: 0 }, degraded: false, status: "archived", tags: [], versionHistory: [], createdAt: "2026-10-03T00:00:00.000Z" });
    const archived = await server.handleAction({ type: "start-build", requirement: "运行已归档场景", mode: "work", scenarioId: "archived-scenario" });
    expect(archived).toMatchObject({ ok: false, error: "场景已归档" });
    expect((await runs.list(5))[0]).toMatchObject({ status: "failed", error: "场景已归档" });

    const rejected = await server.handleAction({ type: "start-build", requirement: "验证启动失败收敛", mode: "work" });
    expect(rejected).toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const snapshot = await server.snapshot();
    expect(snapshot.busy).toBe(false);
    expect(snapshot.run).toMatchObject({ status: "failed", text: "运行失败：launcher rejected" });
    expect((await runs.list(5))[0]).toMatchObject({ status: "failed", error: "launcher rejected" });

    const workspace = await repository.getDefaultWorkspace();
    const boundProject = await repository.createProject(workspace.id, "绑定项目");
    let callbackProjectId: string | undefined;
    depsRef.onStartBuild = async (_requirement, _mode, _scenarioId, _slots, executionProjectId) => {
      callbackProjectId = executionProjectId;
      return { ok: false, error: "bound project probe" };
    };
    const bound = await server.handleAction({ type: "start-build", requirement: "验证后台任务项目边界", mode: "work", projectId: boundProject.id });
    expect(bound).toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(callbackProjectId).toBe(boundProject.id);
    const boundRun = await runs.get(server.currentRunId!);
    expect(boundRun).toMatchObject({ projectId: boundProject.id, status: "failed", error: "bound project probe" });
  });

  it("运行缺少必填输入时进入 awaiting-user，回答后恢复同一 run", async () => {
    const runId = "run-awaiting-user";
    const pending = server.waitForRunInput(runId, [{ name: "sourcePath", description: "源文件", type: "path" }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await server.snapshot()).run).toMatchObject({ runId, status: "waiting-user" });
    expect((await server.snapshot()).awaitingUser).toMatchObject({ runId, inputs: [{ name: "sourcePath" }] });
    await expect(server.handleAction({ type: "answer-run", runId, values: {} })).resolves.toMatchObject({ ok: false });
    await expect(server.handleAction({ type: "answer-run", runId, values: { sourcePath: " C:/input.md " } })).resolves.toMatchObject({ ok: true });
    await expect(pending).resolves.toEqual({ sourcePath: "C:/input.md" });
    expect((await server.snapshot()).awaitingUser).toBeNull();
    expect((await server.snapshot()).run).toMatchObject({ runId, status: "running" });
  });

  it("构建模型澄清会停在 awaiting-user，answer-run 调用恢复器并保持同一 run", async () => {
    const depsRef = (server as unknown as { deps: { onStartBuild?: (...args: never[]) => Promise<{ ok: boolean }>; onAnswerBuild?: (runId: string, values: Record<string, string>) => Promise<{ ok: boolean }> } }).deps;
    depsRef.onStartBuild = async () => ({ ok: true });
    const started = await server.handleAction({ type: "start-build", requirement: "需要澄清的构建", mode: "build" });
    expect(started).toMatchObject({ ok: true });
    const runId = server.currentRunId;
    if (!runId) throw new Error("expected build run id");
    let resumed: Record<string, string> | undefined;
    depsRef.onAnswerBuild = async (id, values) => { expect(id).toBe(runId); resumed = values; return { ok: true }; };
    server.notifyBuildAwaitingUser(runId, { phase: "planning", question: "选择输出格式", inputs: [{ name: "format", type: "string", description: "交付格式" }], source: "model", createdAt: new Date().toISOString() });
    expect((await server.snapshot()).run).toMatchObject({ runId, status: "waiting-user", kind: "build" });
    await expect(server.handleAction({ type: "answer-run", runId, values: { format: "markdown" } })).resolves.toMatchObject({ ok: true });
    expect(resumed).toEqual({ format: "markdown" });
    expect(Reflect.get(server as object, "pendingBuildInput")).toBeUndefined();
    expect((await server.snapshot()).awaitingUser).toBeNull();
    expect((await server.snapshot()).run).toMatchObject({ runId, status: "running" });
  });

  it("编排器仍持有澄清上下文时，回答也会清理面板 pending 请求并走统一恢复器", async () => {
    const runId = "build-awaiting-live-orchestrator";
    const request = { phase: "planning" as const, question: "选择输出格式", inputs: [{ name: "format", type: "string" as const, description: "交付格式" }], source: "model" as const, createdAt: new Date().toISOString() };
    let resumed: Record<string, string> | undefined;
    const depsRef = Reflect.get(server as object, "deps") as PanelDeps & { orchestrator?: Orchestrator };
    depsRef.orchestrator = { ctx: { awaitingUser: request } } as unknown as Orchestrator;
    depsRef.onAnswerBuild = async (id, values) => { expect(id).toBe(runId); resumed = values; (depsRef.orchestrator!.ctx as { awaitingUser: unknown }).awaitingUser = null; return { ok: true }; };
    server.notifyBuildAwaitingUser(runId, request);

    await expect(server.handleAction({ type: "answer-run", runId, values: { format: "markdown" } })).resolves.toMatchObject({ ok: true });
    expect(resumed).toEqual({ format: "markdown" });
    expect((await server.snapshot()).awaitingUser).toBeNull();
  });

  it("快速回答不会被澄清事件的迟到 waiting-user 写入覆盖", async () => {
    const workspace = await repository.getDefaultWorkspace();
    const runId = "build-awaiting-write-race";
    await runs.create({ id: runId, workspaceId: workspace.id, projectId, sessionId: server.currentSessionId, mode: "build", scenarioId: null, providerId: null, model: "m", status: "running", requirement: "澄清写入竞态", startedAt: new Date().toISOString(), finishedAt: null, error: null });
    const request = { phase: "planning" as const, question: "选择格式", inputs: [{ name: "format", type: "string" as const, description: "格式" }], source: "model" as const, createdAt: new Date().toISOString() };
    const depsRef = Reflect.get(server as object, "deps") as PanelDeps & { orchestrator?: Orchestrator };
    depsRef.orchestrator = { ctx: { awaitingUser: request } } as unknown as Orchestrator;
    depsRef.onAnswerBuild = async () => { (depsRef.orchestrator!.ctx as { awaitingUser: unknown }).awaitingUser = null; return { ok: true }; };
    type RunUpdatePatch = Parameters<RunRepository["update"]>[1];
    type RunUpdate = (id: string, patch: RunUpdatePatch) => ReturnType<RunRepository["update"]>;
    const originalUpdate = runs.update.bind(runs);
    let releaseWaiting!: () => void;
    let waitingStarted!: () => void;
    const waitingWriteStarted = new Promise<void>((resolve) => { waitingStarted = resolve; });
    const waitingWriteRelease = new Promise<void>((resolve) => { releaseWaiting = resolve; });
    const update = runs.update.bind(runs);
    (runs as unknown as { update: RunUpdate }).update = async (id, patch) => {
      if (id === runId && patch.status === "waiting-user") { waitingStarted(); await waitingWriteRelease; }
      return update(id, patch);
    };
    try {
      server.notifyBuildAwaitingUser(runId, request);
      await waitingWriteStarted;
      const answer = server.handleAction({ type: "answer-run", runId, values: { format: "markdown" } });
      await new Promise((resolve) => setTimeout(resolve, 10));
      releaseWaiting();
      await expect(answer).resolves.toMatchObject({ ok: true });
      expect(await runs.get(runId)).toMatchObject({ status: "running", details: { awaitingUser: null } });
    } finally {
      (runs as unknown as { update: RunUpdate }).update = originalUpdate;
    }
  });

  it("重启恢复的构建澄清回答后，面板和持久化运行都会回到 running", async () => {
    const workspace = await repository.getDefaultWorkspace();
    const runId = "build-awaiting-restored-answer";
    const request = { phase: "planning" as const, question: "恢复时选择格式", inputs: [{ name: "format", type: "string" as const, description: "格式" }], source: "model" as const, createdAt: new Date().toISOString() };
    await runs.create({ id: runId, workspaceId: workspace.id, projectId, sessionId: server.currentSessionId, mode: "build", scenarioId: null, providerId: null, model: "m", status: "waiting-user", requirement: "恢复澄清", startedAt: new Date().toISOString(), finishedAt: null, error: request.question, details: { awaitingUser: request } });
    const depsRef = Reflect.get(server as object, "deps") as PanelDeps & { orchestrator?: Orchestrator };
    depsRef.orchestrator = { ctx: { awaitingUser: request } } as unknown as Orchestrator;
    depsRef.onAnswerBuild = async () => { (depsRef.orchestrator!.ctx as { awaitingUser: unknown }).awaitingUser = null; return { ok: true }; };
    Reflect.set(server as object, "run", { kind: "build", status: "waiting-user", runId, text: request.question });
    Reflect.set(server as object, "sessionLocked", true);

    await expect(server.handleAction({ type: "answer-run", runId, values: { format: "markdown" } })).resolves.toMatchObject({ ok: true });
    expect((await server.snapshot()).run).toMatchObject({ runId, status: "running" });
    expect((await server.snapshot()).awaitingUser).toBeNull();
    expect(await runs.get(runId)).toMatchObject({ status: "running", error: null, details: { awaitingUser: null, clarificationAnswers: { format: "markdown" } } });
  });

  it("/run retry 只继承当前历史对话的重试次数", async () => {
    const depsRef = (server as unknown as {
      deps: {
        onStartBuild?: (requirement: string, mode: "work" | "build", scenarioId?: string, slots?: Record<string, string>, projectId?: string) => Promise<{ ok: boolean; error?: string }>;
      };
    }).deps;
    depsRef.onStartBuild = async () => ({ ok: true });
    const workspace = await repository.getDefaultWorkspace();
    const sessionId = server.currentSessionId;
    if (!sessionId) throw new Error("expected current session");
    const otherProject = await repository.createProject(workspace.id, "当前选择的其它项目");
    const now = Date.now();
    await runs.create({ id: "retry-current", workspaceId: workspace.id, projectId, sessionId, mode: "work", scenarioId: null, providerId: null, model: "m", status: "failed", requirement: "当前会话的旧需求", startedAt: new Date(now - 2_000).toISOString(), finishedAt: new Date(now - 1_000).toISOString(), error: "failed", retryCount: 2 });
    await runs.create({ id: "retry-foreign", workspaceId: workspace.id, projectId, sessionId: "other-session", mode: "work", scenarioId: null, providerId: null, model: "m", status: "failed", requirement: "另一会话的需求", startedAt: new Date(now - 500).toISOString(), finishedAt: new Date(now - 400).toISOString(), error: "failed", retryCount: 99 });
    await expect(server.handleAction({ type: "select-project", projectId: otherProject.id })).resolves.toMatchObject({ ok: true });
    server.pushChat({ role: "user", content: "当前会话的旧需求", timestamp: now - 3_000 });
    const result = await server.handleAction({ type: "run-command", input: "/run retry" });
    expect(result).toMatchObject({ ok: true });
    const created = (await runs.list(10)).find((run) => run.sessionId === sessionId && run.id !== "retry-current");
    expect(created).toMatchObject({ requirement: "当前会话的旧需求", retryCount: 3 });
    expect(created && (await runs.get(created.id))).toMatchObject({ projectId });
  });

  it("重试或分支运行中记录会被服务端拒绝", async () => {
    const workspace = await repository.getDefaultWorkspace();
    await runs.create({ id: "active-run", workspaceId: workspace.id, projectId, sessionId: "other-session", mode: "work", scenarioId: null, providerId: null, model: "m", status: "running", requirement: "尚未完成的运行", startedAt: new Date().toISOString(), finishedAt: null, error: null });
    await expect(server.handleAction({ type: "retry-run", runId: "active-run" })).resolves.toMatchObject({ ok: false, error: "该运行尚未结束，不能重试" });
    await expect(server.handleAction({ type: "branch-run", runId: "active-run" })).resolves.toMatchObject({ ok: false, error: "该运行尚未结束，不能创建分支" });
  });

  it("运行期间拒绝切换项目，避免异步终态污染新项目", async () => {
    const depsRef = (server as unknown as {
      deps: {
        onStartBuild?: (requirement: string, mode: "work" | "build", scenarioId?: string, slots?: Record<string, string>, projectId?: string) => Promise<{ ok: boolean; error?: string }>;
      };
    }).deps;
    const workspace = await repository.getDefaultWorkspace();
    const otherProject = await repository.createProject(workspace.id, "运行期间不可切换");
    depsRef.onStartBuild = async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { ok: false, error: "delayed failure" };
    };

    await expect(server.handleAction({ type: "start-build", requirement: "检查项目切换边界", mode: "work" })).resolves.toMatchObject({ ok: true });
    await expect(server.handleAction({ type: "select-project", projectId: otherProject.id })).resolves.toMatchObject({ ok: false, error: "当前运行中不能切换项目" });
    await expect(server.handleAction({ type: "create-project", name: "运行期间不应切换" })).resolves.toMatchObject({ ok: false, error: "当前运行中不能切换项目" });
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect((await server.snapshot()).projectId).toBe(projectId);
    expect((await server.snapshot()).run).toMatchObject({ status: "failed" });
  });

  it("终态异步落库固定原 runId，不会更新随后启动的新运行", async () => {
    const workspace = await repository.getDefaultWorkspace();
    const oldId = "terminal-race-old";
    const newId = "terminal-race-new";
    const startedAt = new Date(Date.now() - 1_000).toISOString();
    for (const id of [oldId, newId]) {
      await runs.create({ id, workspaceId: workspace.id, projectId, sessionId: server.currentSessionId, mode: "work", scenarioId: null, providerId: null, model: "m", status: "running", requirement: id, startedAt, finishedAt: null, error: null });
    }
    const state = server as unknown as { run: { kind: "work"; status: "running"; runId: string; text: string }; sessionLocked: boolean };
    state.run = { kind: "work", status: "running", runId: oldId, text: "旧运行" };
    state.sessionLocked = true;
    server.pushChat({ role: "build-status", tone: "ok", runStatus: "succeeded", runId: oldId, terminal: true, text: "旧运行完成", ts: Date.now() });
    state.run = { kind: "work", status: "running", runId: newId, text: "新运行" };
    state.sessionLocked = true;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(await runs.get(oldId)).toMatchObject({ status: "succeeded" });
    expect(await runs.get(newId)).toMatchObject({ status: "running" });
  });

  it("停止后的迟到成功事件不能把运行复活", async () => {
    const workspace = await repository.getDefaultWorkspace();
    const runId = "cancel-race-run";
    await runs.create({ id: runId, workspaceId: workspace.id, projectId, sessionId: server.currentSessionId, mode: "work", scenarioId: null, providerId: null, model: "m", status: "cancelled", requirement: "已停止", startedAt: new Date(Date.now() - 1_000).toISOString(), finishedAt: new Date().toISOString(), error: "已终止" });
    const state = server as unknown as { run: { kind: "work"; status: "cancelled"; runId: string; text: string }; sessionLocked: boolean };
    state.run = { kind: "work", status: "cancelled", runId, text: "已终止" };
    state.sessionLocked = false;
    server.pushChat({ role: "build-status", tone: "ok", runStatus: "succeeded", runId, terminal: true, text: "迟到成功", ts: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect((await server.snapshot()).run).toMatchObject({ status: "cancelled" });
    expect(await runs.get(runId)).toMatchObject({ status: "cancelled", error: "已终止" });
  });

  it("相同 requestId 的重复动作幂等，不重复写入命令消息", async () => {
    const c = new WsClient(`ws://127.0.0.1:${port}/ws`);
    await c.open();
    await c.waitFor("snapshot");
    const action = { type: "run-command", input: "/help", requestId: "dedupe-help" };
    c.send(action);
    expect((await c.waitFor("action-result")) as { ok: boolean; requestId?: string }).toMatchObject({ ok: true, requestId: "dedupe-help" });
    c.send(action);
    expect((await c.waitFor("action-result")) as { ok: boolean; requestId?: string }).toMatchObject({ ok: true, requestId: "dedupe-help" });
    const snapshot = (await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json()) as PanelSnapshot;
    expect(snapshot.chat.filter((message) => message.role === "user" && message.content === "/help")).toHaveLength(1);
    c.close();
  });

  it("requestId 在首个动作仍未完成时也只执行一次", async () => {
    const c = new WsClient(`ws://127.0.0.1:${port}/ws`);
    await c.open();
    await c.waitFor("snapshot");
    const action = { type: "create-project", name: "并发幂等项目", requestId: "dedupe-inflight" };
    c.send(action);
    c.send(action);
    const results = await Promise.all([c.waitFor("action-result", (message) => message.requestId === action.requestId), c.waitFor("action-result", (message) => message.requestId === action.requestId)]);
    expect(results[0]).toMatchObject({ ok: true, requestId: action.requestId });
    expect(results[1]).toMatchObject({ ok: true, requestId: action.requestId });
    const snapshot = (await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json()) as PanelSnapshot;
    expect(snapshot.projects.filter((project) => project.name === "并发幂等项目")).toHaveLength(1);
    c.close();
  });

  it("终态事件先到时，随后失败的 launcher promise 不能复活运行", async () => {
    const depsRef = (server as unknown as { deps: { onStartBuild?: PanelDeps["onStartBuild"] } }).deps;
    depsRef.onStartBuild = async () => {
      await new Promise((resolve) => setTimeout(resolve, 35));
      throw new Error("迟到 launcher 失败");
    };
    await expect(server.handleAction({ type: "start-build", requirement: "终态竞态验证", mode: "work" })).resolves.toMatchObject({ ok: true });
    const runId = server.currentRunId;
    if (!runId) throw new Error("expected run id");
    server.pushChat({ role: "build-status", tone: "ok", runStatus: "succeeded", terminal: true, runId, text: "已完成", ts: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect((await server.snapshot()).run).toMatchObject({ runId, status: "succeeded" });
    expect(await runs.get(runId)).toMatchObject({ status: "succeeded", error: null });
  });

  it("全局搜索在服务端汇总对话、场景、文件和运行结果", async () => {
    const c = new WsClient(`ws://127.0.0.1:${port}/ws`);
    await c.open();
    await c.waitFor("snapshot");
    c.send({ type: "search", query: "测试" });
    expect((await c.waitFor("action-result")) as { ok: boolean }).toMatchObject({ ok: true });
    const result = await c.waitFor("chat", (message) => (message.message as { role?: string }).role === "search-result");
    expect((result.message as { text?: string }).text).toContain("搜索");
    c.close();
  });

  it("项目上下文支持创建/选择和文件上传", async () => {
    const c = new WsClient(`ws://127.0.0.1:${port}/ws`);
    await c.open();
    await c.waitFor("snapshot");
    c.send({ type: "select-project", projectId });
    expect((await c.waitFor("action-result")) as { ok: boolean }).toMatchObject({ ok: true });
    c.send({ type: "upload-file", name: "bad.bin", mediaType: "application/octet-stream", contentBase64: "not-base64" });
    expect((await c.waitFor("action-result")) as { ok: boolean; error?: string }).toMatchObject({ ok: false, error: "文件内容不是有效 Base64" });
    c.send({ type: "upload-file", name: "brief.md", mediaType: "text/markdown", contentBase64: Buffer.from("# brief").toString("base64") });
    expect((await c.waitFor("action-result")) as { ok: boolean }).toMatchObject({ ok: true });
    c.send({ type: "upload-file", name: "brief.md", mediaType: "text/markdown", contentBase64: Buffer.from("# second").toString("base64") });
    expect((await c.waitFor("action-result")) as { ok: boolean }).toMatchObject({ ok: true });
    c.send({ type: "upload-file", name: "notes.md", relativePath: "docs/notes.md", mediaType: "text/markdown", contentBase64: Buffer.from("# notes").toString("base64") });
    expect((await c.waitFor("action-result")) as { ok: boolean }).toMatchObject({ ok: true });
    const snap = (await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json()) as PanelSnapshot;
    expect(snap.projectId).toBe(projectId);
    expect(snap.files).toHaveLength(3);
    expect(snap.files.map((file) => file.name).sort()).toEqual(["brief.md", "brief（2）.md", "docs/notes.md"].sort());
    const primaryFile = snap.files.find((file) => file.name === "brief.md")!;
    const backup = await (await fetch(`http://127.0.0.1:${port}/api/workspace/export`)).json() as { files?: Array<{ name: string; contentBase64?: string | null }> };
    expect(backup.files?.find((file) => file.name === "brief.md")?.contentBase64).toBe(Buffer.from("# brief").toString("base64"));
    const preview = await fetch(`http://127.0.0.1:${port}/api/project-file?path=${encodeURIComponent(primaryFile.path)}`);
    expect(preview.status).toBe(200);
    expect(await preview.text()).toContain("# brief");
    const fileId = primaryFile.id;
    c.send({ type: "index-file", fileId });
    expect((await c.waitFor("action-result")) as { ok: boolean }).toMatchObject({ ok: true });
    expect(((await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json()) as PanelSnapshot).files[0]!.indexed).toBe(true);
    c.send({ type: "delete-file", fileId });
    expect((await c.waitFor("action-result")) as { ok: boolean }).toMatchObject({ ok: false });
    c.send({ type: "delete-file", fileId, confirm: true });
    expect((await c.waitFor("action-result")) as { ok: boolean }).toMatchObject({ ok: true });
    const remaining = ((await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json()) as PanelSnapshot).files;
    expect(remaining).toHaveLength(2);
    for (const file of remaining) {
      c.send({ type: "delete-file", fileId: file.id, confirm: true });
      expect((await c.waitFor("action-result")) as { ok: boolean }).toMatchObject({ ok: true });
    }
    expect(((await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json()) as PanelSnapshot).files).toHaveLength(0);
    c.close();
  });

  it("项目绑定真实根目录后读写原目录，不回落到应用副本", async () => {
    const workspace = await repository.getDefaultWorkspace();
    const externalRoot = path.join(dir, "真实项目目录");
    await mkdir(externalRoot, { recursive: true });
    await writeFile(path.join(externalRoot, "existing.md"), "existing", "utf8");
    await repository.updateProject(projectId, { rootPath: externalRoot });
    await expect(server.handleAction({ type: "select-project", projectId })).resolves.toMatchObject({ ok: true });
    const added = await server.handleAction({ type: "add-file", name: "existing.md", path: path.join(externalRoot, "existing.md"), mediaType: "text/markdown", size: 8 });
    expect(added).toMatchObject({ ok: true });
    const content = Buffer.from("written-directly").toString("base64");
    await expect(server.handleAction({ type: "upload-file", name: "nested.md", relativePath: "docs/nested.md", mediaType: "text/markdown", contentBase64: content })).resolves.toMatchObject({ ok: true });
    expect(await (await import("node:fs/promises")).readFile(path.join(externalRoot, "docs", "nested.md"), "utf8")).toBe("written-directly");
    expect((await repository.listFiles(projectId)).some((file) => file.path === path.join(externalRoot, "docs", "nested.md"))).toBe(true);
    void workspace;
  });

  it("删除当前项目后不会把归档项目选为当前项目", async () => {
    const workspace = await repository.getDefaultWorkspace();
    const archived = await repository.createProject(workspace.id, "归档候选项目");
    await repository.archiveProject(archived.id);
    const replacement = await repository.createProject(workspace.id, "可用替代项目");
    await expect(server.handleAction({ type: "delete-project", projectId, confirm: true })).resolves.toMatchObject({ ok: true });
    expect(server.currentProjectId).toBe(replacement.id);
    expect(server.currentProjectId).not.toBe(archived.id);
  });

  it("归档当前项目后自动切换到其它 active 项目", async () => {
    const workspace = await repository.getDefaultWorkspace();
    const replacement = await repository.createProject(workspace.id, "归档后的替代项目");
    await expect(server.handleAction({ type: "archive-project", projectId })).resolves.toMatchObject({ ok: true });
    expect(server.currentProjectId).toBe(replacement.id);
  });

  it("已删除项目不能被归档、恢复或重复删除复活", async () => {
    const deleted = (await repository.createProject((await repository.getDefaultWorkspace()).id, "删除状态项目")).id;
    await expect(server.handleAction({ type: "delete-project", projectId: deleted, confirm: true })).resolves.toMatchObject({ ok: true });
    await expect(server.handleAction({ type: "archive-project", projectId: deleted })).resolves.toMatchObject({ ok: false, error: "项目不存在或不可用" });
    await expect(server.handleAction({ type: "restore-project", projectId: deleted })).resolves.toMatchObject({ ok: false, error: "项目不存在或不可恢复" });
    await expect(server.handleAction({ type: "pin-project", projectId: deleted, pinned: true })).resolves.toMatchObject({ ok: false, error: "项目不存在或不可用" });
    await expect(server.handleAction({ type: "delete-project", projectId: deleted, confirm: true })).resolves.toMatchObject({ ok: false, error: "项目不存在" });
    expect((await repository.getProject(deleted))?.status).toBe("deleted");
  });

  it("路径导入文件拒绝项目工作区之外的路径", async () => {
    const result = await server.handleAction({ type: "add-file", name: "secret.txt", path: path.join(dir, "..", "secret.txt"), mediaType: "text/plain" });
    expect(result).toMatchObject({ ok: false, error: "文件路径超出当前项目工作区" });
  });

  it("路径导入文件不能登记另一个项目目录中的文件", async () => {
    const workspace = await repository.getDefaultWorkspace();
    const otherProject = await repository.createProject(workspace.id, "另一个项目");
    const otherDir = path.join(dir, "projects", otherProject.id);
    await mkdir(otherDir, { recursive: true });
    const otherFile = path.join(otherDir, "secret.txt");
    await writeFile(otherFile, "other project secret", "utf8");
    const result = await server.handleAction({ type: "add-file", name: "secret.txt", path: otherFile, mediaType: "text/plain" });
    expect(result).toMatchObject({ ok: false, error: "文件路径超出当前项目工作区" });
  });

  it("项目文件预览不能读取另一个项目的文件", async () => {
    const workspace = await repository.getDefaultWorkspace();
    const other = await repository.createProject(workspace.id, "隔离项目");
    const otherPath = path.join(dir, "projects", other.id, "private.txt");
    await mkdir(path.dirname(otherPath), { recursive: true }); await writeFile(otherPath, "private", "utf8");
    const otherFile = await repository.addFile({ workspaceId: workspace.id, projectId: other.id, name: "private.txt", path: otherPath, mediaType: "text/plain", size: 7 });
    const response = await fetch(`http://127.0.0.1:${port}/api/project-file?path=${encodeURIComponent(otherFile.path)}`);
    expect(response.status).toBe(403);
  });

  it("没有当前项目时不能通过路径端点读取或删除其它项目文件", async () => {
    const workspace = await repository.getDefaultWorkspace();
    const other = await repository.createProject(workspace.id, "无当前项目隔离");
    const otherPath = path.join(dir, "projects", other.id, "private.txt");
    await mkdir(path.dirname(otherPath), { recursive: true });
    await writeFile(otherPath, "private", "utf8");
    const otherFile = await repository.addFile({ workspaceId: workspace.id, projectId: other.id, name: "private.txt", path: otherPath, mediaType: "text/plain", size: 7 });
    // Archive the selected project so the panel has no current project. The
    // path-oriented artifact endpoint must not fall back to the parent root.
    await expect(server.handleAction({ type: "archive-project", projectId })).resolves.toMatchObject({ ok: true });
    await expect(server.handleAction({ type: "archive-project", projectId: other.id })).resolves.toMatchObject({ ok: true });
    const preview = await fetch(`http://127.0.0.1:${port}/api/artifact?path=${encodeURIComponent(otherPath)}`);
    expect(preview.status).toBe(403);
    await expect(server.handleAction({ type: "delete-file", fileId: otherFile.id, confirm: true })).resolves.toMatchObject({ ok: false, error: "文件不存在" });
    expect(await repository.getFile(otherFile.id)).toBeTruthy();
  });

  it("没有当前项目时不能导入本地文件桌面上下文", async () => {
    await expect(server.handleAction({ type: "archive-project", projectId })).resolves.toMatchObject({ ok: true });
    await expect(server.handleAction({ type: "create-context", kind: "local-file", origin: path.join(dir, "outside.md"), label: "越权文件", content: "private" })).resolves.toMatchObject({ ok: false, error: "请先选择项目" });
  });

  it("产物登记不能写入另一个项目目录或引用其它工作区运行", async () => {
    const workspace = await repository.getDefaultWorkspace();
    const otherProject = await repository.createProject(workspace.id, "产物隔离项目");
    const foreignPath = path.join(dir, "projects", otherProject.id, "foreign.md");
    await expect(server.handleAction({ type: "create-artifact", name: "foreign.md", mediaType: "text/markdown", path: foreignPath, runId: null })).resolves.toMatchObject({ ok: false, error: "产物路径超出当前项目或产物工作区" });
    const foreignWorkspace = await repository.createWorkspace("其它产物工作区");
    await runs.create({ id: "foreign-artifact-run", workspaceId: foreignWorkspace.id, projectId: null, sessionId: null, mode: "work", scenarioId: null, providerId: null, model: "test", status: "succeeded", requirement: "foreign", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), error: null });
    const localPath = path.join(dir, "projects", projectId, "local.md");
    await expect(server.handleAction({ type: "create-artifact", name: "local.md", mediaType: "text/markdown", path: localPath, runId: "foreign-artifact-run" })).resolves.toMatchObject({ ok: false, error: "产物运行记录不存在" });
  });

  it("Memory 支持前端创建和删除", async () => {
    const c = new WsClient(`ws://127.0.0.1:${port}/ws`);
    await c.open();
    await c.waitFor("snapshot");
    c.send({ type: "create-memory", scope: "project", name: "偏好", content: "报告默认使用中文。" });
    expect((await c.waitFor("action-result")) as { ok: boolean }).toMatchObject({ ok: true });
    const snap = (await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json()) as PanelSnapshot;
    expect(JSON.stringify(snap.memoryTree)).toContain("project-偏好.md");
    expect(snap.memoryItems).toHaveLength(1);
    expect(snap.memoryItems[0]).toMatchObject({ scope: "project", name: "偏好", sourceType: "user" });
    c.send({ type: "toggle-memory", memoryId: snap.memoryItems[0]!.id, enabled: false });
    expect((await c.waitFor("action-result")) as { ok: boolean }).toMatchObject({ ok: true });
    expect(((await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json()) as PanelSnapshot).memoryItems[0]!.enabled).toBe(false);
    const filePath = path.join(dir, "knowledge", "project-偏好.md");
    c.send({ type: "delete-memory", path: filePath, memoryId: snap.memoryItems[0]!.id, confirm: true });
    expect((await c.waitFor("action-result")) as { ok: boolean }).toMatchObject({ ok: true });
    const after = (await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json()) as PanelSnapshot;
    expect(JSON.stringify(after.memoryTree)).not.toContain("project-偏好.md");
    c.close();
  });

  it("切换项目时 Memory 快照和项目清单不会串到其它文件夹", async () => {
    const workspace = await repository.getDefaultWorkspace();
    const other = await repository.createProject(workspace.id, "另一个 Memory 项目");
    const base = { workspaceId: workspace.id, sessionId: null, scenarioId: null, scope: "project" as const, content: "项目上下文", path: null, sourceType: "user" as const, sourceId: null, enabled: true };
    await memories.create({ ...base, id: "memory-current-project", projectId, name: "当前项目 Memory" });
    await memories.create({ ...base, id: "memory-other-project", projectId: other.id, name: "其它项目 Memory" });
    const current = await server.snapshot();
    expect(current.memoryItems.map((item) => item.id)).toEqual(["memory-current-project"]);
    expect(current.projects.find((item) => item.id === projectId)).toMatchObject({ memoryCount: 1 });
    expect(current.projects.find((item) => item.id === other.id)).toMatchObject({ memoryCount: 1 });
    await expect(server.handleAction({ type: "select-project", projectId: other.id })).resolves.toMatchObject({ ok: true });
    const switched = await server.snapshot();
    expect(switched.memoryItems.map((item) => item.id)).toEqual(["memory-other-project"]);
    expect(switched.memoryItems.some((item) => item.id === "memory-current-project")).toBe(false);
  });

  it("切换项目会清掉不再可见的当前场景", async () => {
    const workspace = await repository.getDefaultWorkspace();
    const other = await repository.createProject(workspace.id, "另一个场景项目");
    const scene = ScenarioRecordSchema.parse({
      id: "project-scoped-scene",
      workspaceId: workspace.id,
      projectId,
      name: "当前项目场景",
      goal: "整理当前项目资料",
      pinnedVersion: 1,
      distilled: { slotDefs: [], branches: [], acceptanceTemplates: [], signature: { keywords: ["资料"], embedding: [1, 0], embedVia: "bag-of-words" }, buildId: "build-project-scene", pinnedVersion: 1 },
      capabilityIds: [], source: "test", approvals: [], stats: { uses: 0, successes: 0, lastUsedAt: null, driftCount: 0 }, degraded: false, status: "active", tags: [], versionHistory: [], createdAt: "2026-10-03T00:00:00.000Z",
    });
    await library.save(scene);
    await expect(server.handleAction({ type: "select-scenario", scenarioId: scene.id })).resolves.toMatchObject({ ok: true });
    expect((await server.snapshot()).activeScenarioId).toBe(scene.id);
    await expect(server.handleAction({ type: "select-project", projectId: other.id })).resolves.toMatchObject({ ok: true });
    const switched = await server.snapshot();
    expect(switched.activeScenarioId).toBeNull();
    expect(switched.scenarios.some((item) => item.id === scene.id)).toBe(false);
  });

  it("/memory forget 不能删除其它 workspace 的 Memory 文件", async () => {
    const foreignWorkspace = await repository.createWorkspace("其它 Memory 工作区");
    const foreignPath = path.join(dir, "knowledge", "foreign-forget.md");
    await writeFile(foreignPath, "foreign", "utf8");
    await memories.create({ id: "foreign-forget-memory", workspaceId: foreignWorkspace.id, projectId: null, sessionId: null, scenarioId: null, scope: "global", name: "foreign-forget", content: "foreign", path: foreignPath, sourceType: "user", sourceId: null, enabled: true });
    const result = await server.handleAction({ type: "run-command", input: `/memory forget ${foreignPath}` });
    expect(result).toMatchObject({ ok: false, error: "Memory 不存在" });
    expect(await (await import("node:fs/promises")).readFile(foreignPath, "utf8")).toBe("foreign");
  });

  it("项目或场景 Memory 没有所属上下文时拒绝创建", async () => {
    await expect(server.handleAction({ type: "create-memory", scope: "scenario", name: "无场景", content: "不应落成全局 Memory" })).resolves.toMatchObject({ ok: false, error: "请先选择场景" });
    await expect(server.handleAction({ type: "archive-project", projectId })).resolves.toMatchObject({ ok: true });
    await expect(server.handleAction({ type: "create-memory", scope: "project", name: "无项目", content: "不应落成全局 Memory" })).resolves.toMatchObject({ ok: false, error: "请先选择项目" });
    expect(await memories.list(server.currentWorkspaceId!)).toHaveLength(0);
  });

  it("桌面上下文支持前端导入、停用和删除", async () => {
    const c = new WsClient(`ws://127.0.0.1:${port}/ws`);
    await c.open();
    await c.waitFor("snapshot");
    c.send({ type: "create-context", kind: "clipboard", origin: "clipboard", label: "选中文本", content: "结论先行" });
    expect((await c.waitFor("action-result")) as { ok: boolean }).toMatchObject({ ok: true });
    const snap = (await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json()) as PanelSnapshot;
    expect(snap.contexts).toHaveLength(1);
    const contextId = snap.contexts[0]!.id;
    c.send({ type: "toggle-context", contextId, enabled: false });
    expect((await c.waitFor("action-result")) as { ok: boolean }).toMatchObject({ ok: true });
    c.send({ type: "delete-context", contextId, confirm: true });
    expect((await c.waitFor("action-result")) as { ok: boolean }).toMatchObject({ ok: true });
    c.close();
  });

  it("桌面本地文件上下文不能跨项目导入", async () => {
    const workspace = await repository.getDefaultWorkspace();
    const otherProject = await repository.createProject(workspace.id, "另一个上下文项目");
    const otherDir = path.join(dir, "projects", otherProject.id);
    await mkdir(otherDir, { recursive: true });
    const otherFile = path.join(otherDir, "private.md");
    await writeFile(otherFile, "private", "utf8");
    const result = await server.handleAction({ type: "create-context", kind: "local-file", origin: otherFile, label: "跨项目文件", content: "private" });
    expect(result).toMatchObject({ ok: false, error: "本地文件不在允许范围内" });
  });

  it("连接器中心支持添加、启停和探活失败留痕", async () => {
    const c = new WsClient(`ws://127.0.0.1:${port}/ws`);
    await c.open();
    await c.waitFor("snapshot");
    c.send({ type: "create-connector", name: "坏连接器", kind: "mcp-remote", endpoint: "http://127.0.0.1:1/mcp", permissionScopes: ["read", "network"], hasSecret: false });
    expect((await c.waitFor("action-result")) as { ok: boolean }).toMatchObject({ ok: true });
    const created = (await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json()) as PanelSnapshot;
    expect(created.connectors).toHaveLength(1);
    const connectorId = created.connectors[0]!.id;
    c.send({ type: "test-connector", connectorId });
    expect((await c.waitFor("action-result")) as { ok: boolean }).toMatchObject({ ok: false });
    const failed = (await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json()) as PanelSnapshot;
    expect(failed.connectors[0]!.status).toBe("error");
    expect(failed.connectors[0]!.trustStatus).toBe("warning");
    expect(failed.connectors[0]!.trustEvidenceCount).toBeGreaterThan(0);
    c.send({ type: "toggle-connector", connectorId, enabled: true });
    expect((await c.waitFor("action-result")) as { ok: boolean }).toMatchObject({ ok: true });
    c.close();
  });

  it("连接器探活遵守 network 权限", async () => {
    const c = new WsClient(`ws://127.0.0.1:${port}/ws`);
    await c.open();
    await c.waitFor("snapshot");
    c.send({ type: "create-connector", name: "无网络权限", kind: "http", endpoint: "http://127.0.0.1:4320/api/settings", permissionScopes: ["read"], hasSecret: false });
    expect((await c.waitFor("action-result")) as { ok: boolean }).toMatchObject({ ok: true });
    const created = (await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json()) as PanelSnapshot;
    const connector = created.connectors.find((item) => item.name === "无网络权限");
    if (!connector) throw new Error("connector was not created");
    c.send({ type: "test-connector", connectorId: connector.id });
    expect((await c.waitFor("action-result")) as { ok: boolean; error?: string }).toMatchObject({ ok: false, error: "连接器未授予 network 权限" });
    c.close();
  });

  it("连接器鉴权失败会留下 warning 信任证据而不是标记为可信", async () => {
    const httpServer = createHttpServer((_req, res) => { res.writeHead(401); res.end("expired"); });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
    try {
      const address = httpServer.address(); if (!address || typeof address === "string") throw new Error("http server address unavailable");
      const c = new WsClient(`ws://127.0.0.1:${port}/ws`); await c.open(); await c.waitFor("snapshot");
      c.send({ type: "create-connector", name: "过期鉴权", kind: "http", endpoint: `http://127.0.0.1:${address.port}/health`, permissionScopes: ["read", "network"], hasSecret: true });
      expect((await c.waitFor("action-result")) as { ok: boolean }).toMatchObject({ ok: true });
      const created = (await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json()) as PanelSnapshot;
      const connector = created.connectors.find((item) => item.name === "过期鉴权"); if (!connector) throw new Error("connector was not created");
      c.send({ type: "test-connector", connectorId: connector.id });
      expect((await c.waitFor("action-result")) as { ok: boolean }).toMatchObject({ ok: false });
      const failed = (await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json()) as PanelSnapshot;
      expect(failed.connectors.find((item) => item.id === connector.id)).toMatchObject({ status: "error", trustStatus: "warning", trustEvidenceCount: 1 });
      c.close();
    } finally { await new Promise<void>((resolve) => httpServer.close(() => resolve())); }
  });

  it("无项目运行产物可以通过 artifactRoot 读取", async () => {
    const artifactPath = path.join(dir, "runs", "standalone.md");
    await writeFile(artifactPath, "# standalone", "utf8");
    await artifacts.create({ id: "standalone-artifact", workspaceId: server.currentWorkspaceId!, projectId: null, sessionId: null, runId: null, name: "standalone.md", mediaType: "text/markdown", path: artifactPath, version: 1, status: "ready" });
    const response = await fetch(`http://127.0.0.1:${port}/api/artifact?path=${encodeURIComponent(artifactPath)}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("standalone");
  });

  it("产物、Provider 和后台任务走同一快照与持久化协议", async () => {
    const c = new WsClient(`ws://127.0.0.1:${port}/ws`);
    await c.open();
    await c.waitFor("snapshot");
    c.send({ type: "create-provider", name: "本地测试模型", kind: "local", baseUrl: "http://127.0.0.1:8317/v1", model: "gpt-6.1-sol", hasSecret: true, secret: "provider-secret" });
    expect((await c.waitFor("action-result")) as { ok: boolean }).toMatchObject({ ok: true });
    c.send({ type: "create-task", requirement: "整理测试资料", schedule: "once", projectId, scenarioId: null });
    expect((await c.waitFor("action-result")) as { ok: boolean }).toMatchObject({ ok: true });
    c.send({ type: "create-artifact", name: "结果.md", mediaType: "text/markdown", path: path.join(dir, "projects", projectId, "结果.md"), runId: null });
    expect((await c.waitFor("action-result")) as { ok: boolean }).toMatchObject({ ok: true });
    const snap = (await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json()) as PanelSnapshot;
    expect(snap.providers).toHaveLength(1);
    expect(snap.tasks).toHaveLength(1);
    expect(snap.artifacts).toHaveLength(1);
    const providerId = snap.providers[0]!.id;
    expect(await secrets.get("provider", providerId)).toBe("provider-secret");
    const taskId = snap.tasks[0]!.id;
    const artifactId = snap.artifacts[0]!.id;
    c.send({ type: "toggle-provider", providerId, enabled: false });
    expect((await c.waitFor("action-result")) as { ok: boolean }).toMatchObject({ ok: true });
    c.send({ type: "delete-task", taskId, confirm: true });
    expect((await c.waitFor("action-result")) as { ok: boolean }).toMatchObject({ ok: true });
    c.send({ type: "delete-artifact", artifactId, confirm: true });
    expect((await c.waitFor("action-result")) as { ok: boolean }).toMatchObject({ ok: true });
    c.send({ type: "delete-provider", providerId, confirm: true });
    expect((await c.waitFor("action-result")) as { ok: boolean }).toMatchObject({ ok: true });
    expect(await secrets.get("provider", providerId)).toBeUndefined();
    c.close();
  });

  it("Provider 绑定和模型健康探测都拒绝越界或空响应", async () => {
    const foreignWorkspace = await repository.createWorkspace("Provider 外部工作区");
    const foreignProvider = await providers.create({ id: "provider-foreign-scope", workspaceId: foreignWorkspace.id, name: "外部 Provider", kind: "local", baseUrl: "http://127.0.0.1:8317/v1", model: "m", enabled: true, hasSecret: false, timeoutMs: 1_000 });
    await expect(server.handleAction({ type: "update-settings", settings: { providerId: foreignProvider.id } })).resolves.toMatchObject({ ok: false, error: "Provider 不存在或不属于当前工作区" });
    await expect(server.handleAction({ type: "update-project", projectId, providerId: foreignProvider.id })).resolves.toMatchObject({ ok: false, error: "Provider 不存在或不属于当前工作区" });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 });
      return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 });
    });
    try {
      await expect(server.handleAction({ type: "test-settings", settings: { baseUrl: "http://health.test/v1", model: "m" }, full: true })).resolves.toMatchObject({ ok: true });
      fetchSpy.mockImplementation(async (input) => String(input).endsWith("/models") ? new Response(JSON.stringify({ data: [] }), { status: 200 }) : new Response("", { status: 200 }));
      await expect(server.handleAction({ type: "test-settings", settings: { baseUrl: "http://health.test/v1", model: "m" }, full: true })).resolves.toMatchObject({ ok: false, error: "聊天验证返回了无效 JSON" });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("后台任务不会把需求冒充成当前会话的用户消息", async () => {
    let source: string | undefined;
    const depsRef = (server as unknown as {
      deps: {
        onStartBuild?: (requirement: string, mode: "work" | "build", scenarioId?: string, slots?: Record<string, string>, projectId?: string, source?: "user" | "task") => Promise<{ ok: boolean; error?: string }>;
      };
    }).deps;
    depsRef.onStartBuild = async (_requirement, _mode, _scenarioId, _slots, _projectId, origin) => { source = origin; return { ok: false, error: "task probe" }; };
    const workspace = await repository.getDefaultWorkspace();
    const task = await tasks.create({ id: "task-source-probe", workspaceId: workspace.id, projectId, scenarioId: null, requirement: "后台整理资料", schedule: "once", enabled: true, lastRunId: null, lastRunAt: null, runCount: 0, maxRuns: null, timeoutMs: 1_000 });
    const result = await server.handleAction({ type: "run-task", taskId: task.id });
    expect(result.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(source).toBe("task");
    const snapshot = await server.snapshot();
    expect(snapshot.chat.some((message) => message.role === "user" && message.content === "后台整理资料")).toBe(false);
    expect(snapshot.chat.some((message) => message.role === "task-notification" && String(message.text).includes("后台任务已触发"))).toBe(true);
  });

  it("后台任务不会覆盖当前会话的模式和场景上下文", async () => {
    const makeScenario = (id: string, name: string) => ({
      id,
      name,
      goal: name,
      pinnedVersion: 1,
      distilled: { slotDefs: [], branches: [], acceptanceTemplates: [], signature: { keywords: [name], embedding: [1, 0], embedVia: "bag-of-words" }, buildId: `build-${id}`, pinnedVersion: 1 },
      capabilityIds: [],
      source: "test",
      approvals: [],
      stats: { uses: 0, successes: 0, lastUsedAt: null, driftCount: 0 },
      degraded: false,
      status: "active" as const,
      tags: [],
      versionHistory: [],
      createdAt: "2026-10-03T00:00:00.000Z",
    });
    await library.save(makeScenario("scenario-current", "当前场景"));
    await library.save(makeScenario("scenario-task", "任务场景"));
    await expect(server.handleAction({ type: "select-scenario", scenarioId: "scenario-current" })).resolves.toMatchObject({ ok: true });
    const depsRef = (server as unknown as { deps: { onStartBuild?: (...args: unknown[]) => Promise<{ ok: boolean; error?: string }> } }).deps;
    depsRef.onStartBuild = async () => ({ ok: false, error: "task probe" });
    const workspace = await repository.getDefaultWorkspace();
    const task = await tasks.create({ id: "task-context-isolation", workspaceId: workspace.id, projectId, scenarioId: "scenario-task", requirement: "后台运行另一个场景", schedule: "once", enabled: true, lastRunId: null, lastRunAt: null, runCount: 0, maxRuns: null, timeoutMs: 1_000 });
    const before = await server.snapshot();
    expect(before.activeScenarioId).toBe("scenario-current");
    expect(before.mode).toBe("work");
    await expect(server.handleAction({ type: "run-task", taskId: task.id })).resolves.toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const after = await server.snapshot();
    expect(after.activeScenarioId).toBe("scenario-current");
    expect(after.mode).toBe("work");
    expect((await history.get(server.currentSessionId!))?.activeScenarioId).toBe("scenario-current");
  });

  it("归档或不存在的场景不能被选择、测试或绑定后台任务", async () => {
    await library.save({ id: "scenario-archived-boundary", name: "已归档场景", goal: "已归档工作流", pinnedVersion: 1, distilled: { slotDefs: [], branches: [], acceptanceTemplates: [], signature: { keywords: ["归档"], embedding: [1, 0], embedVia: "bag-of-words" }, buildId: "build-archived-boundary", pinnedVersion: 1 }, capabilityIds: [], source: "test", approvals: [], stats: { uses: 0, successes: 0, lastUsedAt: null, driftCount: 0 }, degraded: false, status: "archived", tags: [], versionHistory: [], createdAt: "2026-10-03T00:00:00.000Z" });
    await expect(server.handleAction({ type: "select-scenario", scenarioId: "scenario-archived-boundary" })).resolves.toMatchObject({ ok: false, error: "场景已归档，不能选择" });
    await expect(server.handleAction({ type: "test-scenario", scenarioId: "scenario-archived-boundary" })).resolves.toMatchObject({ ok: false, error: "场景已归档，不能测试" });
    await expect(server.handleAction({ type: "create-task", requirement: "不应创建归档任务", schedule: "once", projectId, scenarioId: "scenario-archived-boundary" })).resolves.toMatchObject({ ok: false, error: "任务场景已归档" });
    await expect(server.handleAction({ type: "create-task", requirement: "不应创建未知任务", schedule: "once", projectId, scenarioId: "scenario-missing-boundary" })).resolves.toMatchObject({ ok: false, error: "任务场景不存在" });
    const legacyTask = await tasks.create({ id: "task-legacy-archived-scenario", workspaceId: server.currentWorkspaceId!, projectId, scenarioId: "scenario-archived-boundary", requirement: "历史归档任务", schedule: "once", enabled: true, lastRunId: null, lastRunAt: null, runCount: 0, maxRuns: null, timeoutMs: 1_000 });
    await expect(server.handleAction({ type: "run-task", taskId: legacyTask.id })).resolves.toMatchObject({ ok: false, error: "任务场景已归档" });
    expect(await tasks.list(server.currentWorkspaceId!)).toHaveLength(1);
  });

  it("归档项目不能创建或触发后台任务", async () => {
    const workspace = await repository.getDefaultWorkspace();
    await repository.archiveProject(projectId);
    await expect(server.handleAction({ type: "create-task", requirement: "不应绑定归档项目", schedule: "once", projectId, scenarioId: null })).resolves.toMatchObject({ ok: false, error: "任务项目不存在或不可用" });
    const legacyTask = await tasks.create({ id: "task-legacy-archived-project", workspaceId: workspace.id, projectId, scenarioId: null, requirement: "历史归档项目任务", schedule: "once", enabled: true, lastRunId: null, lastRunAt: null, runCount: 0, maxRuns: null, timeoutMs: 1_000 });
    await expect(server.handleAction({ type: "run-task", taskId: legacyTask.id })).resolves.toMatchObject({ ok: false, error: "任务项目不存在或不可用" });
  });

  it("同一事件匹配多个任务时拒绝部分触发", async () => {
    const workspaceId = server.currentWorkspaceId!;
    await tasks.create({ id: "event-task-a", workspaceId, projectId: null, scenarioId: null, requirement: "事件任务 A", schedule: "event:probe", enabled: true, lastRunId: null, lastRunAt: null, runCount: 0, maxRuns: null, timeoutMs: 1_000 });
    await tasks.create({ id: "event-task-b", workspaceId, projectId: null, scenarioId: null, requirement: "事件任务 B", schedule: "event:probe", enabled: true, lastRunId: null, lastRunAt: null, runCount: 0, maxRuns: null, timeoutMs: 1_000 });
    await expect(server.handleAction({ type: "trigger-event", name: "probe" })).resolves.toMatchObject({ ok: false, error: "同一事件匹配多个任务；当前面板一次只允许触发一个任务" });
    expect((await server.snapshot()).busy).toBe(false);
    expect(await runs.listForWorkspace(workspaceId)).toHaveLength(0);
  });

  it("临时会话新建时不写入持久化历史", async () => {
    const before = await history.list();
    await settings.update({ temporarySession: true });
    await expect(server.handleAction({ type: "new-session" })).resolves.toMatchObject({ ok: true });
    const snapshot = await server.snapshot();
    expect(snapshot.sessionId).toBeNull();
    expect(await history.list()).toHaveLength(before.length);
  });

  it("运行中引导会进入当前会话并排队给下一步", async () => {
    Reflect.set(server, "sessionLocked", true);
    Reflect.set(server, "run", { kind: "work", status: "running", runId: "guidance-run" });
    const result = await server.handleAction({ type: "guide-run", instruction: "下一步只读取 docs/meeting.md，并把负责人字段命名为 owner" });
    expect(result).toMatchObject({ ok: true });
    expect(controller.takeGuidance()).toEqual(["下一步只读取 docs/meeting.md，并把负责人字段命名为 owner"]);
    const snapshot = await server.snapshot();
    expect(snapshot.chat.some((message) => message.guidance === true && message.content === "下一步只读取 docs/meeting.md，并把负责人字段命名为 owner")).toBe(true);
    server.pushChat({ role: "build-status", tone: "ok", runStatus: "succeeded", terminal: true, runId: "guidance-run", text: "引导测试完成", ts: Date.now() });
  });

  it("新建对话显式选择项目后，会话与当前上下文一起切换", async () => {
    const workspace = await repository.getDefaultWorkspace();
    const other = await repository.createProject(workspace.id, "新建对话目标项目");
    const result = await server.handleAction({ type: "new-session", projectId: other.id, scenarioId: null });
    expect(result).toMatchObject({ ok: true, data: { projectId: other.id } });
    const snapshot = await server.snapshot();
    expect(snapshot.projectId).toBe(other.id);
    expect(snapshot.sessions.find((session) => session.id === snapshot.sessionId)?.projectId).toBe(other.id);
    const unbound = await server.handleAction({ type: "new-session", projectId: null, scenarioId: null });
    expect(unbound).toMatchObject({ ok: true, data: { projectId: null } });
    expect((await server.snapshot()).projectId).toBeNull();
    expect((await history.get(server.currentSessionId!))?.projectId).toBeNull();
  });

  it("模式切换与场景选择会进入权威快照", async () => {
    const c = new WsClient(`ws://127.0.0.1:${port}/ws`);
    await c.open();
    await c.waitFor("snapshot");
    c.send({ type: "set-mode", mode: "build" });
    expect((await c.waitFor("action-result")) as { ok: boolean }).toMatchObject({ ok: true });
    const buildSnap = (await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json()) as PanelSnapshot;
    expect(buildSnap.mode).toBe("build");
    c.send({ type: "select-scenario", scenarioId: "sc-demo" });
    expect((await c.waitFor("action-result")) as { ok: boolean }).toMatchObject({ ok: false });
    c.send({ type: "select-scenario", scenarioId: null });
    expect((await c.waitFor("action-result")) as { ok: boolean }).toMatchObject({ ok: true });
    const selectedSnap = (await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json()) as PanelSnapshot;
    expect(selectedSnap.activeScenarioId).toBeNull();
    c.close();
  });

  it("跨模式切换保留聊天历史但清空旧运行检查台", async () => {
    const workspaceId = server.currentWorkspaceId;
    const sessionId = server.currentSessionId;
    if (!workspaceId || !sessionId) throw new Error("expected workspace and session");
    await runs.create({ id: "run-mode-boundary", workspaceId, projectId: null, sessionId, mode: "work", scenarioId: null, providerId: null, model: "m", status: "running", requirement: "旧工作需求", startedAt: "2026-10-03T00:00:00.000Z", finishedAt: null, error: null });
    server.resumeBuild("run-mode-boundary");
    (server as unknown as { activeMode: "work" | "build" }).activeMode = "work";
    server.pushChat({ role: "build-status", tone: "err", text: "旧工作运行失败", terminal: true, runStatus: "failed", runId: "run-mode-boundary", ts: Date.now() });
    const before = await server.snapshot();
    expect(before.run).toMatchObject({ status: "failed", runId: "run-mode-boundary" });
    expect(before.chat.some((message) => message.text === "旧工作运行失败")).toBe(true);
    const switched = await server.handleAction({ type: "set-mode", mode: "build" });
    expect(switched.ok).toBe(true);
    const after = await server.snapshot();
    expect(after.mode).toBe("build");
    expect(after.run).toEqual({ kind: "idle", status: "idle" });
    expect(after.chat.some((message) => message.text === "旧工作运行失败")).toBe(true);
  });

  it("场景卡片泛化测试走服务端执行回执", async () => {
    const c = new WsClient(`ws://127.0.0.1:${port}/ws`);
    await c.open(); await c.waitFor("snapshot");
    const lib = (server as unknown as { deps: { library: ScenarioLibrary } }).deps.library;
    await lib.save({ id: "sc-test", name: "泛化场景", goal: "处理文件", pinnedVersion: 1, distilled: { slotDefs: [{ name: "path", type: "path", sourceNodeId: "n1", examples: ["/a", "/b"] }], branches: [], acceptanceTemplates: [], signature: { keywords: ["文件"], embedding: [1], embedVia: "bag-of-words" }, buildId: "b-test", pinnedVersion: 1 }, capabilityIds: ["cap-fs"], source: "test", approvals: [], stats: { uses: 0, successes: 0, lastUsedAt: null, driftCount: 0 }, degraded: false, status: "active", tags: [], versionHistory: [], createdAt: "2026-10-03T00:00:00.000Z" });
    c.send({ type: "test-scenario", scenarioId: "sc-test" });
    expect((await c.waitFor("action-result")) as { ok: boolean }).toMatchObject({ ok: true });
    const message = await c.waitFor("chat", (value) => String((value.message as { text?: string })?.text ?? "").includes("泛化测试通过"));
    expect((message.message as { role?: string }).role).toBe("build-status");
    c.close();
  });

  it("历史对话与设置 API 持久化且只返回脱敏 Key", async () => {
    const initial = (await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json()) as PanelSnapshot;
    expect(initial.sessionId).toBeTruthy();
    expect(initial.settings).toMatchObject({ model: "test-model", hasApiKey: true });
    expect(JSON.stringify(initial.settings)).not.toContain("secret-key");
    const apiSettings = (await (await fetch(`http://127.0.0.1:${port}/api/settings`)).json()) as { apiKeyMasked: string };
    expect(apiSettings.apiKeyMasked).not.toContain("secret-key");

    server.pushChat({ role: "user", content: "历史测试", timestamp: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const first = (await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json()) as PanelSnapshot;
    const firstSession = first.sessionId;
    expect(first.sessions.some((session) => session.id === firstSession && session.messageCount > 0)).toBe(true);

    const c = new WsClient(`ws://127.0.0.1:${port}/ws`);
    await c.open();
    await c.waitFor("snapshot");
    c.send({ type: "new-session" });
    expect((await c.waitFor("action-result")) as { ok: boolean }).toMatchObject({ ok: true });
    const second = (await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json()) as PanelSnapshot;
    expect(second.sessionId).not.toBe(firstSession);
    expect(second.chat).toHaveLength(0);
    c.send({ type: "open-session", sessionId: firstSession });
    expect((await c.waitFor("action-result")) as { ok: boolean }).toMatchObject({ ok: true });
    const restored = (await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json()) as PanelSnapshot;
    expect(restored.chat.some((message) => message.role === "user" && message.content === "历史测试")).toBe(true);
    c.send({ type: "update-settings", settings: { model: "updated-model", apiKey: "new-secret" } });
    expect((await c.waitFor("action-result")) as { ok: boolean }).toMatchObject({ ok: true });
    const updated = (await (await fetch(`http://127.0.0.1:${port}/api/settings`)).json()) as { model: string; apiKeyMasked: string };
    expect(updated.model).toBe("updated-model");
    expect(updated.apiKeyMasked).not.toContain("new-secret");
    const currentId = restored.sessionId;
    if (!currentId) throw new Error("expected current session");
    c.send({ type: "archive-session", sessionId: currentId });
    expect((await c.waitFor("action-result")) as { ok: boolean }).toMatchObject({ ok: true });
    const archived = (await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json()) as PanelSnapshot;
    expect(archived.sessionId).not.toBe(currentId);
    expect(archived.sessions.find((session) => session.id === currentId)?.archived).toBe(true);
    c.send({ type: "restore-session", sessionId: currentId });
    expect((await c.waitFor("action-result")) as { ok: boolean }).toMatchObject({ ok: true });
    const restoredSession = (await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json()) as PanelSnapshot;
    expect(restoredSession.sessions.find((session) => session.id === currentId)?.archived).toBe(false);
    // Restoring from the archive is also a navigation action: the restored
    // conversation should be visible immediately instead of leaving the user
    // on the replacement blank session.
    expect(restoredSession.sessionId).toBe(currentId);
    expect(restoredSession.chat.some((message) => message.role === "user" && message.content === "历史测试")).toBe(true);
    c.send({ type: "delete-session", sessionId: currentId });
    expect((await c.waitFor("action-result")) as { ok: boolean }).toMatchObject({ ok: false });
    c.send({ type: "delete-session", sessionId: currentId, confirm: true });
    expect((await c.waitFor("action-result")) as { ok: boolean }).toMatchObject({ ok: true });
    expect(((await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json()) as PanelSnapshot).sessions.some((session) => session.id === currentId)).toBe(false);
    c.close();
  });

  it("新建对话可以在创建时绑定一个可用场景并持久化选择", async () => {
    await library.save({ id: "scenario-report", name: "整理周报", goal: "整理周报", pinnedVersion: 1, distilled: { slotDefs: [], branches: [], acceptanceTemplates: [], signature: { keywords: ["周报"], embedding: [1, 0], embedVia: "bag-of-words" }, buildId: "build-report", pinnedVersion: 1 }, capabilityIds: [], source: "test", approvals: [], stats: { uses: 0, successes: 0, lastUsedAt: null, driftCount: 0 }, degraded: false, status: "active", tags: [], versionHistory: [], createdAt: "2026-10-03T00:00:00.000Z" });
    const c = new WsClient(`ws://127.0.0.1:${port}/ws`);
    await c.open();
    await c.waitFor("snapshot");
    c.send({ type: "new-session", scenarioId: "scenario-report" });
    const result = await c.waitFor("action-result") as { ok: boolean; data?: { scenarioId?: string; scenarioName?: string } };
    expect(result).toMatchObject({ ok: true, data: { scenarioId: "scenario-report", scenarioName: "整理周报" } });
    const snapshot = (await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json()) as PanelSnapshot;
    expect(snapshot.activeScenarioId).toBe("scenario-report");
    const session = await history.get(snapshot.sessionId!);
    expect(session?.activeScenarioId).toBe("scenario-report");
    c.close();
  });

  it("历史会话切回时恢复其项目上下文，避免运行落到当前其它项目", async () => {
    const workspace = await repository.getDefaultWorkspace();
    const originalProject = server.currentProjectId;
    if (!originalProject) throw new Error("expected original project");
    const boundProject = await repository.createProject(workspace.id, "会话绑定项目");
    await expect(server.handleAction({ type: "select-project", projectId: boundProject.id })).resolves.toMatchObject({ ok: true });
    const boundSessionId = server.currentSessionId;
    if (!boundSessionId) throw new Error("expected bound session");
    server.pushChat({ role: "user", content: "绑定项目的需求", timestamp: Date.now() });
    await expect(server.handleAction({ type: "new-session" })).resolves.toMatchObject({ ok: true });
    await expect(server.handleAction({ type: "select-project", projectId: originalProject })).resolves.toMatchObject({ ok: true });
    await expect(server.handleAction({ type: "open-session", sessionId: boundSessionId })).resolves.toMatchObject({ ok: true });
    expect(server.currentProjectId).toBe(boundProject.id);
    expect((await history.get(boundSessionId))?.projectId).toBe(boundProject.id);
  });

  it("面板进程重启后恢复当前会话的项目上下文", async () => {
    const workspace = await repository.getDefaultWorkspace();
    const boundProject = await repository.createProject(workspace.id, "重启恢复项目");
    await expect(server.handleAction({ type: "select-project", projectId: boundProject.id })).resolves.toMatchObject({ ok: true });
    const sessionId = server.currentSessionId;
    if (!sessionId) throw new Error("expected current session");
    await server.stop();
    const restarted = new PanelServer({ history, settings, repository, runs, longRuns, pageHtml: defaultPageHtml(), projectRoot: path.join(dir, "projects"), artifactRoot: path.join(dir, "runs"), memoryRoot: dir });
    await restarted.start(0);
    expect(restarted.currentSessionId).toBe(sessionId);
    expect(restarted.currentProjectId).toBe(boundProject.id);
    await restarted.stop();
  });

  it("直接重试或创建分支时拒绝其它历史会话的已结束运行", async () => {
    const workspace = await repository.getDefaultWorkspace();
    const foreignSessionId = "foreign-finished-session";
    await runs.create({ id: "foreign-finished-run", workspaceId: workspace.id, projectId, sessionId: foreignSessionId, mode: "work", scenarioId: null, providerId: null, model: "m", status: "failed", requirement: "其它会话的失败需求", startedAt: new Date(Date.now() - 2_000).toISOString(), finishedAt: new Date(Date.now() - 1_000).toISOString(), error: "failed" });
    await expect(server.handleAction({ type: "retry-run", runId: "foreign-finished-run" })).resolves.toMatchObject({ ok: false, error: "运行不属于当前对话，不能重试" });
    await expect(server.handleAction({ type: "branch-run", runId: "foreign-finished-run" })).resolves.toMatchObject({ ok: false, error: "运行不属于当前对话，不能创建分支" });
    expect((await runs.listForWorkspace(workspace.id)).filter((run) => run.requirement === "其它会话的失败需求")).toHaveLength(1);
  });

  it("活动运行所属的历史会话不能被归档或删除", async () => {
    const workspace = await repository.getDefaultWorkspace();
    const historical = await history.create("work", "仍在运行的历史对话", projectId);
    await runs.create({ id: "historical-running-run", workspaceId: workspace.id, projectId, sessionId: historical.id, mode: "work", scenarioId: null, providerId: null, model: "m", status: "running", requirement: "历史运行中", startedAt: new Date().toISOString(), finishedAt: null, error: null });
    await expect(server.handleAction({ type: "archive-session", sessionId: historical.id })).resolves.toMatchObject({ ok: false, error: "该对话仍有运行，不能归档" });
    await expect(server.handleAction({ type: "delete-session", sessionId: historical.id, confirm: true })).resolves.toMatchObject({ ok: false, error: "该对话仍有运行，不能删除" });
    expect((await history.get(historical.id))?.archived).toBe(false);

    const longSession = await history.create("work", "仍在运行的长程对话", projectId);
    await longRuns.create({ id: "historical-long-run", workspaceId: workspace.id, projectId, sessionId: longSession.id, scenarioId: "scenario-long", goal: "历史长程运行中", slots: {}, maxRounds: 2, nextRound: 1, completedRounds: 0, status: "running", terminalReason: null, nextInstruction: null, pendingRound: null, pendingResult: null, lastRound: null, lastSummary: null, lastMetrics: {}, lastError: null, pauseRequested: false, startedAt: new Date().toISOString(), finishedAt: null });
    await expect(server.handleAction({ type: "archive-session", sessionId: longSession.id })).resolves.toMatchObject({ ok: false, error: "该对话仍有运行，不能归档" });
  });

  it("长程场景创建绑定当前上下文，并支持暂停、继续、停止控制", async () => {
    await library.save({ id: "scenario-long", name: "长程整理", goal: "持续整理资料", pinnedVersion: 1, distilled: { slotDefs: [], branches: [], acceptanceTemplates: [], signature: { keywords: ["资料"], embedding: [1, 0], embedVia: "bag-of-words" }, buildId: "build-long", pinnedVersion: 1 }, capabilityIds: [], source: "test", approvals: [], stats: { uses: 0, successes: 0, lastUsedAt: null, driftCount: 0 }, degraded: false, status: "active", tags: [], versionHistory: [], createdAt: "2026-10-03T00:00:00.000Z" });
    const result = await server.handleAction({ type: "create-long-run", scenarioId: "scenario-long", requirement: "持续整理资料", maxRounds: 3, projectId });
    expect(result).toMatchObject({ ok: true });
    const createdSnapshot = await server.snapshot();
    expect(createdSnapshot.chat.some((message) => message.role === "user" && message.content === "持续整理资料")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect((await history.get(createdSnapshot.sessionId!))?.title).toBe("持续整理资料");
    const created = await longRuns.list(server.currentWorkspaceId!);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ scenarioId: "scenario-long", projectId, sessionId: server.currentSessionId, maxRounds: 3, nextRound: 1, status: "queued" });
    expect((await server.snapshot()).busy).toBe(true);

    const paused = await server.handleAction({ type: "control-long-run", longRunId: created[0]!.id, action: "pause" });
    expect(paused.ok).toBe(true);
    expect((await longRuns.get(created[0]!.id))?.status).toBe("paused");
    const resumed = await server.handleAction({ type: "control-long-run", longRunId: created[0]!.id, action: "resume" });
    expect(resumed.ok).toBe(true);
    expect((await longRuns.get(created[0]!.id))?.status).toBe("queued");
    const stopped = await server.handleAction({ type: "control-long-run", longRunId: created[0]!.id, action: "stop" });
    expect(stopped.ok).toBe(true);
    expect((await longRuns.get(created[0]!.id))?.status).toBe("cancelled");
    expect((await server.snapshot()).busy).toBe(false);
  });

  it("长程场景显式选择其它项目时同步切换会话项目上下文", async () => {
    await library.save({ id: "scenario-long-project-switch", name: "项目切换长程", goal: "跨项目长程", pinnedVersion: 1, distilled: { slotDefs: [], branches: [], acceptanceTemplates: [], signature: { keywords: ["跨项目"], embedding: [1, 0], embedVia: "bag-of-words" }, buildId: "build-long-project-switch", pinnedVersion: 1 }, capabilityIds: [], source: "test", approvals: [], stats: { uses: 0, successes: 0, lastUsedAt: null, driftCount: 0 }, degraded: false, status: "active", tags: [], versionHistory: [], createdAt: "2026-10-03T00:00:00.000Z" });
    const workspace = await repository.getDefaultWorkspace();
    const alternateProject = await repository.createProject(workspace.id, "长程目标项目");
    const result = await server.handleAction({ type: "create-long-run", scenarioId: "scenario-long-project-switch", requirement: "跨项目长程", maxRounds: 2, projectId: alternateProject.id });
    expect(result).toMatchObject({ ok: true });
    expect(server.currentProjectId).toBe(alternateProject.id);
    const sessionId = server.currentSessionId;
    expect(sessionId).toBeTruthy();
    expect((await history.get(sessionId!))?.projectId).toBe(alternateProject.id);
    const created = await longRuns.list(workspace.id);
    expect(created[0]).toMatchObject({ projectId: alternateProject.id, sessionId });
  });

  it("长程执行器启动失败会写入失败终态并显示终态聊天卡", async () => {
    await library.save({ id: "scenario-long-start-fail", name: "启动失败场景", goal: "启动失败探针", pinnedVersion: 1, distilled: { slotDefs: [], branches: [], acceptanceTemplates: [], signature: { keywords: ["启动失败"], embedding: [1, 0], embedVia: "bag-of-words" }, buildId: "build-start-fail", pinnedVersion: 1 }, capabilityIds: [], source: "test", approvals: [], stats: { uses: 0, successes: 0, lastUsedAt: null, driftCount: 0 }, degraded: false, status: "active", tags: [], versionHistory: [], createdAt: "2026-10-03T00:00:00.000Z" });
    const panelDeps = Reflect.get(server as object, "deps") as { onStartLongRun?: (run: unknown) => Promise<{ ok: boolean; error?: string }> };
    panelDeps.onStartLongRun = async () => ({ ok: false, error: "provider 启动失败" });
    const result = await server.handleAction({ type: "create-long-run", scenarioId: "scenario-long-start-fail", requirement: "启动失败探针", maxRounds: 2, projectId });
    expect(result).toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const created = await longRuns.list(server.currentWorkspaceId!);
    expect(created[0]).toMatchObject({ status: "failed", lastError: "provider 启动失败" });
    const snapshot = await server.snapshot();
    expect(snapshot.chat.at(-1)).toMatchObject({ role: "build-status", runId: created[0]!.id, terminal: true, runStatus: "failed", text: "provider 启动失败" });
    expect(snapshot.busy).toBe(false);
  });

  it("并发重试创建长程运行时只允许当前对话建立一条记录", async () => {
    await library.save({ id: "scenario-long-race", name: "长程竞态", goal: "竞态检查", pinnedVersion: 1, distilled: { slotDefs: [], branches: [], acceptanceTemplates: [], signature: { keywords: ["竞态"], embedding: [1, 0], embedVia: "bag-of-words" }, buildId: "build-race", pinnedVersion: 1 }, capabilityIds: [], source: "test", approvals: [], stats: { uses: 0, successes: 0, lastUsedAt: null, driftCount: 0 }, degraded: false, status: "active", tags: [], versionHistory: [], createdAt: "2026-10-03T00:00:00.000Z" });
    const results = await Promise.all([
      server.handleAction({ type: "create-long-run", scenarioId: "scenario-long-race", requirement: "竞态检查一", maxRounds: 2, projectId }),
      server.handleAction({ type: "create-long-run", scenarioId: "scenario-long-race", requirement: "竞态检查二", maxRounds: 2, projectId }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    expect(await longRuns.list(server.currentWorkspaceId!)).toHaveLength(1);
  });

  it("已有长程运行时拒绝其它项目请求且不改变当前项目上下文", async () => {
    await library.save({ id: "scenario-long-project-guard", name: "项目守卫长程", goal: "项目守卫", pinnedVersion: 1, distilled: { slotDefs: [], branches: [], acceptanceTemplates: [], signature: { keywords: ["项目守卫"], embedding: [1, 0], embedVia: "bag-of-words" }, buildId: "build-long-project-guard", pinnedVersion: 1 }, capabilityIds: [], source: "test", approvals: [], stats: { uses: 0, successes: 0, lastUsedAt: null, driftCount: 0 }, degraded: false, status: "active", tags: [], versionHistory: [], createdAt: "2026-10-03T00:00:00.000Z" });
    const workspace = await repository.getDefaultWorkspace();
    const alternateProject = await repository.createProject(workspace.id, "不应切换的项目");
    const first = await server.handleAction({ type: "create-long-run", scenarioId: "scenario-long-project-guard", requirement: "项目守卫", maxRounds: 2, projectId });
    expect(first.ok).toBe(true);
    const originalProject = server.currentProjectId;
    // Simulate a stale inspector after reconnect: the durable active row must
    // still guard duplicate creation before any project selection mutation.
    Reflect.set(server as object, "sessionLocked", false);
    const retry = await server.handleAction({ type: "create-long-run", scenarioId: "scenario-long-project-guard", requirement: "重复项目守卫", maxRounds: 2, projectId: alternateProject.id });
    expect(retry).toMatchObject({ ok: false, error: "当前对话已有长程运行，请先完成或停止它" });
    expect(server.currentProjectId).toBe(originalProject);
    expect((await history.get(server.currentSessionId!))?.projectId).toBe(originalProject);
  });

  it("长程终态消息使用 LongRun id 时不会误更新普通运行记录", async () => {
    server.pushChat({ role: "build-status", tone: "err", runStatus: "failed", runId: "long-run-missing-from-runs", terminal: true, text: "长程场景达到轮次上限", ts: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const snapshot = await server.snapshot();
    expect(snapshot.chat.at(-1)).toMatchObject({ runId: "long-run-missing-from-runs", terminal: true });
    expect(snapshot.busy).toBe(false);
  });

  it("切回拥有活动长程运行的历史对话时恢复锁定和检查台状态", async () => {
    const workspace = await repository.getDefaultWorkspace();
    const historicalSessionId = server.currentSessionId;
    if (!historicalSessionId) throw new Error("expected initial session");
    await expect(server.handleAction({ type: "new-session" })).resolves.toMatchObject({ ok: true });
    await longRuns.create({
      id: "historical-active-long-run",
      workspaceId: workspace.id,
      projectId,
      sessionId: historicalSessionId,
      scenarioId: "scenario-history",
      goal: "恢复历史长程运行",
      slots: {},
      maxRounds: 3,
      nextRound: 2,
      completedRounds: 1,
      status: "running",
      terminalReason: null,
      nextInstruction: "继续第二轮",
      pendingRound: null,
      pendingResult: null,
      lastRound: 1,
      lastSummary: "第一轮完成",
      lastMetrics: {},
      lastError: null,
      pauseRequested: false,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    });
    await expect(server.handleAction({ type: "open-session", sessionId: historicalSessionId })).resolves.toMatchObject({ ok: true });
    const snapshot = await server.snapshot();
    expect(snapshot).toMatchObject({ busy: true, sessionId: historicalSessionId, run: { runId: "historical-active-long-run", status: "running" } });
    await expect(server.handleAction({ type: "start-build", requirement: "不应并行启动", mode: "work" })).resolves.toMatchObject({ ok: false, error: "当前运行尚未结束" });
  });

  it("切换历史会话后检查台不会沿用上一个会话的构建上下文", async () => {
    const firstSessionId = server.currentSessionId;
    const workspaceId = server.currentWorkspaceId;
    if (!firstSessionId || !workspaceId) throw new Error("expected initial session and workspace");
    await runs.create({ id: "build-first-session", workspaceId, projectId: null, sessionId: firstSessionId, mode: "build", scenarioId: null, providerId: null, model: "m", status: "succeeded", requirement: "第一会话需求", startedAt: "2026-10-03T00:00:00.000Z", finishedAt: "2026-10-03T00:00:01.000Z", error: null, details: { phase: "done", intent: { goal: "第一会话目标" } } });
    server.resumeBuild("build-first-session");
    server.pushChat({ role: "build-status", tone: "ok", runStatus: "succeeded", runId: "build-first-session", terminal: true, text: "第一会话完成", ts: Date.now() });
    await server.snapshot();

    await expect(server.handleAction({ type: "new-session" })).resolves.toMatchObject({ ok: true });
    const secondSessionId = server.currentSessionId;
    if (!secondSessionId) throw new Error("expected second session");
    await runs.create({ id: "build-second-session", workspaceId, projectId: null, sessionId: secondSessionId, mode: "build", scenarioId: null, providerId: null, model: "m", status: "succeeded", requirement: "第二会话需求", startedAt: "2026-10-03T00:00:02.000Z", finishedAt: "2026-10-03T00:00:03.000Z", error: null, details: { phase: "done", intent: { goal: "第二会话目标" } } });
    await expect(server.handleAction({ type: "open-session", sessionId: secondSessionId })).resolves.toMatchObject({ ok: true });
    const snapshot = await server.snapshot();
    expect(snapshot.buildId).toBe("build-second-session");
    expect(snapshot.preview.goal).toBe("第二会话目标");
    expect(snapshot.preview.goal).not.toBe("第一会话目标");
  });

  it("长会话持久化保留完整历史，快照只渲染最近窗口", async () => {
    const initial = (await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json()) as PanelSnapshot;
    if (!initial.sessionId) throw new Error("expected session");
    for (let index = 0; index < 205; index++) server.pushChat({ role: "build-status", tone: "info", text: `历史窗口探针 ${index}`, ts: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, 120));
    const snapshot = (await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json()) as PanelSnapshot;
    const persisted = await history.get(initial.sessionId);
    expect(snapshot.chat).toHaveLength(200);
    expect(persisted?.messages).toHaveLength(205);
    expect(persisted?.messages.at(0)).toMatchObject({ text: "历史窗口探针 0" });
    expect(persisted?.messages.at(-1)).toMatchObject({ text: "历史窗口探针 204" });
  });

  it("超过持久化上限时保留最近窗口而不让历史写盘失败", async () => {
    const initial = (await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json()) as PanelSnapshot;
    if (!initial.sessionId) throw new Error("expected session");
    for (let index = 0; index < 505; index++) server.pushChat({ role: "build-status", tone: "info", text: `持久化上限探针 ${index}`, ts: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const persisted = await history.get(initial.sessionId);
    expect(persisted?.messages).toHaveLength(500);
    expect(persisted?.messages.at(0)).toMatchObject({ text: "持久化上限探针 5" });
    expect(persisted?.messages.at(-1)).toMatchObject({ text: "持久化上限探针 504" });
  });

  it("同步应用会把无冲突的远端项目合并到本地再回传", async () => {
    const syncDir = await mkdtemp(path.join(tmpdir(), "panel-sync-apply-"));
    const remoteServer = new WorkspaceSyncServer(jsonStore({ filePath: path.join(syncDir, "remote.json"), schema: RemoteSyncEnvelopeSchema }), "sync-secret");
    const syncPort = await remoteServer.start(0);
    try {
      const workspace = await repository.getDefaultWorkspace();
      const baseProject = await repository.getProject(projectId); if (!baseProject) throw new Error("project missing");
      const remoteProject = { ...baseProject, id: "remote-project-1", name: "远端导入项目", createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:00:01.000Z" };
      const futureEntity = { id: "future-entity-1", updatedAt: "2026-10-03T00:00:02.000Z", type: "future-widget", data: { keep: true } };
      const envelope = { schemaVersion: 1 as const, workspaceId: workspace.id, revision: "remote-r1", entities: [{ id: remoteProject.id, updatedAt: remoteProject.updatedAt, type: "project", data: remoteProject }, futureEntity] };
      await fetch(`http://127.0.0.1:${syncPort}/workspaces/${encodeURIComponent(workspace.id)}/sync`, { method: "POST", headers: { authorization: "Bearer sync-secret", "content-type": "application/json" }, body: JSON.stringify(envelope) });
      await settings.update({ syncEndpoint: `http://127.0.0.1:${syncPort}`, syncToken: "sync-secret" });
      const result = await server.handleAction({ type: "sync-apply", includeMemory: false });
      expect(result.ok).toBe(true);
      expect((await repository.listProjects(workspace.id)).some((project) => project.id === "remote-project-1" && project.name === "远端导入项目")).toBe(true);
      const remoteAfterApply = await (await fetch(`http://127.0.0.1:${syncPort}/workspaces/${encodeURIComponent(workspace.id)}`, { headers: { authorization: "Bearer sync-secret" } })).json() as { entities: Array<{ id: string; type: string; data: unknown }> };
      expect(remoteAfterApply.entities).toContainEqual(futureEntity);
    } finally { await remoteServer.stop(); await rm(syncDir, { recursive: true, force: true }); }
  });

  it("工作区导入会恢复项目文件内容并隔离冲突副本", async () => {
    const contentBase64 = Buffer.from("# restored").toString("base64");
    const result = await server.handleAction({ type: "import-workspace", content: JSON.stringify({ projects: [{ id: "source-project", name: "导入恢复测试", description: "backup", instructions: "输出 Markdown", pinned: false }], files: [{ projectId: "source-project", name: "note.md", mediaType: "text/markdown", contentBase64 }], memories: [{ id: "memory-exported" }] }) });
    expect(result.ok).toBe(true);
    const workspace = await repository.getDefaultWorkspace();
    const imported = (await repository.listProjects(workspace.id)).find((project) => project.name === "导入恢复测试（导入）");
    expect(imported).toBeTruthy();
    const files = await repository.listFiles(imported!.id);
    expect(files).toHaveLength(1);
    expect(await (await import("node:fs/promises")).readFile(files[0]!.path, "utf8")).toBe("# restored");
    const importedNotice = (await server.snapshot()).chat.at(-1) as { text?: string };
    expect(importedNotice.text).toContain("Memory 1 条未导入");
  });

  it("工作区导入索引失败会回滚已写入的孤儿文件", async () => {
    const originalAddFile = repository.addFile;
    (repository as unknown as { addFile: (...args: unknown[]) => Promise<unknown> }).addFile = async () => { throw new Error("index failure"); };
    try {
      const contentBase64 = Buffer.from("# rollback").toString("base64");
      const result = await server.handleAction({ type: "import-workspace", content: JSON.stringify({ projects: [{ id: "rollback-project", name: "导入回滚测试" }], files: [{ projectId: "rollback-project", name: "orphan.md", mediaType: "text/markdown", contentBase64 }] }) });
      expect(result.ok).toBe(true);
      const workspace = await repository.getDefaultWorkspace();
      const imported = (await repository.listProjects(workspace.id)).find((project) => project.name === "导入回滚测试（导入）");
      expect(imported).toBeTruthy();
      expect(await repository.listFiles(imported!.id)).toHaveLength(0);
      await expect(readdir(path.join(dir, "projects", imported!.id))).resolves.toEqual([]);
    } finally {
      (repository as unknown as { addFile: typeof repository.addFile }).addFile = originalAddFile;
    }
  });

  it("工作区导出不泄漏本机路径或 URL 中的凭据", async () => {
    const workspace = await repository.getDefaultWorkspace();
    const project = await repository.getProject(projectId); if (!project) throw new Error("project missing");
    const projectFilePath = path.join(dir, "projects", project.id, "portable.md");
    await mkdir(path.dirname(projectFilePath), { recursive: true }); await writeFile(projectFilePath, "portable", "utf8");
    await repository.addFile({ workspaceId: workspace.id, projectId: project.id, name: "portable.md", path: projectFilePath, mediaType: "text/markdown", size: 8 });
    await memories.create({ id: "memory-portable", workspaceId: workspace.id, projectId: project.id, sessionId: null, scenarioId: null, scope: "project", name: "偏好", content: "内容", path: path.join(dir, "knowledge", "private.md"), sourceType: "user", sourceId: null, enabled: true });
    await contexts.create({ id: "context-portable", workspaceId: workspace.id, projectId: project.id, kind: "local-file", origin: path.join(dir, "private.txt"), label: "本地文件", content: "内容", enabled: true });
    await connectors.create({ workspaceId: workspace.id, name: "远程", kind: "http", endpoint: "https://alice:secret@example.test/mcp", permissionScopes: ["network"], trustEvidence: [{ kind: "manual", ref: path.join(dir, "private-evidence.md"), summary: "本地证据", verifiedAt: "2026-10-03T00:00:00.000Z" }] });
    await connectors.create({ workspaceId: workspace.id, name: "本地命令", kind: "cli", endpoint: "node server.js --token secret", permissionScopes: ["network"] });
    await providers.create({ id: "provider-portable", workspaceId: workspace.id, name: "远程模型", kind: "openai-compatible", baseUrl: "https://alice:secret@example.test/v1", model: "m", enabled: true, hasSecret: true, timeoutMs: 1000 });
    await artifacts.create({ id: "artifact-portable", workspaceId: workspace.id, projectId: project.id, sessionId: null, runId: null, name: "result.md", mediaType: "text/markdown", path: path.join(dir, "runs", "result.md"), version: 1, status: "ready" });
    const bundle = await (await fetch(`http://127.0.0.1:${port}/api/workspace/export`)).json() as { files?: Array<Record<string, unknown>>; memories?: Array<Record<string, unknown>>; contexts?: Array<Record<string, unknown>>; connectors?: Array<Record<string, unknown>>; providers?: Array<Record<string, unknown>>; artifacts?: Array<Record<string, unknown>> };
    expect(bundle.files?.find((file) => file.name === "portable.md")).not.toHaveProperty("path");
    expect(bundle.memories?.find((memory) => memory.id === "memory-portable")?.path).toBeNull();
    expect(bundle.contexts?.find((context) => context.id === "context-portable")?.origin).toBe("local-file://redacted");
    expect(bundle.connectors?.find((connector) => connector.name === "远程")?.endpoint).toBe("https://example.test/mcp");
    expect((bundle.connectors?.find((connector) => connector.name === "远程")?.trustEvidence as Array<{ ref: string }>)[0]?.ref).toBe("local://redacted");
    expect(bundle.connectors?.find((connector) => connector.name === "本地命令")?.endpoint).toBe("endpoint://redacted");
    expect(bundle.providers?.find((provider) => provider.id === "provider-portable")?.baseUrl).toBe("https://example.test/v1");
    expect(bundle.artifacts?.find((artifact) => artifact.id === "artifact-portable")).not.toHaveProperty("path");
  });

  it("工作区导入保留空文件、避免同名覆盖并报告无效条目", async () => {
    const empty = Buffer.from("").toString("base64");
    const result = await server.handleAction({ type: "import-workspace", content: JSON.stringify({ projects: [{ id: "portable-project", name: "空文件导入" }], files: [
      { projectId: "portable-project", name: "same.md", mediaType: "text/markdown", contentBase64: empty },
      { projectId: "portable-project", name: "same.md", mediaType: "text/markdown", contentBase64: Buffer.from("second").toString("base64") },
      { projectId: "portable-project", name: "bad.md", mediaType: "text/markdown", contentBase64: "not-base64" },
    ] }) });
    expect(result.ok).toBe(true);
    const workspace = await repository.getDefaultWorkspace();
    const imported = (await repository.listProjects(workspace.id)).find((project) => project.name === "空文件导入（导入）");
    expect(imported).toBeTruthy();
    const files = await repository.listFiles(imported!.id);
    expect(files.map((file) => file.name).sort()).toEqual(["same.md", "same（2）.md"]);
    expect(await (await import("node:fs/promises")).readFile(files.find((file) => file.name === "same.md")!.path, "utf8")).toBe("");
    const notice = (await server.snapshot()).chat.at(-1) as { text?: string };
    expect(notice.text).toContain("项目文件 1 条格式无效或找不到所属项目，未导入");
  });

  it("大工作区导入走 HTTP 端点，不受聊天 WS 小消息限制", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/workspace/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projects: [{ id: "http-import-project", name: "HTTP 导入" }] }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  });
});

describe("8.4 Web 端完成一轮五闸门与状态机一致", () => {
  it("五闸门 WS 决策驱动 → done，approvals 完整", async () => {
    const c = new WsClient(`ws://127.0.0.1:${port}/ws`);
    await c.open();
    await c.waitFor("snapshot");
    const runPromise = orch.run();
    const isGateCard = (gate: number) => (m: Record<string, unknown>) =>
      (m.message as { role?: string })?.role === "gate-card" && (m.message as { gate?: number }).gate === gate;
    for (const gate of [1, 2, 3, 4, 5]) {
      // 等闸门卡片推送（聊天协议）
      await c.waitFor("chat", isGateCard(gate));
      c.send({ type: "gate-decision", decision: { gate, action: "approve" } });
      const res = (await c.waitFor("action-result")) as { ok: boolean };
      expect(res.ok).toBe(true);
    }
    const final = await runPromise;
    expect(final.phase).toBe("done");
    expect(final.approvals.map((a) => a.gate).sort()).toEqual([1, 2, 3, 4, 5]);
    c.close();
  });

  it("聊天协议：闸门卡片经 chat 推送且决策后历史回填 decided", async () => {
    const c = new WsClient(`ws://127.0.0.1:${port}/ws`);
    await c.open();
    await c.waitFor("snapshot");
    const runPromise = orch.run();
    const isGateCard = (gate: number) => (m: Record<string, unknown>) =>
      (m.message as { role?: string })?.role === "gate-card" && (m.message as { gate?: number }).gate === gate;
    await c.waitFor("chat", isGateCard(1));
    c.send({ type: "gate-decision", decision: { gate: 1, action: "approve" } });
    await c.waitFor("action-result");
    // 决策状态行也经 chat 推送
    const decidedLine = (await c.waitFor("chat", (m) => (m.message as { role?: string })?.role === "build-status")) as {
      message: { text?: string };
    };
    expect(decidedLine.message.text).toContain("闸门1 已批准");
    // 快照中的 gate-card 已回填 decided
    const snap = (await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json()) as PanelSnapshot;
    const card = snap.chat.find((m) => m.role === "gate-card") as { gate: number; decided?: { action: string } } | undefined;
    expect(card?.gate).toBe(1);
    expect(card?.decided?.action).toBe("approve");
    for (const gate of [2, 3, 4, 5]) {
      await c.waitFor("chat", isGateCard(gate));
      c.send({ type: "gate-decision", decision: { gate, action: "approve" } });
      await c.waitFor("action-result");
    }
    await runPromise;
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
    const exported = await fetch(`http://127.0.0.1:${port}/api/scenario?id=sc-panel`);
    expect(exported.status).toBe(200);
    expect((await exported.json()).id).toBe("sc-panel");
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
        await c.waitFor("chat", (m: Record<string, unknown>) => {
          const msg = m.message as { role?: string; gate?: number } | undefined;
          return msg?.role === "gate-card" && msg.gate === gate;
        });
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
    // Establish an authoritative active run first; controls sent while the
    // panel is idle must be rejected instead of mutating a stale controller.
    server.resumeBuild("control-run");
    c.send({ type: "control", action: "pause" });
    expect((await c.waitFor("action-result")) as { ok: boolean }).toMatchObject({ ok: true });
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
