/** Isolated DSH execution. User content travels ONLY as JSON on stdin; no shell. */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { env } from "./env.js";
import { createRunModelProxy } from "./model-proxy.js";
import { personalModelSource, type ModelConnection } from "./integration-connections.js";
import { StringDecoder } from "node:string_decoder";
export interface DshGrant {
  kind: "TOOL" | "SKILL" | "MCP" | "KNOWLEDGE" | "MODEL";
  name: string;
  version?: string;
  source?: string;
}
export interface DshEvent {
  type: string;
  [key: string]: unknown;
}
export interface DshRunOptions {
  task: string;
  persona?: string;
  grants?: DshGrant[];
  runId: string;
  organizationId?: string;
  projectId?: string | null;
  agentId?: string;
  version?: number;
  taskId?: string;
  timeoutMs?: number;
  model?: ModelConnection;
  signal?: AbortSignal;
  onEvent?: (event: DshEvent) => Promise<void>;
  /** Deterministic MODEL fixture only. Real DSH/tool bodies. Production rejects this. */
  testCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
}
export interface DshRunResult {
  modelCalls: number | null;
  sessionId: string | null;
  final: string;
  completed: boolean;
  error: string | null;
  events: DshEvent[];
  diagnostics: string;
  modelChannel: "configured" | "stub";
}
const TOOL_MAP: Record<string, string[]> = {
  bash: ["bash"],
  read: ["read"],
  write: ["write"],
  edit: ["edit"],
  glob: ["glob"],
  grep: ["grep"],
  working_directory: ["working_directory"],
  "web.fetch": ["web_fetch"],
  "web.search": ["web_search"],
};
export function grantedToolNames(grants: DshGrant[]): Set<string> {
  return new Set(grants.filter((g) => g.kind === "TOOL").flatMap((g) => TOOL_MAP[g.name] ?? []));
}
export function grantedEntryIds(grants: DshGrant[]): Set<string> {
  const tools = grantedToolNames(grants);
  return new Set(["tools", "tool-executor-native", ...(tools.has("bash") ? ["tool-bash"] : [])]);
}
/** Shared workers identify a deployment by its database/schema, never by credentials. */
export function deploymentScope(databaseUrl = env.databaseUrl()): string {
  const url = new URL(databaseUrl);
  return createHash("sha256")
    .update(`${url.host}${url.pathname}?schema=${url.searchParams.get("schema") || "public"}`)
    .digest("hex");
}
export function buildProfilePatch(opts: {
  persona?: string;
  grants?: DshGrant[];
  stub: boolean;
  modelBaseURL?: string;
  modelId?: string;
}): string {
  const model = opts.stub ? "poros-stub" : (opts.modelId ?? "deepseek-chat");
  return JSON.stringify([
    {
      id: "system-prompt",
      config: { personaPrefix: opts.persona || "You are an organization-governed Agent." },
    },
    {
      id: "llm-pi-ai",
      config: {
        providers: {
          poros: {
            api: "openai-completions",
            baseURL: opts.stub ? "http://127.0.0.1:9919/v1" : opts.modelBaseURL,
            apiKeyEnv: "POROS_MODEL_KEY",
            models: [
              {
                id: model,
                contextWindow: 32768,
                maxTokens: 4096,
              },
            ],
          },
        },
      },
    },
    {
      id: "agent-default-model",
      config: { provider: "poros", model },
    },
    ...[
      "plugin-manager",
      "tool-plugin-manager",
      "config-editor",
      "settings",
      "hmr",
      "remote-access",
      "typert-gateway",
      "session-title-llm",
      "session-telemetry-otel",
      "tool-subagent",
      "tool-subagent-fork",
      "tool-subagent-control",
      "tool-workflow",
      "tool-goal",
      "tool-todo",
      "skill",
      "skill-filesystem",
      "tool-skill",
      "mcp-resources",
      "llm-deepseek",
      "llm-deepseek-account",
      "agent-instructions",
    ].map((id) => ({ id, disabled: true })),
    { insert: [{ id: "poros-policy", name: "file:///opt/poros/tool-policy.mjs" }] },
  ]);
}
export function dockerCommand(
  args: string[],
  input = "",
  signal?: AbortSignal,
  onLine?: (line: string) => void,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "",
      stderr = "",
      pending = "",
      bytes = 0;
    const decoder = new StringDecoder("utf8");
    const abort = () => {
      child.kill();
      reject(new Error("DSH cancelled/aborted or timed out"));
    };
    const deadline = signal ? null : setTimeout(abort, 20000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", (d: Buffer) => {
      bytes += d.length;
      if (bytes > 4 * 1024 * 1024) {
        child.kill();
        reject(new Error("DSH output exceeds 4 MiB quota"));
        return;
      }
      if (onLine) {
        pending += decoder.write(d);
        let index: number;
        while ((index = pending.indexOf("\n")) >= 0) {
          onLine(pending.slice(0, index));
          pending = pending.slice(index + 1);
        }
      } else stdout += decoder.write(d);
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4096);
    });
    child.stdin.on("error", () => {});
    child.on("error", (error) => {
      if (deadline) clearTimeout(deadline);
      reject(error);
    });
    child.on("close", (code) => {
      if (deadline) clearTimeout(deadline);
      signal?.removeEventListener("abort", abort);
      pending += decoder.end();
      if (pending) onLine?.(pending);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.end(input);
  });
}
export async function runDshSession(opts: DshRunOptions): Promise<DshRunResult> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(opts.runId)) throw new Error("Invalid run ID");
  if (!opts.organizationId || !opts.agentId || !opts.taskId)
    throw new Error("DSH requires organization, Agent and task authorization context");
  if (Buffer.byteLength(opts.task) > 80000) throw new Error("Task exceeds size quota");
  const stub = env.dshModelStub();
  if (process.env.NODE_ENV === "production" && (stub || opts.testCalls))
    throw new Error("Production forbids DSH model fixtures");
  if (opts.model && stub) throw new Error("Personal model cannot run through a test model");
  if (!stub && !opts.model && !env.deepseekApiKey())
    throw new Error("DSH model credential not configured (SEC-02)");
  const model = opts.model;
  if (
    !opts.grants?.some(
      (g) =>
        g.kind === "MODEL" &&
        (model
          ? g.name === model.model && g.source === personalModelSource + model.baseUrl
          : g.name === "deepseek-chat" && !g.source?.startsWith(personalModelSource)),
    )
  )
    throw new Error("DSH Model capability not granted");
  const scope = deploymentScope();
  const proxy = stub ? null : await createRunModelProxy(undefined, model);
  const id = createHash("sha256").update(opts.runId).digest("hex").slice(0, 24),
    name = `poros-run-${id}`,
    network = `poros-net-${id}`;
  const ownerToken = randomUUID();
  const ctrl = new AbortController(),
    abort = () => ctrl.abort();
  opts.signal?.addEventListener("abort", abort, { once: true });
  if (opts.signal?.aborted) ctrl.abort();
  const timer = setTimeout(abort, opts.timeoutMs ?? 180000),
    events: DshEvent[] = [];
  let writes = Promise.resolve(),
    streamError: unknown;
  const result: DshRunResult = {
    modelCalls: null,
    sessionId: null,
    final: "",
    completed: false,
    error: null,
    events,
    diagnostics: "",
    modelChannel: stub ? "stub" : "configured",
  };
  const dispatch = (line: string) => {
    let e: DshEvent;
    try {
      e = JSON.parse(line) as DshEvent;
    } catch {
      return;
    }
    if (!e || typeof e.type !== "string") return;
    if (events.length >= 2000) {
      streamError = new Error("DSH event quota exceeded");
      ctrl.abort();
      return;
    }
    events.push(e);
    if (e.type === "session") result.sessionId = String(e.session_id ?? e.sessionId ?? "");
    if (e.type === "final") {
      result.final = String(e.content ?? e.text ?? "");
      result.completed = (e.reason as { kind?: string })?.kind === "completed";
    }
    if (e.type === "done") result.completed = true;
    if (e.type === "error") result.error = String(e.message ?? e.error ?? "DSH error");
    writes = writes
      .then(() => opts.onEvent?.(e))
      .catch((error) => {
        streamError = error;
        ctrl.abort();
      });
  };
  try {
    if (!stub) {
      const net = await dockerCommand(
        [
          "network",
          "create",
          "--label",
          "org.poros.owner=runtime",
          "--label",
          `org.poros.deployment=${scope}`,
          "--label",
          `org.poros.run=${opts.runId}`,
          "--label",
          `org.poros.token=${ownerToken}`,
          network,
        ],
        "",
        ctrl.signal,
      );
      if (net.code) throw new Error("Cannot create isolated DSH network");
    }
    const create = await dockerCommand(
      [
        "create",
        "--name",
        name,
        "--label",
        "org.poros.owner=runtime",
        "--label",
        `org.poros.deployment=${scope}`,
        "--label",
        `org.poros.run=${opts.runId}`,
        "--label",
        `org.poros.token=${ownerToken}`,
        "--label",
        `org.poros.tenant=${createHash("sha256").update(opts.organizationId).digest("hex")}`,
        "--interactive",
        "--init",
        "--user",
        "10001:10001",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--pids-limit",
        "128",
        "--memory",
        "768m",
        "--cpus",
        "1",
        "--network",
        stub ? "none" : network,
        "--add-host",
        "host.docker.internal:host-gateway",
        "--tmpfs",
        "/home/poros:rw,noexec,nosuid,size=268435456,uid=10001,gid=10001,mode=0700",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=67108864,mode=1777",
        "--env",
        "NARB_DISABLE_NATIVE_CACHE=1",
        "--entrypoint",
        "node",
        process.env.POROS_DSH_IMAGE || "poros/dsh:0.2.2-rc.1-audit",
        "/opt/poros/bootstrap.mjs",
      ],
      "",
      ctrl.signal,
    );
    if (create.code)
      throw new Error(`DSH container creation failed: ${create.stderr.slice(0, 200)}`);
    const input = JSON.stringify({
      task: opts.task,
      patch: buildProfilePatch({
        persona: opts.persona,
        grants: opts.grants,
        stub,
        modelBaseURL: proxy?.baseURL,
        modelId: model?.model,
      }),
      allowedTools: [...grantedToolNames(opts.grants ?? [])],
      context: {
        organizationId: opts.organizationId,
        projectId: opts.projectId,
        agentId: opts.agentId,
        version: opts.version,
        taskId: opts.taskId,
        runId: opts.runId,
      },
      stub,
      key: stub ? "test-fixture" : proxy!.token,
      testCalls: stub ? opts.testCalls : undefined,
      container: name,
      timeoutMs: opts.timeoutMs ?? 180000,
    });
    const executed = await dockerCommand(
      ["start", "--attach", "--interactive", name],
      input,
      ctrl.signal,
      dispatch,
    );
    await writes;
    if (streamError) throw streamError;
    result.diagnostics = executed.stderr;
    result.modelCalls = proxy
      ? proxy.upstreamCalls()
      : events.filter((e) => e.type === "status" && e.phase === "step_end").length;
    if (executed.code !== 0) result.error = `DSH process exit ${executed.code}`;
    if (!result.completed && !result.error) result.error = "DSH terminated without done event";
    return result;
  } catch (error) {
    if (error instanceof Error)
      Object.assign(error, {
        usage: {
          modelCalls: proxy?.upstreamCalls() ?? null,
          inputTokens: null,
          outputTokens: null,
          monetaryCost: null,
        },
      });
    throw error;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", abort);
    try {
      await removeOwnedResource("container", name, opts.runId, ownerToken, scope);
      if (!stub) await removeOwnedResource("network", network, opts.runId, ownerToken, scope);
    } finally {
      await proxy?.close();
    }
  }
}
export async function removeOwnedResource(
  kind: "container" | "network",
  name: string,
  runId: string,
  token?: string,
  scope = deploymentScope(),
): Promise<void> {
  const inspected = await dockerCommand(
    kind === "container" ? ["inspect", name] : ["network", "inspect", name],
  );
  if (inspected.code) {
    if (/No such|not found/i.test(inspected.stderr)) return;
    throw new Error("Cannot verify owned runtime cleanup");
  }
  const meta = JSON.parse(inspected.stdout)[0] as {
    Labels?: Record<string, string>;
    Config?: { Labels: Record<string, string> };
  };
  const labels = meta.Labels ?? meta.Config?.Labels ?? {};
  if (
    labels["org.poros.owner"] !== "runtime" ||
    labels["org.poros.deployment"] !== scope ||
    labels["org.poros.run"] !== runId ||
    (token && labels["org.poros.token"] !== token)
  )
    return;
  const removed = await dockerCommand(
    kind === "container" ? ["rm", "--force", name] : ["network", "rm", name],
  );
  if (removed.code && !/No such|not found/i.test(removed.stderr))
    throw new Error("Owned runtime resource removal failed");
}
/** Recover only our labelled resources, after a worker crash. No name-only deletion or user-volume cleanup. */
export async function cleanupOrphanedRuntime(db: PrismaClient): Promise<void> {
  const scope = deploymentScope();
  for (const kind of ["container", "network"] as const) {
    const list = await dockerCommand(
      kind === "container"
        ? [
            "ps",
            "-aq",
            "--filter",
            "label=org.poros.owner=runtime",
            "--filter",
            `label=org.poros.deployment=${scope}`,
          ]
        : [
            "network",
            "ls",
            "--filter",
            "label=org.poros.owner=runtime",
            "--filter",
            `label=org.poros.deployment=${scope}`,
            "--format",
            "{{.Name}}",
          ],
    );
    if (list.code) throw new Error("Runtime janitor cannot reach Docker");
    for (const name of list.stdout.trim().split(/\s+/).filter(Boolean)) {
      const inspected = await dockerCommand(
        kind === "container" ? ["inspect", name] : ["network", "inspect", name],
      );
      if (inspected.code) continue;
      const meta = JSON.parse(inspected.stdout)[0],
        labels = meta.Labels ?? meta.Config?.Labels ?? {},
        runId = labels["org.poros.run"];
      if (!runId) continue;
      const run = await db.run.findUnique({ where: { id: runId }, include: { task: true } });
      if (run?.status === "RUNNING" && run.task.leaseUntil && run.task.leaseUntil > new Date())
        continue;
      if (!run && Date.now() - Date.parse(meta.Created) < 600000) continue;
      await removeOwnedResource(kind, name, runId, undefined, scope);
    }
  }
}
export function auditToolCalls(
  events: DshEvent[],
  grants: DshGrant[],
): Array<{ tool: string; authorized: boolean; callId: string; input: unknown }> {
  const allowed = grantedToolNames(grants);
  return events
    .filter((e) => e.type === "tool_call")
    .map((e) => ({
      tool: String(e.tool),
      authorized: allowed.has(String(e.tool)),
      callId: String(e.call_id ?? ""),
      input: e.input,
    }));
}
