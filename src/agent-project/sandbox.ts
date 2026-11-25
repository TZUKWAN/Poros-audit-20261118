import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { LocalContainer } from "../server/docker-session.js";
import { deploymentScope, dockerExecutable, removeOwnedResource } from "../server/dsh-runtime.js";

export type SandboxCall = (method: string, args: unknown[]) => Promise<unknown>;
export interface SandboxOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  call?: SandboxCall;
  event?: (type: string, data: unknown) => void | Promise<void>;
  /** Trusted host options; never accepted from project source or a public job body. */
  image?: string;
  environment?: string[];
  outputLimitBytes?: number;
  scope?: string;
}
// Only trusted bootstrap code is placed in argv. Project code travels as JSON over stdin.
const bootstrap = String.raw`
const fs = require("node:fs"), readline = require("node:readline");
const lines = readline.createInterface({input:process.stdin, crlfDelay:Infinity});
const write = process.stdout.write.bind(process.stdout), terminate = process.exit.bind(process);
const send = data => write(JSON.stringify(data)+"\n");
const pending = new Map(); let initial = false, sequence = 0;
lines.on("close",()=>terminate(0));
const finish = (packet,code) => write(JSON.stringify(packet)+"\n",()=>terminate(code));
const context = {};
for (const method of ["model","tool","skill","asset","script","http"]) context[method] = (...args) => new Promise((resolve,reject) => {
  const id = String(++sequence); pending.set(id,{resolve,reject}); send({type:"call",id,method,args});
});
context.emit = (kind,data) => send({type:"event",kind,data});
const transport = {start:async()=>{},send:async message=>send({type:"mcp",message}),close:async()=>{transport.onclose?.();}};
globalThis.__porosContext = context; globalThis.__porosMcpTransport = transport;
lines.on("line", line => {
  let packet; try { packet=JSON.parse(line); } catch { return; }
  if (packet.type === "shutdown") { finish({type:"closed"},0); return; }
  if (initial) {
    if (packet.type === "reply") { const item=pending.get(packet.id); if(!item)return;pending.delete(packet.id);packet.error?item.reject(new Error(packet.error)):item.resolve(packet.result); }
    else if (packet.type === "mcp") transport.onmessage?.(packet.message);
    return;
  }
  initial = true;
  setTimeout(()=>terminate(124),Math.min(300000,Math.max(500,packet.timeoutMs||90000)));
  (async()=>{
    fs.writeFileSync("/tmp/poros-entry.cjs",packet.code,{mode:0o600});
    const implementation = require("/tmp/poros-entry.cjs");
    if(packet.mode==="mcp"){await implementation.ready;send({type:"ready"});}
    else {send({type:"ready"});const output=await implementation.default(packet.input,context);if(pending.size)throw new Error("Agent 存在未await的能力调用");finish({type:"result",result:output??null},0);}
  })().catch(error=>{finish({type:"failure",error:String(error?.message||error).slice(0,2000)},1);});
});
`;

