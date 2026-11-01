import { describe, expect, it } from "vitest";
import { createConfiguredPlanner, OpenRouterPlanner } from "@/orchestrator/planner";

describe("场景规划器", () => {
  it("无密钥时使用本地结构化规划，不返回空模板", async () => {
    const planner = createConfiguredPlanner({});
    const intent = await planner.parseIntent("整理 D:\\data\\sales.csv 并生成报告");
    expect(intent).toMatchObject({ via: "template", domain: "data" });
    const dag = await planner.planTasks(intent as never) as { nodes: Array<{ title: string; deps: string[] }> };
    expect(dag.nodes.length).toBeGreaterThanOrEqual(4);
    expect(dag.nodes.at(-1)?.deps).toEqual(["n3"]);
  });

  it("OpenRouter 响应支持 fenced JSON，并使用配置模型", async () => {
    const requests: Array<{ url: string; body: string; auth: string }> = [];
    const planner = new OpenRouterPlanner(
      { apiKey: "test-key", baseUrl: "https://router.test/v1", model: "test/model" },
      async (input, init) => {
        requests.push({ url: String(input), body: String(init?.body), auth: String((init?.headers as Record<string, string>).authorization) });
        return new Response(JSON.stringify({ choices: [{ message: { content: "```json\n{\"goal\":\"x\",\"domain\":\"general\",\"slots\":[],\"keywords\":[\"x\"],\"via\":\"llm\"}\n```" } }] }), { status: 200 });
      },
    );
    const intent = await planner.parseIntent("x");
    expect(intent).toMatchObject({ goal: "x", via: "llm" });
    expect(requests[0]?.url).toBe("https://router.test/v1/chat/completions");
    expect(requests[0]?.auth).toBe("Bearer test-key");
    expect(JSON.parse(requests[0]?.body ?? "{}").model).toBe("test/model");
  });

  it("OpenRouter 即使误返回 template 来源也保持真实 llm 标记", async () => {
    const planner = new OpenRouterPlanner(
      { apiKey: "test-key" },
      async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"goal":"x","domain":"general","slots":[],"keywords":["x"],"via":"template"}' } }] }), { status: 200 }),
    );
    await expect(planner.parseIntent("x")).resolves.toMatchObject({ goal: "x", via: "llm" });
  });

  it("真实规划请求携带冻结的项目指令、文件和 Memory 上下文", async () => {
    let body = "";
    const planner = new OpenRouterPlanner(
      { apiKey: "test-key" },
      async (_input, init) => {
        body = String(init?.body);
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"goal":"x","domain":"general","slots":[],"keywords":["x"],"via":"llm"}' } }] }), { status: 200 });
      },
    );
    await planner.parseIntent("整理报告", { projectId: "p1", projectInstructions: "输出中文 Markdown", files: [{ id: "f1", name: "brief.md", path: "brief.md", mediaType: "text/markdown", size: 12, content: "# 资料" }], memories: [{ id: "m1", name: "偏好", scope: "project", content: "先给结论", sourceType: "user", sourceId: null }], connectors: [], desktopContexts: [], provider: { id: null, baseUrl: "http://127.0.0.1:1/v1", model: "m", timeoutMs: 1000 } });
    expect(body).toContain("输出中文 Markdown");
    expect(body).toContain("先给结论");
    expect(body).toContain("brief.md");
  });

  it("支持 OpenAI-compatible SSE 流式规划并逐块通知", async () => {
    const chunks: string[] = [];
    const content = JSON.stringify({ goal: "x", domain: "general", slots: [], keywords: ["x"], via: "llm" });
    const midpoint = Math.floor(content.length / 2);
    const sse = [content.slice(0, midpoint), content.slice(midpoint)].map((part) => `data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n`).join("") + "data: [DONE]\n";
    const planner = new OpenRouterPlanner({ apiKey: "test-key", stream: true, onChunk: (chunk) => chunks.push(chunk) }, async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }));
    await expect(planner.parseIntent("x")).resolves.toMatchObject({ goal: "x", via: "llm" });
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("流式规划读取 usage，供运行中心记录 token 用量", async () => {
    const content = JSON.stringify({ goal: "x", domain: "general", slots: [], keywords: ["x"], via: "llm" });
    const sse = `data: ${JSON.stringify({ choices: [{ delta: { content } }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } })}\n\ndata: [DONE]\n`;
    const planner = new OpenRouterPlanner({ apiKey: "test-key", stream: true }, async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }));
    await planner.parseIntent("x");
    expect(planner.lastUsage).toEqual({ promptTokens: 11, completionTokens: 7, totalTokens: 18 });
  });

  it("主模型失败时按设置切换 fallback，并记录原因与运行参数", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const planner = new OpenRouterPlanner({ apiKey: "test-key", model: "primary", fallbackModel: "fallback", temperature: 0.7, maxTokens: 23 }, async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      if (body.model === "primary") return new Response("down", { status: 503 });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"goal":"x","domain":"general","slots":[],"keywords":["x"],"via":"llm"}' } }] }), { status: 200 });
    });
    await expect(planner.parseIntent("x")).resolves.toMatchObject({ via: "llm" });
    expect(requests.map((item) => item.model)).toEqual(["primary", "fallback"]);
    expect(requests[1]).toMatchObject({ temperature: 0.7, max_tokens: 23 });
    expect(planner.lastFallbackReason).toContain("fallback");
  });

  it("GPT/O 规划模型使用 max_completion_tokens，普通模型继续使用 max_tokens", async () => {
    let gptBody: Record<string, unknown> | undefined;
    const gpt = new OpenRouterPlanner({ apiKey: "test-key", model: "gpt-6.1-sol", maxTokens: 128 }, async (_input, init) => {
      gptBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"goal":"x","domain":"general","slots":[],"keywords":[],"via":"llm"}' } }] }), { status: 200 });
    });
    await gpt.parseIntent("x");
    expect(gptBody?.max_completion_tokens).toBe(128);
    expect(gptBody?.max_tokens).toBeUndefined();

    let regularBody: Record<string, unknown> | undefined;
    const regular = new OpenRouterPlanner({ apiKey: "test-key", model: "gemini-3-flash", maxTokens: 128 }, async (_input, init) => {
      regularBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"goal":"x","domain":"general","slots":[],"keywords":[],"via":"llm"}' } }] }), { status: 200 });
    });
    await regular.parseIntent("x");
    expect(regularBody?.max_tokens).toBe(128);
    expect(regularBody?.max_completion_tokens).toBeUndefined();
  });

  it("运行终止会中断规划请求，且不会再发起 fallback", async () => {
    const controller = new AbortController();
    let requests = 0;
    const planner = new OpenRouterPlanner({ apiKey: "test-key", model: "primary", fallbackModel: "fallback", timeoutMs: 5_000 }, async (_input, init) => {
      requests += 1;
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal;
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    });
    planner.setAbortSignal(controller.signal);
    const pending = planner.parseIntent("x");
    await Promise.resolve();
    controller.abort();
    // Launcher clears the mutable binding immediately so a later run can
    // attach a fresh signal while this rejected promise is still unwinding.
    planner.setAbortSignal(undefined);
    await expect(pending).rejects.toThrow();
    expect(requests).toBe(1);
  });

  it("规划请求超时给出可操作的中文错误", async () => {
    const planner = new OpenRouterPlanner({ apiKey: "test-key", timeoutMs: 5 }, async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal as AbortSignal;
      signal.addEventListener("abort", () => reject(new DOMException("timeout", "TimeoutError")), { once: true });
    }));
    await expect(planner.parseIntent("x")).rejects.toThrow("模型回复超时");
  });
});
