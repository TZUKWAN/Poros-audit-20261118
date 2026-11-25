import http from "node:http";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { Duplex } from "node:stream";
import { localSocket } from "./docker-control.js";

export async function dockerJson(
  socketPath: string,
  method: string,
  resource: string,
  body?: unknown,
  signal?: AbortSignal,
  timeoutMs = 15000,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        socketPath,
        agent: false,
        path: "/v1.47" + resource,
        method,
        signal,
        headers: payload
          ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
          : { "content-length": "0" },
      },
      (res) => {
        let content = "",
          bytes = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 2 * 1024 * 1024) req.destroy(new Error("Docker response exceeds limit"));
          else content += chunk.toString("utf8");
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode || 500, data: content ? JSON.parse(content) : null });
          } catch {
            reject(new Error("Invalid Docker response"));
          }
        });
      },
    );
    req.setTimeout(timeoutMs, () =>
      req.destroy(
        new Error("Docker Engine " + method + " " + resource.split("?")[0] + " timed out"),
      ),
    );
    req.on("error", reject);
    req.end(payload);
  });
}
/** Trusted host transport for an already sandboxed container; project code never receives this socket. */
export class LocalContainer extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  exitCode: number | null = null;
  private ended = false;
  private readonly controller = new AbortController();
  private constructor(
    private readonly socketPath: string,
    readonly id: string,
    private readonly socket: Duplex,
    private readonly signal?: AbortSignal,
  ) {
    super();
    this.stdin = new Writable({
      write: (chunk, encoding, done) => {
        socket.write(chunk, encoding, done);
      },
      final: (done) => {
        socket.end();
        done();
      },
    });
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 8) {
        const size = pending.readUInt32BE(4);
        if (size > 4 * 1024 * 1024) {
          this.emit("error", new Error("Docker stream exceeds limit"));
          this.kill();
          return;
        }
        if (pending.length < size + 8) return;
        const stream = pending[0];
        const payload = pending.subarray(8, 8 + size);
        (stream === 2 ? this.stderr : this.stdout).write(payload);
        pending = pending.subarray(8 + size);
      }
    });
    socket.on("error", (error) => {
      if (!this.ended) this.emit("error", error);
    });
    socket.on("close", () => {
      this.stdout.end();
      this.stderr.end();
    });
  }
  static async create(
    config: Record<string, unknown>,
    name: string,
    signal?: AbortSignal,
  ): Promise<LocalContainer | null> {
    const socketPath = await localSocket();
    if (!socketPath) return null;
    signal?.throwIfAborted();
    const created = await dockerJson(
      socketPath,
      "POST",
      "/containers/create?name=" + encodeURIComponent(name),
      config,
      signal,
    );
    if (created.status !== 201)
      throw new Error(
        "Docker container creation failed: " + JSON.stringify(created.data).slice(0, 400),
      );
    const id = (created.data as { Id: string }).Id;
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid Docker container ID");
    const socket = await new Promise<Duplex>((resolve, reject) => {
      const req = http.request({
        socketPath,
        agent: false,
        path: "/v1.47/containers/" + id + "/attach?stream=1&stdin=1&stdout=1&stderr=1",
        method: "POST",
        signal,
        headers: { Connection: "Upgrade", Upgrade: "tcp", "content-length": "0" },
      });
      req.on("upgrade", (_res, connection, head) => {
        req.setTimeout(0);
        connection.setTimeout(0);
        if (head.length) connection.unshift(head);
        resolve(connection);
      });
      req.on("response", (res) => {
        res.resume();
        reject(new Error("Docker attach refused (" + res.statusCode + ")"));
      });
      req.setTimeout(15000, () => req.destroy(new Error("Docker attach timed out")));
      req.on("error", reject);
      req.end();
    });
    return new LocalContainer(socketPath, id, socket, signal);
  }
  async start() {
    const signal = AbortSignal.any([this.controller.signal, ...(this.signal ? [this.signal] : [])]);
    const started = await dockerJson(
      this.socketPath,
      "POST",
      "/containers/" + this.id + "/start",
      undefined,
      signal,
    );
    if (started.status !== 204)
      throw new Error("Docker start failed: " + JSON.stringify(started.data).slice(0, 400));
    void dockerJson(
      this.socketPath,
      "POST",
      "/containers/" + this.id + "/wait?condition=not-running",
      undefined,
      signal,
      310000,
    ).then(
      (result) => {
        if (this.ended) return;
        this.exitCode = (result.data as { StatusCode?: number })?.StatusCode ?? -1;
        this.ended = true;
        this.emit("close", this.exitCode);
      },
      (error) => {
        if (!this.ended) this.emit("error", error);
      },
    );
  }
  kill() {
    this.ended = true;
    this.controller.abort();
    this.socket.destroy();
    this.stdin.destroy();
    this.stdout.destroy();
    this.stderr.destroy();
    return true;
  }
}
