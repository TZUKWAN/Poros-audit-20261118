import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ModelEvent, ModelResult, ModelToolDefinition, ModelToolExecutor } from "@/panel/model-client.js";
import type { ScenarioDefinition } from "@/scenario/definition.js";
import { topoSort } from "@/orchestrator/dag.js";
import type { RuntimeContext } from "@/orchestrator/context.js";

/** A deliberately small boundary around the OpenAI-compatible transport. */
export interface WorkModel {
  complete(
    system: string,
    input: string,
    options?: { signal?: AbortSignal; onChunk?: (chunk: string) => void; onEvent?: (event: ModelEvent) => void; tools?: ModelToolDefinition[]; toolExecutor?: ModelToolExecutor; toolChoice?: "auto" | "required" | { type: "function"; function: { name: string } } },
  ): Promise<ModelResult>;
}

export type WorkExecutionStatus = "succeeded" | "failed" | "untested" | "cancelled" | "awaiting-user";

export interface WorkMissingInput {
  name: string;
  description: string;
  type: "string" | "path" | "url" | "number";
}

export interface WorkExecutionStep {
  nodeId: string;
  title: string;
  status: "success" | "failed" | "planned" | "skipped";
  startedAt: string;
  finishedAt: string;
  output?: string;
  error?: string;
  inputSources: string[];
  model?: string;
  totalTokens?: number | null;
}

export interface WorkExecutionResult {
  status: WorkExecutionStatus;
  validation: "passed" | "failed" | "untested";
  trace: WorkExecutionStep[];
  outputs: Record<string, string>;
  artifactPath: string;
  artifactContent: string;
  error?: string;
  model?: string;
  totalTokens: number | null;
  missingInputs?: WorkMissingInput[];
}

export interface WorkExecutionOptions {
  definition: ScenarioDefinition;
  requirement: string;
  context: RuntimeContext;
  model: WorkModel | null;
  outputPath: string;
  /** Project root is an allow-list boundary for files read by this service. */
  allowedRoot?: string;
  slots?: Record<string, string>;
  signal?: AbortSignal;
  /** Optional step-boundary pause/terminate hook owned by the panel run controller. */
  checkpoint?: () => Promise<void>;
  /** User guidance queued while a previous step is running. */
  guidance?: () => string[];
  tools?: ModelToolDefinition[];
  toolExecutor?: ModelToolExecutor;
  onEvent?: (event: WorkExecutionEvent) => void;
}

export type WorkExecutionEvent =
  | { type: "step-start"; nodeId: string; title: string }
  | { type: "chunk"; nodeId: string; chunk: string }
  | { type: "thinking"; nodeId: string; chunk: string }
  | { type: "tool-call"; nodeId: string; call: { id: string; name: string; arguments: Record<string, unknown> } }
  | { type: "tool-result"; nodeId: string; call: { id: string; name: string; arguments: Record<string, unknown> }; output: string }
  | { type: "step-finish"; nodeId: string; title: string; status: WorkExecutionStep["status"]; durationMs: number }
  | { type: "warning"; message: string };

const MAX_FILE_CHARS = 6_000;
const MAX_CONTEXT_CHARS = 12_000;
const MAX_UPSTREAM_CHARS = 6_000;

function forwardModelEvent(onEvent: WorkExecutionOptions["onEvent"], nodeId: string, event: ModelEvent): void {
  if (event.type === "thinking") onEvent?.({ type: "thinking", nodeId, chunk: event.chunk });
  else if (event.type === "tool-call") onEvent?.({ type: "tool-call", nodeId, call: event.call });
  else onEvent?.({ type: "tool-result", nodeId, call: event.call, output: event.output });
}

/**
 * Executes a saved definition one node at a time.  It never fabricates a
 * response when a model is absent: that path produces an auditable untested
 * artifact, while a configured but failing provider produces failed.
 */
