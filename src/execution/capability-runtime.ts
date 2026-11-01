import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { z } from "zod";
import { ScenarioError, ScenarioErrorCode } from "@/core/errors.js";
import { HostExecutionSpecSchema } from "@/federation/types.js";
import type { Capability, HostExecutionSpec } from "@/federation/types.js";
import { digestAndVendor } from "@/federation/skill-digest.js";

/**
 * 4.2 能力运行时：
 *  - 安装器（4.2.1）：npx / CLI / git clone / 远程免安装 四方式 + 安装锁（并发同包只装一次）
 *  - 调用器（4.2.2）：invoke(capability, action, inputs) —— remote 走 HTTP JSON-RPC；
 *    npx 起本地 stdio MCP server；skill 上下文注入
 *  - 权限（4.2.3）：危险操作（安装/远程未知端点）经 PermissionGate 审批事件
 */

// ───────────────────────── 安装器 ─────────────────────────

export interface InstallRecord {
  capabilityId: string;
  method: Capability["install"]["type"];
  installedAt: string;
  /** git clone / npx 缓存位置（远程免安装为空） */
  location?: string;
}

export interface CommandRunner {
  run(
    command: string,
    args: string[],
    options?: { cwd?: string; timeoutMs?: number; maxOutputBytes?: number; signal?: AbortSignal },
  ): Promise<{ code: number; stdout: string; stderr: string; truncated?: boolean }>;
}

export function processCommandRunner(): CommandRunner {
  return {
    run(command, args, options = {}) {
      return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd: options.cwd, shell: false });
        let stdout = "";
        let stderr = "";
        let truncated = false;
        let outputBytes = 0;
        const maxOutputBytes = Math.max(1_024, options.maxOutputBytes ?? 1_000_000);
        const append = (current: string, chunk: string): string => {
          if (outputBytes >= maxOutputBytes) {
            truncated = true;
            return current;
          }
          const remaining = maxOutputBytes - outputBytes;
          const bytes = Buffer.from(chunk, "utf8");
          if (bytes.byteLength <= remaining) {
            outputBytes += bytes.byteLength;
            return current + chunk;
          }
          truncated = true;
          outputBytes = maxOutputBytes;
          return current + bytes.subarray(0, remaining).toString("utf8");
        };
        const timer = setTimeout(() => {
          child.kill();
          reject(new ScenarioError({ code: ScenarioErrorCode.TIMEOUT, message: `${command} timed out`, phase: "executing" }));
        }, options.timeoutMs ?? 120_000);
        const onAbort = () => child.kill();
        if (options.signal) {
          if (options.signal.aborted) onAbort();
          else options.signal.addEventListener("abort", onAbort, { once: true });
        }
        child.stdout.on("data", (d) => (stdout = append(stdout, String(d))));
        child.stderr.on("data", (d) => (stderr = append(stderr, String(d))));
        child.on("error", (e) => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          reject(e);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          resolve({ code: code ?? -1, stdout, stderr, truncated });
        });
      });
    },
  };
}

export interface InstallerDeps {
  runner: CommandRunner;
  /** 安装根目录（默认系统临时下 scenario-installs/） */
  installsDir?: string;
  /** 安装锁（进程内 + 跨实例 store 锁由调用方注入） */
  now?: () => Date;
}

export class CapabilityInstaller {
  private readonly inflight = new Map<string, Promise<InstallRecord>>();
  private readonly events = new EventEmitter();
  readonly installed = new Map<string, InstallRecord>();

  constructor(private deps: InstallerDeps) {}

  onInstalled(handler: (record: InstallRecord) => void): () => void {
    this.events.on("installed", handler);
    return () => this.events.off("installed", handler);
  }

  /** 安装锁语义：并发同 capabilityId 只装一次，其余等待共享结果 */
  async install(cap: Capability, permission?: PermissionGate): Promise<InstallRecord> {
    const existing = this.installed.get(cap.id);
    if (existing) return existing;
    const inflight = this.inflight.get(cap.id);
    if (inflight) return await inflight;

    const task = this.doInstall(cap, permission).finally(() => this.inflight.delete(cap.id));
    this.inflight.set(cap.id, task);
    return await task;
  }

