/**
 * 模型网关（PRD §6.3）：统一准入。
 * - mock：默认。契约真实的模拟网关——返回结构化输出并明确标注"未配置真实模型服务"。
 * - deepseek：真实 DeepSeek API。仅在 POROS_DEEPSEEK_API_KEY 存在时可用；
 *   密钥缺失时 refuses（绝不静默降级到未授权公共免费网关，PRD SEC-02）。
 * 任何网页/工具/文档内容都是不可信输入：prompt 只做数据拼入，不做指令提升。
 */
import { env } from "./env.js";
import { z } from "zod";
import type { ModelConnection } from "./integration-connections.js";
import {
  checkProviderResponse,
  ProviderError,
  readProviderText,
  requestModel,
} from "./provider-http.js";

export interface GatewayResult {
  output: string;
  gateway: string;
  disclaimer: string;
  usage?: {
    modelCalls: number;
    inputTokens: number | null;
    outputTokens: number | null;
    monetaryCost: null;
  };
}

/** Unknown/invalid samples make an aggregate unknown; never invent zero consumption. */
export function addUsageCount(total: unknown, sample: unknown): number | null {
  if (
    typeof total !== "number" ||
    typeof sample !== "number" ||
    !Number.isSafeInteger(total) ||
    !Number.isSafeInteger(sample) ||
    total < 0 ||
    sample < 0
  )
    return null;
  const sum = total + sample;
  return Number.isSafeInteger(sum) ? sum : null;
}

export interface AgentDraft {
  name: string;
  description: string;
  department: string;
  config: { persona: string; modelPolicy: string; outputKind: string; tools: string[] };
}

export interface ModelGateway {
  name: string;
  generate(
    prompt: string,
    system: string,
    options?: { signal?: AbortSignal; retry?: boolean },
  ): Promise<GatewayResult>;
  /** 审查项②：自然语言 → 结构化 AgentDefinition 草稿（LLM 生成，zod 在路由层校验） */
  draftAgent(description: string): Promise<AgentDraft>;
}

function draftFromDescription(name: string, description: string): AgentDraft {
  const clean = description.replace(/\s+/g, " ").trim();
  const headline = clean.slice(0, 60);
  return {
    name: name || headline.slice(0, 12) || "未命名 Agent",
    description: clean.slice(0, 400),
    department: "",
    config: {
      persona: `你是组织内受治理的 Agent。职责：${headline}。严格在授权能力范围内工作，输出必须可核验。`,
      modelPolicy: "default",
      outputKind: /报告|总结|文档/.test(clean) ? "markdown-document" : "chat-answer",
      tools: [],
    },
  };
}

export class MockGateway implements ModelGateway {
  name = "mock";
  async draftAgent(description: string): Promise<AgentDraft> {
    const d = draftFromDescription("", description);
    return { ...d, config: { ...d.config, modelPolicy: "mock（未配置真实模型服务）" } };
  }
  async generate(prompt: string, system: string): Promise<GatewayResult> {
    const output = [
      "【mock 网关输出·未配置真实模型服务】",
      "已接收任务并生成结构化占位结果：",
      "- 任务摘要: " + prompt.slice(0, 120).replace(/\s+/g, " "),
      "- 系统约束: " + (system ? system.slice(0, 120).replace(/\s+/g, " ") : "(无)"),
      "- 引用来源: mock 占位（真实运行时此处列出来源链接）",
      "- 结论: 这是契约测试输出，用于验证运行/注入/评估/审计链路；接入真实模型网关后此段由模型生成。",
    ].join("\n");
    return { output, gateway: this.name, disclaimer: "未配置真实模型服务（MODEL_GATEWAY=mock）" };
  }
}