export async function executeScenarioWork(options: WorkExecutionOptions): Promise<WorkExecutionResult> {
  const { definition, requirement, context, outputPath, signal } = options;
  const stepById = new Map(definition.steps.map((step) => [step.id, step]));
  const ordered = topoSort({ nodes: definition.steps.map((step) => ({ id: step.id, title: step.title, deps: step.deps, expectedOutput: step.expectedOutput })) })
    .map((node) => stepById.get(node.id))
    .filter((step): step is ScenarioDefinition["steps"][number] => Boolean(step));
  const source = await buildSourceContext(context, options.allowedRoot, options.onEvent);
  const trace: WorkExecutionStep[] = [];
  const outputs: Record<string, string> = {};
  let totalTokens = 0;
  let sawTokenUsage = false;
  let modelName: string | undefined;
  let explicitEvidenceGap = false;

  const missingInputs = definition.inputs
    .filter((input) => input.required && !String(options.slots?.[input.name] ?? "").trim())
    .map((input) => ({ name: input.name, description: input.description, type: input.type }));
  if (missingInputs.length) {
    const message = `缺少必填输入：${missingInputs.map((input) => input.name).join("、")}。请补充后继续。`;
    const artifactContent = renderArtifact(definition, requirement, context, source, [], {}, "awaiting-user", message, options.slots);
    await persistArtifact(outputPath, artifactContent);
    return { status: "awaiting-user", validation: "untested", trace: [], outputs: {}, artifactPath: outputPath, artifactContent, error: message, missingInputs, totalTokens: null };
  }

  if (!options.model) {
    const cancelled = signal?.aborted === true;
    for (const step of ordered) {
      const now = new Date().toISOString();
      trace.push({ nodeId: step.id, title: step.title, status: "planned", startedAt: now, finishedAt: now, inputSources: source.ids, error: cancelled ? "运行已取消" : "没有配置可用的 OpenAI-compatible Provider，未执行模型步骤。" });
    }
    const noModelStatus: WorkExecutionStatus = cancelled ? "cancelled" : "untested";
    const noModelError = cancelled ? "运行已取消" : "没有配置可用的 OpenAI-compatible Provider，以上仅为计划，未生成任务结果。";
    const artifactContent = renderArtifact(definition, requirement, context, source, trace, outputs, noModelStatus, noModelError, options.slots);
    await persistArtifact(outputPath, artifactContent);
    return { status: noModelStatus, validation: cancelled ? "failed" : "untested", trace, outputs, artifactPath: outputPath, artifactContent, error: cancelled ? "运行已取消" : "model provider unavailable", totalTokens: null };
  }

  let terminalError: string | undefined;
  let status: WorkExecutionStatus = "succeeded";
  for (const step of ordered) {
    if (signal?.aborted) {
      status = "cancelled";
      terminalError = "运行已取消";
      break;
    }
    try {
      await options.checkpoint?.();
    } catch (error) {
      const finishedAt = new Date().toISOString();
      const message = signal?.aborted ? "运行已取消" : sanitizeError(error);
      trace.push({ nodeId: step.id, title: step.title, status: signal?.aborted ? "skipped" : "failed", startedAt: finishedAt, finishedAt, inputSources: source.ids, error: message });
      status = signal?.aborted ? "cancelled" : "failed";
      terminalError = message;
      break;
    }
    const failedDep = step.deps.find((dep) => trace.find((entry) => entry.nodeId === dep)?.status !== "success");
    if (failedDep) {
      const now = new Date().toISOString();
      trace.push({ nodeId: step.id, title: step.title, status: "skipped", startedAt: now, finishedAt: now, inputSources: source.ids, error: `依赖步骤 ${failedDep} 未成功，未执行。` });
      status = "failed";
      terminalError ??= `依赖步骤 ${failedDep} 未成功`;
      continue;
    }
    const startedAt = new Date().toISOString();
    options.onEvent?.({ type: "step-start", nodeId: step.id, title: step.title });
    const upstream = step.deps.map((dep) => `\n### 上游步骤 ${dep}\n${(outputs[dep] ?? "（无输出）").slice(0, MAX_UPSTREAM_CHARS)}`).join("\n");
    const guidance = options.guidance?.() ?? [];
    const input = renderStepInput(definition, step, requirement, context, source.text, upstream, options.slots, guidance);
    let result: ModelResult;
    try {
      result = await options.model.complete(
        `你是一个严格的工作执行器。只输出本步骤可交付的 Markdown 内容。只能使用用户需求、项目文件、Memory、桌面上下文和上游步骤中提供的事实；不能捏造执行结果、来源、数字、测试或外部操作。历史 Memory 或上游文字中标为 skipped、未验证、计划、建议或待执行的内容，只能称为计划/缺口，绝不能改写为已完成、已搭建、已检索、已执行或已验证。本次模型调用只证明生成了文字，不证明外部文件、工具、代码或第三方服务真的执行；除非上下文给出本次运行的明确证据，否则必须写“未执行”或“无法确认”。方案/目录/流程设计也不等于实际落盘。若证据不足，明确写出缺口。${options.tools?.length ? `本次调用提供了真实工具：${options.tools.map((tool) => tool.function.name).join("、")}。当步骤要求调用工具时必须先调用工具并只依据工具返回结果作答；不要用猜测替代工具结果。` : ""}若且仅当整个目标已经由真实证据完成，在本步骤末尾单独输出 GOAL_MET: true；否则不要输出该标记。输出控制在 1200 个中文字符左右，优先给结论、证据和缺口，不要重复上下文或生成大段模板。`,
        input,
        {
          signal,
          onChunk: (chunk) => options.onEvent?.({ type: "chunk", nodeId: step.id, chunk }),
          onEvent: (event) => forwardModelEvent(options.onEvent, step.id, event),
          tools: options.tools,
          toolExecutor: options.toolExecutor,
          toolChoice: requiredToolChoice(input, options.tools),
        },
      );
      // A provider can resolve at the same instant that cancellation arrives.
      // Check again before committing its output or allowing downstream work.
      if (signal?.aborted) {
        const finishedAt = new Date().toISOString();
        trace.push({ nodeId: step.id, title: step.title, status: "skipped", startedAt, finishedAt, inputSources: source.ids, error: "运行已取消" });
        options.onEvent?.({ type: "step-finish", nodeId: step.id, title: step.title, status: "skipped", durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) });
        status = "cancelled";
        terminalError = "运行已取消";
        break;
      }
      // A pause requested while a model call was in flight takes effect before
      // any downstream step can start. Termination still aborts the call above.
      await options.checkpoint?.();
      modelName = result.model;
      if (typeof result.totalTokens === "number") { totalTokens += result.totalTokens; sawTokenUsage = true; }
      explicitEvidenceGap ||= hasExplicitEvidenceGap(result.text);
      outputs[step.id] = result.text;
      const finishedAt = new Date().toISOString();
      trace.push({ nodeId: step.id, title: step.title, status: "success", startedAt, finishedAt, output: result.text, inputSources: source.ids, model: result.model, totalTokens: result.totalTokens });
      options.onEvent?.({ type: "step-finish", nodeId: step.id, title: step.title, status: "success", durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) });
    } catch (error) {
      const finishedAt = new Date().toISOString();
      const message = signal?.aborted ? "运行已取消" : sanitizeError(error);
      trace.push({ nodeId: step.id, title: step.title, status: signal?.aborted ? "skipped" : "failed", startedAt, finishedAt, inputSources: source.ids, error: message });
      options.onEvent?.({ type: "step-finish", nodeId: step.id, title: step.title, status: signal?.aborted ? "skipped" : "failed", durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) });
      status = signal?.aborted ? "cancelled" : "failed";
      terminalError = message;
      break;
    }
  }
  if (status === "succeeded" && trace.length !== ordered.length) status = "failed";
  if (status === "succeeded" && explicitEvidenceGap) status = "untested";
  const validation = status === "succeeded" ? "passed" : status === "untested" ? "untested" : "failed";
  const finalError = explicitEvidenceGap && status === "untested" ? "模型输出明确说明本次缺少真实执行证据。" : terminalError;
  const artifactContent = renderArtifact(definition, requirement, context, source, trace, outputs, status, finalError, options.slots);
  await persistArtifact(outputPath, artifactContent);
  return { status, validation, trace, outputs, artifactPath: outputPath, artifactContent, ...(finalError ? { error: finalError } : {}), ...(modelName ? { model: modelName } : {}), totalTokens: sawTokenUsage ? totalTokens : null };
}

