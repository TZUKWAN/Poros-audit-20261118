import type { Intent, RuntimeContext } from "./context.js";
import type { HandlerDeps } from "./handlers.js";

export type ScenarioPlanner = NonNullable<HandlerDeps["llm"]> & {
  /** SceneFlow 流式目标叙述（可选能力：本地规划器无模型则缺省，进度卡仅少一段叙述） */
  narrateGoal?: (requirement: string, onDelta: (delta: string) => void, signal?: AbortSignal) => Promise<void>;
};

export interface OpenRouterConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fallbackModel?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  stream?: boolean;
  onChunk?: (chunk: string) => void;
}

/** 无外部模型时的确定性规划器：保留需求语义，并给出可解释的四步任务图。 */
export function createLocalPlanner(): ScenarioPlanner {
  return {
    async parseIntent(requirement: string, _context?: RuntimeContext | null, _clarificationAnswers?: Record<string, string>): Promise<unknown> {
      const keywords = extractKeywords(requirement);
      const slots = extractSlots(requirement);
      return { goal: requirement, domain: inferDomain(keywords), slots, keywords, via: "template" };
    },
    async planTasks(intent: Intent, _context?: RuntimeContext | null, _clarificationAnswers?: Record<string, string>): Promise<unknown> {
      const goal = intent.goal.trim();
      return {
        nodes: [
          { id: "n1", title: `明确「${goal.slice(0, 42)}」的输入与约束`, deps: [], expectedOutput: "结构化任务约束" },
          { id: "n2", title: `检索并筛选完成「${goal.slice(0, 42)}」所需能力`, deps: ["n1"], expectedOutput: "候选能力列表" },
          { id: "n3", title: `执行「${goal.slice(0, 42)}」主流程`, deps: ["n2"], expectedOutput: "真实执行输出" },
          { id: "n4", title: "验证输出并整理交付结果", deps: ["n3"], expectedOutput: "验收报告与产物" },
        ],
      };
    },
  };
}

/** 从环境变量创建 OpenRouter 规划器；没有密钥时返回本地规划器。 */
export function createConfiguredPlanner(env: NodeJS.ProcessEnv = process.env): ScenarioPlanner {
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) return createLocalPlanner();
  return new OpenRouterPlanner({
    apiKey,
    baseUrl: env.OPENROUTER_BASE_URL,
    model: env.OPENROUTER_MODEL,
    timeoutMs: env.OPENROUTER_TIMEOUT_MS ? Number(env.OPENROUTER_TIMEOUT_MS) : undefined,
    stream: env.OPENROUTER_STREAM === "1",
    fallbackModel: env.OPENROUTER_FALLBACK_MODEL,
    temperature: env.OPENROUTER_TEMPERATURE ? Number(env.OPENROUTER_TEMPERATURE) : undefined,
    maxTokens: env.OPENROUTER_MAX_TOKENS ? Number(env.OPENROUTER_MAX_TOKENS) : undefined,
  });
}

export class OpenRouterPlanner implements ScenarioPlanner {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  /**
   * The panel owns cancellation at run level.  Keep it separate from the
   * per-request timeout so a terminate action can interrupt a planner call
   * immediately instead of waiting for the full provider timeout.
   */
  private abortSignal: AbortSignal | undefined;
  lastFallbackReason: string | null = null;
  lastUsage: { promptTokens: number; completionTokens: number; totalTokens: number } | null = null;

  setChunkHandler(handler: ((chunk: string) => void) | undefined): void { this.config.onChunk = handler; }

  /** Bind one run's cancellation signal. The launcher clears it on settle. */
  setAbortSignal(signal: AbortSignal | undefined): void { this.abortSignal = signal; }

