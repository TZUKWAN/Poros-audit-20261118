import http from "node:http";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { FastifyInstance, HTTPMethods } from "fastify";
import { z } from "zod";
import { sealConnectionSecret, connectionSecret } from "../server/integration-connections.js";
import { runtimeRow } from "../runtime/runner.js";
import type { RuntimeStore, RuntimeCredential } from "../runtime/store.js";
import { trustedDownload } from "../runtime/trusted-download.js";
import {
  MAX_BODY,
  MAX_REPLY,
  decodePacket,
  encodePacket,
  remoteAllowed,
  forwardedRequestHeaders,
  forwardedResponseHeaders,
  type RemotePacket,
} from "./protocol.js";
export type RemoteStatus = {
  mode: "OFF" | "QUICK" | "WORKER";
  state: "OFF" | "STARTING" | "ONLINE" | "RECONNECTING" | "FAILED";
  url?: string;
  endpoint?: string;
  message?: string;
  limits: string;
};
async function stopTunnel(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("临时通道进程未能正常停止")), 5000);
    timer.unref();
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });
}
const secretText = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const input = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("OFF") }).strict(),
  z.object({ mode: z.literal("QUICK") }).strict(),
  z
    .object({
      mode: z.literal("WORKER"),
      endpoint: z.string().url().max(500),
      relayKey: secretText.optional(),
    })
    .strict(),
]);
const limits =
  "使用者自己的免费账号额度；Worker 100,000 请求/日、10 ms CPU，SQLite DO 也有独立免费限额。不会自动升级付费。";
