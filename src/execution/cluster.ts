import { ScenarioError, ScenarioErrorCode } from "@/core/errors.js";
import type { BuildContext, ExecutionStep } from "@/orchestrator/context.js";
import type { Capability } from "@/federation/types.js";

/**
 * 4.1 子Agent集群（pi-subagents 语义的可注入实现）：
 *  - Delegator 接口：把单个 DAG 节点委托给一个 worker（pi-subagents 运行时注入真实现；
 *    测试与无 pi 环境用 InProcessDelegator）。
 *  - 递归深度=1：worker 收到的工具集中不含"构建场景"类工具（depth guard 拒绝路径）。
 *  - 结果回流父级验收。
 */

export interface DelegationRequest {
  nodeId: string;
  capability: Capability;
  title: string;
  expectedOutput: string;
  /** 上游节点输出（接口对齐后的输入） */
  inputs: Record<string, unknown>;
  depth: number;
}

export interface DelegationResult {
  nodeId: string;
  ok: boolean;
  output?: unknown;
  error?: string;
  durationMs: number;
  /** worker 实际使用的参数（蒸馏槽位化原料） */
  params?: Record<string, unknown>;
  mode?: "executed" | "context" | "delegated";
}

export interface Delegator {
  delegate(request: DelegationRequest): Promise<DelegationResult>;
}

/** 递归深度上限：子 Agent 不得再发起构建请求（4.1.2） */
export const MAX_DELEGATION_DEPTH = 1;

export function assertDelegationDepth(request: DelegationRequest): void {
  if (request.depth > MAX_DELEGATION_DEPTH) {
    throw new ScenarioError({
      code: ScenarioErrorCode.DEPTH_EXCEEDED,
      message: `delegation depth ${request.depth} exceeds limit ${MAX_DELEGATION_DEPTH} (worker cannot nest builds)`,
      phase: "executing",
      context: { nodeId: request.nodeId },
    });
  }
  if (request.capability.kind === "skill-knowledge") {
    throw new ScenarioError({
      code: ScenarioErrorCode.DEPTH_EXCEEDED,
      message: "skill-knowledge capabilities are context-injected, not delegable workers",
      phase: "executing",
      context: { nodeId: request.nodeId },
    });
  }
}

/** 进程内委托器：经能力运行时真实调用（invoke 见 capability-runtime.ts），生产实现同路径 */
export type NodeExecutor = (request: DelegationRequest) => Promise<DelegationResult>;

export function inProcessDelegator(executor: NodeExecutor): Delegator {
  return {
    async delegate(request: DelegationRequest): Promise<DelegationResult> {
      assertDelegationDepth(request);
      return await executor(request);
    },
  };
}

/** 集群监控事件（4.1.3）：状态 → 事件总线 */
export type ClusterEvent =
  | { type: "worker:started"; nodeId: string; capabilityId: string }
  | { type: "worker:finished"; nodeId: string; ok: true; durationMs: number }
  | { type: "worker:failed"; nodeId: string; ok: false; error: string; willRetry: boolean };

export type ClusterEventListener = (event: ClusterEvent) => void;

export interface ClusterRunOptions {
  concurrency?: number;
  onEvent?: ClusterEventListener;
  signal?: AbortSignal;
  /** Re-run only failed/blocked nodes while reusing successful outputs. */
  resumeFromTrace?: boolean;
}

export interface ClusterRunSummary {
  steps: ExecutionStep[];
  allPassed: boolean;
  wallMs: number;
}

/**
 * 集群调度：DAG 拓扑层并发执行（parallelGroups 分层，层内并发受 concurrency 限制）。
 * 上游输出按边对齐喂给下游（inputs 集合）。
 */
export class ClusterScheduler {
  constructor(
    private delegator: Delegator,
    private ctx: BuildContext,
  ) {}