  private async doInstall(cap: Capability, permission?: PermissionGate): Promise<InstallRecord> {
    const now = (this.deps.now ?? (() => new Date()))();
    const installsDir = this.deps.installsDir ?? path.join(tmpdir(), "scenario-installs");
    switch (cap.install.type) {
      case "remote": {
        // 远程免安装
        const record: InstallRecord = { capabilityId: cap.id, method: "remote", installedAt: now.toISOString() };
        this.installed.set(cap.id, record);
        this.events.emit("installed", record);
        return record;
      }
      case "npx": {
        if (permission && !(await permission.request({ kind: "install", capabilityId: cap.id, detail: `npx ${cap.install.package}` }))) {
          throw new ScenarioError({ code: ScenarioErrorCode.CANCELLED, message: `install denied: ${cap.id}`, phase: "executing" });
        }
        // npx 即取即用：预拉取校验包存在（--version dry check）。安装参数
        // 是能力声明的一部分，必须传给 server；非零退出码不能被记录为已安装。
        const r = await this.deps.runner.run("npx", ["--yes", cap.install.package, ...cap.install.args, "--version"], { timeoutMs: 90_000 });
        if (r.code !== 0) {
          throw new ScenarioError({
            code: ScenarioErrorCode.INSTALL_FAILED,
            message: `npx check failed for ${cap.id}: ${r.stderr.slice(0, 200)}`,
            phase: "executing",
          });
        }
        const record: InstallRecord = {
          capabilityId: cap.id,
          method: "npx",
          installedAt: now.toISOString(),
          location: r.stdout.split("\n")[0]?.trim() || "npx-cache",
        };
        this.installed.set(cap.id, record);
        this.events.emit("installed", record);
        return record;
      }
      case "cli": {
        const record: InstallRecord = { capabilityId: cap.id, method: "cli", installedAt: now.toISOString(), location: cap.install.command };
        this.installed.set(cap.id, record);
        this.events.emit("installed", record);
        return record;
      }
      case "git": {
        if (permission && !(await permission.request({ kind: "install", capabilityId: cap.id, detail: `git clone ${cap.install.repoUrl}` }))) {
          throw new ScenarioError({ code: ScenarioErrorCode.CANCELLED, message: `install denied: ${cap.id}`, phase: "executing" });
        }
        const dir = path.join(installsDir, cap.id.replace(/[^\w.-]/g, "_"));
        try {
          await stat(dir);
          // 已克隆过
          const record: InstallRecord = { capabilityId: cap.id, method: "git", installedAt: now.toISOString(), location: dir };
          this.installed.set(cap.id, record);
          return record;
        } catch {
          /* 首次克隆 */
        }
        const r = await this.deps.runner.run("git", ["clone", "--depth", "1", cap.install.repoUrl, dir], { timeoutMs: 180_000 });
        if (r.code !== 0) {
          throw new ScenarioError({
            code: ScenarioErrorCode.INSTALL_FAILED,
            message: `git clone failed for ${cap.id}: ${r.stderr.slice(0, 200)}`,
            phase: "executing",
          });
        }
        const record: InstallRecord = { capabilityId: cap.id, method: "git", installedAt: now.toISOString(), location: dir };
        this.installed.set(cap.id, record);
        this.events.emit("installed", record);
        return record;
      }
      case "context": {
        // 技能知识：不安装（下载由联邦层矿流水线负责）
        const record: InstallRecord = { capabilityId: cap.id, method: "context", installedAt: now.toISOString() };
        return record;
      }
    }
  }
}

// ───────────────────────── 权限审批（4.2.3）─────────────────────────

export interface PermissionRequest {
  kind: "install" | "remote-call" | "write";
  capabilityId: string;
  detail: string;
}

export type PermissionDecision = "allow" | "deny";

/** pi-hooks 审批事件语义：危险操作挂起等决策；默认拒绝 */
export class PermissionGate {
  private readonly events = new EventEmitter();

  onRequest(handler: (request: PermissionRequest, respond: (d: PermissionDecision) => void) => void): () => void {
    this.events.on("request", handler);
    return () => this.events.off("request", handler);
  }

  async request(req: PermissionRequest): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 30_000); // 默认拒绝
      this.events.emit("request", req, (d: PermissionDecision) => {
        clearTimeout(timer);
        resolve(d === "allow");
      });
    });
  }
}

// ───────────────────────── 调用器（4.2.2）─────────────────────────

const JsonRpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0").optional(),
  id: z.number().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

export interface McpHttpRequestOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  secret?: string;
}

export interface McpHttpResponse {
  ok: boolean;
  status: number;
  payload: unknown;
  headers: Headers;
}

/**
 * Execute one MCP Streamable HTTP request with the required initialize
 * handshake. A few older JSON-RPC bridges only expose tools/list or
 * tools/call and reject initialize; for those explicitly unsupported
 * handshakes we fall back to the legacy single request so existing servers
 * remain usable without weakening HTTP/auth errors.
 */
export async function mcpHttpRequest(endpoint: string, method: string, params: Record<string, unknown>, options: McpHttpRequestOptions = {}): Promise<McpHttpResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = options.timeoutMs ?? 30_000;
  let protocolVersion = "2025-06-18";
  const send = async (id: number | undefined, rpcMethod: string, rpcParams: Record<string, unknown>, sessionId?: string): Promise<McpHttpResponse> => {
    const controller = AbortSignal.timeout(timeout);
    const signal = options.signal ? AbortSignal.any([options.signal, controller]) : controller;
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(options.secret ? { authorization: `Bearer ${options.secret}` } : {}),
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        ...(sessionId ? { "mcp-protocol-version": protocolVersion } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method: rpcMethod, params: rpcParams }),
      signal,
    });
    const text = await response.text();
    const line = text.split(/\r?\n/).find((entry) => entry.startsWith("data:"));
    const source = line ? line.slice(5).trim() : text.trim();
    let payload: unknown = undefined;
    if (source) {
      try { payload = JSON.parse(source); } catch { payload = source; }
    }
    return { ok: response.ok, status: response.status, payload, headers: response.headers };
  };

  if (method === "initialize") return await send(1, method, params);
  let sessionId: string | undefined;
  let initialized = false;
  try {
    const handshake = await send(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pi-scenario", version: "0.1.0" } });
    const parsedHandshake = JsonRpcResponseSchema.safeParse(handshake.payload);
    if (handshake.ok && parsedHandshake.success && !parsedHandshake.data.error && parsedHandshake.data.result !== undefined) {
      sessionId = handshake.headers.get("mcp-session-id") ?? undefined;
      const negotiated = parsedHandshake.data.result;
      if (typeof negotiated === "object" && negotiated !== null && "protocolVersion" in negotiated && typeof negotiated.protocolVersion === "string") protocolVersion = negotiated.protocolVersion;
      initialized = true;
      // The notification is intentionally best-effort; the actual call below
      // remains authoritative and its response/error is returned to callers.
      await send(undefined, "notifications/initialized", {}, sessionId).catch(() => undefined);
    } else if (!isUnsupportedMcpHandshake(handshake)) {
      return handshake;
    }
  } catch (error) {
    if (options.signal?.aborted) throw error;
    // A connection-level failure is not an unsupported protocol. Re-throw it
    // so callers surface the real network failure instead of retrying blindly.
    throw error;
  }

  const result = await send(2, method, params, initialized ? sessionId : undefined);
  if (!initialized && isUnsupportedMcpHandshake(result)) return await send(1, method, params);
  return result;
}

function isUnsupportedMcpHandshake(response: McpHttpResponse): boolean {
  if ([400, 404, 405, 415, 422].includes(response.status)) return true;
  const parsed = JsonRpcResponseSchema.safeParse(response.payload);
  return parsed.success && parsed.data.error?.code === -32601;
}

export interface InvokeOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface InvokeResult {
  ok: boolean;
  output?: unknown;
  error?: string;
  latencyMs: number;
  mode?: "executed" | "context" | "delegated";
  degraded?: boolean;
}

export interface HostExecutionRequest {
  capability: Capability;
  action: string;
  inputs: Record<string, unknown>;
  spec: HostExecutionSpec;
  options: InvokeOptions;
}

/** Host-provided policy for the explicit CLI/git execution contract. */
export interface HostCommandPolicy {
  /** Only these executable basenames may run. An empty list rejects every command. */
  allowedCommands: readonly string[];
  projectRoot?: string;
  workspaceRoot?: string;
  /** Git capabilities may execute inside their verified installation directory. */
  installRoot?: (capability: Capability) => string | undefined;
  maxTimeoutMs?: number;
  maxOutputBytes?: number;
  runner?: CommandRunner;
  permission?: PermissionGate;
}