  constructor(private config: OpenRouterConfig, private fetchImpl: typeof fetch = fetch) {
    this.baseUrl = (config.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
    this.model = config.model ?? "nvidia/nemotron-3-ultra-550b-a55b:free";
    this.timeoutMs = config.timeoutMs ?? 45_000;
  }

  async parseIntent(requirement: string, context?: RuntimeContext | null, clarificationAnswers?: Record<string, string>): Promise<unknown> {
    const raw = await this.complete(
      "Return only valid JSON matching {goal?:string,domain?:string,slots?:{name:string,value:string}[],keywords?:string[],via:\"llm\",clarification?:{question:string,inputs:{name:string,type:\"string\"|\"path\"|\"url\"|\"number\",description:string}[]}}. If a missing or ambiguous user choice prevents a safe plan, return clarification with a concrete question and only the missing fields; goal may be omitted; do not invent values. Otherwise omit clarification and include a non-empty goal. Do not wrap it in markdown.",
      formatPlannerInput(requirement, context, clarificationAnswers),
    );
    // 某些模型会把 via 误写成 template；来源由本规划器决定，字段结构仍交给处理器 schema 校验。
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return { ...(raw as Record<string, unknown>), via: "llm" };
    return raw;
  }

  async planTasks(intent: Intent, context?: RuntimeContext | null, clarificationAnswers?: Record<string, string>): Promise<unknown> {
    return await this.complete(
      "Return only valid JSON matching {nodes:{id:string,title:string,deps:string[],expectedOutput:string}[],clarification?:{question:string,inputs:{name:string,type:\"string\"|\"path\"|\"url\"|\"number\",description:string}[]}}. If a missing or ambiguous user choice prevents a safe DAG, return clarification and no guessed node; otherwise omit clarification. Build a minimal acyclic task graph.",
      formatPlannerInput(JSON.stringify(intent), context, clarificationAnswers),
    );
  }

  /**
   * SceneFlow 真流式：构建开始时用一小段流式文本向用户复述目标与打算（非 JSON），
   * 每个 delta 经 onDelta 直达进度卡。任何失败都静默——叙述是增强，不是依赖。
   */
  async narrateGoal(requirement: string, onDelta: (delta: string) => void, signal?: AbortSignal): Promise<void> {
    const runSignal = signal ?? this.abortSignal;
    const apiKey = this.config.apiKey;
    if (!apiKey) return;
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const model = this.model;
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({
          model,
          temperature: 0.3,
          max_tokens: 160,
          stream: true,
          messages: [
            { role: "system", content: "你是 SceneFlow 工作台的构建助手。用不超过两句话、第一人称向用户复述你理解的目标和你即将做的事。直接输出正文，不要标题、列表、引号或寒暄。" },
            { role: "user", content: requirement.slice(0, 500) },
          ],
        }),
        signal: runSignal && typeof AbortSignal.any === "function" ? AbortSignal.any([runSignal, timeout]) : timeout,
      });
      if (!response.ok || !response.body) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const next = await reader.read();
          buffer += decoder.decode(next.value ?? new Uint8Array(), { stream: !next.done });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            try {
              const body = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
              const chunk = body.choices?.[0]?.delta?.content ?? "";
              if (chunk) onDelta(chunk);
            } catch {
              /* keepalive 片段忽略 */
            }
          }
          if (next.done) break;
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    } catch {
      /* 叙述失败静默：进度卡没有这段文字也完全可用 */
    }
  }

  private async complete(instruction: string, input: string): Promise<unknown> {
    this.lastFallbackReason = null;
    // Capture the signal for this operation. The launcher may clear the
    // planner's binding from its terminate hook while the provider promise is
    // still unwinding; using the captured signal keeps cancellation
    // authoritative and prevents a late fallback request.
    const runSignal = this.abortSignal;
    try {
      return await this.request(this.model, instruction, input);
    } catch (error) {
      // A user cancellation is authoritative. Never start a fallback request
      // after the run has already been terminated.
      if (runSignal?.aborted) throw error;
      const fallback = this.config.fallbackModel?.trim();
      if (!fallback || fallback === this.model) throw error;
      this.lastFallbackReason = `${this.model} 失败，已切换到 ${fallback}：${error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160)}`;
      return await this.request(fallback, instruction, input);
    }
  }

  private async request(model: string, instruction: string, input: string): Promise<unknown> {
    const runSignal = this.abortSignal;
    runSignal?.throwIfAborted();
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = runSignal ? AbortSignal.any([runSignal, timeout]) : timeout;
    const timeoutMessage = (): Error => new Error("模型回复超时，请重试或调整设置中的超时时间。");
    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
        "HTTP-Referer": "https://pi-scenario.local",
        "X-Title": "pi-scenario",
      },
      body: JSON.stringify({
        model,
        temperature: this.config.temperature ?? 0.1,
        ...(this.config.maxTokens ? (isReasoningModel(model) ? { max_completion_tokens: this.config.maxTokens } : { max_tokens: this.config.maxTokens }) : {}),
        ...(this.config.stream ? { stream: true } : {}),
        messages: [
          { role: "system", content: instruction },
          { role: "user", content: input },
        ],
      }),
      signal,
    }).catch((error: unknown) => {
      if (runSignal?.aborted) throw error;
      if (timeout.aborted) throw timeoutMessage();
      throw error;
    });
    if (!response.ok) throw new Error(`OpenRouter HTTP ${response.status}`);
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      let content = "";
      const consumeLine = (line: string): void => {
        if (!line.startsWith("data:")) return;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") return;
        try {
          const body = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
          if (body.usage) this.lastUsage = { promptTokens: body.usage.prompt_tokens ?? 0, completionTokens: body.usage.completion_tokens ?? 0, totalTokens: body.usage.total_tokens ?? (body.usage.prompt_tokens ?? 0) + (body.usage.completion_tokens ?? 0) };
          const chunk = body.choices?.[0]?.delta?.content ?? "";
          content += chunk;
          if (chunk) this.config.onChunk?.(chunk);
        } catch {
          // Ignore malformed keepalive/event fragments and let the final JSON
          // parser provide the actionable error if the model response is bad.
        }
      };
      if (!response.body) {
        for (const line of (await response.text()).split(/\r?\n/)) consumeLine(line);
      } else {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          while (true) {
            signal.throwIfAborted();
            const next = await reader.read();
            buffer += decoder.decode(next.value ?? new Uint8Array(), { stream: !next.done });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() ?? "";
            for (const line of lines) consumeLine(line);
            if (next.done) {
              if (buffer) consumeLine(buffer);
              break;
            }
          }
        } catch (error) {
          if (runSignal?.aborted) throw error;
          if (timeout.aborted) throw timeoutMessage();
          throw error;
        } finally {
          // Release the fetch body even when the timeout or JSON parser aborts
          // the planner. Without this, repeated retries can retain sockets and
          // make the local proxy appear to stall under load.
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      }
      return JSON.parse(extractJson(content));
    }
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
    if (body.usage) this.lastUsage = { promptTokens: body.usage.prompt_tokens ?? 0, completionTokens: body.usage.completion_tokens ?? 0, totalTokens: body.usage.total_tokens ?? (body.usage.prompt_tokens ?? 0) + (body.usage.completion_tokens ?? 0) };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("OpenRouter returned no text content");
    return JSON.parse(extractJson(content));
  }
}

