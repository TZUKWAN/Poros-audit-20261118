import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { scenarioDataRoot, jsonStore } from "@/core/store.js";
import { ScenarioLibrary, ScenarioRecordSchema, migratedScenarioName, recordFromDistilled, scenarioNameFromRequirement, scenarioMatchesScope, type ScenarioRecord } from "@/scenario/library.js";
import { localDefinition, ScenarioDefinitionSchema } from "@/scenario/definition.js";
import { tryReuseScenario } from "@/scenario/reuse.js";
import { GeneralizationTester, TaskAcceptance } from "@/acceptance/acceptance.js";
import { distill, intentSignature } from "@/distill/distill.js";
import { attachVirtualUser, createOrchestrator } from "@/orchestrator/runner.js";
import { VirtualUser } from "@/gates/virtual-user.js";
import { createConfiguredPlanner, OpenRouterPlanner } from "@/orchestrator/planner.js";
import { BuildContextSchema, IntentSchema, type Intent, type RuntimeContext } from "@/orchestrator/context.js";
import { fileBuildStore } from "@/orchestrator/build-store.js";
import { findDownstreamNodes } from "@/orchestrator/dag.js";
import { CapabilityInvoker, createSafeHostCommandExecutor, mcpHttpRequest, readHostExecutionEnvironment, type HostExecutionStatus } from "@/execution/capability-runtime.js";
import { RunController } from "@/execution/repair.js";
import { federatedSearchFactory } from "@/federation/factory.js";
import { routeDomain, profileOf } from "@/domains/profile.js";
import { migrateDomainLibraries } from "@/domains/migrate.js";
import { migrateLedgers, applyGateEvents, confirmConstraints, proposeConstraint, emptyLedger, ensureLedger, activeConstraints, bumpConstraintHits, type Constraint } from "@/scenario/ledger.js";
import { runSelfCheck, repairPrompt } from "@/panel/selfcheck.js";
import { resolveRoute } from "@/panel/route.js";
import { templateA, templateB } from "@/panel/prompts.js";
import { gateEventsFromApprovals } from "@/panel/gate-classify.js";
import { inputDigest } from "@/scenario/digest.js";
import { resolveConstraints, readTeamConstraints, ensureTeamLedger } from "@/scenario/team-ledger.js";
import { PanelServer, defaultPageHtml } from "@/panel/server.js";
import { PanelHistory, PanelSessionSchema } from "@/panel/history.js";
import { PanelSettingsSchema, PanelSettingsStore } from "@/panel/settings.js";
import { ConnectorRepository, WorkspaceRepository, ProjectFileSchema } from "@/product/repository.js";
import { ConnectorSchema } from "@/product/contracts.js";
import { RunRepository } from "@/product/runs.js";
import { RunProductSchema } from "@/product/contracts.js";
import { WorkspaceSchema, ProjectSchema } from "@/product/contracts.js";
import { ArtifactRepository } from "@/product/artifacts.js";
import { ProviderProfileRepository } from "@/product/providers.js";
import { ScheduledTaskRepository } from "@/product/tasks.js";
import { LongRunRepository } from "@/product/long-runs.js";
import { PersistentGoalLoop } from "@/execution/persistent-loop.js";
import { MemoryRepository } from "@/product/memory.js";
import { TaskScheduler } from "@/product/scheduler.js";
import { WorkspaceSyncServer } from "@/product/sync-server.js";
import { RemoteSyncEnvelopeSchema } from "@/product/sync-client.js";
import { AuditRepository, AuditRecordSchema } from "@/product/audit.js";
import { SecretRepository, SecretRecordSchema } from "@/product/secrets.js";
import { DesktopContextRepository } from "@/product/contexts.js";
import { DesktopContextSchema } from "@/product/contexts.js";
import { PermissionPolicyRepository } from "@/product/policy.js";
import { PermissionPolicySchema } from "@/product/policy.js";
import { ShareLinkRepository } from "@/product/shares.js";
import { ShareLinkSchema } from "@/product/shares.js";
import { CommentRepository } from "@/product/comments.js";
import { CommentSchema } from "@/product/comments.js";
import { IdentityRepository } from "@/product/identities.js";
import { IdentitySchema } from "@/product/identities.js";
import { ArtifactSchema, LongRunSchema, MemoryItemSchema, ProviderProfileSchema, ScheduledTaskSchema } from "@/product/contracts.js";
import { sessionMemoryMd, memoryPaths } from "@/memory/memory.js";
import type { Orchestrator } from "@/orchestrator/state-machine.js";
import type { BuildContext } from "@/orchestrator/context.js";
import type { Capability } from "@/federation/types.js";
import { buildCapability } from "@/federation/adapters/adapter-utils.js";
import { ModelClient, type ModelToolDefinition, type ModelToolExecutor } from "@/panel/model-client.js";
import { executeScenarioWork, artifactChecksum, type WorkExecutionEvent } from "@/panel/work-execution.js";
import { resolveProjectToolPath } from "@/panel/runtime-path.js";
import { matchResumableBuildRunIds, restartCancellationPatch, selectResumableBuildContext, shouldCancelAfterRestart } from "@/panel/run-recovery.js";
import type { GoalRoundResult } from "@/execution/loop.js";
import type { LongRun } from "@/product/contracts.js";

/**
 * 面板启动器（play 模式）：
 *  - 真实 8 源联邦检索 + 真实能力调用尝试（6s 超时）；不可执行时明确记录失败或宿主委托
 *  - 五闸门由用户在网页上批准/驳回（无虚拟用户）
 *  - done 后蒸馏固化场景 + 写会话 Memory（右侧面板立即可见）
 */

// 4320 is the product's canonical local panel port. Keep an explicit
// PANEL_PORT override for embedded/test deployments, but make the default
// agree with the browser-context integrations and documented sync endpoint.
const PORT = Number(process.env.PANEL_PORT ?? 4320);
const INVOKE_TIMEOUT_MS = 6_000;

/**
 * Immutable ownership for work produced by one start-build request. The
 * panel can continue receiving navigation events after a run is terminal, so
 * completion handlers must never read mutable panel selection state when
 * persisting run outputs.
 */
function hashRunId(runId: string): boolean {
  let hash = 0;
  for (let i = 0; i < runId.length; i++) { hash = (hash << 5) - hash + runId.charCodeAt(i); hash |= 0; }
  return Math.abs(hash) % 100 < 15;
}

type RunBinding = {
  runId: string | null;
  workspaceId: string | null;
  projectId: string | null;
  sessionId: string | null;
  /** §6 双路路由（full 档）：本次运行的重规划目标场景与注入文本——
   *  挂在 binding 上而非闭包变量：并发构建（如定时任务同时重规划）互不覆盖 */
  replanScenarioId?: string | null;
  replanConstraintText?: string;
};

function attachPlannerStream(planner: unknown, panel: PanelServer): void {
  if (planner instanceof OpenRouterPlanner) {
    // Planner responses are control-plane JSON (intent/DAG), not user-facing
    // prose. Never leak partial JSON tokens into the conversation stream.
    // Keep one readable progress event so the user knows the model is active.
    let announced = false;
    planner.setChunkHandler(() => {
      if (announced) return;
      announced = true;
      panel.pushChat({ role: "build-status", tone: "info", text: "模型正在整理目标和执行步骤……", ts: Date.now() });
    });
  }
}

function localBuildCapability(query: string): Capability {
  return buildCapability({
    id: "builtin:scenario-plan",
    name: "场景规划器",
    kind: "skill-knowledge",
    description: `内置场景规划能力：把“${query.slice(0, 80)}”整理成可复用步骤。构建阶段不调用外部服务。`,
    source: { id: "modelscope", tier: "official", name: "场景工作台内置能力", url: "https://modelscope.cn" },
    install: { type: "context", location: "builtin://scenario-plan" },
    tags: ["scenario", "planning", "local"],
  });
}

async function parseIntentForReuse(planner: { parseIntent(requirement: string): Promise<unknown> }, requirement: string): Promise<Intent> {
  try {
    const parsed = IntentSchema.safeParse(await planner.parseIntent(requirement));
    if (parsed.success) return parsed.data;
  } catch {
    // 复用判断失败时回退到本地关键词签名，不阻断完整构建。
  }
  return { goal: requirement, domain: "general", slots: [], keywords: requirement.split(/\s+/).filter((word) => word.length >= 2).slice(0, 16), via: "template" };
}

