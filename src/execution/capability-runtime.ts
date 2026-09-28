import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { z } from "zod";
import { ScenarioError, ScenarioErrorCode } from "@/core/errors.js";
import type { Capability } from "@/federation/types.js";
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
  run(command: string, args: string[], options?: { cwd?: string; timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }>;
}

export function processCommandRunner(): CommandRunner {
  return {
    run(command, args, options = {}) {
      return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd: options.cwd, shell: false });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
          child.kill();
          reject(new ScenarioError({ code: ScenarioErrorCode.TIMEOUT, message: `${command} timed out`, phase: "executing" }));
        }, options.timeoutMs ?? 120_000);
        child.stdout.on("data", (d) => (stdout += String(d)));
        child.stderr.on("data", (d) => (stderr += String(d)));
        child.on("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ code: code ?? -1, stdout, stderr });
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
        // npx 即取即用：预拉取校验包存在（--no-install 风格 dry check）
        const r = await this.deps.runner.run("npx", ["--yes", cap.install.package, "--version"], { timeoutMs: 90_000 });
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

export interface InvokeOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface InvokeResult {
  ok: boolean;
  output?: unknown;
  error?: string;
  latencyMs: number;
}

export class CapabilityInvoker {
  constructor(
    private permission?: PermissionGate,
    private fetchImpl: typeof fetch = fetch,
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
        return await this.runStdioJsonRpc(["--yes", cap.install.package], action, inputs, options, t0, "npx");
      }
      // git/cli：无独立进程运行态 → 返回装配上下文（pi 运行时内由 LLM 以工具方式调用）
      return {
        ok: true,
        output: {
          mode: "context-handoff",
          capability: cap.id,
          action,
          inputs,
          note: "git/cli capability: 执行委托给宿主 agent 运行时（附 README 装配说明）",
        },
        latencyMs: Date.now() - t0,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - t0,
      };
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
    const resp = await this.fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: action, arguments: inputs } }),
      signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
    const text = await resp.text();
    // SSE 形态：data: {...} 行；JSON 形态：直接解析
    const payload = text.startsWith("event:") || text.startsWith("data:") ? text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() ?? "{}" : text;
    const parsed = JsonRpcResponseSchema.safeParse(JSON.parse(payload));
    if (!parsed.success) {
      return { ok: false, error: `malformed JSON-RPC response from ${endpoint}`, latencyMs: Date.now() - t0 };
    }
    if (parsed.data.error) {
      return { ok: false, error: `${parsed.data.error.code}: ${parsed.data.error.message}`, latencyMs: Date.now() - t0 };
    }
    return { ok: true, output: parsed.data.result, latencyMs: Date.now() - t0 };
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
      const timeout = setTimeout(() => {
        child.kill();
        resolve({ ok: false, error: "stdio MCP timeout", latencyMs: Date.now() - t0 });
      }, options.timeoutMs ?? 60_000);
      const send = (obj: unknown) => child.stdin.write(`${JSON.stringify(obj)}\n`);
      const fail = (error: string) => {
        clearTimeout(timeout);
        child.kill();
        resolve({ ok: false, error, latencyMs: Date.now() - t0 });
      };
      child.stderr.on("data", () => {
        /* 服务端日志忽略 */
      });
      child.on("error", (e) => fail(e.message));
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
          if (msg.id === 1) {
            send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: action, arguments: inputs } });
          } else if (msg.id === 2) {
            clearTimeout(timeout);
            child.kill();
            if (msg.error) resolve({ ok: false, error: msg.error.message ?? "tool call failed", latencyMs: Date.now() - t0 });
            else resolve({ ok: true, output: msg.result, latencyMs: Date.now() - t0 });
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
        };
      }
    } catch {
      /* 下载失败 → 降级为元数据注入 */
    }
    return {
      ok: true,
      output: { mode: "context-injection", capability: cap.id, content: cap.description },
      latencyMs: Date.now() - t0,
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
