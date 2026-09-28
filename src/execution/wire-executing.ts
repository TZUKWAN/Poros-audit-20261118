import { ScenarioError, ScenarioErrorCode } from "@/core/errors.js";
import type { BuildContext } from "@/orchestrator/context.js";
import { ClusterScheduler, inProcessDelegator, type ClusterEvent, type DelegationResult } from "./cluster.js";
import { CapabilityInstaller, CapabilityInvoker, processCommandRunner, type InstallRecord } from "./capability-runtime.js";
import type { PermissionGate } from "./capability-runtime.js";
import { RepairLoop } from "./repair.js";
import { RunController } from "./repair.js";
import type { Capability } from "@/federation/types.js";
import type { FederatedResult } from "@/federation/search.js";

/**
 * 阶段四装配：真实执行处理器（替换 2.3.6 桩）。
 * executing = ClusterScheduler（并行分组委托）→ 任务级验收（每节点 invoke 冒烟）
 *           → 失败走 RepairLoop 换型 → RunController checkpoint 节点间放行。
 */

export interface ExecutingDeps {
  /** 节点真实执行：给定能力与输入产出输出（生产=invoker.invoke；测试可注入） */
  invoke: (cap: Capability, action: string, inputs: Record<string, unknown>) => Promise<{ ok: boolean; output?: unknown; error?: string }>;
  /** 任务级验收判定（阶段五替换为完整体系；缺省=invoke ok） */
  taskAcceptance?: (nodeId: string, result: DelegationResult) => boolean;
  controller?: RunController;
  onClusterEvent?: (event: ClusterEvent) => void;
  permission?: PermissionGate;
  search?: (query: string, limit?: number) => Promise<FederatedResult>;
}

export function makeNodeExecutor(deps: ExecutingDeps) {
  return async (request: { nodeId: string; capability: Capability; inputs: Record<string, unknown>; title: string }) => {
    const action = nodeAction(request.capability, request.title);
    return await deps.invoke(request.capability, action, request.inputs);
  };
}

function nodeAction(cap: Capability, title: string): string {
  // 能力动作名：远程 MCP 用 tools/call 的 name —— 以能力名为主（聚合源名称即工具域）
  void title;
  return cap.name.replace(/\s+/g, "-").toLowerCase();
}

/** 真实 executing 处理器（注入 orchestrator deps.execute） */
export async function handleExecutingReal(ctx: BuildContext, deps: ExecutingDeps): Promise<void> {
  if (!ctx.dag || !ctx.assembly) {
    throw new ScenarioError({ code: ScenarioErrorCode.CONTEXT_CORRUPT, message: "executing without dag/assembly", phase: "executing" });
  }
  const controller = deps.controller ?? new RunController();
  const capsById = new Map<string, Capability>();
  for (const set of ctx.candidates as Array<{ nodeId: string; candidates: Capability[] }>) {
    for (const c of set.candidates) capsById.set(c.id, c);
  }
  const installer = new CapabilityInstaller({ runner: processCommandRunner() });
  // 生产默认：真实 invoker（remote JSON-RPC / npx stdio / skill 注入）；测试可注入 deps.invoke 覆盖
  const invoker = new CapabilityInvoker(deps.permission);
  const invoke = deps.invoke ?? ((cap: Capability, action: string, inputs: Record<string, unknown>) => invoker.invoke(cap, action, inputs));

  const delegator = inProcessDelegator(async (req) => {
    // 远程优先免安装；其余先安装（权限门控在 installer 内）
    await installer.install(req.capability, deps.permission);
    const invoked = await invoke(req.capability, nodeAction(req.capability, req.title), req.inputs);
    const passed = deps.taskAcceptance ? deps.taskAcceptance(req.nodeId, { nodeId: req.nodeId, ok: invoked.ok, output: invoked.output, error: invoked.error, durationMs: 0 }) : invoked.ok;
    return {
      nodeId: req.nodeId,
      ok: passed,
      output: invoked.output,
      error: invoked.error,
      durationMs: 0,
      params: req.inputs,
    };
  });

  // 节点间放行：checkpoint 在 delegator 前由调度层调用 —— 这里包装 onEvent 不可行，
  // 直接在执行前对每个节点 checkpoint（ClusterScheduler 的并发层内逐 worker 执行）
  const scheduler = new ClusterScheduler(
    {
      delegate: async (req) => {
        await controller.checkpoint();
        return await delegator.delegate(req);
      },
    },
    ctx,
  );

  const summary = await scheduler.run({ onEvent: deps.onClusterEvent });
  const failedNode = summary.steps.find((s) => s.status === "failed");

  if (failedNode && summary.allPassed === false) {
    // 3.3.1 自动修复回路：trust 次优换型重试（每失败节点一次 repair 会话）
    const repair = new RepairLoop({
      candidatesFor: (nodeId) => {
        const set = (ctx.candidates as Array<{ nodeId: string; candidates: Capability[] }>).find((s) => s.nodeId === nodeId);
        return set?.candidates ?? [];
      },
      runNode: async (nodeId, capabilityId) => {
        const cap = capsById.get(capabilityId);
        if (!cap) return { passed: false, error: "missing capability" };
        await controller.checkpoint();
        const r = await deps.invoke(cap, nodeAction(cap, nodeId), {});
        return { passed: r.ok, error: r.error };
      },
      maxRounds: 3,
    });
    const outcome = await repair.repairNode(ctx, failedNode.nodeId);
    ctx.acceptance.push({
      layer: "task",
      passed: outcome.repaired,
      detail: { repaired: outcome.repaired, escalated: outcome.escalated, attempts: outcome.attempts },
      at: new Date().toISOString(),
    });
    if (!outcome.repaired) {
      // 自主模式：记录并终止该次执行（不挂死）
      throw new ScenarioError({
        code: ScenarioErrorCode.ACCEPTANCE_FAILED,
        message: `node ${failedNode.nodeId} failed after repair escalation`,
        phase: "executing",
        context: { attempts: outcome.attempts.length },
      });
    }
    return;
  }

  ctx.acceptance.push({
    layer: "task",
    passed: summary.allPassed,
    detail: { nodes: summary.steps.map((s) => ({ nodeId: s.nodeId, status: s.status })) },
    at: new Date().toISOString(),
  });
  void installer;
}

export type { InstallRecord };