export function isLiveModelGateway(name: string): boolean {
  return name === "deepseek" || name === "openai-compatible";
}
class CompatibleGateway implements ModelGateway {
  readonly name: string;
  constructor(private readonly target?: ModelConnection) {
    this.name = target ? "openai-compatible" : "deepseek";
  }
  private async request(
    messages: Array<{ role: string; content: string }>,
    signal?: AbortSignal,
    json = false,
    retry = true,
  ) {
    const target = this.target ?? {
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
      apiKey: env.deepseekApiKey(),
    };
    if (!target.apiKey) throw new Error("DeepSeek credential missing (SEC-02)");
    let calls = 0;
    for (;;) {
      calls++;
      try {
        const request = {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer " + target.apiKey },
          signal: AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]),
          body: JSON.stringify({
            model: target.model,
            messages,
            max_tokens: 4096,
            ...(json && !this.target ? { response_format: { type: "json_object" } } : {}),
          }),
        } as const;
        const res = this.target
          ? await requestModel(target.baseUrl, "/chat/completions", request)
          : await fetch(target.baseUrl + "/chat/completions", { ...request, redirect: "error" });
        if ([429, 502, 503].includes(res.status) && calls < 2 && retry) {
          await res.body?.cancel();
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
        await checkProviderResponse(res, true);
        const data = JSON.parse(await readProviderText(res)) as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const output = data.choices?.[0]?.message?.content;
        if (typeof output !== "string" || !output.trim())
          throw new ProviderError("INVALID_RESPONSE", res.status);
        return {
          output,
          usage: {
            modelCalls: calls,
            inputTokens: data.usage?.prompt_tokens ?? null,
            outputTokens: data.usage?.completion_tokens ?? null,
            monetaryCost: null,
          },
        };
      } catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error("Model request failed"), {
          usage: { modelCalls: calls, inputTokens: null, outputTokens: null, monetaryCost: null },
        });
      }
    }
  }
  async draftAgent(description: string): Promise<AgentDraft> {
    const key = env.deepseekApiKey();
    if (!this.target && !key)
      throw new Error("DeepSeek 网关未配置 POROS_DEEPSEEK_API_KEY：拒绝静默降级（SEC-02）");
    const sys =
      "你是 Poros Agent Builder。把用户的自然语言描述转成结构化 Agent 草稿 JSON，字段：name(≤12字)、department、config.persona(职责+边界)、config.outputKind(markdown-document|chat-answer)、config.tools(空数组，能力由授权表管理)。只输出 JSON。";
    const result = await this.request(
      [
        { role: "system", content: sys },
        { role: "user", content: description },
      ],
      undefined,
      true,
    );
    const raw = z
      .object({
        name: z.string().trim().min(1).max(120),
        department: z.string().default(""),
        config: z.object({
          persona: z.string().min(1).max(12000),
          outputKind: z.enum(["markdown-document", "chat-answer"]),
        }),
      })
      .parse(JSON.parse(result.output.trim().replace(/^\x60{3}(?:json)?\s*|\s*\x60{3}$/gi, "")));
    return {
      ...raw,
      description,
      config: { ...raw.config, modelPolicy: this.target ? "default" : "deepseek-chat", tools: [] },
    };
  }
  async generate(
    prompt: string,
    system: string,
    options?: { signal?: AbortSignal; retry?: boolean },
  ): Promise<GatewayResult> {
    const key = env.deepseekApiKey();
    if (!this.target && !key)
      throw new Error(
        "DeepSeek 网关未配置 POROS_DEEPSEEK_API_KEY：拒绝静默降级到未授权公共网关（SEC-02）",
      );
    const result = await this.request(
      [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      options?.signal,
      false,
      options?.retry !== false,
    );
    return { ...result, gateway: this.name, disclaimer: "" };
  }
}

export function createGateway(kind: "mock" | "deepseek" = env.modelGateway()): ModelGateway {
  if (kind === "deepseek") return new CompatibleGateway();
  return new MockGateway();
}
export function executionGateway(runtime: "gateway" | "dsh" = env.porosRuntime()): ModelGateway {
  return createGateway(runtime === "dsh" && !env.dshModelStub() ? "deepseek" : env.modelGateway());
}
export const createPersonalGateway = (target: ModelConnection): ModelGateway =>
  new CompatibleGateway(target);