class Sandbox {
  private child?: ChildProcessWithoutNullStreams | LocalContainer;
  private readonly id = randomUUID();
  private readonly token = randomUUID();
  private readonly controller = new AbortController();
  private readonly scope: string;
  private readonly name =
    "poros-ide-" + createHash("sha256").update(this.id).digest("hex").slice(0, 24);
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private resultResolve!: (value: unknown) => void;
  private resultReject!: (error: Error) => void;
  private ready = new Promise<void>((resolve, reject) => {
    this.readyResolve = resolve;
    this.readyReject = reject;
  });
  readonly result = new Promise<unknown>((resolve, reject) => {
    this.resultResolve = resolve;
    this.resultReject = reject;
  });
  private timer?: ReturnType<typeof setTimeout>;
  private calls = 0;
  private closed = false;
  private failed = false;
  private cancellationRequested = false;
  private returned = false;
  private exitResolve!: () => void;
  private exited = new Promise<void>((resolve) => {
    this.exitResolve = resolve;
  });
  onmessage?: Transport["onmessage"];
  onclose?: () => void;
  get cancelled() {
    return this.cancellationRequested;
  }
  private readonly abort = () => {
    this.cancellationRequested = true;
    this.fail(new Error("运行已取消或超时"));
  };
  constructor(
    private readonly code: string,
    private readonly options: SandboxOptions,
    private readonly mode: "program" | "mcp",
    private readonly input?: unknown,
  ) {
    this.scope = options.scope || deploymentScope();
    // MCP consumers use the ready promise; program consumers use both. Avoid unhandled rejections.
    void this.result.catch(() => {});
    void this.ready.catch(() => {});
  }
  private emit(type: string, data: unknown) {
    try {
      void Promise.resolve(this.options.event?.(type, data)).catch((error) =>
        this.fail(error instanceof Error ? error : new Error("运行事件保存失败")),
      );
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error("运行事件处理失败"));
    }
  }
  async start() {
    this.options.signal?.throwIfAborted();
    this.timer = setTimeout(this.abort, this.options.timeoutMs ?? 90000);
    this.options.signal?.addEventListener("abort", this.abort, { once: true });
    const image = this.options.image || process.env.POROS_DSH_IMAGE || "poros/dsh:0.2.2-rc.1-audit";
    this.emit("sandbox.start", {
      image,
      network: "none",
      sourceBytes: Buffer.byteLength(this.code),
    });
    this.child =
      (await LocalContainer.create(
        {
          Image: image,
          Env: this.options.environment || [],
          User: "10001:10001",
          OpenStdin: true,
          StdinOnce: true,
          AttachStdin: true,
          AttachStdout: true,
          AttachStderr: true,
          Labels: {
            "org.poros.owner": "ide",
            "org.poros.deployment": this.scope,
            "org.poros.run": this.id,
            "org.poros.token": this.token,
          },
          Entrypoint: ["/usr/bin/timeout"],
          Cmd: [
            "--signal=KILL",
            "--kill-after=2",
            String(Math.ceil(Math.min(300000, this.options.timeoutMs ?? 90000) / 1000) + 5),
            "node",
            "--max-old-space-size=256",
            "-e",
            bootstrap,
          ],
          HostConfig: {
            Init: true,
            ReadonlyRootfs: true,
            CapDrop: ["ALL"],
            SecurityOpt: ["no-new-privileges:true"],
            NetworkMode: "none",
            PidsLimit: 64,
            Memory: 512 * 1024 * 1024,
            NanoCpus: 1000000000,
            Ulimits: [{ Name: "cpu", Soft: 120, Hard: 125 }],
            Tmpfs: { "/tmp": "rw,noexec,nosuid,size=67108864,mode=1777" },
          },
        },
        this.name,
        this.controller.signal,
      )) ||
      spawn(
        dockerExecutable(),
        [
          "run",
          "--rm",
          "--name",
          this.name,
          "--label",
          "org.poros.owner=ide",
          "--label",
          `org.poros.deployment=${this.scope}`,
          "--label",
          `org.poros.run=${this.id}`,
          "--label",
          `org.poros.token=${this.token}`,
          "--interactive",
          "--init",
          "--user",
          "10001:10001",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges:true",
          "--network",
          "none",
          "--pids-limit",
          "64",
          "--memory",
          "512m",
          "--cpus",
          "1",
          "--ulimit",
          "cpu=120:125",
          "--tmpfs",
          "/tmp:rw,noexec,nosuid,size=67108864,mode=1777",
          ...(this.options.environment || []).flatMap((value) => ["--env", value]),
          "--entrypoint",
          "/usr/bin/timeout",
          image,
          "--signal=KILL",
          "--kill-after=2",
          String(Math.ceil(Math.min(300000, this.options.timeoutMs ?? 90000) / 1000) + 5),
          "node",
          "--max-old-space-size=256",
          "-e",
          bootstrap,
        ],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      );
    const decoder = new StringDecoder("utf8");
    let pending = "",
      bytes = 0,
      errors = "";
    this.child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (this.options.outputLimitBytes || 4 * 1024 * 1024))
        return this.fail(new Error("隔离运行输出超过限制"));
      pending += decoder.write(chunk);
      if (pending.length > (this.options.outputLimitBytes || 2 * 1024 * 1024))
        return this.fail(new Error("运行消息超过限制"));
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        let packet: unknown;
        try {
          packet = JSON.parse(line);
        } catch {
          this.emit("program.log", { text: line.slice(0, 1000) });
          continue;
        }
        try {
          this.dispatch(packet);
        } catch (error) {
          this.fail(error instanceof Error ? error : new Error("运行事件处理失败"));
          return;
        }
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      errors = (errors + chunk.toString()).slice(-3000);
    });
    this.child.stdin.on("error", (error) => {
      if (!this.closed) this.fail(error);
    });
    this.child.on("error", (error) => this.fail(error));
    this.child.on("close", (code) => {
      this.exitResolve();
      if (!this.closed && !this.returned) this.fail(new Error(`隔离进程结束(${code}) ${errors}`));
    });
    if (this.child instanceof LocalContainer) await this.child.start();
    await this.write({
      code: this.code,
      mode: this.mode,
      input: this.input,
      timeoutMs: this.options.timeoutMs ?? 90000,
    });
    await this.ready;
  }
  private dispatch(raw: unknown) {
    if (this.failed) return;
    if (!raw || typeof raw !== "object") return;
    const packet = raw as Record<string, unknown>;
    if (packet.type === "ready") this.readyResolve();
    else if (packet.type === "result") {
      this.returned = true;
      this.resultResolve(packet.result);
    } else if (packet.type === "failure") this.fail(new Error(String(packet.error)));
    else if (packet.type === "mcp") this.onmessage?.(JSONRPCMessageSchema.parse(packet.message));
    else if (packet.type === "event")
      this.emit("program.event", { kind: String(packet.kind).slice(0, 80), data: packet.data });
    else if (packet.type === "call") {
      if (
        typeof packet.id !== "string" ||
        !/^[0-9]{1,4}$/.test(packet.id) ||
        !Array.isArray(packet.args)
      )
        return;
      if (++this.calls > 40) return this.fail(new Error("本次运行调用次数超过限制"));
      const id = packet.id;
      Promise.resolve()
        .then(() => {
          if (
            !this.options.call ||
            !["model", "tool", "skill", "asset", "script", "http"].includes(String(packet.method))
          )
            throw new Error("此运行没有授予该能力");
          return this.options.call(String(packet.method), packet.args as unknown[]);
        })
        .then(
          (result) => this.write({ type: "reply", id, result: result ?? null }),
          (error) =>
            this.write({
              type: "reply",
              id,
              error: error instanceof Error ? error.message : "调用失败",
            }),
        )
        .catch((error) => this.fail(error));
    }
  }
  private fail(error: Error) {
    if (this.failed) return;
    this.failed = true;
    this.controller.abort();
    this.readyReject(error);
    this.resultReject(error);
    this.onclose?.();
  }
  async write(packet: unknown) {
    if (!this.child || this.child.stdin.destroyed || this.closed)
      throw new Error("隔离运行连接已关闭");
    const message = JSON.stringify(packet) + "\n";
    await new Promise<void>((resolve, reject) =>
      this.child!.stdin.write(message, (error) => (error ? reject(error) : resolve())),
    );
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.options.signal?.removeEventListener("abort", this.abort);
    if (!this.child) {
      await removeOwnedResource("container", this.name, this.id, this.token, this.scope, "ide");
      return;
    }
    this.child.stdin.end(JSON.stringify({ type: "shutdown" }) + "\n");
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    const exited = this.controller.signal.aborted
      ? false
      : await Promise.race([
          this.exited.then(() => true),
          new Promise<boolean>((resolve) => {
            exitTimer = setTimeout(() => resolve(false), 5000);
          }),
        ]);
    if (exitTimer) clearTimeout(exitTimer);
    this.emit("sandbox.cleanup", {
      exited,
      returned: this.returned,
      exitCode: this.child.exitCode,
    });
    // docker run --rm removes normally exited containers. Only abnormal processes need broker cleanup.
    try {
      if (
        this.child instanceof LocalContainer ||
        !exited ||
        (!this.returned && this.mode === "program" && this.child.exitCode !== 0)
      )
        await removeOwnedResource(
          "container",
          this.name,
          this.id,
          this.token,
          this.scope,
          "ide",
        ).catch((error) => {
          throw new Error(
            "隔离进程清理失败：" + (error instanceof Error ? error.message : "Docker不可用"),
          );
        });
    } finally {
      this.controller.abort();
      this.child.kill();
      this.child.stdin.destroy();
      this.child.stdout.destroy();
      this.child.stderr.destroy();
      this.emit("sandbox.end", {});
    }
  }
}

export async function runProgram(
  code: string,
  input: unknown,
  options: SandboxOptions = {},
): Promise<unknown> {
  const session = new Sandbox(code, options, "program", input);
  try {
    await session.start();
    return await session.result;
  } catch (error) {
    if (session.cancelled) throw new Error("运行已取消或超时");
    throw error;
  } finally {
    await session.close();
  }
}

export async function withMcp<T>(
  code: string,
  options: SandboxOptions,
  use: (client: Client) => Promise<T>,
): Promise<T> {
  const session = new Sandbox(code, options, "mcp");
  const transport: Transport = {
    start: async () => {
      session.onmessage = (message) => transport.onmessage?.(message);
      session.onclose = () => transport.onclose?.();
      await session.start();
    },
    send: async (message: JSONRPCMessage) => session.write({ type: "mcp", message }),
    close: async () => {
      try {
        await session.close();
      } finally {
        transport.onclose?.();
      }
    },
  };
  const client = new Client({ name: "Poros-IDE", version: "1.0.0" });
  try {
    await client.connect(transport);
    return await use(client);
  } finally {
    await client.close();
    await session.close();
  }
}