const relayEndpoint = (value: string) => {
  const url = new URL(value),
    local =
      process.env.POROS_RELAY_ALLOW_LOCAL === "1" && ["127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/"].includes(url.pathname)
  )
    throw new Error("请填写中继 HTTPS 根地址，不能包含密钥或路径");
  return url.origin;
};
export class RemoteManager {
  private current: RemoteStatus = { mode: "OFF", state: "OFF", limits };
  private socket?: WebSocket;
  private tunnel?: ChildProcess;
  private bridge?: http.Server;
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private retry = 1000;
  private inflight = 0;
  private setup?: Promise<void>;
  private setupAbort?: AbortController;
  private serial: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly app: FastifyInstance,
    private readonly store: RuntimeStore,
  ) {}
  status() {
    return { ...this.current };
  }
  private async forward(packet: RemotePacket, body: Uint8Array) {
    if (
      !packet.method ||
      !packet.path ||
      !remoteAllowed(packet.method, packet.path) ||
      body.length > MAX_BODY ||
      (packet.base && !/^\/c\/[a-f0-9]{64}\/$/.test(packet.base))
    )
      throw new Error("远程请求被拒绝");
    if (this.inflight >= 16) throw new Error("远程请求繁忙");
    this.inflight++;
    try {
      const headers: Record<string, string> = { "x-poros-remote": "1" };
      if (packet.base) headers["x-poros-base"] = packet.base;
      for (const name of forwardedRequestHeaders) {
        const value = packet.headers[name];
        if (typeof value === "string" && value.length <= 300) headers[name] = value;
      }
      const response = await this.app.inject({
        method: packet.method as HTTPMethods,
        url: packet.path,
        headers,
        payload: body.length ? Buffer.from(body) : undefined,
      });
      if (response.rawPayload.length > MAX_REPLY) throw new Error("远程响应超过 2 MB");
      const safe: Record<string, string> = {};
      for (const name of forwardedResponseHeaders) {
        const value = response.headers[name];
        if (typeof value === "string" && value.length < 8000) safe[name] = value;
      }
      return {
        meta: {
          type: "response" as const,
          id: packet.id,
          status: response.statusCode,
          headers: safe,
        },
        body: new Uint8Array(response.rawPayload),
      };
    } finally {
      this.inflight--;
    }
  }
  private connection() {
    return this.store.snapshot().credentials.find((item) => item.provider === "remote:relay");
  }
  async resume() {
    const row = this.connection();
    if (row?.settings.enabled)
      await this.configure(
        row.settings.mode === "QUICK"
          ? { mode: "QUICK" }
          : { mode: "WORKER", endpoint: row.settings.endpoint },
      );
  }
  configure(raw: unknown): Promise<RemoteStatus> {
    const body = input.parse(raw);
    const operation = this.serial
      .then(async () => {
        await this.stopTransport();
        const generation = this.generation;
        const previous = this.connection(),
          old = previous ? connectionSecret(runtimeRow(previous), this.store.key) : null;
        const identity = {
          provider: "remote:relay",
          organizationId: this.store.package().payload.appId,
          userId: "installation",
          revision: randomUUID(),
        };
        const endpoint = body.mode === "WORKER" ? relayEndpoint(body.endpoint) : undefined;
        const hostSecret = old?.apiKey || randomBytes(32).toString("base64url"),
          relayKey =
            body.mode === "WORKER"
              ? body.relayKey ||
                (previous?.settings.endpoint === endpoint ? old?.clientId : undefined)
              : old?.clientId;
        if (body.mode === "WORKER" && !relayKey) throw new Error("首次连接需要中继管理密钥");
        const row: RuntimeCredential = {
          ...identity,
          encryptedKey: sealConnectionSecret(
            identity,
            { apiKey: hostSecret, clientId: relayKey },
            this.store.key,
          ),
          settings: { mode: body.mode, endpoint, enabled: body.mode !== "OFF" },
          testedAt: null,
          testCode: null,
          updatedAt: new Date().toISOString(),
        };
        await this.store.change((next) => {
          next.credentials = [
            ...next.credentials.filter((item) => item.provider !== identity.provider),
            row,
          ];
        });
        this.current = {
          mode: body.mode,
          state: body.mode === "OFF" ? "OFF" : "STARTING",
          endpoint,
          limits:
            body.mode === "QUICK"
              ? "临时免费地址；重启会变，不保证可用性；最多 200 个在途请求，不支持 SSE。"
              : limits,
        };
        if (body.mode === "WORKER")
          this.connectWorker(endpoint!, hostSecret, relayKey!, generation);
        if (body.mode === "QUICK") {
          this.setupAbort = new AbortController();
          this.setup = this.startQuick(generation, this.setupAbort.signal).catch((error) => {
            if (generation === this.generation)
              this.current = {
                ...this.current,
                state: "FAILED",
                message: error instanceof Error ? error.message : "临时通道启动失败",
              };
          });
        }
        return this.status();
      })
      .catch((error) => {
        this.current = {
          ...this.current,
          state: "FAILED",
          message: error instanceof Error ? error.message : "远程启动失败",
        };
        throw error;
      });
    this.serial = operation.catch(() => {});
    return operation;
  }
  private connectWorker(endpoint: string, secret: string, key: string, generation: number) {
    if (generation !== this.generation) return;
    const channel = createHash("sha256").update(secret).digest("hex"); // Sync host-side SHA256 is supplied below; no secret appears in a URL.
    const url = endpoint.replace(/^http/, "ws") + "/connect/" + channel;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url, ["poros-relay-v1", "auth." + secret, "key." + key]);
    } catch {
      this.reconnect(endpoint, secret, key, generation);
      return;
    }
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.onopen = () => {
      if (generation !== this.generation) {
        socket.close();
        return;
      }
      this.retry = 1000;
      this.current = {
        ...this.current,
        state: "ONLINE",
        url: endpoint + "/c/" + channel + "/",
        message: undefined,
      };
    };
    socket.onmessage = (event) => {
      if (generation !== this.generation || !(event.data instanceof ArrayBuffer)) return;
      void (async () => {
        const { meta, body } = decodePacket(event.data);
        if (meta.type !== "request") throw new Error("无效消息类型");
        let response;
        try {
          response = await this.forward(meta, body);
        } catch {
          response = {
            meta: {
              type: "response" as const,
              id: meta.id,
              status: 502,
              headers: { "content-type": "application/json" },
            },
            body: new TextEncoder().encode(
              JSON.stringify({ ok: false, error: "远程转发失败；请查看原任务回执" }),
            ),
          };
        }
        if (socket.readyState === WebSocket.OPEN && generation === this.generation)
          socket.send(encodePacket(response.meta, response.body));
      })().catch(() => {
        socket.close(1008, "Invalid remote request");
      });
    };
    socket.onerror = () => {
      this.current = {
        ...this.current,
        state: "RECONNECTING",
        message: "中继连接失败，正在重连；原任务不会自动重放",
      };
    };
    socket.onclose = () => this.reconnect(endpoint, secret, key, generation);
  }
  private reconnect(endpoint: string, secret: string, key: string, generation: number) {
    if (generation !== this.generation) return;
    this.current = {
      ...this.current,
      state: "RECONNECTING",
      message: "通道已断开，正在重连；原任务不会自动重放",
    };
    this.timer = setTimeout(
      () => this.connectWorker(endpoint, secret, key, generation),
      this.retry,
    );
    this.timer.unref();
    this.retry = Math.min(this.retry * 2, 30000);
  }
  private async startQuick(generation: number, signal: AbortSignal) {
    if (process.platform !== "win32" || process.arch !== "x64")
      throw new Error("免账号通道当前自动支持 Windows x64；其他系统可使用自建 Worker 中继");
    const binary = path.join(
      this.store.directory,
      "remote-components",
      "cloudflared-2026.11.2.exe",
    );
    await trustedDownload(
      "https://github.com/cloudflare/cloudflared/releases/download/2026.11.2/cloudflared-windows-amd64.exe",
      binary,
      "555b46c85582461d189cac30d14ad05480d612613801be9f110b8ce08c5b2113",
      signal,
    );
    if (generation !== this.generation) return;
    const server = http.createServer((request, reply) => {
      void (async () => {
        const raw = request.url || "/";
        if (!remoteAllowed(request.method || "GET", raw)) {
          reply.writeHead(404);
          reply.end();
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > MAX_BODY) {
            reply.writeHead(413);
            reply.end();
            request.destroy();
            return;
          }
          chunks.push(chunk);
        }
        const headers: Record<string, string> = {};
        for (const name of forwardedRequestHeaders) {
          const value = request.headers[name];
          if (typeof value === "string" && value.length <= 300) headers[name] = value;
        }
        const response = await this.forward(
          { type: "request", id: randomUUID(), method: request.method, path: raw, headers },
          Buffer.concat(chunks),
        );
        reply.writeHead(response.meta.status!, response.meta.headers);
        reply.end(response.body);
      })().catch(() => {
        if (!reply.headersSent) reply.writeHead(502);
        reply.end();
      });
    });
    this.bridge = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("远程入口启动失败");
    signal.throwIfAborted();
    if (generation !== this.generation) {
      server.close();
      return;
    }
    const configuration = path.join(this.store.directory, "remote-components", "quick-empty.yml");
    await writeFile(configuration, "{}\n", { mode: 0o600 });
    const environment = { ...process.env };
    for (const name of Object.keys(environment))
      if (/^TUNNEL_|^CF_|^CLOUDFLARE_|^POROS_|^JWT_SECRET$|^S3_|^MODEL_/.test(name))
        delete environment[name];
    const child = spawn(
      binary,
      [
        "--no-autoupdate",
        "tunnel",
        "--config",
        configuration,
        "--url",
        "http://127.0.0.1:" + address.port,
        "--protocol",
        "http2",
      ],
      { windowsHide: true, env: environment, stdio: ["ignore", "pipe", "pipe"] },
    );
    this.tunnel = child;
    await new Promise<void>((resolve, reject) => {
      let log = "",
        publicUrl: string | undefined,
        registered = false;
      const abort = () => reject(new Error("临时通道准备已取消"));
      signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              "临时免费通道未建立：" + log.split("\n").filter(Boolean).at(-1)?.slice(0, 350),
            ),
          ),
        45000,
      );
      timer.unref();
      const read = (data: Buffer) => {
        log = (log + data.toString()).slice(-6000);
        publicUrl ||= /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(log)?.[0];
        registered ||= log.includes("Registered tunnel connection");
        if (publicUrl && registered && generation === this.generation) {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          this.current = {
            ...this.current,
            state: "ONLINE",
            url: publicUrl + "/",
            message: "临时免费地址，停止或重启后失效",
          };
          resolve();
        }
      };
      child.stdout?.on("data", read);
      child.stderr?.on("data", read);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (generation === this.generation) {
          this.current = {
            ...this.current,
            state: "FAILED",
            message: "临时通道已关闭 (" + code + ")",
          };
          reject(new Error("临时通道进程已退出"));
        }
      });
    }).catch(async (error) => {
      await stopTunnel(child);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (this.tunnel === child) this.tunnel = undefined;
      if (this.bridge === server) this.bridge = undefined;
      throw error;
    });
  }
  private async stopTransport() {
    this.generation++;
    this.setupAbort?.abort();
    await this.setup;
    this.setup = undefined;
    this.setupAbort = undefined;
    clearTimeout(this.timer);
    this.socket?.close(1000, "Remote disabled");
    this.socket = undefined;
    await stopTunnel(this.tunnel);
    this.tunnel = undefined;
    if (this.bridge) {
      this.bridge.closeAllConnections();
      await new Promise<void>((resolve) => this.bridge!.close(() => resolve()));
      this.bridge = undefined;
    }
  }
  async close() {
    await this.serial;
    await this.stopTransport();
  }
}
