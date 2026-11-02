import { EventEmitter } from "node:events";
import { z } from "zod";
import { ScenarioError, ScenarioErrorCode } from "@/core/errors.js";
import type { EventBus } from "@/core/events.js";
import {
  AcceptanceRecordSchema,
  BuildContextSchema,
  DagSchema,
  FinalizeChoiceSchema,
  IntentSchema,
  SelectionSchema,
  newBuildContext,
  type RuntimeContext,
  type BuildContext,
  type BuildClarification,
} from "./context.js";

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
  action: z.enum(["approve", "reject", "edit"]),
  /** reject 必填：回退目标阶段 */
  targetPhase: z.enum(["parsing", "planning", "retrieving", "assembling", "verifying", "executing", "distilling"]).optional(),
  comment: z.string().optional(),
  edit: z
    .discriminatedUnion("kind", [
      z.object({
        kind: z.literal("intent"),
        intent: IntentSchema,
      }),
      z.object({
        kind: z.literal("dag"),
        dag: DagSchema,
      }),
      z.object({
        kind: z.literal("selections"),
        selections: z.array(SelectionSchema),
      }),
      z.object({
        kind: z.literal("acceptance"),
        acceptance: z.array(AcceptanceRecordSchema),
      }),
    ])
    .optional(),
  choice: FinalizeChoiceSchema.optional(),
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
  "gate:edited": { decision: GateDecision; context: BuildContext };
  "run:done": { context: BuildContext };
  "user:pending": { request: BuildClarification; context: BuildContext };
  "user:answered": { values: Record<string, string>; context: BuildContext };
}

/** A handler can suspend construction only by returning this structured signal. */
export class BuildAwaitingUserError extends Error {
  readonly code = "BUILD_AWAITING_USER" as const;
  constructor(readonly request: Omit<BuildClarification, "source" | "createdAt">) {
    super(request.question);
    this.name = "BuildAwaitingUserError";
  }
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
  private decideResolve: ((d: { decision: GateDecision; decidedBy: "human" | "virtual-user" }) => void) | undefined;
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

  start(requirement: string, id?: string, runtimeContext: RuntimeContext | null = null, executionMode: "run" | "construction" = "run"): void {
    if (this.running) {
      throw new ScenarioError({ code: ScenarioErrorCode.CONFLICT, message: "orchestrator already running", phase: "infra" });
    }
    // AbortController is one-shot. Reset it so an instance can be reused
    // safely after a cancelled run.
    this.abortController = new AbortController();
    this.context = newBuildContext(id ?? `build-${Date.now()}`, requirement, new Date().toISOString(), runtimeContext, executionMode);
  }

