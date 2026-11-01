import { EventEmitter } from "node:events";
import { ScenarioError, ScenarioErrorCode } from "@/core/errors.js";

/**
 * 4.3 循环引擎（pi-agent-loop goal 模式语义 + 逐轮放行 hook；pi-reactor 长驻触发见 reactor-bridge.ts）：
 *  - GoalLoop：目标/终止条件/轮次上限参数化
 *  - RoundGate：每轮摘要 → 挂起等 GateDecision（approve/fix/stop）
 */

export interface GoalRoundResult {
  round: number;
  summary: string;
  goalMet: boolean;
  metrics: Record<string, number>;
}

export interface LoopDecision {
  action: "approve" | "fix" | "stop";
  /** fix：注入下一轮的修正指令 */
  instruction?: string;
}

export interface GoalLoopOptions {
  goal: string;
  /** 终止条件谓词：每轮结果 → 是否达成（LLM judge 或规则，注入式） */
  goalCheck(result: GoalRoundResult): Promise<boolean> | boolean;
  /** 单轮执行（执行底座或场景填槽运行） */
  /** 单轮执行可读取 signal；旧实现只接收前两个参数仍然兼容。 */
  runRound(round: number, instruction?: string, signal?: AbortSignal): Promise<GoalRoundResult>;
  maxRounds: number;
  /** 每轮放行 hook：挂起等决策（虚拟用户/真人）；缺省 = 自动放行 */
  roundGate?: (result: GoalRoundResult) => Promise<LoopDecision>;
  /** 轮次边界 hook，用于持久化检查点、UI 进度或长程场景审计。 */
  onRoundStart?: (round: number) => Promise<void> | void;
  onRoundEnd?: (result: GoalRoundResult) => Promise<void> | void;
  /** 外部停止信号；停止只在安全的轮次边界生效，不伪造完成。 */
  signal?: AbortSignal;
}

export type LoopEvent =
  | { type: "round:start"; round: number }
  | { type: "round:end"; result: GoalRoundResult }
  | { type: "round:gate"; result: GoalRoundResult; decision: LoopDecision }
  | { type: "loop:done"; reason: "goal-met" | "max-rounds" | "stopped" | "cancelled"; rounds: number };

export class GoalLoop {
  private readonly events = new EventEmitter();

  constructor(private options: GoalLoopOptions) {}

  on(handler: (event: LoopEvent) => void): () => void {
    this.events.on("event", handler);
    return () => this.events.off("event", handler);
  }

  private emit(event: LoopEvent): void {
    this.events.emit("event", event);
  }

  /**
   * 终止性：轮数 ≤ maxRounds 硬顶；每轮必经 goalCheck/roundGate → 无死循环。
   */
  async run(): Promise<{ reason: "goal-met" | "max-rounds" | "stopped" | "cancelled"; rounds: number; last: GoalRoundResult | undefined }> {
    assertLoopParams(this.options.maxRounds);
    let last: GoalRoundResult | undefined;
    let nextInstruction: string | undefined;
    for (let round = 1; round <= this.options.maxRounds; round++) {
      if (this.options.signal?.aborted) {
        this.emit({ type: "loop:done", reason: "cancelled", rounds: round - 1 });
        return { reason: "cancelled", rounds: round - 1, last };
      }
      await this.options.onRoundStart?.(round);
      if (this.options.signal?.aborted) {
        this.emit({ type: "loop:done", reason: "cancelled", rounds: round - 1 });
        return { reason: "cancelled", rounds: round - 1, last };
      }
      this.emit({ type: "round:start", round });
      const result = await this.options.runRound(round, nextInstruction, this.options.signal);
      nextInstruction = undefined;
      last = result;
      await this.options.onRoundEnd?.(result);
      if (this.options.signal?.aborted) {
        // Keep one terminal round event even when cancellation arrives from
        // the end hook; no goal judge should run after the cancellation won.
        result.goalMet = false;
        this.emit({ type: "round:end", result });
        this.emit({ type: "loop:done", reason: "cancelled", rounds: round });
        return { reason: "cancelled", rounds: round, last };
      }
      const goalMet = await this.options.goalCheck(result);
      // The event is emitted after the injected judge so subscribers see the
      // same goal decision that controls loop termination. This also avoids
      // the old duplicate `round:end` event on successful rounds.
      result.goalMet = goalMet;
      this.emit({ type: "round:end", result });
      // A stop that arrives while the goal judge is running wins over a
      // late positive answer; callers must never observe a cancelled run as
      // successfully completed.
      if (this.options.signal?.aborted) {
        this.emit({ type: "loop:done", reason: "cancelled", rounds: round });
        return { reason: "cancelled", rounds: round, last };
      }
      if (goalMet) {
        this.emit({ type: "loop:done", reason: "goal-met", rounds: round });
        return { reason: "goal-met", rounds: round, last };
      }
      if (this.options.roundGate) {
        const decision = await this.options.roundGate(result);
        this.emit({ type: "round:gate", result, decision });
        if (this.options.signal?.aborted) {
          this.emit({ type: "loop:done", reason: "cancelled", rounds: round });
          return { reason: "cancelled", rounds: round, last };
        }
        if (decision.action === "stop") {
          this.emit({ type: "loop:done", reason: "stopped", rounds: round });
          return { reason: "stopped", rounds: round, last };
        }
        if (decision.action === "fix" && decision.instruction) {
          nextInstruction = decision.instruction;
        }
      }
    }
    this.emit({ type: "loop:done", reason: "max-rounds", rounds: this.options.maxRounds });
    return { reason: "max-rounds", rounds: this.options.maxRounds, last };
  }
}

/** roundGate 便捷：从 GateDecision 适配（approve/fix{instruction}/stop） */
export function loopDecisionFromGate(d: { action: "approve" | "reject"; comment?: string }): { action: "approve" | "fix" | "stop"; instruction?: string } {
  if (d.action === "approve") return { action: "approve" };
  if (d.comment && d.comment.length > 0) return { action: "fix", instruction: d.comment };
  return { action: "stop" };
}

export function assertLoopParams(maxRounds: number): void {
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 50) {
    throw new ScenarioError({
      code: ScenarioErrorCode.LOOP_LIMIT,
      message: `maxRounds must be integer in [1,50], got ${maxRounds}`,
      phase: "executing",
    });
  }
}