/**
 * Sanitized host policy exposed to the panel.  This is intentionally a
 * status object rather than the executable policy itself: callers must still
 * build a `HostCommandExecutor` with a project root for each run.
 */
export interface HostExecutionStatus {
  enabled: boolean;
  allowedCommands: string[];
  workspaceRoot: string | null;
  installRoot: string | null;
  maxTimeoutMs: number | null;
  maxOutputBytes: number | null;
  error: string | null;
}

export interface HostExecutionEnvironment {
  status: HostExecutionStatus;
  allowedCommands: string[];
  workspaceRoot?: string;
  installRoot?: string;
  maxTimeoutMs?: number;
  maxOutputBytes?: number;
}

const HOST_COMMAND_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Read the optional launcher host policy.  An absent or malformed allow-list
 * disables host execution.  No command is ever enabled by default, and all
 * roots must be absolute paths so a process cannot inherit an ambiguous cwd.
 *
 * Environment variables are deliberately narrow and are intended for the
 * local launcher/host wrapper, never for model or catalog input:
 *
 *   SCENARIO_HOST_ALLOWED_COMMANDS=safe-tool,another-tool
 *   SCENARIO_HOST_WORKSPACE_ROOT=C:\\workspace
 *   SCENARIO_HOST_INSTALL_ROOT=C:\\scenario-installs
 *   SCENARIO_HOST_MAX_TIMEOUT_MS=30000
 *   SCENARIO_HOST_MAX_OUTPUT_BYTES=200000
 */
export function readHostExecutionEnvironment(env: NodeJS.ProcessEnv = process.env): HostExecutionEnvironment {
  const rawCommands = env.SCENARIO_HOST_ALLOWED_COMMANDS?.trim() ?? "";
  const rawCommandsList = rawCommands ? rawCommands.split(/[\s,]+/).filter(Boolean) : [];
  const allowedCommands = [...new Set(rawCommandsList.map((command) => command.trim().toLowerCase()))];
  const invalidCommand = allowedCommands.find((command) => !HOST_COMMAND_RE.test(command));
  const parseRoot = (name: string): { value?: string; error?: string } => {
    const raw = env[name]?.trim();
    if (!raw) return {};
    if (!path.isAbsolute(raw)) return { error: `${name} must be an absolute path` };
    return { value: path.resolve(raw) };
  };
  const workspace = parseRoot("SCENARIO_HOST_WORKSPACE_ROOT");
  const install = parseRoot("SCENARIO_HOST_INSTALL_ROOT");
  const parseBounded = (name: string, min: number, max: number): { value?: number; error?: string } => {
    const raw = env[name]?.trim();
    if (!raw) return {};
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) return { error: `${name} must be an integer between ${min} and ${max}` };
    return { value };
  };
  const timeout = parseBounded("SCENARIO_HOST_MAX_TIMEOUT_MS", 100, 120_000);
  const output = parseBounded("SCENARIO_HOST_MAX_OUTPUT_BYTES", 1_024, 1_000_000);
  const error = invalidCommand
    ? `SCENARIO_HOST_ALLOWED_COMMANDS contains an invalid command: ${invalidCommand}`
    : workspace.error ?? install.error ?? timeout.error ?? output.error ?? null;
  const enabled = allowedCommands.length > 0 && !error;
  const status: HostExecutionStatus = {
    enabled,
    allowedCommands: enabled ? allowedCommands : [],
    workspaceRoot: workspace.value ?? null,
    installRoot: install.value ?? null,
    maxTimeoutMs: timeout.value ?? null,
    maxOutputBytes: output.value ?? null,
    error: error ?? (allowedCommands.length === 0 ? "host execution disabled: no allow-listed commands configured" : null),
  };
  return {
    status,
    allowedCommands: status.allowedCommands,
    ...(workspace.value ? { workspaceRoot: workspace.value } : {}),
    ...(install.value ? { installRoot: install.value } : {}),
    ...(timeout.value !== undefined ? { maxTimeoutMs: timeout.value } : {}),
    ...(output.value !== undefined ? { maxOutputBytes: output.value } : {}),
  };
}

export interface HostCommandExecutor {
  execute(request: HostExecutionRequest): Promise<InvokeResult>;
}

function pathWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function hostArgs(spec: HostExecutionSpec, inputs: Record<string, unknown>): { args?: string[]; error?: string } {
  const args = [...spec.args];
  for (const [key, binding] of Object.entries(spec.inputArgs)) {
    const value = inputs[key];
    if (value === undefined || value === null) {
      if (binding.required) return { error: `missing required host input: ${key}` };
      continue;
    }
    if (binding.type === "boolean") {
      if (typeof value !== "boolean") return { error: `host input ${key} must be boolean` };
      if (value) args.push(binding.flag);
      continue;
    }
    if (binding.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) return { error: `host input ${key} must be finite number` };
      args.push(binding.flag, String(value));
      continue;
    }
    if (typeof value !== "string" || value.length > 4_000 || value.includes("\u0000")) {
      return { error: `host input ${key} must be a string without NUL (max 4000 chars)` };
    }
    args.push(binding.flag, value);
  }
  return { args };
}

/**
 * Build a bounded host executor. This is deliberately opt-in: without this
 * adapter, CLI/git capabilities remain delegated and cannot be reported as
 * executed. The command is always spawned with shell:false and model inputs
 * can only populate explicitly declared argv flags.
 */
export function createSafeHostCommandExecutor(policy: HostCommandPolicy): HostCommandExecutor {
  const allowed = new Set(policy.allowedCommands.map((command) => command.toLowerCase()));
  const runner = policy.runner ?? processCommandRunner();
  return {
    async execute(request) {
      const parsed = HostExecutionSpecSchema.safeParse(request.spec);
      if (!parsed.success) return { ok: false, error: "invalid host execution contract", latencyMs: 0, mode: "delegated" };
      const spec = parsed.data;
      if (!allowed.has(spec.command.toLowerCase())) {
        return { ok: false, error: `host command is not allow-listed: ${spec.command}`, latencyMs: 0, mode: "delegated" };
      }
      if (request.capability.install.type !== "cli" && request.capability.install.type !== "git") {
        return { ok: false, error: "host execution is only valid for cli/git capabilities", latencyMs: 0, mode: "delegated" };
      }
      const root = spec.cwd === "project" ? policy.projectRoot : spec.cwd === "workspace" ? policy.workspaceRoot : policy.installRoot?.(request.capability);
      if (!root) return { ok: false, error: `host execution has no ${spec.cwd} root`, latencyMs: 0, mode: "delegated" };
      const cwd = path.resolve(root);
      if (!pathWithinRoot(root, cwd)) return { ok: false, error: "host execution cwd escapes its root", latencyMs: 0, mode: "delegated" };
      const built = hostArgs(spec, request.inputs);
      if (!built.args) return { ok: false, error: built.error ?? "invalid host inputs", latencyMs: 0, mode: "delegated" };
      if (policy.permission && !(await policy.permission.request({ kind: "write", capabilityId: request.capability.id, detail: `host command ${spec.command} (${built.args.length} argv tokens)` }))) {
        return { ok: false, error: "host command denied by permission gate", latencyMs: 0, mode: "delegated" };
      }
      const t0 = Date.now();
      try {
        const result = await runner.run(spec.command, built.args, {
          cwd,
          timeoutMs: Math.min(spec.timeoutMs, policy.maxTimeoutMs ?? spec.timeoutMs),
          maxOutputBytes: Math.min(spec.maxOutputBytes, policy.maxOutputBytes ?? spec.maxOutputBytes),
          signal: request.options.signal,
        });
        const output = {
          command: spec.command,
          args: built.args,
          cwd,
          exitCode: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
          truncated: result.truncated === true,
        };
        return {
          ok: result.code === 0,
          output,
          error: result.code === 0 ? undefined : `host command exited with code ${result.code}`,
          latencyMs: Date.now() - t0,
          mode: "executed",
          degraded: result.truncated === true,
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - t0, mode: "executed" };
      }
    },
  };
}

export class CapabilityInvoker {
  constructor(
    private permission?: PermissionGate,
    private fetchImpl: typeof fetch = fetch,
    private hostExecutor?: HostCommandExecutor,
  ) {}