  async run(options: ClusterRunOptions = {}): Promise<ClusterRunSummary> {
    const startedWall = Date.now();
    const { parallelGroups } = await import("@/orchestrator/dag.js");
    if (!this.ctx.dag || !this.ctx.assembly) {
      throw new ScenarioError({ code: ScenarioErrorCode.CONTEXT_CORRUPT, message: "cluster run without dag/assembly", phase: "executing" });
    }
    if (this.ctx.dag.nodes.length === 0 || this.ctx.assembly.nodes.length === 0) {
      throw new ScenarioError({ code: ScenarioErrorCode.VALIDATION, message: "cluster run requires at least one DAG node", phase: "executing" });
    }
    const capsById = new Map<string, Capability>();
    for (const set of this.ctx.candidates as Array<{ nodeId: string; candidates: Capability[] }>) {
      for (const c of set.candidates) capsById.set(c.id, c);
    }
    const assembly = this.ctx.assembly as { nodes: Array<{ nodeId: string; capabilityId: string }>; edges: Array<{ from: string; to: string }> };
    const capOfNode = (nodeId: string): Capability | undefined => {
      const sel = this.ctx.selections.find((s) => s.nodeId === nodeId);
      return sel ? capsById.get(sel.capabilityId) : undefined;
    };
    const previousTrace = options.resumeFromTrace ? [...(this.ctx.trace as ExecutionStep[])] : [];
    const outputs = new Map<string, unknown>();
    for (const step of previousTrace) {
      if (step.status === "success") outputs.set(step.nodeId, step.output);
    }
    const steps: ExecutionStep[] = options.resumeFromTrace ? [] : (this.ctx.trace as ExecutionStep[]);
    if (options.resumeFromTrace) this.ctx.trace = steps;

    for (const group of parallelGroups(this.ctx.dag)) {
      if (options.signal?.aborted) break;
      // 层内并发
      const queue = [...group];
      const workers = Array.from({ length: Math.min(options.concurrency ?? group.length, queue.length) }, async () => {
        while (queue.length > 0 && !options.signal?.aborted) {
          const nodeId = queue.shift();
          if (!nodeId) break;
          const capability = capOfNode(nodeId);
          const node = this.ctx.dag?.nodes.find((n) => n.id === nodeId);
          if (!capability || !node) {
            steps.push({ nodeId, startedAt: new Date().toISOString(), status: "skipped" });
            continue;
          }
          const prior = previousTrace.find((step) => step.nodeId === nodeId && step.status === "success" && step.capabilityId === capability.id);
          if (options.resumeFromTrace && prior) {
            // Preserve the successful result and avoid repeating an external
            // side effect while retrying a downstream failure.
            steps.push({ ...prior });
            options.onEvent?.({ type: "worker:finished", nodeId, ok: true, durationMs: 0 });
            continue;
          }
          // Never run a dependent node when an upstream node failed or was
          // skipped. Passing `undefined` as an upstream result can trigger
          // destructive side effects and used to make a run look partially
          // successful even though its DAG was broken.
          const blockedBy = node.deps.find((dep) => {
            const upstream = steps.find((step) => step.nodeId === dep);
            return !upstream || upstream.status !== "success";
          });
          if (blockedBy) {
            const blockedAt = new Date().toISOString();
            const error = `upstream node ${blockedBy} did not complete successfully`;
            steps.push({ nodeId, startedAt: blockedAt, finishedAt: blockedAt, status: "failed", error });
            options.onEvent?.({ type: "worker:failed", nodeId, ok: false, error, willRetry: false });
            continue;
          }
          // 上游输出按边收集
          const inputs: Record<string, unknown> = {};
          for (const e of assembly.edges.filter((e) => e.to === nodeId)) {
            inputs[e.from] = outputs.get(e.from);
          }
          options.onEvent?.({ type: "worker:started", nodeId, capabilityId: capability.id });
          const t0 = Date.now();
          const step: ExecutionStep = { nodeId, startedAt: new Date().toISOString(), status: "running", params: inputs };
          steps.push(step);
          try {
            const result = await this.delegator.delegate({
              nodeId,
              capability,
              title: node.title,
              expectedOutput: node.expectedOutput,
              inputs,
              depth: 1,
            });
            step.finishedAt = new Date().toISOString();
            step.status = result.mode === "delegated" ? "delegated" : result.ok ? "success" : "failed";
            step.output = result.output;
            step.error = result.error;
            step.params = result.params ?? inputs;
            if (result.ok) {
              outputs.set(nodeId, result.output);
              options.onEvent?.({ type: "worker:finished", nodeId, ok: true, durationMs: result.durationMs });
            } else {
              options.onEvent?.({ type: "worker:failed", nodeId, ok: false, error: result.error ?? "unknown", willRetry: false });
            }
            void t0;
          } catch (err) {
            step.finishedAt = new Date().toISOString();
            step.status = "failed";
            step.error = err instanceof Error ? err.message : String(err);
            options.onEvent?.({ type: "worker:failed", nodeId, ok: false, error: step.error, willRetry: false });
          }
        }
      });
      await Promise.all(workers);
    }

    const nodeSteps = steps.filter((s) => s.status !== undefined);
    return {
      steps,
      allPassed: this.ctx.dag.nodes.every((n) => steps.find((s) => s.nodeId === n.id)?.status === "success"),
      wallMs: Date.now() - startedWall,
      ...(nodeSteps.length >= 0 ? {} : {}),
    };
  }
}
