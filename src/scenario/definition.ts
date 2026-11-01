import { z } from "zod";
import { topoSort } from "@/orchestrator/dag.js";

export const ScenarioDefinitionSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  name: z.string().trim().min(1).max(80),
  summary: z.string().trim().min(1).max(600),
  instructions: z.string().trim().min(1).max(8000),
  inputs: z.array(z.object({ name: z.string().trim().min(1).max(80), description: z.string().max(300), required: z.boolean().default(false), type: z.enum(["string", "path", "url", "number"]).default("string") })).max(20).default([]),
  steps: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]+$/).max(50), title: z.string().trim().min(1).max(200), instruction: z.string().trim().min(1).max(4000), deps: z.array(z.string()).default([]), expectedOutput: z.string().trim().min(1).max(400), capabilityId: z.string().nullable().default(null) })).min(1).max(12),
  checks: z.array(z.string().trim().min(1).max(500)).min(1).max(12),
  generatedBy: z.enum(["model", "local"]),
  model: z.string().nullable().default(null),
  validation: z.object({ definition: z.literal("passed"), execution: z.enum(["untested", "passed", "failed"]).default("untested"), lastRunId: z.string().nullable().default(null) }).default({ definition: "passed", execution: "untested", lastRunId: null }),
});
export type ScenarioDefinition = z.infer<typeof ScenarioDefinitionSchema>;

export function validateDefinition(value: unknown): ScenarioDefinition {
  const definition = ScenarioDefinitionSchema.parse(value);
  const ids = definition.steps.map((step) => step.id);
  if (new Set(ids).size !== ids.length) throw new Error("步骤编号重复，请重新规划。");
  const inputNames = definition.inputs.map((input) => input.name);
  if (new Set(inputNames).size !== inputNames.length) throw new Error("输入名称重复，请重新规划。");
  topoSort({ nodes: definition.steps.map((step) => ({ id: step.id, title: step.title, deps: step.deps, expectedOutput: step.expectedOutput })) });
  return definition;
}

/** 离线场景是一份真实的可加载操作定义；不声称模型已规划或任务已运行。 */
export function localDefinition(requirement: string): ScenarioDefinition {
  const clean = requirement.trim();
  const name = clean.replace(/^(请|帮我)?(构建|创建|建立|做)(一个|一份)?/, "").slice(0, 60) || clean.slice(0, 60);
  return validateDefinition({
    name, summary: clean,
    instructions: `目标：${clean}\n使用用户提供的真实资料；缺少信息时明确指出；产出与输入可追溯，不能虚构来源、执行结果、统计显著性或测试通过。`,
    inputs: [{ name: "materials", description: "工作时提供的资料或具体要求，可上传项目文件", required: false, type: "string" }],
    steps: [
      { id: "prepare", title: "阅读输入资料", instruction: "阅读本次请求和项目资料，明确目标、可用证据及缺少的信息。不要编造资料。", deps: [], expectedOutput: "资料要点与工作要求" },
      { id: "produce", title: "完成目标内容", instruction: `根据真实资料完成这项工作：${clean}。若需要尚未接入的外部工具或代码执行，请交付可执行说明并明确未执行，不能声称已执行。`, deps: ["prepare"], expectedOutput: "可直接使用的内容或明确的待执行说明" },
      { id: "review", title: "检查并交付", instruction: "核对上一步与目标及原始输入，修正可避免错误，给出最终完整交付物；列出缺少的证据或未执行事项，禁止硬性保证显著性。", deps: ["produce"], expectedOutput: "最终交付与必要的限制说明" },
    ],
    checks: ["回答对应本次目标", "所有事实和计算能对应到真实输入", "未执行或缺少证据的事项明确说明"],
    generatedBy: "local", model: null,
  });
}