function formatPlannerInput(input: string, context?: RuntimeContext | null, clarificationAnswers?: Record<string, string>): string {
  const answers = Object.entries(clarificationAnswers ?? {});
  const answerText = answers.length ? `\n\n用户已补充的澄清输入（请直接使用，不要再次询问相同字段）：\n${answers.map(([name, value]) => `- ${name}: ${value}`).join("\n")}` : "";
  return context ? `${input}${answerText}\n\n运行上下文（只用于约束和输入，不要改写用户目标）：\n${formatRuntimeContext(context)}` : `${input}${answerText}`;
}

function isReasoningModel(model: string): boolean {
  return /(^|\/)(gpt|o)[-_]?\d/i.test(model);
}

function formatRuntimeContext(context: RuntimeContext): string {
  const sections = [
    `项目指令：${context.projectInstructions || "（无）"}`,
    `文件：${context.files.map((file) => `- ${file.name} (${file.mediaType}, ${file.size} bytes)${file.content ? `\n${file.content.slice(0, 1800)}` : ""}`).join("\n") || "（无）"}`,
    `Memory：${context.memories.map((memory) => `- [${memory.scope}] ${memory.name}: ${memory.content.slice(0, 1800)}`).join("\n") || "（无）"}`,
    `桌面上下文：${context.desktopContexts.map((item) => `- [${item.kind}] ${item.label} (${item.origin})\n${item.content.slice(0, 1800)}`).join("\n") || "（无）"}`,
    `可用连接器：${context.connectors.filter((connector) => connector.status === "enabled").map((connector) => `- ${connector.name} (${connector.kind}; ${connector.permissionScopes.join(", ")})`).join("\n") || "（无）"}`,
    context.provider ? `Provider：${context.provider.model} @ ${context.provider.baseUrl}` : "Provider：默认配置",
  ];
  const maxChars = 24_000;
  let remaining = maxChars;
  const output: string[] = [];
  for (const section of sections) {
    if (remaining <= 0) break;
    const clipped = section.slice(0, remaining);
    output.push(clipped);
    remaining -= clipped.length;
  }
  return output.join("\n");
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = (fenced ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("planner response did not contain a JSON object");
  return candidate.slice(start, end + 1);
}

function extractKeywords(requirement: string): string[] {
  const stop = new Set(["请", "帮我", "帮忙", "一下", "一个", "进行", "并且", "然后", "需要", "生成", "整理"]);
  return [...new Set(requirement.toLowerCase().split(/[^\p{L}\p{N}_./:-]+/u).filter((word) => word.length >= 2 && !stop.has(word)))].slice(0, 16);
}

function extractSlots(requirement: string): Array<{ name: string; value: string }> {
  const slots: Array<{ name: string; value: string }> = [];
  const paths = requirement.match(/(?:[A-Za-z]:\\[^\s，。,；;]+|\/[^\s，。,；;]+)/g) ?? [];
  for (const value of paths.slice(0, 4)) slots.push({ name: "path", value });
  const urls = requirement.match(/https?:\/\/[^\s，。,；;]+/g) ?? [];
  for (const value of urls.slice(0, 4)) slots.push({ name: "url", value });
  return slots;
}

function inferDomain(keywords: string[]): string {
  if (keywords.some((word) => /代码|仓库|git|程序|脚本/.test(word))) return "software";
  if (keywords.some((word) => /数据|表格|csv|excel|数据库/.test(word))) return "data";
  if (keywords.some((word) => /网页|网站|浏览器|搜索/.test(word))) return "web";
  return "general";
}