  /** 驱动到下一个闸门或 done。挂起时 resolve runPromise 之前先 emit gate:pending。 */
  async run(): Promise<BuildContext> {
    if (this.running) {
      throw new ScenarioError({ code: ScenarioErrorCode.CONFLICT, message: "orchestrator is already running", phase: "infra" });
    }
    this.running = true;
    try {
      // A restored build must remain suspended until the explicit answer API
      // clears the durable request. Never rerun a model with missing context.
      if (this.context.awaitingUser) return this.ctx;
      while (this.context.phase !== "done") {
        this.assertNotAborted();
        const state = this.context.phase as WorkState;
        if (!WORK_STATES.includes(state)) {
          throw new ScenarioError({ code: ScenarioErrorCode.CONTEXT_CORRUPT, message: `unknown phase ${state}`, phase: "infra" });
        }
        // 1. 执行当前阶段处理器
        // 如果是从闸门挂起点恢复，阶段处理器已经成功执行过，直接重新
        // 展示当前闸门即可；否则重跑会重复追加验收记录或重复调用能力。
        const resumedGate = this.context.pendingGate !== null && GATE_ON_EXIT[state] === this.context.pendingGate;
        if (!resumedGate) await this.deps.handlers[state as Exclude<WorkState, "done">](this.context);
        else await Promise.resolve();
        this.touch();
        // 2. 出闸门检查
        const gate = GATE_ON_EXIT[state];
        if (gate !== 0) {
          this.context.pendingGate = gate;
          let decision: GateDecision;
          do {
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
            const resolved = await decisionPromise;
            decision = resolved.decision;
            this.applyDecision(decision, state, resolved.decidedBy);
            await this.deps.persist(this.context);
          } while (decision.action === "edit");
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
      if (this.context.finalizeChoice !== "discard") {
        const accepted = this.context.acceptance.length > 0 && this.context.acceptance.every((record) => record.passed);
        const expectedNodes = this.context.assembly?.nodes.map((node) => node.nodeId) ?? [];
        const executed = expectedNodes.length > 0 && expectedNodes.every((nodeId) => {
          const step = this.context.trace.find((candidate) => candidate.nodeId === nodeId);
          return step?.status === "success" || step?.status === "skipped" || (this.context.executionMode === "construction" && step?.status === "planned");
        });
        this.context.outcome = accepted && executed ? "completed" : "failed";
      }
      this.emitter.emit("run:done", { context: this.ctx });
      return this.ctx;
    } catch (error) {
      if (error instanceof BuildAwaitingUserError) {
        this.context.awaitingUser = {
          ...error.request,
          source: "model",
          createdAt: (this.deps.now ?? (() => new Date()))().toISOString(),
        };
        this.context.outcome = "running";
        this.touch();
        await this.deps.persist(this.context);
        this.emitter.emit("user:pending", { request: this.context.awaitingUser, context: this.ctx });
        return this.ctx;
      }
      if (this.context.finalizeChoice !== "discard") {
        this.context.outcome = "failed";
        this.touch();
        await this.deps.persist(this.context).catch(() => undefined);
      }
      throw error;
    } finally {
      this.running = false;
    }
  }

  /**
   * Supply an answer to a persisted model clarification. The phase remains at
   * the point that requested it, so the next run() call retries only that
   * phase and downstream state is not guessed or silently skipped.
   */
  async answerAwaitingUser(values: Record<string, string>): Promise<void> {
    const request = this.context.awaitingUser;
    if (!request) {
      throw new ScenarioError({ code: ScenarioErrorCode.CONFLICT, message: "no build clarification is pending", phase: "infra" });
    }
    const normalized = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value).trim()]));
    const missing = request.inputs.filter((input) => !normalized[input.name]);
    if (missing.length > 0) {
      throw new ScenarioError({ code: ScenarioErrorCode.VALIDATION, message: `missing clarification input: ${missing.map((input) => input.name).join(", ")}`, phase: request.phase });
    }
    this.context.clarificationAnswers = { ...this.context.clarificationAnswers, ...normalized };
    this.context.awaitingUser = null;
    this.context.outcome = "running";
    this.touch();
    await this.deps.persist(this.context);
    this.emitter.emit("user:answered", { values: normalized, context: this.ctx });
  }

  /** 闸门决策（挂起/恢复机制 2.1.3） */
  async decide(decision: GateDecision, decidedBy: "human" | "virtual-user" = "human"): Promise<void> {
    const parsed = GateDecisionSchema.safeParse(decision);
    if (!parsed.success) {
      throw new ScenarioError({
        code: ScenarioErrorCode.VALIDATION,
        message: "invalid GateDecision",
        phase: "infra",
        context: { issues: parsed.error.issues.slice(0, 3) },
      });
    }
    if (parsed.data.gate !== this.context.pendingGate) {
      throw new ScenarioError({
        code: ScenarioErrorCode.CONFLICT,
        message: `decision gate ${parsed.data.gate} does not match pending gate ${this.context.pendingGate ?? "none"}`,
        phase: "infra",
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
    if (parsed.data.action === "edit") {
      if (!parsed.data.edit) {
        throw new ScenarioError({ code: ScenarioErrorCode.VALIDATION, message: "edit requires edit payload", phase: "infra" });
      }
      if (parsed.data.gate === 5) {
        throw new ScenarioError({ code: ScenarioErrorCode.VALIDATION, message: "gate 5 does not support edits", phase: "infra" });
      }
    }
    if (parsed.data.choice && parsed.data.gate !== 5) {
      throw new ScenarioError({ code: ScenarioErrorCode.VALIDATION, message: "finalize choice is only valid for gate 5", phase: "infra" });
    }
    if (parsed.data.gate === 5 && parsed.data.action === "approve" && parsed.data.choice === "rerun") {
      throw new ScenarioError({ code: ScenarioErrorCode.VALIDATION, message: "rerun must use reject action", phase: "infra" });
    }
    const resolve = this.decideResolve;
    if (!resolve) {
      throw new ScenarioError({ code: ScenarioErrorCode.CONFLICT, message: "no gate pending", phase: "infra" });
    }
    // R4 审计P2（与 ares/metis 同步）：决策必须针对当前 pending 的 gate。校验失败时
    // 不清 decideResolve——真正 pending 的等待继续存活。
    if (this.context.pendingGate !== parsed.data.gate) {
      throw new ScenarioError({
        code: ScenarioErrorCode.CONFLICT,
        message: `gate ${parsed.data.gate} is not the pending gate (${this.context.pendingGate ?? "none"})`,
        phase: "infra",
      });
    }
    this.decideResolve = undefined;
    resolve({ decision: parsed.data, decidedBy });
  }

  on<K extends keyof OrchestratorEvents>(event: K, handler: (data: OrchestratorEvents[K]) => void): () => void {
    this.emitter.on(event, handler);
    return () => this.emitter.off(event, handler);
  }

  waitForGate(): Promise<GateRequest> {
    // Consumers may subscribe just after the synchronous `gate:pending`
    // emission. If the decision waiter is already installed, expose the
    // current request instead of waiting forever for an event that already
    // happened. Do not use pendingGate alone: during decide() it remains set
    // until the state-machine loop has persisted the decision.
    if (this.context.pendingGate !== null && this.decideResolve) {
      const gate = this.context.pendingGate as 1 | 2 | 3 | 4 | 5;
      return Promise.resolve({ gate, phase: this.context.phase as WorkState, payload: gatePayload(gate, this.context), context: this.ctx });
    }
    return new Promise((resolve) => this.emitter.once("gate:pending", (r: { request: GateRequest }) => resolve(r.request)));
  }

  abort(): void {
    this.abortController.abort();
  }

  private applyDecision(decision: GateDecision, fromState: WorkState, decidedBy: "human" | "virtual-user"): void {
    this.context.approvals.push({
      gate: decision.gate,
      action: decision.action,
      targetPhase: decision.targetPhase,
      comment: decision.comment,
      edit: decision.edit,
      choice: decision.choice,
      decidedBy,
      decidedAt: (this.deps.now ?? (() => new Date()))().toISOString(),
    });
    if (decision.edit) {
      this.applyEdit(decision.gate as 1 | 2 | 3 | 4 | 5, decision.edit);
    }
    if (decision.choice) {
      this.context.finalizeChoice = decision.choice;
      if (decision.choice === "discard") this.context.outcome = "discarded";
    }
    if (decision.action === "edit") {
      this.emitter.emit("gate:edited", { decision, context: this.ctx });
      return;
    }
    if (decision.action === "reject") {
      const target = decision.targetPhase as WorkState;
      this.invalidateAfter(target);
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

  private applyEdit(gate: 1 | 2 | 3 | 4 | 5, edit: NonNullable<GateDecision["edit"]>): void {
    if (gate === 1 && edit.kind !== "intent") {
      throw new ScenarioError({ code: ScenarioErrorCode.VALIDATION, message: "gate 1 requires intent edit", phase: "infra" });
    }
    if (gate === 2 && edit.kind !== "dag") {
      throw new ScenarioError({ code: ScenarioErrorCode.VALIDATION, message: "gate 2 requires dag edit", phase: "infra" });
    }
    if (gate === 3 && edit.kind !== "selections") {
      throw new ScenarioError({ code: ScenarioErrorCode.VALIDATION, message: "gate 3 requires selection edit", phase: "infra" });
    }
    if (gate === 4 && edit.kind !== "acceptance") {
      throw new ScenarioError({ code: ScenarioErrorCode.VALIDATION, message: "gate 4 requires acceptance edit", phase: "infra" });
    }
    switch (edit.kind) {
      case "intent":
        this.context.intent = edit.intent;
        break;
      case "dag":
        this.context.dag = edit.dag;
        break;
      case "selections": {
        const candidates = this.context.candidates;
        for (const selection of edit.selections) {
          const set = candidates.find((candidate) => candidate.nodeId === selection.nodeId);
          if (!set?.candidates.some((candidate) => candidate.id === selection.capabilityId)) {
            throw new ScenarioError({
              code: ScenarioErrorCode.NOT_FOUND,
              message: `selection ${selection.capabilityId} is not a candidate for ${selection.nodeId}`,
              phase: "infra",
            });
          }
        }
        this.context.selections = edit.selections;
        break;
      }
      case "acceptance":
        this.context.acceptance = edit.acceptance;
        break;
    }
    this.touch();
  }

  /** Clear downstream artifacts before a rejected phase is run again. */
  private invalidateAfter(target: WorkState): void {
    const index = WORK_STATES.indexOf(target);
    if (index <= WORK_STATES.indexOf("parsing")) {
      this.context.intent = null;
      this.context.planner = null;
    }
    if (index <= WORK_STATES.indexOf("planning")) this.context.dag = null;
    if (index <= WORK_STATES.indexOf("retrieving")) {
      this.context.candidates = [];
      this.context.skillNotes = [];
    }
    if (index <= WORK_STATES.indexOf("assembling")) {
      this.context.selections = [];
      this.context.assembly = null;
    }
    if (index <= WORK_STATES.indexOf("verifying")) {
      this.context.acceptance = [];
    } else if (index <= WORK_STATES.indexOf("executing")) {
      this.context.acceptance = this.context.acceptance.filter((record) => record.layer === "component");
    } else if (index <= WORK_STATES.indexOf("distilling")) {
      this.context.acceptance = this.context.acceptance.filter((record) => record.layer !== "generalization");
    }
    if (index <= WORK_STATES.indexOf("executing")) this.context.trace = [];
    this.context.distilled = null;
    this.context.finalizeChoice = null;
    this.context.outcome = "running";
    this.touch();
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

  private async waitForDecision(): Promise<{ decision: GateDecision; decidedBy: "human" | "virtual-user" }> {
    return await new Promise<{ decision: GateDecision; decidedBy: "human" | "virtual-user" }>((resolve, reject) => {
      const onAbort = () => {
        // R4 审计P3：abort 时必须清 decideResolve 与 pendingGate——否则迟到的 decide()
        // 会 resolve 已被遗弃的等待（被静默吞掉而非报 CONFLICT），且持久化的上下文
        // 带着死闸门，恢复构建时重新呈现已失败 run 的 gate。
        this.decideResolve = undefined;
        this.ctx.pendingGate = null;
        reject(new ScenarioError({ code: ScenarioErrorCode.CANCELLED, message: "orchestrator aborted while waiting for gate decision", phase: "infra" }));
      };
      if (this.abortController.signal.aborted) {
        onAbort();
        return;
      }
      this.abortController.signal.addEventListener("abort", onAbort, { once: true });
      this.decideResolve = (d) => {
        this.decideResolve = undefined;
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
