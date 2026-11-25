/** Isolated DSH execution. User content travels ONLY as JSON on stdin; no shell. */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { env } from "./env.js";
import { createRunModelProxy } from "./model-proxy.js";
import type { describeProviderError } from "./provider-errors.js";
import { runtimeToolName } from "./capability-catalog.js";
import { personalModelSource, type ModelConnection } from "./integration-connections.js";
import { StringDecoder } from "node:string_decoder";
import { LocalContainer, dockerJson } from "./docker-session.js";
import { localSocket, localDockerControl } from "./docker-control.js";
export interface DshGrant {
  kind: "TOOL" | "SKILL" | "MCP" | "KNOWLEDGE" | "MODEL";
  name: string;
  version?: string;
  source?: string;
  scopeNote?: string;
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
  brokerTools?: Array<{
    name: string;
    description: string;
    input: Record<string, "string">;
    timeoutMs?: number;
  }>;
  invokeTool?: (name: string, input: unknown, signal: AbortSignal) => Promise<unknown>;
  authorizeTool?: (name: string) => Promise<void>;
  authorizeModel?: () => Promise<void>;
  /** Deterministic MODEL fixture only. Real DSH/tool bodies. Production rejects this. */
  testCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  testSequence?: boolean;
  /** IDE always uses its verified model, independently of the legacy test profile. */
  configuredModelOnly?: boolean;
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
  modelFailure?: ReturnType<typeof describeProviderError>;
}
/** Windows Docker Desktop also ships an extensionless POSIX shim; never spawn that shim. */
export const dockerExecutable = () =>
  process.env.POROS_DOCKER_BINARY || (process.platform === "win32" ? "docker.exe" : "docker");
