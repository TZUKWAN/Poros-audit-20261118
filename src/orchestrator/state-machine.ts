import { EventEmitter } from "node:events";
import { z } from "zod";
import { ScenarioError, ScenarioErrorCode } from "@/core/errors.js";
import type { EventBus } from "@/core/events.js";
import { BuildContextSchema, newBuildContext, type BuildContext } from "./context.js";

/**
 * 2.1.2 编排内核状态机：8 工作状态 + idle 起点（DECISIONS D11）。
 * 线性主干：parsing → planning → retrieving → assembling → verifying → executing → distilling → done
 * 闸门挂点：parsing→(gate1)→planning→(gate2)→retrieving→(gate3)→assembling→verifying→(gate4)→executing→distilling→(gate5)→done
 * 驳回：GateDecision.reject{targetPhase} 回退到任意更早阶段。
 */

export const WORK_STATES = ["parsing", "planning", "retrieving", "assembling", "verifying", "executing", "distilling", "done"] as const;
export type WorkState = (typeof WORK_STATES)[number];

/** 状态出闸门映射：离开 X 状态前需通过对应闸门（无闸门为 0） */
export const GATE_ON_EXIT: Record<WorkState, 0 | 1 | 2 | 3 | 4 | 5> = {
  parsing: 1,
  planning: 2,
  retrieving: 3,
  assembling: 0,
  verifying: 4,
  executing: 0,
  distilling: 5,
  done: 0,
};

/** 合法转换表：主干前进 + 驳回回退（done 为终态，不可再离开） */
export function isLegalTransition(from: WorkState, to: WorkState): boolean {
  if (from === "done") return false;
  const fi = WORK_STATES.indexOf(from);
  const ti = WORK_STATES.indexOf(to);
  if (ti === fi + 1) return true; // 主干前进
  if (ti >= 0 && ti < fi) return true; // 驳回回退（具体闸门合法性在 decide() 校验）
  return false;
}

export const GateDecisionSchema = z.object({
  gate: z.number().int().min(1).max(5),
  action: z.enum(["approve", "reject"]),
  /** reject 必填：回退目标阶段 */
  targetPhase: z.enum(["parsing", "planning", "retrieving", "assembling", "verifying", "executing", "distilling"]).optional(),
  comment: z.string().optional(),
});
export type GateDecision = z.infer<typeof GateDecisionSchema>;

export interface GateRequest {
  gate: 1 | 2 | 3 | 4 | 5;
  phase: WorkState;
  /** 闸门负载：g1=intent, g2=dag, g3=candidates, g4=assembly+acceptance, g5=distill preview */
  payload: unknown;
  context: BuildContext;
}

export interface OrchestratorEvents {
  "state:enter": { from: WorkState | "idle"; to: WorkState; context: BuildContext };
  "state:exit": { from: WorkState; to: WorkState | "done"; context: BuildContext };
  "gate:pending": { request: GateRequest };
  "gate:decided": { decision: GateDecision; context: BuildContext };
  "run:done": { context: BuildContext };
}

export interface OrchestratorDeps {
  /** 各阶段处理器：输入当前 context（可变），返回下一个状态（或由 run 循环推进） */
  handlers: {
    parsing(ctx: BuildContext): Promise<void>;
    planning(ctx: BuildContext): Promise<void>;
    retrieving(ctx: BuildContext): Promise<void>;
    assembling(ctx: BuildContext): Promise<void>;
    verifying(ctx: BuildContext): Promise<void>;
    executing(ctx: BuildContext): Promise<void>;
    distilling(ctx: BuildContext): Promise<void>;
  };
  /** 断点持久化（每闸门后与每状态迁移后调用） */
  persist(ctx: BuildContext): Promise<void>;
  events?: EventBus<Record<string, unknown>>;
  now?: () => Date;
}

export class Orchestrator {
  private context: BuildContext;
  private readonly emitter = new EventEmitter();
  private decideResolve: ((d: GateDecision) => void) | undefined;
  private abortController = new AbortController();
  private running = false;

