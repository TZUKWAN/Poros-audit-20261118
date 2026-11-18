/** Run-scoped model transport. The provider key stays on the API host, outside Agent containers. */
import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "./env.js";
import type { ModelConnection } from "./integration-connections.js";
import { checkProviderResponse, ProviderError, requestModel } from "./provider-http.js";
import { describeProviderError } from "./provider-errors.js";
export async function createRunModelProxy(
  forward: typeof fetch = fetch,
  configured?: ModelConnection,
) {
  const token = randomBytes(32).toString("base64url");
  let calls = 0;
  let upstreamCalls = 0;
  let lastFailure: ReturnType<typeof describeProviderError> | undefined;
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
      const body = JSON.parse(raw) as {
        messages: unknown;
        stream?: boolean;
        max_tokens?: number;
        max_completion_tokens?: number;
        n?: number;
      };
      if (!Array.isArray(body.messages) || body.messages.length > 300)
        throw new Error("Invalid messages");
      upstreamCalls++;
      const target = configured ?? {
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-chat",
        apiKey: env.deepseekApiKey(),
      };
      const init = {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + target.apiKey,
        },
        signal: AbortSignal.any([disconnected.signal, AbortSignal.timeout(30000)]),
        body: JSON.stringify({
          ...body,
          model: target.model,
          ...(body.max_completion_tokens === undefined
            ? { max_tokens: Math.min(4096, Math.max(1, Number(body.max_tokens) || 4096)) }
            : {
                max_tokens: undefined,
                max_completion_tokens: Math.min(
                  4096,
                  Math.max(1, Number(body.max_completion_tokens) || 4096),
                ),
              }),
          ...(body.n !== undefined ? { n: 1 } : {}),
        }),
      } as const;
      const reply = configured
        ? await requestModel(target.baseUrl, "/chat/completions", init)
        : await forward(target.baseUrl + "/chat/completions", { ...init, redirect: "error" });
      await checkProviderResponse(reply, true);
      lastFailure = undefined;
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
    } catch (error) {
      lastFailure = describeProviderError(error);
      if (!res.headersSent) {
        const status =
          error instanceof ProviderError && error.http && error.http >= 400 ? error.http : 502;
        res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(
          JSON.stringify({
            error: {
              message: lastFailure.code,
            },
          }),
        );
      } else {
        res.destroy();
      }
    }
  });
  server.requestTimeout = 35000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as { port: number }).port;
  return {
    token,
    baseURL: `http://127.0.0.1:${port}/v1`,
    port,
    calls: () => calls,
    upstreamCalls: () => upstreamCalls,
    failure: () => lastFailure,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