export function grantedToolNames(grants: DshGrant[]): Set<string> {
  return new Set(grants.map(runtimeToolName).filter((name): name is string => name !== null));
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
      "tool-web",
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
  onLine?: (
    line: string,
    send: (value: unknown) => Promise<void>,
    finishInput?: () => void,
  ) => void,
  interactive = false,
  existingChild?: LocalContainer,
): Promise<{ code: number; stdout: string; stderr: string }> {
  // Node readline treats these Unicode characters as delimiters even inside a JSON string.
  const frame = (json: string) =>
    json.replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029") + "\n";
  return new Promise((resolve, reject) => {
    const child =
      existingChild ||
      spawn(dockerExecutable(), args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "",
      stderr = "",
      pending = "",
      bytes = 0;
    const decoder = new StringDecoder("utf8");
    const send = (value: unknown) =>
      new Promise<void>((resolve, reject) => {
        if (child.stdin.destroyed || !child.stdin.writable) {
          reject(new Error("DSH bridge input is closed"));
          return;
        }
        child.stdin.write(frame(JSON.stringify(value)), (error) =>
          error ? reject(error) : resolve(),
        );
      });
    const abort = () => {
      child.kill();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
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
          onLine(pending.slice(0, index), send, () => child.stdin.end());
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
      if (pending) onLine?.(pending, send, () => child.stdin.end());
      resolve({ code: code ?? -1, stdout, stderr });
    });
    const begin = async () => {
      if (existingChild) await existingChild.start();
      if (interactive) child.stdin.write(frame(input));
      else child.stdin.end(input);
    };
    void begin().catch(reject);
  });
}
export async function runDshSession(opts: DshRunOptions): Promise<DshRunResult> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(opts.runId)) throw new Error("Invalid run ID");
  if (!opts.organizationId || !opts.agentId || !opts.taskId)
    throw new Error("DSH requires organization, Agent and task authorization context");
  if (Buffer.byteLength(opts.task) > 80000) throw new Error("Task exceeds size quota");
  const stub = opts.configuredModelOnly ? false : env.dshModelStub();
  if (process.env.NODE_ENV === "production" && (stub || opts.testCalls || opts.testSequence))
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
  const runtimeImage = process.env.POROS_DSH_IMAGE || "poros/dsh:0.2.2-rc.1-audit";
  const socket = await localSocket();
  const image = socket
    ? await dockerJson(socket, "GET", "/images/" + encodeURIComponent(runtimeImage) + "/json")
    : null;
  const protocol = image
    ? {
        code: image.status === 200 ? 0 : 1,
        stdout: String(
          (image.data as { Config?: { Labels?: Record<string, string> } }).Config?.Labels?.[
            "org.poros.bridge-protocol"
          ] || "",
        ),
      }
    : await dockerCommand([
        "image",
        "inspect",
        "--format",
        '{{index .Config.Labels "org.poros.bridge-protocol"}}',
        runtimeImage,
      ]);
  if (protocol.code || protocol.stdout.trim() !== "3")
    throw new Error("DSH 镜像缺少交互桥协议 v3，请用当前 deploy/Dockerfile.dsh 重新构建运行镜像");
  const proxy = stub ? null : await createRunModelProxy(undefined, model);
  const id = createHash("sha256").update(opts.runId).digest("hex").slice(0, 24),
    name = `poros-run-${id}`;
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
  const requests = new Map<string, AbortController>();
  const allowedBrokerTools = new Set(opts.brokerTools?.map((tool) => tool.name) ?? []);
  const allowedTools = grantedToolNames(opts.grants ?? []);
  let toolRequests = 0;
  const relay = async (e: DshEvent, send: (value: unknown) => Promise<void>) => {
    if (typeof e.id !== "string" || !/^[a-f0-9-]{36}$/.test(e.id)) return;
    const id = e.id;
    if (e.type === "bridge.cancel") {
      requests.get(id)?.abort();
      return;
    }
    if (requests.has(id)) return;
    const request = new AbortController();
    const toolName = (e.body as { name?: string } | undefined)?.name;
    const requestedTimeout =
      e.route === "tool"
        ? opts.brokerTools?.find((tool) => tool.name === toolName)?.timeoutMs
        : undefined;
    const signal = AbortSignal.any([
      ctrl.signal,
      request.signal,
      AbortSignal.timeout(Math.min(180000, Math.max(35000, requestedTimeout || 35000))),
    ]);
    requests.set(id, request);
    const reply = (part: Record<string, unknown>) => send({ type: "bridge.reply", id, ...part });
    const chunk = (data: string | Uint8Array) => {
      const bytes = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
      return reply({ chunk: bytes.toString("base64") });
    };
    let sentHeaders = false;
    try {
      if (requests.size > 4) {
        await reply({ status: 429, done: true });
      } else if (e.route === "model" && proxy) {
        await opts.authorizeModel?.();
        const response = await fetch(proxy.baseURL + "/chat/completions", {
          method: "POST",
          signal,
          headers: { "content-type": "application/json", authorization: "Bearer " + proxy.token },
          body: JSON.stringify(e.body),
          redirect: "error",
        });
        await reply({ status: response.status, contentType: response.headers.get("content-type") });
        sentHeaders = true;
        if (response.body) {
          const reader = response.body.getReader();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              await chunk(value);
            }
          } finally {
            await reader.cancel().catch(() => {});
          }
        }
        await reply({ done: true });
      } else if (e.route === "tool" && opts.invokeTool) {
        const body = e.body as { name?: string; input?: unknown } | undefined;
        if (!body?.name || !allowedBrokerTools.has(body.name) || ++toolRequests > 64) {
          await reply({ status: 403, done: true });
          return;
        }
        const output = await opts.invokeTool(body.name, body.input, signal);
        await reply({ status: 200, contentType: "application/json" });
        sentHeaders = true;
        await chunk(JSON.stringify(output));
        await reply({ done: true });
      } else if (e.route === "authorize") {
        const body = e.body as { name?: string } | undefined;
        if (!body?.name || !allowedTools.has(body.name)) {
          await reply({ status: 403, done: true });
          return;
        }
        await opts.authorizeTool?.(body.name);
        await reply({ status: 204, done: true });
      } else {
        await reply({ status: 403, done: true });
      }
    } catch {
      if (!sentHeaders) await reply({ status: 502, done: true }).catch(() => {});
      else await reply({ abort: true }).catch(() => {});
    } finally {
      requests.delete(id);
    }
  };
  const dispatch = (
    line: string,
    send: (value: unknown) => Promise<void>,
    finishInput?: () => void,
  ) => {
    let e: DshEvent;
    try {
      e = JSON.parse(line) as DshEvent;
    } catch {
      return;
    }
    if (!e || typeof e.type !== "string") return;
    if (e.type === "bridge.request" || e.type === "bridge.cancel") {
      void relay(e, send).catch(() => {});
      return;
    }
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
    if (e.type === "runtime.exit") finishInput?.();
    if (e.type === "error") result.error = String(e.message ?? e.error ?? "DSH error");
    writes = writes
      .then(() => opts.onEvent?.(e))
      .catch((error) => {
        streamError = error;
        ctrl.abort();
      });
  };
  try {
    const local = await LocalContainer.create(
      {
        Image: runtimeImage,
        User: "10001:10001",
        OpenStdin: true,
        StdinOnce: true,
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Labels: {
          "org.poros.owner": "runtime",
          "org.poros.deployment": scope,
          "org.poros.run": opts.runId,
          "org.poros.token": ownerToken,
          "org.poros.tenant": createHash("sha256").update(opts.organizationId).digest("hex"),
        },
        Env: ["NARB_DISABLE_NATIVE_CACHE=1"],
        Entrypoint: ["node"],
        Cmd: ["/opt/poros/bootstrap.mjs"],
        HostConfig: {
          Init: true,
          ReadonlyRootfs: true,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"],
          NetworkMode: "none",
          PidsLimit: 128,
          Memory: 768 * 1024 * 1024,
          NanoCpus: 1000000000,
          Tmpfs: {
            "/home/poros": "rw,noexec,nosuid,size=268435456,uid=10001,gid=10001,mode=0700",
            "/tmp": "rw,noexec,nosuid,size=67108864,mode=1777",
          },
        },
      },
      name,
      ctrl.signal,
    );
    const create = local
      ? { code: 0, stderr: "" }
      : await dockerCommand(
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
            "none",
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
        modelBaseURL: "http://127.0.0.1:9918/v1",
        modelId: model?.model,
      }),
      allowedTools: [...allowedTools],
      brokerTools: opts.brokerTools ?? [],
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
      testSequence: stub ? opts.testSequence : undefined,
      container: name,
      timeoutMs: opts.timeoutMs ?? 180000,
    });
    const executed = await dockerCommand(
      ["start", "--attach", "--interactive", name],
      input,
      ctrl.signal,
      dispatch,
      true,
      local || undefined,
    );
    await writes;
    if (streamError) throw streamError;
    result.diagnostics = executed.stderr;
    result.modelCalls = proxy
      ? proxy.upstreamCalls()
      : events.filter((e) => e.type === "status" && e.phase === "step_end").length;
    result.modelFailure = proxy?.failure();
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
    for (const request of requests.values()) request.abort();
    opts.signal?.removeEventListener("abort", abort);
    try {
      await removeOwnedResource("container", name, opts.runId, ownerToken, scope);
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
  owner: "runtime" | "ide" = "runtime",
): Promise<void> {
  if (!/^[A-Za-z0-9_.-]{1,120}$/.test(name)) throw new Error("Invalid runtime resource name");
  const resource = kind === "container" ? `/containers/${name}/json` : `/networks/${name}`;
  const inspectedApi = await localDockerControl("GET", resource);
  if (inspectedApi) {
    if (inspectedApi.status === 404) return;
    if (inspectedApi.status !== 200) throw new Error("Cannot verify owned runtime cleanup");
    const meta = inspectedApi.data as {
      Id: string;
      Labels?: Record<string, string>;
      Config?: { Labels?: Record<string, string> };
    };
    const labels = meta.Labels ?? meta.Config?.Labels ?? {};
    if (
      labels["org.poros.owner"] !== owner ||
      labels["org.poros.deployment"] !== scope ||
      labels["org.poros.run"] !== runId ||
      (token && labels["org.poros.token"] !== token)
    )
      return;
    if (!/^[a-f0-9]{64}$/.test(meta.Id)) throw new Error("Invalid runtime resource identity");
    const removed = await localDockerControl(
      "DELETE",
      kind === "container" ? `/containers/${meta.Id}?force=1` : `/networks/${meta.Id}`,
    );
    if (!removed || ![204, 404].includes(removed.status)) {
      const remaining = await localDockerControl("GET", resource);
      if (remaining?.status !== 404) throw new Error("Owned runtime resource removal failed");
    }
    return;
  }
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
    labels["org.poros.owner"] !== owner ||
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
