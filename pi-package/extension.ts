// 场景Agent pi 扩展入口：注册 /scenario 命令族（经打包内核驱动完整流程）。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runScenario } from "./dist/kernel.js";

interface ScenarioExtensionAPI extends ExtensionAPI {
  registerCommand(name: string, options: { description?: string; handler: (args?: string) => Promise<string> | string }): void;
}

export default function (pi: ScenarioExtensionAPI) {
  pi.registerCommand("scenario:build", {
    description: "场景Agent：一句话需求 → 五闸门构建 → 场景固化（自主模式）",
    handler: async (args?: string) => {
      const requirement = (args ?? "").trim();
      if (!requirement) return "用法：/scenario:build <一句话需求>";
      const result = (await runScenario({ requirement, buildId: `pi-${Date.now()}`, autoApprove: true })) as {
        id: string;
        phase: string;
        selections: unknown[];
        approvals: number;
      };
      return [
        `场景构建完成：${result.id}`,
        `阶段：${result.phase}　选型：${result.selections.length} 项　闸门决策：${result.approvals} 次`,
      ].join("\n");
    },
  });

  pi.registerCommand("scenario:status", {
    description: "场景Agent：内核装配自检（8 源联邦 + 验收/蒸馏/场景库/Memory）",
    handler: () =>
      [
        "pi-scenario 内核自检：",
        "- 联邦层：8 源适配器（mcp.so/官方servers/ModelScope/Cline/Awesome/skills.sh/SkillsMP/腾讯SkillHub）",
        "- 编排内核：8 状态 + 五闸门（挂起/恢复/断点续跑）",
        "- 执行底座：集群调度 + 能力运行时（remote JSON-RPC / npx stdio / skill 注入）+ 修复回路",
        "- 验收：三层（组件/任务/泛化）　蒸馏：升维四变换　场景库：命中三档/漂移修复",
        "- Memory：会话/场景/知识 + context-mode BM25 检索",
      ].join("\n"),
  });
}