function requiredToolChoice(input: string, tools: ModelToolDefinition[] | undefined): "auto" | "required" | { type: "function"; function: { name: string } } | undefined {
  if (!tools?.length) return undefined;
  const named = tools.find((tool) => input.includes(tool.function.name));
  if (named) return { type: "function", function: { name: named.function.name } };
  return /必须(?:先)?(?:调用|使用)|要求(?:调用|使用)/u.test(input) ? "required" : undefined;
}

async function buildSourceContext(context: RuntimeContext, allowedRoot: string | undefined, onEvent?: WorkExecutionOptions["onEvent"]): Promise<{ text: string; ids: string[] }> {
  const sections: string[] = [];
  const ids: string[] = [];
  if (context.projectInstructions.trim()) sections.push(`## 项目指令\n${context.projectInstructions.trim()}`);
  for (const file of context.files.slice(0, 40)) {
    const content = await readAuthorizedFile(file, allowedRoot, onEvent);
    if (content === undefined) continue;
    ids.push(`file:${file.id}`);
    sections.push(`## 项目文件：${file.name}\n来源：${file.path}\n${content.slice(0, MAX_FILE_CHARS)}`);
  }
  for (const memory of context.memories.slice(0, 8)) {
    ids.push(`memory:${memory.id}`);
    sections.push(`## Memory：${memory.name}\n${memory.content.slice(0, MAX_FILE_CHARS)}`);
  }
  for (const item of context.desktopContexts.slice(0, 6)) {
    ids.push(`desktop:${item.id}`);
    sections.push(`## 桌面上下文：${item.label}\n类型：${item.kind}\n来源：${item.origin}\n${item.content.slice(0, MAX_FILE_CHARS)}`);
  }
  let text = sections.join("\n\n");
  if (text.length > MAX_CONTEXT_CHARS) text = `${text.slice(0, MAX_CONTEXT_CHARS)}\n\n[上下文已截断]`;
  return { text: text || "（本次运行没有可用的项目文件、Memory 或桌面上下文。）", ids };
}

