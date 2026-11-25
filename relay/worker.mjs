import { DurableObject } from "cloudflare:workers";
import {
  MAX_BODY,
  MAX_REPLY,
  encodePacket,
  decodePacket,
  remoteAllowed,
  forwardedRequestHeaders,
  forwardedResponseHeaders,
} from "../src/remote/protocol.ts";
const fail = (status, error) =>
  Response.json({ ok: false, error }, { status, headers: { "cache-control": "no-store" } });
const hash = async (value) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
const equal = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};
export default {
  async fetch(request, env) {
    const url = new URL(request.url),
      connect = /^\/connect\/([a-f0-9]{64})$/.exec(url.pathname),
      publicRoute = /^\/c\/([a-f0-9]{64})(\/.*)$/.exec(url.pathname);
    if (url.search || request.url.length > 2000) return fail(400, "Invalid relay URL");
    if (connect) {
      if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket")
        return fail(426, "WebSocket required");
      const protocols = (request.headers.get("sec-websocket-protocol") || "")
          .split(",")
          .map((item) => item.trim()),
        secret = protocols.find((item) => item.startsWith("auth."))?.slice(5),
        key = protocols.find((item) => item.startsWith("key."))?.slice(4);
      if (
        !/^[A-Za-z0-9_-]{43}$/.test(secret || "") ||
        !/^[A-Za-z0-9_-]{43}$/.test(env.HOST_KEY || "") ||
        !equal(key, env.HOST_KEY) ||
        (await hash(secret)) !== connect[1] ||
        !protocols.includes("poros-relay-v1")
      )
        return fail(403, "Host authentication failed");
      return env.AGENTS.get(env.AGENTS.idFromName(connect[1])).fetch(request);
    }
    if (!publicRoute || !remoteAllowed(request.method, publicRoute[2]))
      return fail(404, "Remote route unavailable");
    const headers = new Headers();
    for (const name of forwardedRequestHeaders) {
      const value = request.headers.get(name);
      if (value) {
        if (value.length > 300) return fail(400, "Header too large");
        headers.set(name, value);
      }
    }
    headers.set("x-poros-path", publicRoute[2]);
    headers.set("x-poros-base", "/c/" + publicRoute[1] + "/");
    return env.AGENTS.get(env.AGENTS.idFromName(publicRoute[1])).fetch(
      new Request("https://poros.internal/proxy", {
        method: request.method,
        headers,
        body: request.method === "POST" ? request.body : undefined,
        duplex: request.method === "POST" ? "half" : undefined,
      }),
    );
  },
};
export class AgentChannel extends DurableObject {
  pending = new Map();
  constructor(ctx, env) {
    super(ctx, env);
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/connect/")) {
      for (const socket of this.ctx.getWebSockets("host")) socket.close(1012, "Host reconnected");
      for (const entry of this.pending.values())
        entry.finish(fail(503, "安装端已重新连接，请找回原任务回执"));
      const pair = new WebSocketPair(),
        [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server, ["host"]);
      server.serializeAttachment({ channel: url.pathname.slice(9) });
      return new Response(null, {
        status: 101,
        webSocket: client,
        headers: { "Sec-WebSocket-Protocol": "poros-relay-v1" },
      });
    }
    const host = this.ctx.getWebSockets("host").find((socket) => socket.readyState === 1);
    if (!host) return fail(503, "安装端不在线，本次请求未转发");
    if (this.pending.size >= 32) return fail(429, "远程通道繁忙");
    const path = request.headers.get("x-poros-path"),
      base = request.headers.get("x-poros-base");
    if (!path || !remoteAllowed(request.method, path) || !/^\/c\/[a-f0-9]{64}\/$/.test(base || ""))
      return fail(400, "Invalid relay request");
    const reader = request.body?.getReader();
    let bytes = 0;
    const chunks = [];
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > MAX_BODY) {
          await reader.cancel();
          return fail(413, "请求过大");
        }
        chunks.push(value);
      }
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.length;
    }
    const id = crypto.randomUUID(),
      headers = Object.fromEntries(
        forwardedRequestHeaders
          .map((name) => [name, request.headers.get(name)])
          .filter(([, value]) => value),
      );
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(fail(504, "远程响应超时；请找回原任务，不要重复执行"));
      }, 20000);
      const finish = (response) => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(response);
      };
      this.pending.set(id, { finish, host });
      try {
        host.send(
          encodePacket({ type: "request", id, method: request.method, path, base, headers }, body),
        );
      } catch {
        finish(fail(503, "安装端连接已断开"));
      }
    });
  }
  webSocketMessage(socket, message) {
    if (typeof message === "string") return;
    try {
      const { meta, body } = decodePacket(message),
        entry = this.pending.get(meta.id);
      if (!entry || entry.host !== socket || meta.type !== "response") return;
      if (
        !Number.isInteger(meta.status) ||
        meta.status < 200 ||
        meta.status > 599 ||
        body.length > MAX_REPLY
      )
        throw new Error("Invalid response");
      const headers = new Headers();
      for (const name of forwardedResponseHeaders) {
        const value = meta.headers[name];
        if (typeof value === "string" && value.length < 8000) headers.set(name, value);
      }
      headers.set("cache-control", "no-store");
      entry.finish(
        new Response([204, 304].includes(meta.status) ? null : body, {
          status: meta.status,
          headers,
        }),
      );
    } catch {
      socket.close(1008, "Invalid wire response");
      this.failSocket(socket);
    }
  }
  failSocket(socket) {
    for (const entry of this.pending.values())
      if (entry.host === socket) entry.finish(fail(503, "安装端连接已断开；任务状态请重连后找回"));
  }
  webSocketClose(socket, code, reason) {
    this.failSocket(socket);
    if (code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code))
      socket.close(code, reason);
    else socket.close();
  }
  webSocketError(socket) {
    this.failSocket(socket);
    socket.close();
  }
}
