import { z } from "zod";

/** 场景系统错误码枚举（按阶段/层分组） */
export enum ScenarioErrorCode {
  // 通用
  UNKNOWN = "UNKNOWN",
  VALIDATION = "VALIDATION",
  TIMEOUT = "TIMEOUT",
  NOT_FOUND = "NOT_FOUND",
  IO = "IO",
  CANCELLED = "CANCELLED",
  CONFLICT = "CONFLICT",
  // 编排内核
  ILLEGAL_TRANSITION = "ILLEGAL_TRANSITION",
  GATE_REJECTED = "GATE_REJECTED",
  CONTEXT_CORRUPT = "CONTEXT_CORRUPT",
  // 联邦层
  SOURCE_UNAVAILABLE = "SOURCE_UNAVAILABLE",
  SOURCE_PARSE = "SOURCE_PARSE",
  RATE_LIMITED = "RATE_LIMITED",
  TRUST_FILTERED = "TRUST_FILTERED",
  // 执行层
  INSTALL_FAILED = "INSTALL_FAILED",
  INVOKE_FAILED = "INVOKE_FAILED",
  CAPABILITY_DRIFT = "CAPABILITY_DRIFT",
  DEPTH_EXCEEDED = "DEPTH_EXCEEDED",
  LOOP_LIMIT = "LOOP_LIMIT",
  // 验收
  ACCEPTANCE_FAILED = "ACCEPTANCE_FAILED",
  GENERALIZATION_FAILED = "GENERALIZATION_FAILED",
  // LLM
  LLM_UNAVAILABLE = "LLM_UNAVAILABLE",
  LLM_MALFORMED = "LLM_MALFORMED",
}

export const ScenarioErrorCodeSchema = z.nativeEnum(ScenarioErrorCode);

/** 开发阶段标签（错误定位与日志过滤用） */
export type Phase =
  | "parsing"
  | "planning"
  | "retrieving"
  | "assembling"
  | "verifying"
  | "executing"
  | "distilling"
  | "done"
  | "infra";

export const PhaseSchema = z.enum([
  "parsing",
  "planning",
  "retrieving",
  "assembling",
  "verifying",
  "executing",
  "distilling",
  "done",
  "infra",
]);

export interface ScenarioErrorFields {
  code: ScenarioErrorCode;
  message: string;
  phase: Phase;
  /** 结构化上下文：源名、能力名、节点 id 等，禁止携带密钥 */
  context?: Record<string, unknown>;
  cause?: unknown;
}

/** 全项目统一错误类型 */
export class ScenarioError extends Error {
  readonly code: ScenarioErrorCode;
  readonly phase: Phase;
  readonly context: Record<string, unknown>;

  constructor(fields: ScenarioErrorFields) {
    super(fields.message, { cause: fields.cause });
    this.name = "ScenarioError";
    this.code = fields.code;
    this.phase = fields.phase;
    this.context = fields.context ?? {};
  }

  /** 序列化为可落盘/跨进程的普通对象（不含 cause 堆栈，cause 单独取） */
  toJSON(): {
    name: string;
    code: ScenarioErrorCode;
    message: string;
    phase: Phase;
    context: Record<string, unknown>;
    cause?: string;
  } {
    const cause = this.cause;
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      phase: this.phase,
      context: this.context,
      ...(cause !== undefined
        ? { cause: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause) }
        : {}),
    };
  }

  static fromJSON(raw: unknown): ScenarioError {
    const parsed = SerializedSchema.safeParse(raw);
    if (!parsed.success) {
      return new ScenarioError({
        code: ScenarioErrorCode.UNKNOWN,
        message: `unserializable error payload: ${JSON.stringify(raw)}`,
        phase: "infra",
        context: { raw: safeStringify(raw) },
      });
    }
    const p = parsed.data;
    return new ScenarioError({
      code: p.code,
      message: p.message,
      phase: p.phase,
      context: p.context,
    });
  }
}

const SerializedSchema = z.object({
  code: ScenarioErrorCodeSchema,
  message: z.string(),
  phase: PhaseSchema,
  context: z.record(z.string(), z.unknown()).default({}),
});

/** 任意 thrown 值 → ScenarioError 归一化（unknown 安全） */
export function toScenarioError(err: unknown, phase: Phase, defaultCode = ScenarioErrorCode.UNKNOWN): ScenarioError {
  if (err instanceof ScenarioError) return err;
  if (err instanceof Error) {
    return new ScenarioError({
      code: classify(err, defaultCode),
      message: err.message,
      phase,
      cause: err,
      context: { errorName: err.name },
    });
  }
  return new ScenarioError({
    code: defaultCode,
    message: safeStringify(err),
    phase,
  });
}

function classify(err: Error, fallback: ScenarioErrorCode): ScenarioErrorCode {
  const msg = err.message.toLowerCase();
  if (err.name === "AbortError" || msg.includes("abort")) return ScenarioErrorCode.CANCELLED;
  if (err.name === "TimeoutError" || msg.includes("timeout") || msg.includes("etimedout")) {
    return ScenarioErrorCode.TIMEOUT;
  }
  if (msg.includes("econn") || msg.includes("enotfound") || msg.includes("fetch failed") || msg.includes("network")) {
    return ScenarioErrorCode.SOURCE_UNAVAILABLE;
  }
  if (msg.includes("429") || msg.includes("rate limit")) return ScenarioErrorCode.RATE_LIMITED;
  if (msg.includes("enoent")) return ScenarioErrorCode.NOT_FOUND;
  if (msg.includes("json")) return ScenarioErrorCode.SOURCE_PARSE;
  return fallback;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}
