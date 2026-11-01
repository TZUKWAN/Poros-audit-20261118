export interface ModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  fallbackModel?: string | null;
  temperature: number;
  maxTokens?: number | null;
  /** Reasoning budget for OpenAI-compatible reasoning models. */
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  timeoutMs: number;
  streaming: boolean;
}
export interface ModelToolDefinition { type: "function"; function: { name: string; description?: string; parameters?: Record<string, unknown> } }
export interface ModelToolCall { id: string; name: string; arguments: Record<string, unknown> }
export type ModelToolExecutor = (call: ModelToolCall, options?: { signal?: AbortSignal }) => Promise<string>;
/**
 * Provider-emitted work that can be shown in the conversation without
 * pretending that an assistant's private chain-of-thought was available.
 * `thinking` is only emitted when the provider sends an explicit reasoning
 * field (for example `reasoning_content`). Tool events are emitted from the
 * real tool-call protocol and are therefore safe to present as execution
 * trace entries.
 */
export type ModelEvent =
  | { type: "thinking"; chunk: string }
  | { type: "tool-call"; call: ModelToolCall }
  | { type: "tool-result"; call: ModelToolCall; output: string };
export interface ModelResult { text: string; model: string; streamed: boolean; totalTokens: number | null; toolCalls?: ModelToolCall[] }

export class ModelConnectionError extends Error {}
class ModelToolUnsupportedError extends Error {}

export class ModelClient {
  constructor(readonly config: ModelConfig, private fetchImpl: typeof fetch = fetch) {}

  async complete(system: string, input: string, options: { signal?: AbortSignal; onChunk?: (chunk: string) => void; onEvent?: (event: ModelEvent) => void; tools?: ModelToolDefinition[]; toolExecutor?: ModelToolExecutor; toolChoice?: "auto" | "required" | { type: "function"; function: { name: string } } } = {}): Promise<ModelResult> {
    const models = [...new Set([this.config.model, this.config.fallbackModel].filter((model): model is string => Boolean(model)))];
    let error: unknown;
    for (const model of models) {
      let received = false;
      try {
        return await this.request(model, system, input, {
          ...options,
          onChunk: (chunk) => { received = true; options.onChunk?.(chunk); },
          onEvent: (event) => { received = true; options.onEvent?.(event); },
        });
      } catch (caught) {
        if (options.signal?.aborted || received) throw caught;
        error = caught;
      }
    }
    throw error;
  }