  /**
   * 统一调用入口：
   *  - remote / 带 remoteRun 的能力 → HTTP JSON-RPC（tools/call）
   *  - npx → spawn stdio MCP（initialize + tools/call）
   *  - skill-knowledge → 上下文注入（返回 SKILL.md 内容块）
   *  - git/cli → 返回引导上下文（真实执行由 pi 运行时承接，独立运行态降级为说明）
   */
  async invoke(cap: Capability, action: string, inputs: Record<string, unknown>, options: InvokeOptions = {}): Promise<InvokeResult> {
    const t0 = Date.now();
    try {
      if (cap.kind === "skill-knowledge" || cap.install.type === "context") {
        return await this.invokeSkillContext(cap, t0);
      }
      const endpoint = cap.remoteRun?.url ?? (cap.install.type === "remote" ? cap.install.url : undefined);
      if (endpoint) {
        return await this.invokeRemote(cap, endpoint, action, inputs, options, t0);
      }
      if (cap.install.type === "npx") {
        return await this.runStdioJsonRpc(["--yes", cap.install.package, ...cap.install.args], action, inputs, options, t0, "npx");
      }
      if ((cap.install.type === "cli" || cap.install.type === "git") && cap.hostExecution && this.hostExecutor) {
        return await this.hostExecutor.execute({ capability: cap, action, inputs, spec: cap.hostExecution, options });
      }
      // git/cli：没有显式宿主执行契约时返回交接信息但明确不是成功。
      return {
        ok: false,
        output: {
          mode: "context-handoff",
          capability: cap.id,
          action,
          inputs,
          note: "git/cli capability: 执行委托给宿主 agent 运行时（附 README 装配说明）",
        },
        latencyMs: Date.now() - t0,
        mode: "delegated",
        error: "capability requires host agent runtime; no standalone executor is available",
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - t0,
      };
    }
  }

  async probe(cap: Capability, options: InvokeOptions = {}): Promise<{ available: boolean; latencyMs: number; message?: string }> {
    const t0 = Date.now();
    if (cap.kind === "skill-knowledge" || cap.install.type === "context") {
      const available = cap.description.trim().length > 0;
      return { available, latencyMs: Date.now() - t0, message: available ? undefined : "capability has no context content" };
    }
    const endpoint = cap.remoteRun?.url ?? (cap.install.type === "remote" ? cap.install.url : undefined);
    if (!endpoint) {
      return { available: false, latencyMs: Date.now() - t0, message: `${cap.install.type} capability has no safe probe endpoint` };
    }
    try {
      const resp = await mcpHttpRequest(endpoint, "tools/list", {}, { fetchImpl: this.fetchImpl, signal: options.signal, timeoutMs: options.timeoutMs ?? 10_000 });
      if (!resp.ok) return { available: false, latencyMs: Date.now() - t0, message: `probe HTTP ${resp.status}` };
      const parsed = JsonRpcResponseSchema.safeParse(resp.payload);
      if (!parsed.success || parsed.data.error) {
        return { available: false, latencyMs: Date.now() - t0, message: parsed.success ? parsed.data.error?.message ?? "probe failed" : "malformed probe response" };
      }
      return { available: true, latencyMs: Date.now() - t0 };
    } catch (err) {
      return { available: false, latencyMs: Date.now() - t0, message: err instanceof Error ? err.message : String(err) };
    }
  }

  private async invokeRemote(
    cap: Capability,
    endpoint: string,
    action: string,
    inputs: Record<string, unknown>,
    options: InvokeOptions,
    t0: number,
  ): Promise<InvokeResult> {
    if (this.permission && !(await this.permission.request({ kind: "remote-call", capabilityId: cap.id, detail: `POST ${endpoint} ${action}` }))) {
      return { ok: false, error: "remote call denied by permission gate", latencyMs: Date.now() - t0 };
    }
    const resp = await mcpHttpRequest(endpoint, "tools/call", { name: action, arguments: inputs }, { fetchImpl: this.fetchImpl, signal: options.signal, timeoutMs: options.timeoutMs ?? 30_000 });
    if (!resp.ok) return { ok: false, error: `remote HTTP ${resp.status}`, latencyMs: Date.now() - t0 };
    const parsed = JsonRpcResponseSchema.safeParse(resp.payload);
    if (!parsed.success) {
      return { ok: false, error: `malformed JSON-RPC response from ${endpoint}`, latencyMs: Date.now() - t0 };
    }
    if (parsed.data.error) {
      return { ok: false, error: `${parsed.data.error.code}: ${parsed.data.error.message}`, latencyMs: Date.now() - t0 };
    }
    return { ok: true, output: parsed.data.result, latencyMs: Date.now() - t0, mode: "executed" };
  }