  constructor(private deps: OrchestratorDeps, context?: BuildContext) {
    this.context = context ?? newBuildContext(`build-${Date.now()}-0`, "");
  }

  get ctx(): BuildContext {
    return structuredCloneShallow(this.context);
  }

  get state(): WorkState {
    return this.context.phase as WorkState;
  }

  /** 从 BuildContext 恢复（断点续跑/崩溃恢复） */
  static restore(context: unknown, deps: OrchestratorDeps): Orchestrator {
    const parsed = BuildContextSchema.safeParse(context);
    if (!parsed.success) {
      throw new ScenarioError({
        code: ScenarioErrorCode.CONTEXT_CORRUPT,
        message: "BuildContext restore failed schema validation",
        phase: "infra",
        context: { issues: parsed.error.issues.slice(0, 5) },
      });
    }
    return new Orchestrator(deps, parsed.data);
  }

  start(requirement: string, id?: string): void {
    if (this.running) {
      throw new ScenarioError({ code: ScenarioErrorCode.CONFLICT, message: "orchestrator already running", phase: "infra" });
    }
    this.context = newBuildContext(id ?? `build-${Date.now()}`, requirement);
  }

  /** 驱动到下一个闸门或 done。挂起时 resolve runPromise 之前先 emit gate:pending。 */
  async run(): Promise<BuildContext> {
    this.running = true;
    try {
      while (this.context.phase !== "done") {
        this.assertNotAborted();
        const state = this.context.phase as WorkState;
        if (!WORK_STATES.includes(state)) {
          throw new ScenarioError({ code: ScenarioErrorCode.CONTEXT_CORRUPT, message: `unknown phase ${state}`, phase: "infra" });
        }
        // 1. 执行当前阶段处理器
        await this.deps.handlers[state as Exclude<WorkState, "done">](this.context);
        this.touch();
        // 2. 出闸门检查
        const gate = GATE_ON_EXIT[state];
        if (gate !== 0) {
          this.context.pendingGate = gate;
          // 先建决策 promise 再发事件：决策方（虚拟用户/真人 UI）可能在 emit 回调里同步 decide()
          const decisionPromise = this.waitForDecision();
          const request: GateRequest = {
            gate: gate,
            phase: state,
            payload: gatePayload(gate, this.context),
            context: this.ctx,
          };
          this.emitter.emit("gate:pending", { request });
          await this.deps.persist(this.context);
          const decision = await decisionPromise;
          this.applyDecision(decision, state);
          this.context.pendingGate = null;
          await this.deps.persist(this.context);
          if (decision.action === "reject") {
            continue; // 回退后重新跑目标阶段
          }
        }
        // 3. 前进（驳回路径已在上方 continue）
        const next = WORK_STATES[WORK_STATES.indexOf(state) + 1];
        if (next) {
          this.transition(state, next);
          await this.deps.persist(this.context);
        }
      }
      this.emitter.emit("run:done", { context: this.ctx });
      return this.ctx;
    } finally {
      this.running = false;
    }
  }

  /** 闸门决策（挂起/恢复机制 2.1.3） */
  async decide(decision: GateDecision): Promise<void> {
    const parsed = GateDecisionSchema.safeParse(decision);
    if (!parsed.success) {
      throw new ScenarioError({
        code: ScenarioErrorCode.VALIDATION,
        message: "invalid GateDecision",
        phase: "infra",
        context: { issues: parsed.error.issues.slice(0, 3) },
      });
    }
    if (parsed.data.action === "reject") {
      if (!parsed.data.targetPhase) {
        throw new ScenarioError({ code: ScenarioErrorCode.VALIDATION, message: "reject requires targetPhase", phase: "infra" });
      }
      const currentIdx = WORK_STATES.indexOf(this.context.phase as WorkState);
      const targetIdx = WORK_STATES.indexOf(parsed.data.targetPhase);
      if (targetIdx < 0 || targetIdx > currentIdx) {
        throw new ScenarioError({
          code: ScenarioErrorCode.ILLEGAL_TRANSITION,
          message: `reject target ${parsed.data.targetPhase} is not before current ${this.context.phase}`,
          phase: "infra",
        });
      }
    }
    const resolve = this.decideResolve;
    if (!resolve) {
      throw new ScenarioError({ code: ScenarioErrorCode.CONFLICT, message: "no gate pending", phase: "infra" });
    }
    this.decideResolve = undefined;
    resolve(parsed.data);
  }