async function readAuthorizedFile(file: RuntimeContext["files"][number], allowedRoot: string | undefined, onEvent?: WorkExecutionOptions["onEvent"]): Promise<string | undefined> {
  if (!isTextFile(file)) {
    onEvent?.({ type: "warning", message: `文件 ${file.name}（${file.mediaType}）不是可直接读取的文本，已从本次上下文排除。` });
    return undefined;
  }
  if (!allowedRoot && file.content !== undefined) return file.content;
  if (!allowedRoot) {
    onEvent?.({ type: "warning", message: `文件 ${file.name} 没有安全工作区边界，未读取。` });
    return undefined;
  }
  const root = path.resolve(allowedRoot);
  const target = path.resolve(file.path);
  // Lexical containment is insufficient for project files: a symlink inside
  // the project can point outside it. Resolve both sides before accepting
  // either preloaded content or a disk read.
  const canonicalRoot = await realpath(root).catch(() => root);
  const canonicalTarget = await realpath(target).catch(() => undefined);
  if (!canonicalTarget) {
    onEvent?.({ type: "warning", message: `文件 ${file.name} 无法解析，已从本次上下文排除。` });
    return undefined;
  }
  const relative = path.relative(canonicalRoot, canonicalTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    onEvent?.({ type: "warning", message: `文件 ${file.name} 位于项目工作区之外，未读取。` });
    return undefined;
  }
  // With an allow-list boundary, always read the canonical file. A caller
  // supplied content field may have been prepared through a symlink path and
  // must not bypass the realpath check.
  if (!allowedRoot && file.content !== undefined) return file.content;
  try {
    return await readFile(canonicalTarget, "utf8");
  } catch {
    onEvent?.({ type: "warning", message: `文件 ${file.name} 无法读取，已从本次上下文排除。` });
    return undefined;
  }
}

function isTextFile(file: RuntimeContext["files"][number]): boolean {
  if (file.mediaType.startsWith("text/")) return true;
  if (/json|csv|markdown|xml|yaml|toml|javascript|typescript|ecmascript|sql|x-sh|shell/.test(file.mediaType.toLowerCase())) return true;
  return /\.(md|markdown|txt|json|jsonl|csv|tsv|ya?ml|toml|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|java|go|rs|sql|sh|ps1|bat|cmd)$/i.test(file.name);
}