  /** stdio JSON-RPC 通用驱动（initialize → tools/call）；npx 形态即 spawn npx，测试可注入本地脚本命令 */
  runStdioJsonRpc(
    args: string[],
    action: string,
    inputs: Record<string, unknown>,
    options: InvokeOptions,
    t0: number,
    command = "npx",
  ): Promise<InvokeResult> {
    return new Promise((resolve) => {
      const child = spawn(command, args, { shell: false, stdio: ["pipe", "pipe", "pipe"] });
      let buf = "";
      let settled = false;
      const timeout = setTimeout(() => finish({ ok: false, error: "stdio MCP timeout", latencyMs: Date.now() - t0 }), options.timeoutMs ?? 60_000);
      const finish = (result: InvokeResult, kill = true) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (kill) child.kill();
        resolve(result);
      };
      const fail = (error: string) => finish({ ok: false, error, latencyMs: Date.now() - t0 });
      const send = (obj: unknown) => {
        if (settled) return;
        try {
          if (child.stdin.destroyed) return fail("stdio MCP stdin is closed");
          child.stdin.write(`${JSON.stringify(obj)}\n`);
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
        }
      };
      child.stderr.on("data", () => {
        /* 服务端日志忽略 */
      });
      child.on("error", (e) => fail(e.message));
      child.on("close", (code) => {
        if (!settled) fail(`stdio MCP exited before response (code ${code ?? "unknown"})`);
      });
      child.stdout.on("data", (d) => {
        buf += String(d);
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          let msg: { id?: number; result?: unknown; error?: { message?: string } };
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.id === 1 && msg.error) {
            fail(msg.error.message ?? "MCP initialize failed");
          } else if (msg.id === 1) {
            send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: action, arguments: inputs } });
          } else if (msg.id === 2) {
            if (msg.error) finish({ ok: false, error: msg.error.message ?? "tool call failed", latencyMs: Date.now() - t0 });
            else finish({ ok: true, output: msg.result, latencyMs: Date.now() - t0, mode: "executed" });
          }
        }
      });
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pi-scenario", version: "0.1.0" } },
      });
    });
  }

  private async invokeSkillContext(cap: Capability, t0: number): Promise<InvokeResult> {
    // 技能上下文注入：定位 SKILL.md（产物目录或临时克隆）→ 内容块
    const vendorDir = path.join(tmpdir(), "scenario-skill-context");
    await mkdir(vendorDir, { recursive: true });
    try {
      const { downloadSkillMd } = await import("@/federation/adapters/skill-sources.js");
      const repo = cap.repoUrl?.replace("https://github.com/", "");
      if (repo) {
        const slug = cap.id.split("/").pop() ?? cap.name;
        const dl = await downloadSkillMd(repo, [`skills/${slug}/SKILL.md`, `${slug}/SKILL.md`, "SKILL.md"], vendorDir);
        const md = await readFile(dl.skillMdPath, "utf8");
        await rm(vendorDir, { recursive: true, force: true });
        return {
          ok: true,
          output: { mode: "context-injection", capability: cap.id, content: md.slice(0, 8000) },
          latencyMs: Date.now() - t0,
          mode: "context",
        };
      }
    } catch {
      /* 下载失败 → 降级为元数据注入 */
    }
    return {
      ok: true,
      output: { mode: "context-injection", capability: cap.id, content: cap.description },
      latencyMs: Date.now() - t0,
      mode: "context",
      degraded: true,
    };
  }
}

/** 便捷：执行蒸馏产物目录（供 1.5.3 vendoring 复用） */
export async function vendorSkillTo(scenarioProductsDir: string, skillMdPath: string, meta: { skillId: string; sourceUrl: string }): Promise<void> {
  const temp = await mkdtemp(path.join(tmpdir(), "vendorskill-"));
  try {
    await writeFile(path.join(temp, "SKILL.md"), await readFile(skillMdPath, "utf8"), "utf8");
    await digestAndVendor(temp, scenarioProductsDir, meta);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
