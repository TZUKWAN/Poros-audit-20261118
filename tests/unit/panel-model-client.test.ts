import { describe, expect, it } from "vitest";
import { ModelClient, ModelConnectionError } from "@/panel/model-client";

const config = { baseUrl: "https://model.test/v1", apiKey: "test-key", model: "primary", temperature: 0.1, timeoutMs: 1000, streaming: true };

describe("模型传输协议（注入网络响应的单元测试）", () => {
  it("流未关闭前传出首块，跨字节的中文正确解码", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array>;
    let firstChunk: () => void = () => {};
    const first = new Promise<void>((resolve) => { firstChunk = resolve; });
    const chunks: string[] = [];
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; } });
    const client = new ModelClient(config, async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }));
    const promise = client.complete("s", "u", { onChunk: (chunk) => { chunks.push(chunk); firstChunk(); } });
    const event = encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "你好" } }] })}\n\n`);
    streamController!.enqueue(event.slice(0, event.length - 7));
    streamController!.enqueue(event.slice(event.length - 7));
    await first;
    expect(chunks).toEqual(["你好"]);
    streamController!.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"世界"}}]}\n\ndata: [DONE]\n\n'));
    const result = await promise;
    expect(result.text).toBe("你好世界");
  });
  it("保留 provider 显式 reasoning_content，并按增量事件通知 UI", async () => {
    const events: Array<{ type: string; chunk?: string }> = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"先检查上下文"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"结果已准备"}}]}\n\ndata: [DONE]\n\n'));
        controller.close();
      },
    });
    const client = new ModelClient(config, async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }));
    const result = await client.complete("s", "u", { onEvent: (event) => events.push({ type: event.type, ...(event.type === "thinking" ? { chunk: event.chunk } : {}) }) });
    expect(result.text).toBe("结果已准备");
    expect(events).toEqual([{ type: "thinking", chunk: "先检查上下文" }]);
  });
  it("拒绝空结果、流式错误、鉴权失败，并给出不含密钥的错误", async () => {
    const client = new ModelClient(config, async () => new Response("", { status: 401 }));
    await expect(client.complete("s", "u")).rejects.toBeInstanceOf(ModelConnectionError);
    await expect(client.complete("s", "u")).rejects.not.toThrow("test-key");
    const streamClient = new ModelClient(config, async () => new Response('data: {"error":{"message":"secret"}}\n\n', { headers: { "content-type": "text/event-stream" } }));
    await expect(streamClient.complete("s", "u")).rejects.toThrow("生成过程中");
  });
  it("网络失败可以使用指定备用模型；取消后不调用备用", async () => {
    const models: string[] = [];
    const client = new ModelClient({ ...config, fallbackModel: "secondary" }, async (_url, init) => {
      const model = (JSON.parse(String(init?.body)) as { model: string }).model;
      models.push(model);
      return model === "primary" ? new Response("", { status: 503 }) : new Response(JSON.stringify({ choices: [{ message: { content: "真实协议返回" } }] }));
    });
    expect((await client.complete("s", "u")).model).toBe("secondary");
    expect(models).toEqual(["primary", "secondary"]);
    const signal = AbortSignal.abort();
    await expect(client.complete("s", "u", { signal })).rejects.toThrow();
    expect(models).toHaveLength(2);
  });

  it("gpt 系列使用 reasoning provider 兼容的 max_completion_tokens", async () => {
    let body: Record<string, unknown> | undefined;
    const client = new ModelClient({ ...config, model: "gpt-6.1-sol", maxTokens: 128 }, async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    });
    await client.complete("s", "u");
    expect(body?.max_completion_tokens).toBe(128);
    expect(body?.max_tokens).toBeUndefined();
  });

  it("仅对 reasoning 模型发送低推理预算，避免普通模型收到未知参数", async () => {
    let gptBody: Record<string, unknown> | undefined;
    const gpt = new ModelClient({ ...config, model: "gpt-6-luna", reasoningEffort: "low" }, async (_url, init) => {
      gptBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    });
    await gpt.complete("s", "u");
    expect(gptBody?.reasoning_effort).toBe("low");

    let regularBody: Record<string, unknown> | undefined;
    const regular = new ModelClient({ ...config, model: "gemini-3-flash", reasoningEffort: "low" }, async (_url, init) => {
      regularBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    });
    await regular.complete("s", "u");
    expect(regularBody?.reasoning_effort).toBeUndefined();

    let legacyBody: Record<string, unknown> | undefined;
    const legacy = new ModelClient({ ...config, model: "gpt-4o", reasoningEffort: "low" }, async (_url, init) => {
      legacyBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    });
    await legacy.complete("s", "u");
    expect(legacyBody?.reasoning_effort).toBeUndefined();
  });

  it("流式响应传输中超时不会泄露原始 DOMException", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; } });
    const client = new ModelClient({ ...config, timeoutMs: 10 }, async (_url, init) => {
      (init?.signal as AbortSignal).addEventListener("abort", () => streamController?.error(new DOMException("timeout", "TimeoutError")), { once: true });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    });
    await expect(client.complete("s", "u")).rejects.toThrow("模型回复超时");
  });

  it("OpenAI-compatible tool call 会执行工具并把结果回送模型", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const client = new ModelClient({ ...config, streaming: false }, async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (bodies.length === 1) return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: "call-1", function: { name: "read_note", arguments: JSON.stringify({ path: "notes.md" }) } }] } }] }));
      return new Response(JSON.stringify({ choices: [{ message: { content: "工具结果已纳入回答" } }] }));
    });
    const events: string[] = [];
    const result = await client.complete("s", "u", {
      tools: [{ type: "function", function: { name: "read_note", description: "读取笔记", parameters: { type: "object", properties: { path: { type: "string" } } } } }],
      toolExecutor: async (call) => `已读取 ${String(call.arguments.path)}`,
      toolChoice: { type: "function", function: { name: "read_note" } },
      onEvent: (event) => { if (event.type === "tool-call" || event.type === "tool-result") events.push(event.type); },
    });
    expect(result.text).toBe("工具结果已纳入回答");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.tool_choice).toEqual({ type: "function", function: { name: "read_note" } });
    expect((bodies[1]!.messages as Array<{ role: string }>).some((message) => message.role === "tool")).toBe(true);
    expect(events).toEqual(["tool-call", "tool-result"]);
  });
});