function renderStepInput(definition: ScenarioDefinition, step: ScenarioDefinition["steps"][number], requirement: string, context: RuntimeContext, source: string, upstream: string, slots?: Record<string, string>, guidance: string[] = []): string {
  const slotText = slots && Object.keys(slots).length ? `\n\n## 本次输入\n${Object.entries(slots).map(([key, value]) => `- ${key}: ${value}`).join("\n")}` : "";
  const guidanceText = guidance.length ? `\n\n## 用户运行中引导\n${guidance.map((item) => `- ${item}`).join("\n")}` : "";
  const checks = definition.checks.map((check, index) => `${index + 1}. ${check}`).join("\n");
  return [`# 场景：${definition.name}`, `## 总目标\n${requirement}`, `## 场景说明\n${definition.summary}`, `## 场景约束\n${definition.instructions}`, `## 验收标准\n${checks}`, `## 当前步骤：${step.title}`, step.capabilityId ? `## 优先能力\n${step.capabilityId}` : "", `要求：${step.instruction}`, `预期产出：${step.expectedOutput}`, `## 可用真实上下文\n${source}`, upstream, slotText, guidanceText].filter(Boolean).join("\n\n");
}

function renderArtifact(definition: ScenarioDefinition, requirement: string, context: RuntimeContext, source: { text: string; ids: string[] }, trace: WorkExecutionStep[], outputs: Record<string, string>, status: WorkExecutionStatus, error?: string, slots?: Record<string, string>): string {
  const lines = [`# ${definition.name}`, "", `- 运行状态：${status}`, `- 目标：${requirement}`, `- 项目：${context.projectId ?? "未选择项目"}`, `- 上下文来源：${source.ids.length ? source.ids.join(", ") : "无"}`, ...(slots && Object.keys(slots).length ? [`- 输入槽位：${JSON.stringify(slots)}`] : []), "", "## 验收标准", ...definition.checks.map((check, index) => `${index + 1}. ${check}`), ""];
  if (error) lines.push(`> 错误：${error}`, "");
  for (const step of trace) {
    lines.push(`## ${step.title}`, "", `状态：${step.status}`, `步骤 ID：${step.nodeId}`);
    const definitionStep = definition.steps.find((candidate) => candidate.id === step.nodeId);
    if (definitionStep) lines.push(`要求：${definitionStep.instruction}`, `预期产出：${definitionStep.expectedOutput}`);
    if (step.error) lines.push(`错误：${step.error}`);
    if (step.output) lines.push("", step.output);
    lines.push("");
  }
  if (status === "untested") {
    const note = error === "没有配置可用的 OpenAI-compatible Provider，以上仅为计划，未生成任务结果。"
      ? `模型 Provider 不可用，本文件只记录真实场景定义和待执行步骤；没有生成任务结果。${error}`
      : `没有形成可验证的任务结果。${error ?? "本文件记录了模型输出，但缺少真实执行证据。"}`;
    lines.push("## 说明", "", note, "");
  }
  if (status === "succeeded" && Object.keys(outputs).length === 0) lines.push("## 说明", "", "没有可交付输出。", "");
  return `${lines.join("\n").trim()}\n`;
}

async function persistArtifact(outputPath: string, content: string): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, content, "utf8");
}

function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [REDACTED]").slice(0, 1_000);
}

function hasExplicitEvidenceGap(text: string): boolean {
  return /(?:执行状态|执行结论|交付结论|状态)\s*[：:]\s*(?:未执行|无法确认|未验证|缺少)/u.test(text)
    || /(?:本次|当前|本轮|本项)[^。\n]{0,40}(?:未执行|无法确认|缺少真实|缺少必要|未提供真实)/u.test(text)
    || /(?:未执行事项|未读取[^。\n]{0,80}(?:真实文件|真实数据|目录)|未进行(?:数据|文件)[^。\n]{0,40}(?:清洗|读取|汇总|计算)|未落盘[^。\n]{0,40}(?:简报|结果)|无法生成(?:真实|实际))/u.test(text);
}

export function artifactChecksum(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