  on<K extends keyof OrchestratorEvents>(event: K, handler: (data: OrchestratorEvents[K]) => void): () => void {
    this.emitter.on(event, handler);
    return () => this.emitter.off(event, handler);
  }

  waitForGate(): Promise<GateRequest> {
    return new Promise((resolve) => this.emitter.once("gate:pending", (r: { request: GateRequest }) => resolve(r.request)));
  }

  abort(): void {
    this.abortController.abort();
  }

  private applyDecision(decision: GateDecision, fromState: WorkState): void {
    this.context.approvals.push({
      gate: decision.gate,
      action: decision.action,
      targetPhase: decision.targetPhase,
      comment: decision.comment,
      decidedBy: "virtual-user",
      decidedAt: (this.deps.now ?? (() => new Date()))().toISOString(),
    });
    if (decision.action === "reject") {
      const target = decision.targetPhase as WorkState;
      if (target !== fromState) {
        this.transition(fromState, target, `rejected gate ${decision.gate}: ${decision.comment ?? ""}`);
      } else {
        // 同阶段驳回：重跑该阶段（发出重进入事件供 UI/日志观测）
        this.emitter.emit("state:enter", { from: target, to: target, context: this.ctx });
      }
    } else {
      this.emitter.emit("gate:decided", { decision, context: this.ctx });
    }
  }

  private transition(from: WorkState, to: WorkState, reason?: string): void {
    if (!isLegalTransition(from, to)) {
      throw new ScenarioError({
        code: ScenarioErrorCode.ILLEGAL_TRANSITION,
        message: `illegal transition ${from} → ${to}${reason ? ` (${reason})` : ""}`,
        phase: "infra",
        context: { from, to, reason },
      });
    }
    this.emitter.emit("state:exit", { from, to, context: this.ctx });
    this.context.phase = to;
    this.touch();
    this.emitter.emit("state:enter", { from, to, context: this.ctx });
  }

  private async waitForDecision(): Promise<GateDecision> {
    return await new Promise<GateDecision>((resolve, reject) => {
      const onAbort = () => {
        reject(new ScenarioError({ code: ScenarioErrorCode.CANCELLED, message: "orchestrator aborted while waiting for gate decision", phase: "infra" }));
      };
      if (this.abortController.signal.aborted) {
        onAbort();
        return;
      }
      this.abortController.signal.addEventListener("abort", onAbort, { once: true });
      this.decideResolve = (d) => {
        this.abortController.signal.removeEventListener("abort", onAbort);
        resolve(d);
      };
    });
  }

  private assertNotAborted(): void {
    if (this.abortController.signal.aborted) {
      throw new ScenarioError({ code: ScenarioErrorCode.CANCELLED, message: "orchestrator aborted", phase: "infra" });
    }
  }

  private touch(): void {
    this.context.updatedAt = (this.deps.now ?? (() => new Date()))().toISOString();
  }
}

export function gatePayload(gate: 1 | 2 | 3 | 4 | 5, ctx: BuildContext): unknown {
  switch (gate) {
    case 1:
      return ctx.intent;
    case 2:
      return ctx.dag;
    case 3:
      return ctx.candidates;
    case 4:
      return { assembly: ctx.assembly, acceptance: ctx.acceptance };
    case 5:
      return { intent: ctx.intent, trace: ctx.trace, acceptance: ctx.acceptance };
  }
}

function structuredCloneShallow(ctx: BuildContext): BuildContext {
  return JSON.parse(JSON.stringify(ctx)) as BuildContext;
}

/** 供 zod 之外的快速校验（外部载入前） */
export function validateContextRaw(raw: unknown): BuildContext {
  return BuildContextSchema.parse(raw);
}