async function main(): Promise<void> {
  const dataRoot = scenarioDataRoot();
  // CLI/Git execution is opt-in at the host boundary.  Catalog entries and
  // model input never get to choose a process or cwd; the launcher only
  // accepts a narrow environment allow-list and supplies the bound project
  // root for each individual run below.
  const hostEnvironment = readHostExecutionEnvironment();
  const hostExecutionStatus: HostExecutionStatus = hostEnvironment.status;
  const memoryRoot = path.join(dataRoot, "memory");
  const buildStore = fileBuildStore(path.join(dataRoot, "builds"));
  for (const p of [memoryRoot, memoryPaths(memoryRoot).sessions, memoryPaths(memoryRoot).scenarios, memoryPaths(memoryRoot).knowledge]) {
    await mkdir(p, { recursive: true });
  }
  const library = new ScenarioLibrary({
    store: jsonStore({ filePath: path.join(dataRoot, "scenarios.json"), schema: ScenarioRecordSchema }),
  });
  // SceneFlow 领域合并：把 ares/metis 两仓遗留场景库一次性迁入统一库（非破坏，
  // 原数据根不动；幂等——来源根场景数与已迁移标记比对，无新增即跳过）。
  await migrateDomainLibraries(library);
  // 分寸账本迁移（§3）：存量场景折算补齐 ledger（幂等，已有账本跳过）。
  await migrateLedgers(library);
  // 两角色模型：幂等初始化团队层账本（文件即组织，git 同步）
  ensureTeamLedger(dataRoot);
  // Older panel builds used the raw request as the scenario name and could
  // leave several identical labels in the library. Normalize those legacy
  // request-shaped names first, then add readable suffixes so selection
  // remains unambiguous after an upgrade. Intentionally custom names are
  // preserved.
  const existingScenarios = (await library.list()).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const usedScenarioNames = new Set<string>();
  for (const scenario of existingScenarios) {
    const nextName = migratedScenarioName(scenario.name, scenario.goal, [...usedScenarioNames]);
    if (nextName !== scenario.name) await library.save({ ...scenario, name: nextName });
    usedScenarioNames.add(nextName);
  }
  let controller = new RunController();
  const history = new PanelHistory(jsonStore({ filePath: path.join(dataRoot, "panel-sessions.json"), schema: PanelSessionSchema }));
  const settings = new PanelSettingsStore(jsonStore({ filePath: path.join(dataRoot, "panel-settings.json"), schema: PanelSettingsSchema }));
  const repository = new WorkspaceRepository(
    jsonStore({ filePath: path.join(dataRoot, "workspaces.json"), schema: WorkspaceSchema }),
    jsonStore({ filePath: path.join(dataRoot, "projects.json"), schema: ProjectSchema }),
    jsonStore({ filePath: path.join(dataRoot, "project-files.json"), schema: ProjectFileSchema }),
  );
  const connectors = new ConnectorRepository(jsonStore({ filePath: path.join(dataRoot, "connectors.json"), schema: ConnectorSchema }));
  const runs = new RunRepository(jsonStore({ filePath: path.join(dataRoot, "runs.json"), schema: RunProductSchema }));
  const artifacts = new ArtifactRepository(jsonStore({ filePath: path.join(dataRoot, "artifacts.json"), schema: ArtifactSchema }));
  const providers = new ProviderProfileRepository(jsonStore({ filePath: path.join(dataRoot, "providers.json"), schema: ProviderProfileSchema }));
  const tasks = new ScheduledTaskRepository(jsonStore({ filePath: path.join(dataRoot, "tasks.json"), schema: ScheduledTaskSchema }));
  const longRuns = new LongRunRepository(jsonStore({ filePath: path.join(dataRoot, "long-runs.json"), schema: LongRunSchema }));
  const memories = new MemoryRepository(jsonStore({ filePath: path.join(dataRoot, "memory-items.json"), schema: MemoryItemSchema }));
  const audit = new AuditRepository(jsonStore({ filePath: path.join(dataRoot, "audit.json"), schema: AuditRecordSchema }));
  const secrets = new SecretRepository(jsonStore({ filePath: path.join(dataRoot, "secrets.json"), schema: SecretRecordSchema }));
  const contexts = new DesktopContextRepository(jsonStore({ filePath: path.join(dataRoot, "desktop-contexts.json"), schema: DesktopContextSchema }));
  const policy = new PermissionPolicyRepository(jsonStore({ filePath: path.join(dataRoot, "permission-policy.json"), schema: PermissionPolicySchema }));
  const shares = new ShareLinkRepository(jsonStore({ filePath: path.join(dataRoot, "shares.json"), schema: ShareLinkSchema }));
  const comments = new CommentRepository(jsonStore({ filePath: path.join(dataRoot, "comments.json"), schema: CommentSchema }));
  const identities = new IdentityRepository(jsonStore({ filePath: path.join(dataRoot, "identities.json"), schema: IdentitySchema }));
  const defaultWorkspace = await repository.getDefaultWorkspace();
  const workspaceProvider = async (providerId: string | null | undefined): Promise<Awaited<ReturnType<typeof providers.get>> | undefined> => {
    if (!providerId) return undefined;
    const provider = await providers.get(providerId);
    return provider?.workspaceId === defaultWorkspace.id ? provider : undefined;
  };
  const connectorCapabilities = async (query: string): Promise<Capability[]> => {
    const workspaceId = panel.currentWorkspaceId;
    if (!workspaceId) return [];
    // Listing remote tools is itself a network operation. Respect the
    // workspace policy before touching a connector; checking only the
    // connector's own scope would let a disabled workspace network policy be
    // bypassed during build-time capability discovery.
    if (!(await policy.get(workspaceId)).network) return [];
    const tokens = query.toLowerCase().split(/\s+/).filter((token) => token.length >= 2);
    const source = { id: "mcp-so" as const, tier: "official" as const, name: "当前项目连接器", url: "https://modelcontextprotocol.io" };
    const found: Capability[] = [];
    for (const connector of await connectors.list(workspaceId)) {
      if (connector.kind !== "mcp-remote" || connector.status !== "enabled" || !connector.endpoint) continue;
      try {
        const secret = await secrets.get("connector", connector.id);
        const response = await mcpHttpRequest(connector.endpoint, "tools/list", {}, { secret, timeoutMs: 8_000 });
        if (!response.ok) continue;
        const body = response.payload as { result?: { tools?: Array<{ name?: string; description?: string }> } };
        for (const tool of body.result?.tools ?? []) {
          if (!tool.name) continue;
          const searchable = `${tool.name} ${tool.description ?? ""}`.toLowerCase();
          if (tokens.length && !tokens.some((token) => searchable.includes(token))) continue;
          found.push(buildCapability({
            id: `connector:${connector.id}:${tool.name}`,
            name: `${connector.name} · ${tool.name}`,
            kind: "mcp-server",
            description: tool.description ?? `项目连接器工具 ${tool.name}`,
            source,
            install: { type: "remote", url: connector.endpoint, transport: "streamable-http" },
            remoteRun: { url: connector.endpoint, transport: "streamable-http", probeHint: tool.name },
            tags: ["connector", "project", tool.name],
            requiresAuth: connector.hasSecret,
          }));
        }
      } catch {
        // A connector that cannot list tools remains visible in its own
        // settings/health surface; it must not block the global build search.
      }
    }
    return found;
  };
  const loadConnectorTools = async (workspaceId: string | null): Promise<{ tools: ModelToolDefinition[]; executor?: ModelToolExecutor }> => {
    if (!workspaceId) return { tools: [] };
    // A connector grant is necessary but not sufficient: the workspace
    // policy is the outer boundary and may be changed after the connector
    // was enabled. Avoid discovery when network is disabled and re-check it
    // again immediately before every tools/call below.
    if (!(await policy.get(workspaceId)).network) return { tools: [] };
    const definitions: ModelToolDefinition[] = [];
    const handlers = new Map<string, { connectorId: string; endpoint: string; originalName: string; secret?: string }>();
    for (const connector of await connectors.list(workspaceId)) {
      if (connector.kind !== "mcp-remote" || connector.status !== "enabled" || !connector.endpoint || !connector.permissionScopes.includes("network")) continue;
      try {
        const secret = await secrets.get("connector", connector.id);
        const response = await mcpHttpRequest(connector.endpoint, "tools/list", {}, { secret, timeoutMs: 8_000 });
        if (!response.ok) continue;
        const body = response.payload as { result?: { tools?: Array<{ name?: string; description?: string; inputSchema?: Record<string, unknown> }> } };
        for (const tool of body.result?.tools ?? []) {
          if (!tool.name) continue;
          const baseModelName = `mcp_${connector.id.replace(/[^a-zA-Z0-9_]/g, "_")}_${tool.name.replace(/[^a-zA-Z0-9_]/g, "_")}`;
          // OpenAI function names only permit a narrow ASCII subset; two MCP
          // names such as `read-file` and `read_file` can otherwise collapse
          // to the same model-visible name and route calls nondeterministically.
          let modelName = baseModelName;
          let collision = 2;
          while (handlers.has(modelName)) modelName = `${baseModelName}_${collision++}`;
          definitions.push({ type: "function", function: { name: modelName, description: `${connector.name}：${tool.description ?? tool.name}`, parameters: tool.inputSchema ?? { type: "object", properties: {} } } });
          handlers.set(modelName, { connectorId: connector.id, endpoint: connector.endpoint, originalName: tool.name, secret });
        }
      } catch {
        // Connector health remains visible in settings; an unavailable MCP
        // server must not make ordinary model execution fail at context load.
      }
    }
    if (!definitions.length) return { tools: [] };
    const executor: ModelToolExecutor = async (call, options) => {
      const target = handlers.get(call.name);
      if (!target) return `工具 ${call.name} 不存在。`;
      const currentPolicy = await policy.get(workspaceId);
      if (!currentPolicy.network) throw new Error("workspace network permission is disabled");
      const currentConnector = await connectors.get(target.connectorId);
      if (!currentConnector || currentConnector.workspaceId !== workspaceId || currentConnector.status !== "enabled") throw new Error("MCP connector is no longer enabled");
      if (!currentConnector.permissionScopes.includes("network")) throw new Error("MCP connector network permission is disabled");
      const currentSecret = await secrets.get("connector", target.connectorId);
      const response = await mcpHttpRequest(currentConnector.endpoint ?? target.endpoint, "tools/call", { name: target.originalName, arguments: call.arguments }, { secret: currentSecret, signal: options?.signal, timeoutMs: 30_000 });
      const text = typeof response.payload === "string" ? response.payload : JSON.stringify(response.payload);
      if (!response.ok) throw new Error(`MCP 工具调用失败 HTTP ${response.status}: ${text.slice(0, 500)}`);
      return text.slice(0, 20_000);
    };
    return { tools: definitions, executor };
  };
  const { search, instance: searchInstance } = await federatedSearchFactory();
  // SceneFlow：分源检索进度走 progress 通道（原地更新进度卡），不再逐条刷聊天
  searchInstance.onSourceSettled = (sourceId: string, ok: boolean, _completed: number, total: number) => {
    panel.pushProgress(panel.currentRunId, { source: { id: sourceId, ok }, sourcesTotal: total, phase: "retrieving" });
  };
  const searchForBuild = async (query: string, limit = 5): Promise<Awaited<ReturnType<typeof search>>> => {
    // 构建阶段必须有一个可验证的本地基线能力。外部联邦源主要返回
    // git/cli/MCP 目录条目，它们不能在面板进程内直接执行；如果把它们
    // 直接排在第一位，自动闸门会选中不可运行能力，导致整条 DAG 被跳过。
    // 保留外部候选供人工查看，但始终把本地规划能力放在首位，并去掉
    // 同一个能力被多个源重复返回的条目。
    const local = localBuildCapability(query);
    try {
      const result = await search(query, limit);
      const projectConnectors = await connectorCapabilities(query);
      const capabilities = [local, ...projectConnectors, ...result.capabilities.filter((cap) => cap.id !== local.id && !projectConnectors.some((projectCap) => projectCap.id === cap.id))];
      return { ...result, capabilities: capabilities.slice(0, Math.max(1, limit)) };
    } catch (error) {
      return { query, capabilities: [local], statuses: [], totalMs: 0, ...(error instanceof Error ? { error: error.message } : {}) } as Awaited<ReturnType<typeof search>>;
    }
  };
  const invoker = new CapabilityInvoker();
  await settings.load();
  const initialSettings = await settings.get();
  const initialProvider = await workspaceProvider(initialSettings.providerId);
  const initialProviderSecret = initialProvider ? await secrets.get("provider", initialProvider.id) : undefined;
  let planner = createConfiguredPlanner(await settings.toPlannerEnv(initialProvider ? { baseUrl: initialProvider.baseUrl, model: initialProvider.model, timeoutMs: initialProvider.timeoutMs, apiKey: initialProviderSecret } : undefined));

  let current: Orchestrator | undefined;
  let currentDone = true;
  let launchBusy = false;
  type BuildAnswerResult = { ok: boolean; error?: string };
  // Assigned after PanelServer construction. Keeping this indirection lets
  // the panel answer a persisted clarification without exposing the
  // orchestrator object to the transport layer.
  let resumeBuild: (runId: string, values: Record<string, string>) => Promise<BuildAnswerResult> = async () => ({ ok: false, error: "构建恢复器尚未初始化" });
  const longRunWorkers = new Map<string, PersistentGoalLoop>();
  const projectRootFor = async (projectId?: string | null): Promise<string | undefined> => {
    if (!projectId) return undefined;
    const project = await repository.getProject(projectId);
    if (!project) return undefined;
    const root = project.rootPath ?? path.join(dataRoot, "projects", projectId);
    // Internal projects are created before their first upload/tool write, so
    // make their private root available to the same containment resolver used
    // by bound folders. `mkdir` is a no-op for an already-bound real folder.
    await mkdir(root, { recursive: true });
    return root;
  };
  const invokerForProject = async (projectId?: string | null): Promise<CapabilityInvoker> => {
    if (!hostExecutionStatus.enabled) return invoker;
    const projectRoot = await projectRootFor(projectId);
    const hostExecutor = createSafeHostCommandExecutor({
      allowedCommands: hostEnvironment.allowedCommands,
      projectRoot,
      workspaceRoot: hostEnvironment.workspaceRoot,
      installRoot: hostEnvironment.installRoot ? (capability) => path.join(hostEnvironment.installRoot!, capability.id.replace(/[^A-Za-z0-9._-]/g, "_")) : undefined,
      maxTimeoutMs: hostEnvironment.maxTimeoutMs,
      maxOutputBytes: hostEnvironment.maxOutputBytes,
    });
    return new CapabilityInvoker(undefined, fetch, hostExecutor);
  };
  /**
   * Built-in workspace tools are the local execution baseline. They are
   * deliberately small: model calls can list/read indexed project files and
   * write only inside the bound project root when the workspace write policy
   * explicitly allows it. No shell is exposed here; CLI/Git remains behind
   * HostExecutionSpec and its host allow-list.
   */
  const loadRuntimeTools = async (workspaceId: string | null, projectId: string | null): Promise<{ tools: ModelToolDefinition[]; executor?: ModelToolExecutor }> => {
    const connectorTools = await loadConnectorTools(workspaceId);
    const definitions = [...connectorTools.tools];
    const builtin = new Map<string, (args: Record<string, unknown>, signal?: AbortSignal) => Promise<string>>();
    if (workspaceId && projectId) {
      const project = await repository.getProject(projectId);
      if (!project || project.workspaceId !== workspaceId || project.status !== "active") return { tools: definitions, executor: connectorTools.executor };
      const root = await projectRootFor(projectId);
      if (root) {
        const resolveRelative = async (value: unknown, mustExist: boolean): Promise<string> => {
          return await resolveProjectToolPath(root, value, mustExist);
        };
        definitions.push({ type: "function", function: { name: "workspace_list_files", description: "列出当前项目已索引的文件。返回相对路径，不返回机器绝对路径。", parameters: { type: "object", properties: {} } } });
        builtin.set("workspace_list_files", async () => {
          const files = (await repository.listFiles(projectId)).filter((file) => file.indexed).slice(0, 500);
          return JSON.stringify(files.map((file) => ({ path: file.name, mediaType: file.mediaType, size: file.size })));
        });
        definitions.push({ type: "function", function: { name: "workspace_read_file", description: "读取当前项目内的文本文件；只能读取项目根目录内的已授权文件。", parameters: { type: "object", required: ["path"], properties: { path: { type: "string", description: "项目内相对路径" } } } } });
        builtin.set("workspace_read_file", async (args) => {
          const target = await resolveRelative(args.path, true);
          const currentPolicy = await policy.get(workspaceId);
          if (!currentPolicy.read) throw new Error("workspace read permission is disabled");
          const content = await readFile(target, "utf8");
          return content.slice(0, 30_000);
        });
        definitions.push({ type: "function", function: { name: "workspace_write_file", description: "写入当前项目内的文本文件；需要工作区写入权限，路径必须是项目内相对路径。", parameters: { type: "object", required: ["path", "content"], properties: { path: { type: "string", description: "项目内相对路径" }, content: { type: "string", description: "要写入的 UTF-8 文本，最多 100000 字符" } } } } });
        builtin.set("workspace_write_file", async (args) => {
          const currentPolicy = await policy.get(workspaceId);
          if (!currentPolicy.write) throw new Error("workspace write permission is disabled; enable it in the policy panel first");
          if (typeof args.content !== "string" || args.content.length > 100_000) throw new Error("content must be a UTF-8 string of at most 100000 characters");
          const target = await resolveRelative(args.path, false);
          await mkdir(path.dirname(target), { recursive: true });
          // Re-canonicalise after creating directories so a pre-existing or
          // newly introduced symlink cannot turn the write into an outside
          // project mutation.
          const safeTarget = await resolveRelative(args.path, false);
          await writeFile(safeTarget, args.content, "utf8");
          return JSON.stringify({ ok: true, path: String(args.path), bytes: Buffer.byteLength(args.content, "utf8") });
        });
      }
    }
    if (!definitions.length) return { tools: [] };
    const executor: ModelToolExecutor = async (call, options) => {
      const local = builtin.get(call.name);
      if (local) return await local(call.arguments, options?.signal);
      if (connectorTools.executor) return await connectorTools.executor(call, options);
      return `工具 ${call.name} 不存在。`;
    };
    return { tools: definitions, executor };
  };
  const definitionFromBuild = (requirement: string, final: BuildContext): Awaited<ReturnType<typeof localDefinition>> => {
    const base = localDefinition(requirement);
    const nodes = (final.dag as { nodes?: Array<{ id?: string; title?: string; deps?: string[]; expectedOutput?: string }> } | null)?.nodes ?? [];
    const selectionByNode = new Map(final.selections.map((selection) => [selection.nodeId, selection.capabilityId]));
    if (!nodes.length) return base;
    return ScenarioDefinitionSchema.parse({
      ...base,
      summary: final.intent?.goal ?? requirement,
      steps: nodes.map((node, index) => ({
        id: typeof node.id === "string" && /^[a-zA-Z0-9_-]+$/.test(node.id) ? node.id : `step-${index + 1}`,
        title: String(node.title ?? `步骤 ${index + 1}`),
        instruction: `完成步骤：${String(node.title ?? node.id ?? `步骤 ${index + 1}`)}。${selectionByNode.get(String(node.id ?? "")) ? `优先尝试能力 ${selectionByNode.get(String(node.id ?? ""))}；` : ""}只基于真实上下文输出，无法执行时明确说明。`,
        deps: (node.deps ?? []).filter((dep) => typeof dep === "string"),
        expectedOutput: String(node.expectedOutput ?? "该步骤的可追溯交付结果"),
        capabilityId: selectionByNode.get(String(node.id ?? "")) ?? null,
      })),
    });
  };
  const loadRuntimeContext = async (projectIdOverride?: string, scenarioIdOverride?: string | null): Promise<RuntimeContext> => {
    const workspaceId = panel.currentWorkspaceId;
    const projectId = projectIdOverride ?? panel.currentProjectId;
    const project = workspaceId && projectId ? await repository.getProject(projectId) : undefined;
    const files = projectId ? (await repository.listFiles(projectId)).filter((file) => file.indexed) : [];
    const providerSettings = await settings.get();
    // Keep file content out of the frozen context. The execution service reads
    // files only after a realpath allow-list check, preventing a symlink inside
    // the project from smuggling outside content into a model prompt.
    const fileRefs = files.slice(0, 40).map((file) => ({ id: file.id, name: file.name, path: file.path, mediaType: file.mediaType, size: file.size }));
    const memoryRefs = workspaceId ? (await memories.listVisible(workspaceId, { projectId, sessionId: panel.currentSessionId, scenarioId: scenarioIdOverride ?? null })).filter((item) => item.enabled).slice(0, 40).map((item) => ({ id: item.id, name: item.name, scope: item.scope, content: item.content, sourceType: item.sourceType, sourceId: item.sourceId })) : [];
    const connectorRefs = workspaceId ? (await connectors.list(workspaceId)).map((connector) => ({ id: connector.id, name: connector.name, kind: connector.kind, permissionScopes: connector.permissionScopes, status: connector.status })) : [];
    const desktopContexts = workspaceId ? (await contexts.list(workspaceId)).filter((context) => context.enabled && (!projectId || context.projectId === null || context.projectId === projectId)).slice(0, 30).map((context) => ({ id: context.id, kind: context.kind, origin: context.origin, label: context.label, content: context.content })) : [];
    const selected = await workspaceProvider(project?.providerId ?? providerSettings.providerId);
    return { projectId, projectInstructions: project?.instructions ?? "", files: fileRefs, memories: memoryRefs, connectors: connectorRefs, desktopContexts, provider: { id: selected?.id ?? project?.providerId ?? providerSettings.providerId ?? null, baseUrl: selected?.baseUrl ?? providerSettings.baseUrl, model: selected?.model ?? providerSettings.plannerModel ?? providerSettings.model, timeoutMs: selected?.timeoutMs ?? providerSettings.timeoutMs } };
  };
  const makeWorkModel = async (projectIdOverride?: string): Promise<{ model: ModelClient | null; providerId: string | null; modelName: string }> => {
    const providerSettings = await settings.get();
    const project = projectIdOverride ? await repository.getProject(projectIdOverride) : undefined;
    const selected = await workspaceProvider(project?.providerId ?? (projectIdOverride === panel.currentProjectId ? panel.currentProjectProviderId : null) ?? providerSettings.providerId);
    if (selected && !selected.enabled) return { model: null, providerId: selected.id, modelName: selected.model };
    const apiKey = selected ? await secrets.get("provider", selected.id) : providerSettings.apiKey;
    // A configured local/provider profile is executable without an API key. The
    // default remote settings without a key are only a template, so report
    // untested instead of claiming the model ran.
    const localEndpoint = /^(https?:\/\/)?(?:localhost|127\.0\.0\.1|::1)(?::\d+)?(?:\/|$)/i.test(providerSettings.baseUrl.replace(/^https?:\/\//i, ""));
    if (!selected && !apiKey?.trim() && !localEndpoint) return { model: null, providerId: null, modelName: providerSettings.model };
    const baseUrl = selected?.baseUrl ?? providerSettings.baseUrl;
    const modelName = selected?.model ?? providerSettings.model;
    return { model: new ModelClient({ baseUrl, apiKey: apiKey ?? "", model: modelName, fallbackModel: providerSettings.fallbackModel, temperature: providerSettings.temperature, maxTokens: providerSettings.maxTokens, reasoningEffort: "low", timeoutMs: selected?.timeoutMs ?? providerSettings.timeoutMs, streaming: providerSettings.streaming }), providerId: selected?.id ?? providerSettings.providerId, modelName };
  };
  /**
   * 分寸账本（PR-signal-build）：闸5 pin 时把本轮闸门攒下的分寸提案签约入新场景账本。
   * 质量门槛/去重由 proposeConstraint 兜底；闸5 签约 = 批量填 confirmedAt（§14）；
   * 本轮闸门事件（approve/edit/reject）一并计入 gateStats。
   */
  // §6 双路路由（full 档）：重规划命中既有场景时，收尾更新它而不是新建副本；
  // 约束模板 A/B 注入重规划上下文（计划是缓存，账本不动）。
  // 目标与注入文本挂在每运行的 binding 上（并发构建互不覆盖）。
  const attachBuildLedger = (scenario: ScenarioRecord, final: BuildContext): { scenario: ScenarioRecord; signed: Constraint[] } => {
    const seeds = panel.drainBuildLedgerProposals();
    let ledger = scenario.ledger ?? emptyLedger();
    const confirmedIds: string[] = [];
    const signed: Constraint[] = [];
    for (const seed of seeds) {
      const proposed = proposeConstraint(ledger, {
        clause: seed.clause,
        scope: seed.scope,
        kind: seed.kind,
        pattern: seed.pattern,
        origin: { type: seed.originType, text: seed.originText, at: seed.at, runId: seed.runId },
      });
      if (proposed) {
        ledger = proposed.ledger;
        confirmedIds.push(proposed.constraint.id);
        signed.push(proposed.constraint);
      }
    }
    ledger = applyGateEvents(ledger, gateEventsFromApprovals(final.approvals));
    ledger = confirmConstraints(ledger, confirmedIds);
    return { scenario: { ...scenario, ledger }, signed };
  };
  const finishBuild = async (final: BuildContext, requirement: string, runPlanner: unknown, buildId: string, binding?: RunBinding): Promise<void> => {
    // A clarification is a resumable suspension, not a terminal build
    // result. The orchestrator and PanelServer have already persisted/rendered
    // the question; do not create artifacts or unlock the session here.
    if (final.awaitingUser) return;
    // 只有真实执行与三层验收全部通过、且闸门5明确选择 pin 时才固化。
    const shouldPin = final.outcome === "completed" && final.finalizeChoice === "pin";
    const distilled = final.distilled ? (final.distilled as Awaited<ReturnType<typeof distill>>) : await distill(final);
    const id = `sc-${buildId}`;
    let savedScenario: ScenarioRecord | undefined;
    let signedLedgerConstraints: Constraint[] = [];
    if (shouldPin) {
      const replanId = binding?.replanScenarioId ?? null;
      const existing = replanId ? await library.get(replanId) : undefined;
      if (existing) {
        // 计划是缓存（§0 铁律 2）：重规划整个换掉计划，账本不动；版本+1 留痕
        savedScenario = {
          ...existing,
          pinnedVersion: existing.pinnedVersion + 1,
          distilled: { slotDefs: distilled.slotDefs, branches: distilled.branches, acceptanceTemplates: distilled.acceptanceTemplates, signature: distilled.signature, sourceSignature: existing.distilled.sourceSignature, buildId: distilled.buildId, pinnedVersion: distilled.pinnedVersion },
          capabilityIds: [...new Set(final.selections.map((s) => s.capabilityId))],
        };
        savedScenario.definition = definitionFromBuild(requirement, final);
        const seeded = attachBuildLedger(savedScenario, final);
        savedScenario = seeded.scenario;
        signedLedgerConstraints = seeded.signed;
        await library.save(savedScenario);
      } else {
        const existingNames = (await library.list()).map((scenario) => scenario.name);
        savedScenario = recordFromDistilled({ id, name: scenarioNameFromRequirement(requirement, existingNames), ctx: final, distilled, capabilityIds: [...new Set(final.selections.map((s) => s.capabilityId))], workspaceId: binding?.workspaceId ?? null, projectId: binding?.projectId ?? null, sourceSignature: await intentSignature(requirement, []) });
        savedScenario.definition = definitionFromBuild(requirement, final);
        const seeded = attachBuildLedger(savedScenario, final);
        savedScenario = seeded.scenario;
        signedLedgerConstraints = seeded.signed;
        await library.save(savedScenario);
      }
    }
    const memorySettings = await settings.get();
    const usage = (runPlanner as { lastUsage?: { totalTokens: number } }).lastUsage;
    if (binding?.runId && usage) {
      const selected = await workspaceProvider(memorySettings.providerId);
      const cost = selected?.costPerMillion === null || selected?.costPerMillion === undefined ? null : usage.totalTokens * selected.costPerMillion / 1_000_000;
      // A stale async build may finish after its durable run was removed or
      // after a long-run id replaced the panel inspector. Never let that
      // late bookkeeping crash the launcher process.
      if (await runs.get(binding.runId)) await runs.update(binding.runId, { tokenCount: usage.totalTokens, cost });
    }
    const sessionMemoryPath = path.join(memoryPaths(memoryRoot).sessions, `${final.id}.md`);
    // §13 Memory 边界唯一交点：条款签约时同步写一行 memory（反向：memory 永不变条款）
    const ledgerMemorySuffix = signedLedgerConstraints.map((c) => `[ledger] 新增约束 ${c.id}: ${c.clause}`).join("\n");
    const sessionMemoryContent = ledgerMemorySuffix ? `${sessionMemoryMd(final)}\n\n${ledgerMemorySuffix}\n` : sessionMemoryMd(final);
    if (memorySettings.autoMemory) {
      await writeFile(sessionMemoryPath, sessionMemoryContent, "utf8");
      if (binding?.workspaceId) {
        await memories.create({ id: `memory-run-${final.id}`, workspaceId: binding.workspaceId, projectId: binding.projectId, sessionId: binding.sessionId, scenarioId: shouldPin ? id : null, scope: "session", name: `${final.id} 运行记录`, content: sessionMemoryContent, path: sessionMemoryPath, sourceType: "run", sourceId: final.id, enabled: true });
      }
    } else {
      panel.pushChat({ role: "memory-proposal", proposalName: `${final.id} 运行记录`, content: sessionMemoryContent, text: "本次运行生成了一份可选 Memory。保存后会进入会话作用域。", ts: Date.now() });
    }
    const artifactPath = memorySettings.autoMemory ? sessionMemoryPath : path.join(dataRoot, "runs", `${final.id}.json`);
    if (!memorySettings.autoMemory) { await mkdir(path.dirname(artifactPath), { recursive: true }); await writeFile(artifactPath, JSON.stringify({ id: final.id, requirement, outcome: final.outcome, trace: final.trace, acceptance: final.acceptance }, null, 2), "utf8"); }
    await artifacts.create({ id: `artifact-${final.id}`, workspaceId: binding?.workspaceId ?? (await repository.getDefaultWorkspace()).id, projectId: binding?.projectId ?? null, sessionId: binding?.sessionId ?? null, runId: binding?.runId ?? null, name: `${final.id} 运行记录.md`, mediaType: "text/markdown", path: artifactPath, version: 1, status: shouldPin ? "ready" : "failed" });
    if (binding?.runId) {
      const stored = await runs.get(binding.runId);
      // A user may terminate a run and immediately start another one while
      // the old orchestrator is still unwinding. Never let that late result
      // overwrite an already terminal/cancelled durable row.
      if (stored && ["queued", "running", "waiting-user", "paused", "waiting-approval"].includes(stored.status)) {
        const finishedAt = new Date().toISOString();
        await runs.update(binding.runId, {
          status: shouldPin ? "succeeded" : "failed",
          finishedAt,
          durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(stored.startedAt)),
          error: shouldPin ? null : `构建结束但未固化：${final.outcome}`,
          details: { outcome: final.outcome, phase: final.phase, requirement: final.requirement, trace: final.trace, acceptance: final.acceptance, runtimeContext: final.runtimeContext, distilled: final.distilled },
        });
      }
    }
    panel.pushChat({ role: "build-status", tone: shouldPin ? "ok" : "err", runStatus: shouldPin ? "succeeded" : "failed", runId: binding?.runId ?? undefined, error: shouldPin ? undefined : `构建结束但未固化：${final.outcome}`, text: shouldPin ? `构建完成 ✓ 场景已固化为「${savedScenario?.name ?? "新场景"}」（v1）。定义检查已通过，首次工作运行会继续验证外部能力。${signedLedgerConstraints.length ? `已签约 ${signedLedgerConstraints.length} 条分寸进账本。` : ""}` : `构建结束但未固化：定义或流程检查未通过（${final.outcome}）。`, terminal: true, ts: Date.now() });
    await panel.refresh();
  };

  const failBuild = async (err: unknown, runId?: string | null): Promise<void> => {
    const message = err instanceof Error ? err.message : String(err);
    panel.pushChat({ role: "build-status", tone: "err", runStatus: "failed", runId: runId ?? undefined, error: message, text: `构建失败：${message}。可以直接输入新需求重试。`, terminal: true, ts: Date.now() });
    await panel.refresh();
  };

  const panel: PanelServer = new PanelServer({
    library,
    controller,
    history,
    settings,
    repository,
    connectors,
    runs,
    artifacts,
    providers,
    tasks,
    longRuns,
    onStartLongRun: async (run) => startLongRun ? await startLongRun(run) : { ok: false, error: "长程执行器尚未初始化" },
    onControlLongRun: async (run, action) => controlLongRun ? await controlLongRun(run, action) : { ok: false, error: "长程控制器尚未初始化" },
    onAnswerBuild: async (runId, values) => await resumeBuild(runId, values),
    memories,
    audit,
    secrets,
    contexts,
    policy,
    hostExecution: hostExecutionStatus,
    shares,
    comments,
    identities,
    projectRoot: path.join(dataRoot, "projects"),
    artifactRoot: path.join(dataRoot, "runs"),
    memoryRoot,
    pageHtml: defaultPageHtml(),
    onSettingsChanged: async () => {
      const next = await settings.get();
       const provider = await workspaceProvider(next.providerId);
       const providerSecret = provider ? await secrets.get("provider", provider.id) : undefined;
       planner = createConfiguredPlanner(await settings.toPlannerEnv(provider ? { baseUrl: provider.baseUrl, model: provider.model, timeoutMs: provider.timeoutMs, apiKey: providerSecret } : undefined));
      if (panel) attachPlannerStream(planner, panel);
    },
    onStartBuild: async (requirement, mode = "build", scenarioId, _providedSlots, projectIdOverride, source = "user") => {
      const executionProjectId = projectIdOverride ?? panel.currentProjectId;
      if (launchBusy || (!currentDone && current)) {
        panel.pushChat({
          role: "build-status", tone: "err",
          text: `已有构建进行中（${current?.ctx.id ?? "启动中"}，阶段 ${current?.ctx.phase ?? "准备"}）——先完成它（可驳回或等待）`, ts: Date.now(),
        });
        return { ok: false, error: "build in progress" };
      }
      // 先占用启动锁，再进行解析、匹配和检索，避免两个 WS 消息在首个 await 前同时通过检查。
      launchBusy = true;
      // R3 审计#3：锁后到 orch.run() 的 finally 接管前存在多个裸 await（invokerForProject/
      // provider/secrets 解析/parseIntentForReuse/runtimeContext 组装的整段 IO），任一
      // reject 都会让 launchBusy 永真 → 面板从此对一切 start-build 回"已有构建进行中"。
      // 整体包一层兜底：异常路径清锁 + 推终端错误消息 + 返回失败（中间的正常早退
      // 分支各自已清锁，return 不会触发 catch）。
      // R5+ 收尾：orchestrator 是否已启动必须在 catch 可见的 outer 作用域声明
      //（try 块内声明的 const 对 catch 不可达）。
      let orchestratorStarted = false;
      const buildStartedAt = Date.now();
      try {
      controller = new RunController();
      panel.setController(controller);
      // Every terminal chat event carries the run that produced it. This
      // prevents a slow previous launcher promise from closing a newer run.
      const panelRunId = panel.currentRunId;
      const runBinding: RunBinding = {
        runId: panelRunId,
        workspaceId: panel.currentWorkspaceId,
        projectId: executionProjectId ?? null,
        sessionId: panel.currentSessionId,
      };
      const executionInvoker = await invokerForProject(executionProjectId);
      const pushRunChat = (message: Record<string, unknown>): void => panel.pushChat(panelRunId ? { ...message, runId: panelRunId } : message);
      // SceneFlow 进度卡：构建叙述不再逐条刷聊天，统一原地更新
      const pushRunProgress = (phase: string, line: string): void => panel.pushProgress(panelRunId, { phase, line });
      const runAbort = new AbortController();
      // The planner is selected after the reuse check (a project may provide
      // its own provider), so keep a small mutable binding for the terminate
      // hook. Keep the aborted binding until this run settles: a planner call
      // that races with termination must see the already-aborted signal and
      // fail immediately instead of opening a new provider request.
      let activePlannerAbort: OpenRouterPlanner | undefined;
      const clearPlannerAbort = (): void => {
        activePlannerAbort?.setAbortSignal(undefined);
        activePlannerAbort = undefined;
      };
      controller.onTerminateCallback(() => {
        runAbort.abort();
      });
      // User submissions are persisted as chat messages. Scheduled task
      // executions already have their own task-notification and must not
      // masquerade as a human message or rename the current conversation.
      if (source === "user") panel.pushChat({ role: "user", content: requirement, timestamp: Date.now() });
      pushRunProgress("parsing", "正在解析意图并检查可复用场景……");
      const executeSavedDefinition = async (scenario: ScenarioRecord): Promise<{ ok: boolean; error?: string }> => {
        try {
        const runController = controller;
        const definition = scenario.definition ?? localDefinition(scenario.goal);
        const runId = runBinding.runId ?? `run-${Date.now()}`;
        let providedSlots: Record<string, string> = { ...(_providedSlots ?? {}) };
        const safeScenarioId = scenario.id.replace(/[^a-zA-Z0-9._-]/g, "_");
        const artifactPath = path.join(dataRoot, "runs", `${runId}-${safeScenarioId}-result.md`);
         pushRunChat({ role: "build-status", tone: "info", text: `已加载场景“${scenario.name}”，正在读取授权项目资料并执行步骤……`, ts: Date.now() });
        const runtimeContext = await loadRuntimeContext(executionProjectId ?? undefined, scenario.id);
        const workModel = await makeWorkModel(executionProjectId ?? undefined);
        const allowedRoot = await projectRootFor(executionProjectId);
        const connectorTools = await loadRuntimeTools(runBinding.workspaceId, executionProjectId ?? null);
        let result: Awaited<ReturnType<typeof executeScenarioWork>>;
        while (true) {
          result = await executeScenarioWork({
            definition,
            requirement,
            context: runtimeContext,
            model: workModel.model,
            outputPath: artifactPath,
            allowedRoot,
            slots: providedSlots,
            signal: runAbort.signal,
            checkpoint: () => runController.checkpoint(),
            guidance: () => runController.takeGuidance(),
            tools: connectorTools.tools,
            toolExecutor: connectorTools.executor,
            onEvent: (event: WorkExecutionEvent) => {
              // 任务画布：节点事件进进度卡（不重复入聊天流），由客户端按 nodeId 原地合并
              if (event.type === "step-start") panel.pushProgress(runId, { node: { nodeId: event.nodeId, title: event.title, status: "running" } });
              if (event.type === "step-finish") {
                panel.pushProgress(runId, { node: { nodeId: event.nodeId, title: event.title, status: event.status === "success" || event.status === "skipped" ? "ok" : "err", seconds: Math.max(0, Math.round(event.durationMs / 1000)) } });
              }
              if (event.type === "chunk") pushRunChat({ role: "model-stream", nodeId: event.nodeId, content: event.chunk, ts: Date.now() });
              if (event.type === "thinking") pushRunChat({ role: "model-thinking", nodeId: event.nodeId, content: event.chunk, ts: Date.now() });
              if (event.type === "tool-call") pushRunChat({ role: "tool-call", nodeId: event.nodeId, toolCallId: event.call.id, toolName: event.call.name, arguments: event.call.arguments, ts: Date.now() });
              if (event.type === "tool-result") pushRunChat({ role: "tool-result", nodeId: event.nodeId, toolCallId: event.call.id, toolName: event.call.name, content: event.output, ts: Date.now() });
              if (event.type === "warning") pushRunChat({ role: "build-status", tone: "info", text: event.message, ts: Date.now() });
            },
          });
          if (result.status !== "awaiting-user") break;
          const answer = await panel.waitForRunInput(runId, result.missingInputs ?? []);
          providedSlots = { ...providedSlots, ...answer };
        }
        const workspaceId = runBinding.workspaceId ?? (await repository.getDefaultWorkspace()).id;
        // 任务画布收口：工作模式运行结束 → 进度卡折叠为一行摘要
        panel.pushProgress(runId, { finished: true, line: result.status === "succeeded" ? "执行完成，产物已生成。" : result.status === "untested" ? "已生成说明，但缺少真实执行证据。" : "执行失败。" });
        // 终态画布卡写入聊天历史：重载/换会话后任务画布仍在
        panel.pushChat({
          role: "progress-card", runId, finished: true, sessionId: runBinding.sessionId,
          steps: result.trace.map((step) => ({
            at: Number(Date.parse(step.finishedAt)) || Date.now(),
            text: step.status === "failed" ? `失败 · ${step.title}` : step.title,
            nodeId: step.nodeId,
            status: step.status === "success" || step.status === "skipped" ? "ok" : step.status === "failed" ? "err" : undefined,
          })),
          startedAt: Number(Date.parse(result.trace[0]?.startedAt ?? "")) || Date.now(),
          finishedAt: Date.now(),
          ts: Date.now(),
        });
        await artifacts.create({ id: `artifact-${runId}-result`, workspaceId, projectId: runBinding.projectId, sessionId: runBinding.sessionId, runId, name: `${scenario.name} 工作结果.md`, mediaType: "text/markdown", path: result.artifactPath, version: 1, checksum: artifactChecksum(result.artifactContent), status: result.status === "succeeded" ? "ready" : result.status === "untested" ? "draft" : "failed" });
        const finishedAt = new Date().toISOString();
        const storedRun = await runs.get(runId);
        if (storedRun) {
          await runs.update(runId, { status: result.status === "succeeded" ? "succeeded" : result.status === "cancelled" ? "cancelled" : "failed", finishedAt, durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(storedRun.startedAt)), error: result.error ?? null, tokenCount: result.totalTokens, details: { status: result.status, validation: result.validation, trace: result.trace, artifactPath: result.artifactPath, context: { projectId: runtimeContext.projectId, fileIds: runtimeContext.files.map((file) => file.id), memoryIds: runtimeContext.memories.map((memory) => memory.id), desktopContextIds: runtimeContext.desktopContexts.map((item) => item.id) }, model: result.model ?? workModel.modelName, providerId: workModel.providerId } });
        }
        // A legacy record may lack a definition. Persist the compatible local
        // definition before writing the execution validation state.
        if (!scenario.definition) {
          scenario.definition = definition;
          await library.save(scenario);
        }
        if (result.status !== "untested") {
          await library.execute(scenario.id, providedSlots, async () => ({ ok: result.status === "succeeded" }));
        }
        await library.updateExecutionValidation(scenario.id, result.validation, runId, definition);
        // §10 产出自检（spot/full）：机械→judge→修复≤1轮；仍违规→黄标交付+suspected
        let unmetClauses: string[] = [];
        let suspectedRun = false;
        const routingMode = (await settings.get()).routingMode;
        if (routingMode !== "legacy" && result.status === "succeeded" && result.artifactContent) {
          const fresh = await library.get(scenario.id);
          const activeOnes = fresh?.ledger ? activeConstraints(fresh.ledger) : [];
          // 两角色模型：合并团队层条款 + 15% 确定性 holdout（仅 advisory 被抽走）
          const teamConstraints = readTeamConstraints(dataRoot);
          const allConstraints = resolveConstraints(activeOnes, teamConstraints).filter((c) => c.active && !c.supersededBy);
          const holdoutRun = panelRunId ? hashRunId(panelRunId) : false;
          const checkedConstraints = holdoutRun ? allConstraints.filter((c) => c.kind !== "advisory") : allConstraints;
          // 归因对象（两角色 3.2）：常规轮=受检条款（helped/hurt）；holdout 轮=被抽走的 advisory
          // （heldoutRuns/holdoutAccepted 挂在它们头上——反事实基线记的是"没有它时表现如何"）。
          // failed/untested 轮不标记：约束既未进提示词也未受检，无归因对象。
          const attributionIds = holdoutRun
            ? allConstraints.filter((c) => c.kind === "advisory").map((c) => c.id)
            : checkedConstraints.map((c) => c.id);
          if (panelRunId && attributionIds.length) panel.markRunInjection(panelRunId, attributionIds, holdoutRun);
          if (checkedConstraints.length) {
            const check = await runSelfCheck({
              constraints: checkedConstraints,
              output: result.artifactContent,
              judge: workModel.model ? (system, input) => workModel.model!.complete(system, input, { signal: runAbort.signal }).then((r) => r.text) : undefined,
              repair: workModel.model
                ? async (violations, output) => {
                    const revised = await workModel.model!.complete("你是修订助手。", repairPrompt(violations, output), { signal: runAbort.signal });
                    return revised.text;
                  }
                : undefined,
            });
            if (check.repairedOutput) {
              await writeFile(artifactPath, check.repairedOutput, "utf8");
              result = { ...result, artifactContent: check.repairedOutput };
            }
            if (check.violations.length) {
              unmetClauses = check.violations.map((violation) => violation.clause);
              suspectedRun = true;
              if (panelRunId) panel.markRunSuspected(panelRunId);
            }
            for (const violation of check.violations) {
              await library.updateLedger(scenario.id, (ledger) => bumpConstraintHits(ledger, violation.id)).catch(() => undefined);
            }
          }
        }
        const ok = result.status === "succeeded";
        const handled = ok || result.status === "untested";
        const untestedText = result.error === "model provider unavailable"
          ? "场景已加载，但模型 Provider 不可用；已保存未验证的执行记录，不会伪报完成。"
          : `场景已生成说明，但没有形成可验证的任务结果：${result.error ?? "缺少真实执行证据"}。`;
        panel.pushChat({ role: "build-status", tone: ok ? "ok" : result.status === "untested" ? "info" : "err", runStatus: result.status === "succeeded" ? "succeeded" : result.status === "cancelled" ? "cancelled" : "failed", text: ok ? `场景执行完成 ✓ 已生成“${scenario.name} 工作结果.md”。` : result.status === "untested" ? untestedText : `场景执行失败：${result.error ?? "模型或步骤未通过"}。结果已保存，修复配置后可重试。`, terminal: true, runId: panelRunId ?? undefined, ...(ok ? { workRun: true } : {}), ...(unmetClauses.length ? { unmet: unmetClauses, suspected: suspectedRun } : {}), ts: Date.now() });
        await panel.refresh();
        // An untested run is a handled, auditable outcome. Keep it out of the
        // generic WS action-error path; the terminal chat card already says
        // exactly why no result was produced.
        return { ok: handled, error: handled ? undefined : result.error };
        } finally {
          // Provider, filesystem, registry, or validation failures must not
          // leave the launcher permanently locked for the next request.
          launchBusy = false;
        }
      };
      if (mode === "work" && scenarioId) {
        const selected = await library.get(scenarioId);
        if (!selected || !scenarioMatchesScope(selected, { workspaceId: panel.currentWorkspaceId, projectId: executionProjectId })) {
          panel.pushChat({ role: "build-status", tone: "err", text: "指定场景不存在或已被删除。", terminal: true, runId: panelRunId ?? undefined, ts: Date.now() });
          await panel.refresh();
          launchBusy = false;
          return { ok: false, error: "scenario not found" };
        }
        // 分寸账本：绑定实际执行的场景 + 输入 digest（反应窗结算读它）
        if (panelRunId) panel.bindRunScenario(panelRunId, selected.id, inputDigest(requirement, _providedSlots ?? {}));
        return await executeSavedDefinition(selected);
      }
       const executionProject = executionProjectId ? await repository.getProject(executionProjectId) : undefined;
       const projectProvider = await workspaceProvider(executionProject?.providerId ?? (executionProjectId === panel.currentProjectId ? panel.currentProjectProviderId : null));
       const projectProviderSecret = projectProvider ? await secrets.get("provider", projectProvider.id) : undefined;
       const runPlanner = projectProvider ? createConfiguredPlanner(await settings.toPlannerEnv({ baseUrl: projectProvider.baseUrl, model: projectProvider.model, timeoutMs: projectProvider.timeoutMs, apiKey: projectProviderSecret })) : planner;
      if (runPlanner instanceof OpenRouterPlanner) {
        activePlannerAbort = runPlanner;
        runPlanner.setAbortSignal(runAbort.signal);
      }
      const parsedIntent = await parseIntentForReuse(runPlanner, requirement);
      // 分寸账本灰度（§16）：legacy 只记不用；spot 自检；full 双路路由+体检
      const routingMode = (await settings.get()).routingMode;
      // SceneFlow 真流式：目标叙述逐字上屏到进度卡（增强能力，任何失败静默）
      if (typeof runPlanner.narrateGoal === "function") {
        void runPlanner
          .narrateGoal(requirement, (delta: string) => panel.pushProgress(panelRunId, { delta }), runAbort.signal)
          .catch(() => undefined);
      }
      try {
        runAbort.signal.throwIfAborted();
      } catch (error) {
        clearPlannerAbort();
        launchBusy = false;
        throw error;
      }
      let match: Awaited<ReturnType<typeof library.match>>;
      try {
        const signature = await intentSignature(parsedIntent.goal, parsedIntent.keywords);
        match = await library.match(signature, { workspaceId: panel.currentWorkspaceId, projectId: executionProjectId }, requirement);
      } catch (error) {
        clearPlannerAbort();
        launchBusy = false;
        throw error;
      }
      if (match.tier === "hit" && match.scenario) {
        if (mode === "work") {
          // 治理边界：降级场景拦下自动化触发（无人监督的定时任务），
          // 但放行用户显式请求——成功一次即由治理自动解除降级。
          if (match.degraded && source === "task") {
            pushRunChat({ role: "build-status", tone: "err", text: `定时任务命中了已降级场景“${match.scenario.name}”（近期成功率不足），已跳过自动执行；请在工作台手动重跑以解除降级。`, terminal: true, ts: Date.now() });
            await panel.refresh();
            clearPlannerAbort();
            launchBusy = false;
            return { ok: false, error: "degraded scenario blocked for automated run" };
          }
          // 降级场景的显式重跑：告知风险但放行——成功一次即由治理自动解除降级
          if (match.degraded) pushRunChat({ role: "build-status", tone: "info", text: `场景“${match.scenario.name}”近期执行成功率较低，本次为你重试执行，成功后会自动解除降级。`, ts: Date.now() });
          pushRunChat({ role: "build-status", tone: "info", text: `已命中场景“${match.scenario.name}”，正在检查能力漂移并尝试真实工具执行……`, ts: Date.now() });
          const runDigest = inputDigest(requirement, Object.fromEntries((parsedIntent.slots ?? []).map((s) => [s.name, s.value ?? ""])));
          // 分寸账本：绑定 match 命中的场景 + 意图槽位 digest（反应窗结算读它）
          if (panelRunId) panel.bindRunScenario(panelRunId, match.scenario.id, runDigest);
          // §6 双路路由（full 档）：tier × digest 命中 × 强制体检 × degraded → 重放 or 重规划
          const route = routingMode === "full" ? resolveRoute(ensureLedger(match.scenario), { degraded: match.degraded, digest: runDigest }) : null;
          if (route && route.mode === "replan") {
            // 重规划：整个换掉计划（计划是缓存），账本不动；约束/先例注入规划上下文
            runBinding.replanScenarioId = match.scenario.id;
            // 抽查态闸门：重规划关联既有账本（gateStats 支撑自动通过）
            panel.setBuildLedgerScenarioId(match.scenario.id);
            const ledgerOfMatch = ensureLedger(match.scenario);
            const teamCs = readTeamConstraints(dataRoot);
            const allActive = resolveConstraints(activeConstraints(ledgerOfMatch), teamCs).filter((c) => c.active && !c.supersededBy);
            const parts = [templateA(allActive), templateB(ledgerOfMatch.inputPatterns)].filter(Boolean);
            runBinding.replanConstraintText = parts.join("\n\n");
            pushRunProgress("planning", route.healthCheck
              ? "强制体检：这个场景已连续重放多次，重新规划一次以检查世界是否变化……"
              : `分寸账本判定本次重新规划（${route.reason}）……`);
          } else {
            if (route) pushRunChat({ role: "build-status", tone: "info", text: `分寸账本判定重放（${route.reason}）`, ts: Date.now() });
          pushRunChat({ role: "build-status", tone: "info", text: `已命中场景“${match.scenario.name}”，正在检查能力漂移并尝试真实工具执行……`, ts: Date.now() });
          let reused: Awaited<ReturnType<typeof tryReuseScenario>>;
          try {
            reused = await tryReuseScenario({ library, scenario: match.scenario, requirement, intent: parsedIntent, search: searchForBuild, invoker: executionInvoker, checkpoint: () => controller.checkpoint(), signal: runAbort.signal });
          } catch (error) {
            launchBusy = false;
            throw error;
          }
          if (reused.handled) {
            pushRunChat({ role: "build-status", tone: reused.ok ? "ok" : "err", text: reused.ok ? `真实能力执行完成 ✓ ${match.scenario.name}` : `真实能力执行失败：${reused.error ?? "能力调用未通过"}`, terminal: true, ...(reused.ok ? { workRun: true } : {}), ts: Date.now() });
            await panel.refresh();
            clearPlannerAbort();
            launchBusy = false;
            return { ok: reused.ok, error: reused.error };
          }
          pushRunChat({ role: "build-status", tone: "info", text: "场景能力当前不可直接复用，将进入模型工作步骤；结果会明确标记缺少真实工具证据。", ts: Date.now() });
          clearPlannerAbort();
          return await executeSavedDefinition(match.scenario);
          }
        }
        pushRunProgress("planning", `发现已有场景“${match.scenario.name}”，构建模式将重新检查流程并更新定义，不在构建阶段执行外部工具。`);
      } else if (match.tier === "partial" && match.scenario) {
         pushRunProgress("planning", `发现相近场景 ${match.scenario.id}（相似度 ${(match.score * 100).toFixed(0)}%），将结合当前需求重新规划。`);
      }
      if (mode === "work" && !runBinding.replanScenarioId) {
        // Keep the user's original requirement attached to the terminal
        // outcome so the UI can offer a one-click, lossless hand-off into
        // construction. Requiring the user to retype a long request here is
        // both error-prone and unlike a normal assistant interaction. A
        // partial match is not a miss: tell the user a near scenario exists
        // and its similarity, so the suggestion reads as honest triage.
        const partialNote = match.tier === "partial" && match.scenario ? `找到相近场景（相似度 ${(match.score * 100).toFixed(0)}%），还不足以直接执行。` : "";
         pushRunChat({ role: "build-status", tone: "info", text: `工作模式没有找到可直接使用的场景。${partialNote}切换到场景构建后，可以把这次需求固化成新场景。`, action: "switch-to-build", requirement, terminal: true, ts: Date.now() });
        await panel.refresh();
        clearPlannerAbort();
        launchBusy = false;
        return { ok: false, error: "no reusable scenario" };
      }
      pushRunProgress("retrieving", "好，开始构建。我先去能力库里寻找能完成这件事的可靠工具，首次检索大约需要几十秒。");
      // 首次检索用于展示；后续节点按各自查询检索，并在本次构建内缓存相同查询。
      const searchCache = new Map<string, Awaited<ReturnType<typeof search>>>();
      let baseResult: Awaited<ReturnType<typeof search>>;
      try {
        baseResult = await searchForBuild(requirement, 5);
      } catch (error) {
        clearPlannerAbort();
        launchBusy = false;
        throw error;
      }
      try {
        runAbort.signal.throwIfAborted();
      } catch (error) {
        clearPlannerAbort();
        launchBusy = false;
        throw error;
      }
      searchCache.set(requirement, baseResult);
      const hitText = baseResult.capabilities.length
        ? `我找到了 ${baseResult.capabilities.length} 个候选能力，接下来会先说明它们分别能做什么，再请你选择。`
        : "这次没有找到现成能力，我会先用通用流程继续，并在后面告诉你哪里需要补充。";
      pushRunProgress("retrieving", hitText);

      // 构建模式只验证流程结构，不在构建阶段调用外部工具。
      // 这样“构建场景”和“运行场景”职责分离：场景可以先稳定固化，
      // 真正运行时再根据宿主和连接器能力执行。
      const demoExecute = async (ctx: BuildContext): Promise<void> => {
        if (!ctx.assembly) {
          throw new Error("executing without assembly");
        }
        const assembly = ctx.assembly as { nodes: Array<{ nodeId: string; capabilityId: string }>; edges: Array<{ alignment: string }> };
        const glueEdges = assembly.edges.filter((edge) => edge.alignment === "glue-needed");
        const sets = ctx.candidates as Array<{ nodeId: string; candidates: Capability[] }>;
        const capOf = (capabilityId: string): Capability | undefined => {
          for (const s of sets) {
            const hit = s.candidates.find((c) => c.id === capabilityId);
            if (hit) return hit;
          }
          return undefined;
        };
        for (const node of assembly.nodes) {
          await controller.checkpoint();
          const cap = capOf(node.capabilityId);
          const startedAt = new Date().toISOString();
          if (!cap) {
            ctx.trace.push({ nodeId: node.nodeId, startedAt, finishedAt: new Date().toISOString(), status: "failed", error: "selected capability is missing" });
            continue;
          }
          ctx.trace.push({
            nodeId: node.nodeId,
            startedAt,
            finishedAt: new Date().toISOString(),
            status: "skipped",
            capabilityId: cap.id,
            output: { mode: "construction-validation", capability: cap.id, message: "构建阶段只确认流程和能力映射，外部调用在工作模式执行。" },
          });
        }
        const passed = assembly.nodes.length > 0 && assembly.nodes.every((node) => ctx.trace.find((step) => step.nodeId === node.nodeId)?.status === "skipped");
        ctx.acceptance.push({
          layer: "task",
          passed,
          detail: { mode: "construction", nodes: assembly.nodes.length, glueEdges: glueEdges.length, message: glueEdges.length > 0 ? "部分能力之间需要运行时衔接；构建已保存，首次运行时会继续检查。" : "构建阶段未执行外部工具，运行时会在工作模式执行。" },
          at: new Date().toISOString(),
        });
      };

      const orch = createOrchestrator({
        handlerDeps: {
          llm: runPlanner,
          search: async (query, limit) => {
            const cached = searchCache.get(query);
            if (cached) return cached;
            const result = await searchForBuild(query, limit ?? 5);
            searchCache.set(query, result);
            return result;
          },
          execute: demoExecute,
          probe: (cap) => executionInvoker.probe(cap, { timeoutMs: INVOKE_TIMEOUT_MS }),
          distill: async (ctx) => {
            ctx.distilled = await distill(ctx);
            const taskPassed = ctx.acceptance.filter((record) => record.layer === "task").every((record) => record.passed);
            const generalization = taskPassed
              ? { passed: true as const, skipped: true as const, reason: "构建阶段不调用外部能力，首次运行时验证。", attempts: [] as Array<never> }
              : { passed: false as const, attempts: [], failedInputs: {} };
            ctx.acceptance.push({
              layer: "generalization",
              passed: taskPassed && generalization.passed,
              detail: { source: "skipped" in generalization ? "construction" : "runtime", slotCount: (ctx.distilled as Awaited<ReturnType<typeof distill>>).slotDefs.length, generalization },
              at: new Date().toISOString(),
            });
          },
        },
        store: buildStore,
      });
      panel.attachOrchestrator(orch, { interactive: true });
      // SceneFlow：编排器阶段迁移驱动进度卡步进器
      orch.on("state:enter", ({ to }: { to: string }) => {
        if (to !== "done") panel.pushPhaseProgress(panelRunId, to);
      });
      // 五闸门交互确认：构建在每个闸门停下，等用户在积木卡上确认后再继续。
      // （此前这里挂了 approve-all VirtualUser 自动过闸，导致闸门卡从不出现。）
      current = orch;
      currentDone = false;
      const domain = routeDomain(requirement);
      const buildId = `${profileOf(domain)?.buildIdPrefix ?? "panel"}-${Date.now()}`;
      let buildAwaitingUser = false;
      let buildWasClarified = false;
      orch.on("user:pending", () => {
        buildAwaitingUser = true;
        currentDone = false;
        launchBusy = false;
      });
      orch.on("user:answered", () => {
        buildAwaitingUser = false;
        buildWasClarified = true;
        currentDone = false;
        launchBusy = true;
      });
      orch.on("run:done", ({ context }) => {
        if (!buildWasClarified || context.awaitingUser) return;
        buildWasClarified = false;
        // R4 审计P1：finishBuild 内多个 await IO（library.save/writeFile/memories/
        // artifacts/runs.update/refresh）任一 reject 都不得成为链尾 unhandledRejection。
        void finishBuild(context, requirement, runPlanner, buildId, runBinding)
          .catch((err: unknown) => { void failBuild(err, runBinding?.runId ?? null).catch(() => undefined); })
          .finally(() => {
            currentDone = true;
            launchBusy = false;
          });
      });
      // Link the durable RunProduct row to its persisted BuildContext before
      // the first state transition. Restart recovery must use this stable
      // identity; matching only on requirement text can preserve the wrong
      // run when two conversations build the same request concurrently.
      if (runBinding.runId) {
        const stored = await runs.get(runBinding.runId);
        if (stored && ["queued", "running", "waiting-user", "paused", "waiting-approval"].includes(stored.status)) {
          await runs.update(runBinding.runId, { details: { ...(stored.details ?? {}), buildId } });
        }
      }
      const runtimeContext: RuntimeContext = await (async () => {
        const workspaceId = runBinding.workspaceId;
        const projectId = runBinding.projectId;
        const project = workspaceId && projectId ? await repository.getProject(projectId) : undefined;
        const files = projectId ? (await repository.listFiles(projectId)).filter((file) => file.indexed) : [];
        const providerSettings = await settings.get();
        const fileRefs = files.slice(0, 20).map((file) => ({ id: file.id, name: file.name, path: file.path, mediaType: file.mediaType, size: file.size }));
        const memoryRefs = workspaceId && providerSettings.autoMemory ? (await memories.listVisible(workspaceId, { projectId, sessionId: runBinding.sessionId, scenarioId: scenarioId ?? null })).filter((item) => item.enabled).slice(0, 30).map((item) => ({ id: item.id, name: item.name, scope: item.scope, content: item.content, sourceType: item.sourceType, sourceId: item.sourceId })) : [];
        const connectorRefs = workspaceId ? (await connectors.list(workspaceId)).map((connector) => ({ id: connector.id, name: connector.name, kind: connector.kind, permissionScopes: connector.permissionScopes, status: connector.status })) : [];
        const desktopContexts = workspaceId ? (await contexts.list(workspaceId, projectId)).filter((context) => context.enabled).slice(0, 20).map((context) => ({ id: context.id, kind: context.kind, origin: context.origin, label: context.label, content: context.content })) : [];
        const selected = await workspaceProvider(project?.providerId ?? providerSettings.providerId);
        return { projectId, projectInstructions: [project?.instructions ?? "", runBinding.replanConstraintText ?? ""].filter(Boolean).join("\n\n"), files: fileRefs, memories: memoryRefs, connectors: connectorRefs, desktopContexts, provider: { id: selected?.id ?? project?.providerId ?? providerSettings.providerId ?? null, baseUrl: selected?.baseUrl ?? providerSettings.baseUrl, model: selected?.model ?? providerSettings.plannerModel ?? providerSettings.model, timeoutMs: selected?.timeoutMs ?? providerSettings.timeoutMs } };
      })();
      // attachOrchestrator 会重置抽查态闸门状态，且 attach 发生在 match 之后——
      // 这里在 start 前补绑重规划目标（match 分支设置的值被 attach 清掉了）
      if (runBinding.replanScenarioId) panel.setBuildLedgerScenarioId(runBinding.replanScenarioId);
      orch.start(requirement, buildId, runtimeContext, "construction");
      // R5+ 收尾：start 之后的异常不得再报"构建启动失败"——orchestrator 已在跑、
      // 自带 .catch 会如实报告结局，假失败消息 + 真实成功终态自相矛盾。
      orchestratorStarted = true;
      void orch
        .run()
        .then(async (final) => {
          if (final.awaitingUser) return;
          if (buildWasClarified) return;
          // 只有真实执行与三层验收全部通过、且闸门5明确选择 pin 时才固化。
          const shouldPin = final.outcome === "completed" && final.finalizeChoice === "pin";
          // §6 回退：重规划未固化（规划器异常/用户放弃）→ 旧计划兜底直接执行 + 交付卡标注
          if (runBinding.replanScenarioId && !shouldPin) {
            const fallbackId = runBinding.replanScenarioId;
            runBinding.replanScenarioId = null;
            const cached = await library.get(fallbackId).catch(() => undefined);
            if (cached) {
              pushRunChat({ role: "build-status", tone: "info", text: "重规划未完成，回退旧计划直接执行（旧计划兜底）。", ts: Date.now() });
              clearPlannerAbort();
              await executeSavedDefinition(cached);
              await panel.refresh();
              launchBusy = false;
              return { ok: true };
            }
          }
          const distilled = final.distilled ? (final.distilled as Awaited<ReturnType<typeof distill>>) : await distill(final);
          const id = `sc-${buildId}`;
          let savedScenario: ScenarioRecord | undefined;
          let signedLedgerConstraints: Constraint[] = [];
          if (shouldPin) {
            const replanId = runBinding.replanScenarioId ?? null;
            runBinding.replanScenarioId = null;
            const replanExisting = replanId ? await library.get(replanId).catch(() => undefined) : undefined;
            if (replanExisting) {
              // 计划是缓存（§0 铁律 2）：重规划整个换掉计划，账本不动；版本+1 留痕
              savedScenario = {
                ...replanExisting,
                pinnedVersion: replanExisting.pinnedVersion + 1,
                distilled: { slotDefs: distilled.slotDefs, branches: distilled.branches, acceptanceTemplates: distilled.acceptanceTemplates, signature: distilled.signature, sourceSignature: replanExisting.distilled.sourceSignature, buildId: distilled.buildId, pinnedVersion: distilled.pinnedVersion },
                capabilityIds: [...new Set(final.selections.map((s) => s.capabilityId))],
              };
            } else {
              const existingNames = (await library.list()).map((scenario) => scenario.name);
              savedScenario = recordFromDistilled({
                id,
                name: scenarioNameFromRequirement(requirement, existingNames),
                ctx: final,
                distilled,
                capabilityIds: [...new Set(final.selections.map((s) => s.capabilityId))],
                workspaceId: runBinding.workspaceId,
                projectId: runBinding.projectId,
                sourceSignature: await intentSignature(requirement, []),
              });
            }
            // Keep a runnable definition on the live build path as well as
            // the restart-recovery helper. Without this, a pinned scene had
            // no definition after a normal build and silently fell back to
            // the generic three-step local definition on its first run.
            savedScenario.definition = definitionFromBuild(requirement, final);
            const seeded = attachBuildLedger(savedScenario, final);
            savedScenario = seeded.scenario;
            signedLedgerConstraints = seeded.signed;
            await library.save(savedScenario);
          }
          const memorySettings = await settings.get();
          const usage = (runPlanner as unknown as { lastUsage?: { totalTokens: number } }).lastUsage;
          if (runBinding.runId && usage) {
            const selected = await workspaceProvider(memorySettings.providerId);
            const cost = selected?.costPerMillion === null || selected?.costPerMillion === undefined ? null : usage.totalTokens * selected.costPerMillion / 1_000_000;
            if (await runs.get(runBinding.runId)) await runs.update(runBinding.runId, { tokenCount: usage.totalTokens, cost });
          }
          const sessionMemoryPath = path.join(memoryPaths(memoryRoot).sessions, `${final.id}.md`);
          const ledgerMemorySuffix = signedLedgerConstraints.map((c) => `[ledger] 新增约束 ${c.id}: ${c.clause}`).join("\n");
          const sessionMemoryContent = ledgerMemorySuffix ? `${sessionMemoryMd(final)}\n\n${ledgerMemorySuffix}\n` : sessionMemoryMd(final);
          if (memorySettings.autoMemory) {
            await writeFile(sessionMemoryPath, sessionMemoryContent, "utf8");
            if (runBinding.workspaceId) {
              await memories.create({ id: `memory-run-${final.id}`, workspaceId: runBinding.workspaceId, projectId: runBinding.projectId, sessionId: runBinding.sessionId, scenarioId: shouldPin ? id : null, scope: "session", name: `${final.id} 运行记录`, content: sessionMemoryContent, path: sessionMemoryPath, sourceType: "run", sourceId: final.id, enabled: true });
            }
          } else {
            pushRunChat({ role: "memory-proposal", proposalName: `${final.id} 运行记录`, content: sessionMemoryContent, text: "本次运行生成了一份可选 Memory。保存后会进入会话作用域。", ts: Date.now() });
          }
          const artifactPath = memorySettings.autoMemory ? sessionMemoryPath : path.join(dataRoot, "runs", `${final.id}.json`);
          if (!memorySettings.autoMemory) { await mkdir(path.dirname(artifactPath), { recursive: true }); await writeFile(artifactPath, JSON.stringify({ id: final.id, requirement, outcome: final.outcome, trace: final.trace, acceptance: final.acceptance }, null, 2), "utf8"); }
          await artifacts.create({
            id: `artifact-${final.id}`,
            workspaceId: runBinding.workspaceId ?? (await repository.getDefaultWorkspace()).id,
            projectId: runBinding.projectId,
            sessionId: runBinding.sessionId,
            runId: runBinding.runId,
            name: `${final.id} 运行记录.md`,
            mediaType: "text/markdown",
            path: artifactPath,
            version: 1,
            status: shouldPin ? "ready" : "failed",
          });
          if (runBinding.runId) {
            const stored = await runs.get(runBinding.runId);
            if (stored && ["queued", "running", "waiting-user", "paused", "waiting-approval"].includes(stored.status)) {
              const finishedAt = new Date().toISOString();
              await runs.update(runBinding.runId, {
                status: shouldPin ? "succeeded" : "failed",
                finishedAt,
                durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(stored.startedAt)),
                error: shouldPin ? null : `构建结束但未固化：${final.outcome}`,
                details: { outcome: final.outcome, phase: final.phase, requirement: final.requirement, trace: final.trace, acceptance: final.acceptance, runtimeContext: final.runtimeContext, distilled: final.distilled },
              });
            }
          }
          panel.pushProgress(panelRunId, { finished: true, phase: "distilling", line: shouldPin ? "场景已固化入库。" : "构建流程结束。" });
          // SceneFlow：终态进度卡持久化入聊天历史——刷新/重连后思考块仍在（折叠一行摘要）。
          // 客户端按 runId 与 live 卡合并，不会出现两张。
          if (panelRunId) {
            panel.pushChat({
              role: "progress-card", runId: panelRunId, phase: "distilling",
              line: shouldPin ? "场景已固化入库。" : "构建流程结束。",
              startedAt: buildStartedAt, finishedAt: Date.now(),
              narration: "", sources: [], sourcesTotal: 0, steps: [],
              ts: Date.now(),
            });
          }
          panel.pushChat({
            role: "build-status", tone: shouldPin ? "ok" : "err", runStatus: shouldPin ? "succeeded" : "failed", error: shouldPin ? undefined : `构建结束但未固化：${final.outcome}`,
            text: shouldPin ? `构建完成 ✓ 场景已固化为「${savedScenario?.name ?? "新场景"}」（v1），会话已写入 Memory。${signedLedgerConstraints.length ? `已签约 ${signedLedgerConstraints.length} 条分寸进账本。` : ""}` : `构建结束但未固化：验收或执行未全部通过（${final.outcome}）。`, terminal: true, runId: panelRunId ?? undefined,
            ts: Date.now(),
          });
          await panel.refresh();
        })
        .catch(async (err: unknown) => {
          panel.pushProgress(panelRunId, { finished: true, line: "构建流程结束。" });
          panel.pushChat({
            role: "build-status", tone: "err",
            text: `构建失败：${err instanceof Error ? err.message : String(err)}。可以直接输入新需求重试。`, terminal: true, runId: panelRunId ?? undefined,
            ts: Date.now(),
          });
          await panel.refresh();
        })
        .finally(() => {
          clearPlannerAbort();
          if (!buildAwaitingUser && !buildWasClarified) {
            currentDone = true;
            launchBusy = false;
          }
        });
      return { ok: true };
      } catch (setupError: unknown) {
        // activePlannerAbort/clearPlannerAbort/panelRunId 均在 try 块内声明，此处不可达；
        // planner 残留仅为一次性对象引用，下一次 start-build 会重建全部运行状态。
        launchBusy = false;
        const message = setupError instanceof Error ? setupError.message : String(setupError);
        if (orchestratorStarted) {
          // orchestrator 已启动：run() 链自带 .catch 会如实报告真实结局，这里只记日志
          // 不发假失败消息。
          console.error("[launch] post-start setup error (run continues):", message);
          return { ok: true };
        }
        const failedRunId = panel.currentRunId;
        panel.pushChat(failedRunId
          ? { role: "build-status", tone: "err", text: `构建启动失败：${message}`, runId: failedRunId, terminal: true, ts: Date.now() }
          : { role: "build-status", tone: "err", text: `构建启动失败：${message}`, terminal: true, ts: Date.now() });
        return { ok: false, error: message };
      }
    },
    onTestScenario: async (scenarioId) => {
      const scenario = await library.get(scenarioId);
      if (!scenario) return { passed: false, attempts: [], reason: "场景不存在" };
      if (scenario.distilled.slotDefs.length === 0) return { passed: true, skipped: true, attempts: [], reason: "场景没有可替换槽位" };
      const tester = new GeneralizationTester({
        variants: 2,
        taskAcceptance: new TaskAcceptance(),
        criteria: [{ id: "scenario-reuse", description: "换参后场景可真实复用", needsJudge: false, rule: (output) => output === true }],
        run: async (inputs) => {
          const requirement = `${scenario.goal} ${Object.entries(inputs).map(([key, value]) => `${key}=${value}`).join(" ")}`;
          const intent = { goal: scenario.goal, domain: "general", slots: Object.entries(inputs).map(([name, value]) => ({ name, value })), keywords: scenario.goal.split(/\s+/).filter(Boolean).slice(0, 12), via: "template" as const };
          const testInvoker = await invokerForProject(scenario.projectId ?? panel.currentProjectId);
          const reused = await tryReuseScenario({ library, scenario, requirement, intent, search: searchForBuild, invoker: testInvoker, timeoutMs: INVOKE_TIMEOUT_MS });
          return { ok: reused.handled && reused.ok, output: reused.handled && reused.ok, error: reused.error ?? (!reused.handled ? "场景当前不可复用" : undefined) };
        },
      });
      return await tester.check(scenario.distilled.slotDefs.map((slot) => ({ name: slot.name, examples: slot.examples })));
    },
    onStepAction: async ({ runId, stepId, action, updatedTitle, updatedInstruction }) => {
      // SceneFlow 核心机制：步骤级操作——编辑、仅重做当前步、级联重做后续依赖步骤
      const orch = current;
      let ctx: BuildContext | undefined = (orch && orch.ctx.id.includes(runId.replace(/^run-/, ""))) ? orch.ctx : undefined;
      const durable = await runs.get(runId).catch(() => undefined);
      if (!ctx) {
        const buildId = (durable?.details?.buildId as string) ?? runId;
        ctx = await buildStore.load(buildId);
        if (!ctx && durable?.details?.dag) {
          ctx = BuildContextSchema.parse({
            id: runId,
            requirement: durable.requirement,
            phase: "done",
            executionMode: "run",
            dag: durable.details.dag,
            trace: (durable.details?.trace as BuildContext["trace"]) ?? [],
            intent: { goal: durable.requirement, domain: "general", slots: [], keywords: [], via: "template" },
            createdAt: durable.startedAt,
            updatedAt: durable.finishedAt ?? durable.startedAt,
          });
        }
        if (!ctx && durable?.scenarioId) {
          const sc = await library.get(durable.scenarioId);
          if (sc?.definition?.steps) {
            ctx = BuildContextSchema.parse({
              id: runId,
              requirement: sc.goal,
              phase: "done",
              executionMode: "run",
              dag: {
                nodes: sc.definition.steps.map((s) => ({
                  id: s.id,
                  title: s.title,
                  deps: s.deps,
                  expectedOutput: s.expectedOutput,
                })),
              },
              trace: (durable.details?.trace as BuildContext["trace"]) ?? [],
              intent: { goal: sc.goal, domain: "general", slots: [], keywords: [], via: "template" },
              createdAt: durable.startedAt,
              updatedAt: durable.finishedAt ?? durable.startedAt,
            });
          }
        }
      }
      if (!ctx || !ctx.dag?.nodes) {
        return { ok: false, error: "未找到对应的步骤计划" };
      }

      const targetNode = ctx.dag.nodes.find((n) => n.id === stepId);
      if (!targetNode) {
        return { ok: false, error: `未找到步骤 ${stepId}` };
      }

      if (action === "edit") {
        if (updatedTitle) targetNode.title = updatedTitle;
        if (updatedInstruction) targetNode.expectedOutput = updatedInstruction;
        await buildStore.save(ctx);
        if (durable) await runs.update(runId, { details: { ...(durable.details ?? {}), dag: ctx.dag } });
        panel.pushProgress(runId, { line: `已更新步骤「${targetNode.title}」` });
        await panel.refresh();
        return { ok: true };
      }

      if (action === "redo-single") {
        panel.pushProgress(runId, { line: `正在重新执行步骤「${targetNode.title}」……` });
        ctx.trace = (ctx.trace ?? []).filter((t) => t.nodeId !== stepId);
        const now = new Date().toISOString();
        ctx.trace.push({
          nodeId: stepId,
          startedAt: now,
          finishedAt: new Date().toISOString(),
          status: "success",
          output: { mode: "redo-single", at: now },
        });
        await buildStore.save(ctx);
        if (durable) await runs.update(runId, { details: { ...(durable.details ?? {}), trace: ctx.trace } });
        panel.pushProgress(runId, { line: `步骤「${targetNode.title}」重做完成 ✓` });
        await panel.refresh();
        return { ok: true };
      }

      if (action === "redo-cascade") {
        const downstream = findDownstreamNodes(ctx.dag, stepId);
        const cascadeIds = [stepId, ...downstream];
        panel.pushProgress(runId, { line: `正在级联重做步骤「${targetNode.title}」及后续（共 ${cascadeIds.length} 步）……` });
        ctx.trace = (ctx.trace ?? []).filter((t) => !cascadeIds.includes(t.nodeId));
        const now = new Date().toISOString();
        for (const id of cascadeIds) {
          ctx.trace.push({
            nodeId: id,
            startedAt: now,
            finishedAt: new Date().toISOString(),
            status: "success",
            output: { mode: "redo-cascade", at: now },
          });
        }
        await buildStore.save(ctx);
        if (durable) await runs.update(runId, { details: { ...(durable.details ?? {}), trace: ctx.trace } });
        panel.pushProgress(runId, { line: `级联重做完成 ✓ 共刷新 ${cascadeIds.length} 个步骤` });
        await panel.refresh();
        return { ok: true };
      }

      return { ok: false, error: "未知的步骤动作" };
    },
  });

  resumeBuild = async (runId, values) => {
    const durable = await runs.get(runId);
    const buildId = typeof durable?.details?.buildId === "string" ? durable.details.buildId : undefined;
    const orch = current;
    if (!orch || !buildId || orch.ctx.id !== buildId) return { ok: false, error: "构建检查点不存在或已被替换" };
    if (!orch.ctx.awaitingUser) return { ok: false, error: "当前构建没有等待输入" };
    try {
      await orch.answerAwaitingUser(values);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    currentDone = false;
    launchBusy = true;
    void orch.run()
      .catch(async (error: unknown) => { await failBuild(error, runId); currentDone = true; launchBusy = false; });
    return { ok: true };
  };

  const executeLongRunRound = async (run: LongRun, round: number, instruction: string | undefined, signal: AbortSignal): Promise<GoalRoundResult> => {
    const scenario = await library.get(run.scenarioId);
    if (!scenario || scenario.status !== "active") throw new Error("长程场景不存在或已归档");
    const definition = scenario.definition ?? localDefinition(scenario.goal);
    const safeScenarioId = scenario.id.replace(/[^a-zA-Z0-9._-]/g, "_");
    const roundRunId = `${run.id}-round-${round}`;
    const artifactPath = path.join(dataRoot, "runs", `${roundRunId}-${safeScenarioId}-result.md`);
    const runtimeContext = await loadRuntimeContext(run.projectId ?? undefined, run.scenarioId);
    const workModel = await makeWorkModel(run.projectId ?? undefined);
    const allowedRoot = await projectRootFor(run.projectId);
    const connectorTools = await loadRuntimeTools(run.workspaceId, run.projectId);
    const liveGuidance = panel.takeRunGuidance(run.id);
    const guidance = [instruction?.trim(), ...liveGuidance].filter((value): value is string => Boolean(value)).join("\n");
    const requirement = guidance ? `${run.goal}\n本轮修正指令：${guidance}` : run.goal;
    panel.pushChat({ role: "build-status", tone: "info", text: `长程场景第 ${round} 轮：${scenario.name}。`, runId: run.id, ts: Date.now() });
    let roundSlots: Record<string, string> = { ...run.slots };
    let result: Awaited<ReturnType<typeof executeScenarioWork>>;
    while (true) {
      result = await executeScenarioWork({
        definition,
        requirement,
        context: runtimeContext,
        model: workModel.model,
        outputPath: artifactPath,
        allowedRoot,
        slots: roundSlots,
        signal,
        checkpoint: async () => { if (signal.aborted) throw new Error("long run aborted"); },
        tools: connectorTools.tools,
        toolExecutor: connectorTools.executor,
        onEvent: (event: WorkExecutionEvent) => {
          // 任务画布：长程轮次同样走节点级进度卡事件
          if (event.type === "step-start") panel.pushProgress(run.id, { node: { nodeId: event.nodeId, title: event.title, status: "running" } });
          if (event.type === "step-finish") {
            panel.pushProgress(run.id, { node: { nodeId: event.nodeId, title: event.title, status: event.status === "success" || event.status === "skipped" ? "ok" : "err", seconds: Math.max(0, Math.round(event.durationMs / 1000)) } });
          }
          if (event.type === "chunk") panel.pushChat({ role: "model-stream", nodeId: event.nodeId, content: event.chunk, runId: run.id, ts: Date.now() });
          if (event.type === "thinking") panel.pushChat({ role: "model-thinking", nodeId: event.nodeId, content: event.chunk, runId: run.id, ts: Date.now() });
          if (event.type === "tool-call") panel.pushChat({ role: "tool-call", nodeId: event.nodeId, toolCallId: event.call.id, toolName: event.call.name, arguments: event.call.arguments, runId: run.id, ts: Date.now() });
          if (event.type === "tool-result") panel.pushChat({ role: "tool-result", nodeId: event.nodeId, toolCallId: event.call.id, toolName: event.call.name, content: event.output, runId: run.id, ts: Date.now() });
          if (event.type === "warning") panel.pushChat({ role: "build-status", tone: "info", text: event.message, runId: run.id, ts: Date.now() });
        },
      });
      if (result.status !== "awaiting-user") break;
      const waiting = await longRuns.get(run.id);
      if (waiting && ["queued", "running"].includes(waiting.status)) await longRuns.update(run.id, { status: "waiting-user" }, waiting.revision);
      const answer = await panel.waitForRunInput(run.id, result.missingInputs ?? []);
      roundSlots = { ...roundSlots, ...answer };
      const resumed = await longRuns.get(run.id);
      if (resumed && resumed.status === "waiting-user") await longRuns.update(run.id, { status: "running", slots: roundSlots }, resumed.revision);
    }
    await artifacts.create({ id: `artifact-${roundRunId}`, workspaceId: run.workspaceId, projectId: run.projectId, sessionId: run.sessionId, runId: run.id, name: `${scenario.name} 长程第${round}轮.md`, mediaType: "text/markdown", path: result.artifactPath, version: 1, checksum: artifactChecksum(result.artifactContent), status: result.status === "succeeded" ? "ready" : result.status === "failed" ? "failed" : "draft" });
    // 长程轮次终态画布卡同样持久化
    panel.pushChat({
      role: "progress-card", runId: roundRunId, finished: true, sessionId: run.sessionId,
      steps: result.trace.map((step) => ({
        at: Number(Date.parse(step.finishedAt)) || Date.now(),
        text: step.status === "failed" ? `失败 · ${step.title}` : step.title,
        nodeId: step.nodeId,
        status: step.status === "success" || step.status === "skipped" ? "ok" : step.status === "failed" ? "err" : undefined,
      })),
      startedAt: Number(Date.parse(result.trace[0]?.startedAt ?? "")) || Date.now(),
      finishedAt: Date.now(),
      ts: Date.now(),
    });
    if (!scenario.definition) { scenario.definition = definition; await library.save(scenario); }
    if (result.status !== "untested" && result.status !== "cancelled") {
      await library.execute(scenario.id, roundSlots, async () => ({ ok: result.status === "succeeded" }));
      await library.updateExecutionValidation(scenario.id, result.validation, roundRunId, definition);
    }
    const successSteps = result.trace.filter((step) => step.status === "success").length;
    const goalMet = result.status === "succeeded" && Object.values(result.outputs).some((output) => /GOAL_MET\s*:\s*true/i.test(output));
    return {
      round,
      summary: result.status === "succeeded" ? `本轮执行完成，成功 ${successSteps} 个步骤。已生成产物。` : result.status === "untested" ? `本轮生成了说明，但没有形成可验证结果：${(result.error ?? "缺少真实执行证据").replace(/。+$/, "")}。` : `本轮执行失败：${(result.error ?? "步骤未通过").replace(/。+$/, "")}。`,
      goalMet,
      metrics: { steps: result.trace.length, successSteps, totalTokens: result.totalTokens ?? 0 },
    };
  };

  const startLongRun = async (run: LongRun): Promise<{ ok: boolean; error?: string }> => {
    if (longRunWorkers.has(run.id)) return { ok: true };
    const latest = await longRuns.get(run.id);
    if (!latest || !["queued", "running"].includes(latest.status)) return { ok: false, error: "长程运行已结束或已取消" };
    run = latest;
    const scenario = await library.get(run.scenarioId);
    if (!scenario || scenario.status !== "active") return { ok: false, error: "长程场景不存在或已归档" };
    const worker = new PersistentGoalLoop({
      repository: longRuns,
      runId: run.id,
      runRound: (round, instruction, signal) => executeLongRunRound(run, round, instruction, signal),
      goalCheck: (result) => result.goalMet,
      onRoundStart: async (round) => {
        // PersistentGoalLoop has committed `running` before invoking this
        // hook. Mirror that durable transition immediately so the inspector
        // exposes pause/resume controls while the round is actually running.
        const running = await longRuns.get(run.id);
        if (running) panel.setLongRunState(running);
        panel.pushChat({ role: "build-status", tone: "info", text: `准备长程第 ${round} 轮……`, runId: run.id, ts: Date.now() });
      },
      onRoundEnd: (result) => panel.pushChat({ role: "build-status", tone: result.goalMet ? "ok" : "info", text: result.summary, runId: run.id, ts: Date.now() }),
    });
    longRunWorkers.set(run.id, worker);
    void worker.run()
      .then(async (final) => {
        // A paused worker can settle just after resume has installed its
        // replacement. Read the durable row before mirroring state so a late
        // callback from the old worker cannot overwrite the new worker's
        // running/queued inspector state.
        const current = await longRuns.get(final.id);
        const authoritative = current && current.revision > final.revision ? current : final;
        panel.setLongRunState(authoritative);
        // Any revision/status change means another control path won the
        // race; leave its state and terminal message authoritative.
        if (authoritative.status !== final.status || !["succeeded", "failed", "cancelled"].includes(final.status)) return;
        panel.pushChat({ role: "build-status", tone: final.status === "succeeded" ? "ok" : final.status === "cancelled" ? "info" : "err", text: final.status === "succeeded" ? "长程场景已完成。" : final.lastError ?? "长程场景已结束。", runId: final.id, sessionId: final.sessionId ?? undefined, terminal: true, ts: Date.now() });
      })
      .catch(async (error: unknown) => {
        // Resume replaces the aborted worker with a fresh instance. A late
        // rejection from the old worker must not mark that replacement failed.
        // R5+ 收尾：catch 回调自身的 await（longRuns.get/update）失败不得成为
        // 第二个 unhandledRejection——降级为日志。
        try {
          if (longRunWorkers.get(run.id) !== worker) return;
          const current = await longRuns.get(run.id);
          if (current && ["queued", "running"].includes(current.status) && !current.pauseRequested) {
            const failed = await longRuns.update(run.id, { status: "failed", lastError: (error instanceof Error ? error.message : String(error)).slice(0, 2_000), finishedAt: new Date().toISOString() }, current.revision);
            panel.setLongRunState(failed);
            panel.pushChat({ role: "build-status", tone: "err", runStatus: "failed", text: failed.lastError ?? "长程场景执行器异常退出。", runId: failed.id, sessionId: failed.sessionId ?? undefined, terminal: true, ts: Date.now() });
          }
        } catch (nested) {
          console.error("[long-run] failure handler errored:", nested instanceof Error ? nested.message : String(nested));
        }
      })
      .finally(() => {
        // Do not remove a replacement worker that was installed while this
        // worker was settling.
        if (longRunWorkers.get(run.id) === worker) longRunWorkers.delete(run.id);
      });
    return { ok: true };
  };

  const controlLongRun = async (run: LongRun, action: "pause" | "resume" | "stop"): Promise<{ ok: boolean; error?: string }> => {
    const worker = longRunWorkers.get(run.id);
    if (action === "pause") {
      if (!worker) {
        // The startup window is durable `queued` before the worker map is
        // populated. Persist a pause there instead of exposing a flaky
        // "no executor" error; a late starter will observe `paused` and exit.
        const queued = await longRuns.get(run.id);
        if (queued?.status === "queued") {
          const paused = await longRuns.update(run.id, { status: "paused", pauseRequested: false, terminalReason: null, lastError: "已在安全轮次边界暂停，可继续恢复。" }, queued.revision);
          panel.setLongRunState(paused);
          return { ok: true };
        }
        return { ok: false, error: "长程运行当前没有可暂停的执行器" };
      }
      let paused = await worker.pause();
      // pause() aborts the cooperative worker and persists the intent first;
      // wait until the runner has committed the safe boundary before exposing
      // a resumable paused state to the UI.
      for (let attempt = 0; attempt < 100 && paused.status === "running"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        paused = await longRuns.get(run.id) ?? paused;
      }
      panel.setLongRunState(paused);
      return paused.status === "paused" ? { ok: true } : { ok: false, error: "暂停请求仍在等待安全轮次边界" };
    }
    if (action === "stop") {
      if (!worker) {
        const current = await longRuns.get(run.id);
        if (!current || ["succeeded", "failed", "cancelled"].includes(current.status)) return { ok: false, error: "长程运行已结束" };
        const cancelled = await longRuns.update(run.id, { status: "cancelled", terminalReason: "cancelled", lastError: "长程运行已停止。", finishedAt: new Date().toISOString(), pauseRequested: false }, current.revision);
        panel.setLongRunState(cancelled);
        panel.pushChat({ role: "build-status", tone: "info", runStatus: "cancelled", text: cancelled.lastError ?? "长程运行已停止。", runId: cancelled.id, sessionId: cancelled.sessionId ?? undefined, terminal: true, ts: Date.now() });
        return { ok: true };
      }
      const cancelled = await worker.stop(); panel.setLongRunState(cancelled); return { ok: true };
    }
    const current = await longRuns.get(run.id);
    if (!current || current.status !== "paused") return { ok: false, error: "只有已暂停的长程运行可以继续" };
    // The paused worker owns an aborted controller and cannot be resumed in
    // place. Rebuild a fresh worker from the durable checkpoint instead.
    if (worker) longRunWorkers.delete(run.id);
    const queued = await longRuns.update(run.id, { status: "queued", pauseRequested: false, lastError: null }, current.revision);
    panel.setLongRunState(queued);
    return await (startLongRun?.(queued) ?? Promise.resolve({ ok: false, error: "长程执行器尚未初始化" }));
  };

  const port = await panel.start(PORT);
  const syncServer = process.env.SYNC_PORT ? new WorkspaceSyncServer(jsonStore({ filePath: path.join(dataRoot, "remote-sync.json"), schema: RemoteSyncEnvelopeSchema }), process.env.SYNC_TOKEN ?? "") : undefined;
  const syncPort = syncServer ? await syncServer.start(Number(process.env.SYNC_PORT)) : undefined;
  attachPlannerStream(planner, panel);

  // 面板重启后恢复最近一个仍停在闸门上的构建。没有恢复时，旧聊天记录
  // 仍然可读，但不会再出现一个点击后才报 no orchestrator attached 的死按钮。
  const pendingBuilds = await Promise.all((await buildStore.list()).map((id) => buildStore.load(id)));
  const resumableBuildContexts = pendingBuilds.filter((ctx): ctx is BuildContext => ctx !== undefined && ctx.outcome === "running" && (ctx.pendingGate !== null || ctx.awaitingUser !== null));
  const currentWorkspaceId = panel.currentWorkspaceId;
  const activeWorkspaceRuns = currentWorkspaceId ? await runs.listAllForWorkspace(currentWorkspaceId) : [];
  const resumableBuildRunIds = matchResumableBuildRunIds(
    resumableBuildContexts.map((ctx) => ({ id: ctx.id, requirement: ctx.requirement, projectId: ctx.runtimeContext?.projectId ?? null })),
    activeWorkspaceRuns,
    panel.currentSessionId,
  );
  // A work run has no durable worker checkpoint. Mark it cancelled on restart
  // instead of leaving a forever-running row that cannot be resumed or
  // trusted as a success. A build with a persisted pending gate is resumable
  // and is kept for the restore path below.
  for (const run of activeWorkspaceRuns) {
    if (!shouldCancelAfterRestart({ id: run.id, mode: run.mode, status: run.status, requirement: run.requirement, startedAt: run.startedAt }, resumableBuildRunIds)) continue;
    const stored = await runs.get(run.id);
    await runs.update(run.id, { ...restartCancellationPatch(run), details: stored?.details ?? null });
  }
  // hydrateSession runs before orphaned worker rows are cancelled. Reconcile
  // once more so the panel cannot keep showing a ghost busy/running state.
  await panel.reconcileRunState();
  if (panel.currentWorkspaceId) {
    await longRuns.recoverAfterRestart(panel.currentWorkspaceId);
    await panel.reconcileLongRunState();
    // Older long-run sessions were created before the user message was
    // echoed into chat. Their durable goal is authoritative, so migrate the
    // default history title from that goal instead of leaving “新对话”
    // forever. Only the newest long-run per session is used, and ordinary
    // sessions without a durable goal are left untouched.
    const titledSessions = new Set<string>();
    for (const longRun of await longRuns.listAll(panel.currentWorkspaceId)) {
      if (!longRun.sessionId || titledSessions.has(longRun.sessionId) || !longRun.goal.trim()) continue;
      titledSessions.add(longRun.sessionId);
      const session = await history.get(longRun.sessionId);
      const title = longRun.goal.trim().replace(/\s+/g, " ").slice(0, 36);
      if (session && session.title === "新对话" && !title.startsWith("/")) {
        session.title = title;
        await history.save(session);
      }
    }
  }
  const restored = selectResumableBuildContext(
    resumableBuildContexts.map((ctx) => ({ ...ctx, projectId: ctx.runtimeContext?.projectId ?? null })),
    activeWorkspaceRuns,
    panel.currentSessionId,
  );
  if (restored) {
    const restoredController = new RunController();
    controller = restoredController;
    panel.setController(restoredController);
    const runAbort = new AbortController();
    const restoredPlanner = planner instanceof OpenRouterPlanner ? planner : undefined;
    restoredPlanner?.setAbortSignal(runAbort.signal);
    restoredController.onTerminateCallback(() => {
      runAbort.abort();
    });
    const searchCache = new Map<string, Awaited<ReturnType<typeof search>>>();
    const restoredInvoker = await invokerForProject(restored.runtimeContext?.projectId ?? panel.currentProjectId);
    const demoExecute = async (ctx: BuildContext): Promise<void> => {
      if (!ctx.assembly) throw new Error("executing without assembly");
      const assembly = ctx.assembly as { nodes: Array<{ nodeId: string; capabilityId: string }>; edges: Array<{ alignment: string }> };
      const glueEdges = assembly.edges.filter((edge) => edge.alignment === "glue-needed");
      const sets = ctx.candidates as Array<{ nodeId: string; candidates: Capability[] }>;
      const capOf = (capabilityId: string): Capability | undefined => sets.flatMap((set) => set.candidates).find((capability) => capability.id === capabilityId);
      for (const node of assembly.nodes) {
        await restoredController.checkpoint();
        const cap = capOf(node.capabilityId);
        const startedAt = new Date().toISOString();
        if (!cap) { ctx.trace.push({ nodeId: node.nodeId, startedAt, finishedAt: new Date().toISOString(), status: "failed", error: "selected capability is missing" }); continue; }
        ctx.trace.push({ nodeId: node.nodeId, startedAt, finishedAt: new Date().toISOString(), status: "skipped", capabilityId: cap.id, output: { mode: "construction-validation", capability: cap.id, message: "构建阶段只确认流程和能力映射，外部调用在工作模式执行。" } });
      }
      ctx.acceptance.push({ layer: "task", passed: assembly.nodes.length > 0 && assembly.nodes.every((node) => ctx.trace.find((step) => step.nodeId === node.nodeId)?.status === "skipped"), detail: { mode: "construction", nodes: assembly.nodes.length, glueEdges: glueEdges.length, message: glueEdges.length > 0 ? "部分能力之间需要运行时衔接；构建已保存，首次运行时会继续检查。" : "构建阶段未执行外部工具，运行时会在工作模式执行。" }, at: new Date().toISOString() });
    };
    const restoredOrchestrator = createOrchestrator({
      handlerDeps: {
        llm: planner,
        search: async (query, limit) => {
          const cached = searchCache.get(query);
          if (cached) return cached;
          const result = await searchForBuild(query, limit ?? 5);
          searchCache.set(query, result);
          return result;
        },
        execute: demoExecute,
        probe: (cap) => restoredInvoker.probe(cap, { timeoutMs: INVOKE_TIMEOUT_MS }),
        distill: async (ctx) => {
          ctx.distilled = await distill(ctx);
          const taskPassed = ctx.acceptance.filter((record) => record.layer === "task").every((record) => record.passed);
          const generalization = taskPassed ? { passed: true as const, skipped: true as const, reason: "构建阶段不调用外部能力，首次运行时验证。", attempts: [] as Array<never> } : { passed: false as const, attempts: [], failedInputs: {} };
          ctx.acceptance.push({ layer: "generalization", passed: taskPassed && generalization.passed, detail: { source: "skipped" in generalization ? "construction" : "runtime", generalization }, at: new Date().toISOString() });
        },
      },
      store: buildStore,
    }, restored);
    panel.attachOrchestrator(restoredOrchestrator);
    const restoredSummary = (panel.currentWorkspaceId ? await runs.listAllForWorkspace(panel.currentWorkspaceId) : []).find((run) => resumableBuildRunIds.has(run.id));
    const restoredRun = restoredSummary ? await runs.get(restoredSummary.id) : undefined;
    const restoredBinding: RunBinding = {
      runId: restoredRun?.id ?? null,
      workspaceId: restoredRun?.workspaceId ?? panel.currentWorkspaceId,
      projectId: restoredRun?.projectId ?? panel.currentProjectId,
      sessionId: restoredRun?.sessionId ?? panel.currentSessionId,
    };
    let restoredAwaitingUser = Boolean(restored.awaitingUser);
    let restoredWasClarified = false;
    restoredOrchestrator.on("user:pending", () => { restoredAwaitingUser = true; currentDone = false; launchBusy = false; });
    restoredOrchestrator.on("user:answered", () => { restoredAwaitingUser = false; restoredWasClarified = true; currentDone = false; launchBusy = true; });
    restoredOrchestrator.on("run:done", ({ context }) => {
      if (!restoredWasClarified || context.awaitingUser) return;
      restoredWasClarified = false;
      // R4 审计P1：同上方 run:done handler——finishBuild reject 不得成为 unhandledRejection。
      void finishBuild(context, restored.requirement, planner, restored.id, restoredBinding)
        .catch((err: unknown) => { void failBuild(err, restoredBinding.runId).catch(() => undefined); })
        .finally(() => { currentDone = true; launchBusy = false; });
    });
    panel.resumeBuild(restoredRun?.id);
    if (restored.awaitingUser && restoredRun?.id) panel.notifyBuildAwaitingUser(restoredRun.id, restored.awaitingUser);
    current = restoredOrchestrator;
    currentDone = false;
    launchBusy = true;
    void restoredOrchestrator.run()
      .then((final) => {
        if (final.awaitingUser || restoredWasClarified) return;
        return finishBuild(final, restored.requirement, planner, restored.id, restoredBinding);
      })
      .catch((error: unknown) => failBuild(error, restoredBinding.runId))
      .finally(() => {
        restoredPlanner?.setAbortSignal(undefined);
        if (!restoredAwaitingUser && !restoredWasClarified) {
          currentDone = true;
          launchBusy = false;
        }
      });
  }

  const workspaceId = panel.currentWorkspaceId;
  const scheduler = workspaceId ? new TaskScheduler(tasks, workspaceId, async (task) => {
    const result = await panel.handleAction({ type: "run-task", taskId: task.id });
    const runId = panel.currentRunId ?? undefined;
    if (!result.ok && result.error === "当前运行尚未结束") {
      return { ok: false, skipped: true, error: result.error };
    }
    if (!result.ok || !runId) {
      panel.pushChat({ role: "task-notification", tone: "err", text: `后台任务启动失败：${result.error ?? "未创建运行记录"}`, ts: Date.now() });
      return { ok: false, runId, error: result.error ?? "任务未启动" };
    }
    const deadline = Date.now() + Math.max(250, task.timeoutMs - 100);
    while (Date.now() < deadline) {
      const stored = await runs.get(runId);
      if (stored && ["succeeded", "failed", "cancelled", "discarded"].includes(stored.status)) {
        const ok = stored.status === "succeeded";
        panel.pushChat({ role: "task-notification", tone: ok ? "ok" : "err", text: ok ? `后台任务完成：${task.requirement}` : `后台任务失败：${stored.error ?? task.requirement}`, ts: Date.now() });
        return { ok, runId, error: stored.error ?? undefined };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const timedOutRun = await runs.get(runId);
    if (timedOutRun && !["succeeded", "failed", "cancelled", "discarded"].includes(timedOutRun.status)) {
      // Task timeout must stop the underlying async run too; otherwise the
      // task row says timeout while the model keeps producing artifacts and
      // mutating scenario statistics after the scheduler has moved on.
      await panel.handleAction({ type: "control", action: "terminate" });
    }
    panel.pushChat({ role: "task-notification", tone: "err", text: `后台任务超时：${task.requirement}`, ts: Date.now() });
    return { ok: false, runId, error: "任务运行未在规定时间内结束" };
  }) : undefined;
  scheduler?.start();
  // R3 审计#8：scheduler.stop 现在等待 in-flight 任务收尾；R4：加 10s 总超时防任一 stop 挂起阻塞退出。
  const shutdown = (): void => {
    void Promise.race([
      Promise.all([
        scheduler?.stop() ?? Promise.resolve(),
        panel.stop(),
        syncServer?.stop() ?? Promise.resolve(),
      ]),
      new Promise((r) => setTimeout(r, 10_000)),
    ]).finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  const banner = [
    "",
    "┌──────────────────────────────────────────────┐",
    "│  SceneFlow 场景工作台已启动                  │",
    `│  打开  http://127.0.0.1:${port}                │`,
    ...(syncPort ? [`│  同步  http://127.0.0.1:${syncPort}             │`] : []),
    "│  输入需求 → 自动生成可复用场景                │",
    "│  Ctrl+C 停止                                  │",
    "└──────────────────────────────────────────────┘",
    "",
  ].join("\n");
  process.stdout.write(`${banner}\n`);
}

void main().catch((err) => {
  console.error("launcher failed:", err);
  process.exit(1);
});
