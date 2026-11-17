import { it, expect } from "vitest";
import { request } from "node:http";
import { createRunModelProxy } from "../../src/server/model-proxy.js";
import { deploymentScope } from "../../src/server/dsh-runtime.js";
import { addUsageCount } from "../../src/server/model-gateway.js";

it("usage preserves unknown/missing/invalid counts instead of reporting free consumption", () => {
  expect(addUsageCount(7, 0)).toBe(7);
  expect(addUsageCount(7, 3)).toBe(10);
  for (const missing of [undefined, null, -1, NaN, Infinity, "3", 1.5])
    expect(addUsageCount(7, missing)).toBeNull();
  expect(addUsageCount(null, 3)).toBeNull();
  expect(addUsageCount(Number.MAX_SAFE_INTEGER, 1)).toBeNull();
});

it("runtime cleanup scope separates databases/schemas and survives credential rotation", () => {
  const a = deploymentScope("postgresql://worker:old@db:5432/poros?schema=public");
  expect(
    deploymentScope("postgresql://worker:new@db:5432/poros?schema=public&sslmode=require"),
  ).toBe(a);
  expect(deploymentScope("postgresql://worker:new@db:5432/poros")).toBe(a);
  expect(deploymentScope("postgresql://worker:old@db:5432/other?schema=public")).not.toBe(a);
  expect(deploymentScope("postgresql://worker:old@db:5432/poros?schema=other")).not.toBe(a);
});
it("model proxy requires a run token, pins upstream/model, and never returns the provider key", async () => {
  const original = process.env.POROS_DEEPSEEK_API_KEY;
  process.env.POROS_DEEPSEEK_API_KEY = "unit-test-provider-secret-never-a-real-key";
  let received: RequestInit | undefined,
    upstream = "";
  const forward: typeof fetch = async (url, init) => {
    upstream = String(url);
    received = init;
    return new Response('data: {"fixture":"model-only"}\n\n', {
      headers: { "content-type": "text/event-stream" },
    });
  };
  const proxy = await createRunModelProxy(forward),
    base = `http://127.0.0.1:${proxy.port}`;
  try {
    expect((await fetch(base + "/v1/chat/completions", { method: "POST" })).status).toBe(401);
    expect(proxy.upstreamCalls()).toBe(0);
    expect(
      (
        await fetch(base + "/v1/chat/completions", {
          method: "POST",
          headers: { authorization: "Bearer " + "é".repeat(proxy.token.length) },
        })
      ).status,
    ).toBe(401);
    expect(proxy.upstreamCalls()).toBe(0);
    expect(
      (
        await fetch(base + "/arbitrary", {
          method: "POST",
          headers: { authorization: `Bearer ${proxy.token}` },
        })
      ).status,
    ).toBe(403);
    const r = await fetch(base + "/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${proxy.token}` },
      body: JSON.stringify({ model: "unapproved-model", max_tokens: 999999, messages: [] }),
    });
    const text = await r.text();
    expect(r.status).toBe(200);
    expect(proxy.upstreamCalls()).toBe(1);
    expect(text).not.toContain(process.env.POROS_DEEPSEEK_API_KEY);
    expect(proxy.token).not.toBe(process.env.POROS_DEEPSEEK_API_KEY);
    expect(upstream).toBe("https://api.deepseek.com/chat/completions");
    expect(JSON.parse(String(received!.body))).toMatchObject({
      model: "deepseek-chat",
      max_tokens: 4096,
    });
    const unicode = "中文🙂分块请求";
    const payload = Buffer.from(JSON.stringify({ messages: [{ role: "user", content: unicode }] }));
    const split = payload.indexOf(Buffer.from(unicode)) + 1;
    await new Promise<void>((resolve, reject) => {
      const req = request(
        base + "/v1/chat/completions",
        { method: "POST", headers: { authorization: `Bearer ${proxy.token}` } },
        (res) => {
          res.resume();
          res.once("end", () =>
            res.statusCode === 200 ? resolve() : reject(new Error(`HTTP ${res.statusCode}`)),
          );
        },
      );
      req.on("error", reject);
      req.setTimeout(5000, () => req.destroy(new Error("chunked HTTP deadline")));
      req.write(payload.subarray(0, split));
      setTimeout(() => req.end(payload.subarray(split)), 20);
    });
    expect(JSON.parse(String(received!.body)).messages[0].content).toBe(unicode);
    expect(
      (
        await fetch(base + "/v1/chat/completions", {
          method: "POST",
          headers: { authorization: `Bearer ${proxy.token}` },
          body: JSON.stringify({ messages: "invalid" }),
        })
      ).status,
    ).toBe(502);
    expect(proxy.upstreamCalls()).toBe(2);
  } finally {
    await proxy.close();
    if (original === undefined) delete process.env.POROS_DEEPSEEK_API_KEY;
    else process.env.POROS_DEEPSEEK_API_KEY = original;
  }
});