  private async request(model: string, system: string, input: string, options: { signal?: AbortSignal; onChunk?: (chunk: string) => void; onEvent?: (event: ModelEvent) => void; tools?: ModelToolDefinition[]; toolExecutor?: ModelToolExecutor; toolChoice?: "auto" | "required" | { type: "function"; function: { name: string } } }): Promise<ModelResult> {
    if (options.tools?.length && options.toolExecutor) {
      try {
        return await this.requestWithTools(model, system, input, { ...options, tools: options.tools, toolExecutor: options.toolExecutor });
      } catch (error) {
        // Some OpenAI-compatible providers reject the `tools` field even
        // though their ordinary chat endpoint works. Preserve tool errors,
        // but fall back to text mode for an explicit protocol rejection so a
        // workspace with no tool-capable provider still remains usable.
        if (!(error instanceof ModelToolUnsupportedError)) throw error;
        return await this.request(model, system, input, { signal: options.signal, onChunk: options.onChunk, onEvent: options.onEvent });
      }
    }
    options.signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST", signal,
        headers: { "content-type": "application/json", accept: this.config.streaming ? "text/event-stream, application/json" : "application/json", ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}) },
        body: JSON.stringify({
          model,
          temperature: this.config.temperature,
          ...(this.config.maxTokens ? (/(^|\/)(gpt|o)[-_]?\d/i.test(model) ? { max_completion_tokens: this.config.maxTokens } : { max_tokens: this.config.maxTokens }) : {}),
          ...(this.config.reasoningEffort && supportsReasoningEffort(model) ? { reasoning_effort: this.config.reasoningEffort } : {}),
          stream: this.config.streaming,
          messages: [{ role: "system", content: system }, { role: "user", content: input }],
        }),
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new ModelConnectionError(timeout.aborted ? "模型回复超时，请重试或调整设置中的超时时间。" : "连接不到模型服务，请打开设置检查 API 地址、密钥和模型。");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ModelConnectionError(response.status === 401 || response.status === 403 ? "模型鉴权失败，请检查 API 密钥。" : response.status === 429 ? "模型服务限流，请稍后重试或设置备用模型。" : `模型服务返回 HTTP ${response.status}，请检查模型配置。`);
    }
    let text = "";
    let totalTokens: number | null = null;
    const streamed = Boolean(response.headers.get("content-type")?.includes("text/event-stream"));
    if (streamed) {
      if (!response.body) throw new Error("模型流式响应没有内容。");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let doneEvent = false;
      const consume = (line: string) => {
        if (!line.startsWith("data:")) return;
        const data = line.slice(5).trim();
        if (!data) return;
        if (data === "[DONE]") { doneEvent = true; return; }
        let body: { error?: unknown; choices?: Array<{ delta?: { content?: unknown; reasoning?: unknown; reasoning_content?: unknown; thinking?: unknown } }>; usage?: { total_tokens?: number } };
        try { body = JSON.parse(data) as typeof body; } catch { throw new Error("模型流式响应格式无效，请重试。"); }
        if (body.error) throw new ModelConnectionError("模型在生成过程中返回错误，请重试。");
        if (typeof body.usage?.total_tokens === "number") totalTokens = body.usage.total_tokens;
        const delta = body.choices?.[0]?.delta;
        // OpenAI-compatible reasoning providers use different names. Only
        // fields explicitly marked as reasoning are surfaced as thinking;
        // ordinary content is never re-labelled or inferred as chain of
        // thought.
        const reasoning = delta?.reasoning_content ?? delta?.reasoning ?? delta?.thinking;
        if (typeof reasoning === "string" && reasoning) options.onEvent?.({ type: "thinking", chunk: reasoning });
        const chunk = delta?.content;
        if (typeof chunk === "string" && chunk) { text += chunk; options.onChunk?.(chunk); }
      };
      try {
        while (!doneEvent) {
          signal.throwIfAborted();
          const next = await reader.read();
          buffer += decoder.decode(next.value, { stream: !next.done });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";
          for (const line of lines) consume(line);
          if (next.done) { if (buffer) consume(buffer); break; }
        }
      } catch (error) {
        // Once a stream has produced partial output, retrying would duplicate
        // text in the conversation. Preserve that rule, but normalize the
        // provider timeout into the same actionable message used by the
        // initial fetch path instead of leaking a runtime DOMException.
        if (timeout.aborted && !options.signal?.aborted) throw new ModelConnectionError("模型回复超时，请重试或调整设置中的超时时间。");
        throw error;
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    } else {
      let body: { choices?: Array<{ message?: { content?: unknown; reasoning?: unknown; reasoning_content?: unknown } }>; usage?: { total_tokens?: number } };
      try {
        body = await response.json() as typeof body;
      } catch (error) {
        if (timeout.aborted && !options.signal?.aborted) throw new ModelConnectionError("模型回复超时，请重试或调整设置中的超时时间。");
        throw error;
      }
      const message = body.choices?.[0]?.message;
      const reasoning = message?.reasoning_content ?? message?.reasoning;
      if (typeof reasoning === "string" && reasoning) options.onEvent?.({ type: "thinking", chunk: reasoning });
      const content = message?.content;
      if (typeof content !== "string") throw new Error("模型没有返回文字，请检查模型名称。 ");
      text = content;
      totalTokens = body.usage?.total_tokens ?? null;
      if (text) options.onChunk?.(text);
    }
    if (!text.trim()) throw new Error("模型返回空内容，请重试。");
    return { text, model, streamed, totalTokens };
  }

  private async requestWithTools(model: string, system: string, input: string, options: { signal?: AbortSignal; onChunk?: (chunk: string) => void; onEvent?: (event: ModelEvent) => void; tools: ModelToolDefinition[]; toolExecutor: ModelToolExecutor; toolChoice?: "auto" | "required" | { type: "function"; function: { name: string } } }): Promise<ModelResult> {
    const messages: Array<Record<string, unknown>> = [{ role: "system", content: system }, { role: "user", content: input }];
    let totalTokens = 0;
    let sawTokens = false;
    for (let round = 0; round < 5; round += 1) {
      options.signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(this.config.timeoutMs);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST", signal,
          headers: { "content-type": "application/json", accept: "application/json", ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}) },
          body: JSON.stringify({ model, temperature: this.config.temperature, ...(this.config.maxTokens ? (/(^|\/)(gpt|o)[-_]?\d/i.test(model) ? { max_completion_tokens: this.config.maxTokens } : { max_tokens: this.config.maxTokens }) : {}), ...(this.config.reasoningEffort && supportsReasoningEffort(model) ? { reasoning_effort: this.config.reasoningEffort } : {}), stream: false, tools: options.tools, ...(options.toolChoice ? { tool_choice: options.toolChoice } : {}), messages }),
        });
      } catch (error) {
        if (options.signal?.aborted) throw error;
        throw new ModelConnectionError(timeout.aborted ? "模型回复超时，请重试或调整设置中的超时时间。" : "连接不到模型服务，请打开设置检查 API 地址、密钥和模型。");
      }
      if (!response.ok) {
        if ([400, 404, 405, 415, 422].includes(response.status)) throw new ModelToolUnsupportedError(`模型不支持工具调用（HTTP ${response.status}）`);
        throw new ModelConnectionError(`模型服务返回 HTTP ${response.status}，请检查模型配置。`);
      }
      const body = await response.json() as { choices?: Array<{ message?: { content?: unknown; reasoning?: unknown; reasoning_content?: unknown; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string | Record<string, unknown> } }> } }>; usage?: { total_tokens?: number } };
      if (typeof body.usage?.total_tokens === "number") { totalTokens += body.usage.total_tokens; sawTokens = true; }
      const message = body.choices?.[0]?.message;
      if (!message) throw new Error("模型没有返回有效消息。");
      const calls = (message.tool_calls ?? []).map((call, index) => {
        const raw = call.function?.arguments;
        let args: Record<string, unknown> = {};
        try { args = typeof raw === "string" ? JSON.parse(raw) as Record<string, unknown> : raw ?? {}; } catch { throw new Error(`工具 ${call.function?.name ?? "unknown"} 参数不是有效 JSON。`); }
        return { id: call.id ?? `tool-call-${round}-${index}`, name: call.function?.name ?? "", arguments: args };
      }).filter((call) => call.name);
      const reasoning = message.reasoning_content ?? message.reasoning;
      if (typeof reasoning === "string" && reasoning) options.onEvent?.({ type: "thinking", chunk: reasoning });
      if (!calls.length) {
        const text = typeof message.content === "string" ? message.content : "";
        if (!text.trim()) throw new Error("模型返回空内容，请重试。");
        options.onChunk?.(text);
        return { text, model, streamed: false, totalTokens: sawTokens ? totalTokens : null };
      }
      messages.push({ role: "assistant", content: typeof message.content === "string" ? message.content : null, tool_calls: calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) });
      for (const call of calls) {
        options.onEvent?.({ type: "tool-call", call });
        let output: string;
        try {
          output = await options.toolExecutor(call, { signal: options.signal });
        } catch (error) {
          // Keep the failure visible in the execution trace before the error
          // crosses the model boundary and marks the step failed.
          const messageText = error instanceof Error ? error.message : String(error);
          options.onEvent?.({ type: "tool-result", call, output: `工具调用失败：${messageText}` });
          throw error;
        }
        options.onEvent?.({ type: "tool-result", call, output });
        messages.push({ role: "tool", tool_call_id: call.id, content: output.slice(0, 20_000) });
      }
    }
    throw new Error("模型连续调用工具超过 5 轮，已停止以避免无限循环。");
  }
}

/** GPT-5/6 and o-series expose reasoning_effort; legacy GPT chat models do not. */
function supportsReasoningEffort(model: string): boolean {
  return /(?:^|\/)(?:o\d(?:[-_.]|$)|gpt-(?:5|6)(?:[-_.]|\d|$))/i.test(model);
}

export function parseModelJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("模型没有返回有效的场景定义。");
  return JSON.parse(fenced.slice(start, end + 1));
}
