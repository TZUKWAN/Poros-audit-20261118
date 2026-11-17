/** Run-scoped model transport. The provider key stays on the API host, outside Agent containers. */
import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "./env.js";
export async function createRunModelProxy(forward: typeof fetch = fetch) {
  const token = randomBytes(32).toString("base64url");
  let calls = 0;
  let upstreamCalls = 0;
  const server = http.createServer(async (req, res) => {
    const disconnected = new AbortController();
    res.once("close", () => disconnected.abort());
    const supplied = Buffer.from(req.headers.authorization ?? ""),
      expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.writeHead(401).end();
      return;
    }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(403).end();
      return;
    }
    if (++calls > 64) {
      res.writeHead(429).end();
      return;
    }
    try {
      req.setEncoding("utf8");
      let raw = "";
      for await (const c of req) {
        raw += c;
        if (Buffer.byteLength(raw) > 256000) {
          res.writeHead(413).end();
          return;
        }
      }
      const body = JSON.parse(raw) as { messages: unknown; stream?: boolean; max_tokens?: number };
      if (!Array.isArray(body.messages) || body.messages.length > 300)
        throw new Error("Invalid messages");
      upstreamCalls++;
      const reply = await forward("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${env.deepseekApiKey()}`,
        },
        signal: AbortSignal.any([disconnected.signal, AbortSignal.timeout(30000)]),
        redirect: "error",
        body: JSON.stringify({
          ...body,
          model: "deepseek-chat",
          max_tokens: Math.min(4096, Math.max(1, Number(body.max_tokens) || 4096)),
        }),
      });
      res.writeHead(reply.status, {
        "content-type": reply.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      });
      let bytes = 0;
      if (reply.body) {
        const reader = reply.body.getReader();
        for (;;) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          if (res.destroyed) {
            await reader.cancel();
            break;
          }
          bytes += chunk.length;
          if (bytes > 2 * 1024 * 1024) {
            await reader.cancel();
            throw new Error("Model response quota exceeded");
          }
          if (!res.write(chunk))
            await new Promise<void>((resolve) => {
              const resume = () => {
                res.off("drain", resume);
                res.off("close", resume);
                resolve();
              };
              res.once("drain", resume);
              res.once("close", resume);
            });
        }
      }
      res.end();
    } catch {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    }
  });
  server.requestTimeout = 35000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });
  const port = (server.address() as { port: number }).port;
  return {
    token,
    baseURL: `http://host.docker.internal:${port}/v1`,
    port,
    calls: () => calls,
    upstreamCalls: () => upstreamCalls,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
