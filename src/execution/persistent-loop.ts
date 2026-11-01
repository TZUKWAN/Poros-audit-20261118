import type { GoalRoundResult, LoopDecision } from "./loop.js";
import type { LongRun } from "@/product/contracts.js";
import type { LongRunRepository } from "@/product/long-runs.js";

export interface PersistentGoalLoopOptions {
  repository: LongRunRepository;
  runId: string;
  runRound(round: number, instruction: string | undefined, signal: AbortSignal): Promise<GoalRoundResult>;
  goalCheck(result: GoalRoundResult): Promise<boolean> | boolean;
  roundGate?: (result: GoalRoundResult) => Promise<LoopDecision>;
  onRoundStart?: (round: number) => Promise<void> | void;
  onRoundEnd?: (result: GoalRoundResult) => Promise<void> | void;
  signal?: AbortSignal;
}

/**
 * Durable multi-round runner for long-lived scenarios.
 *
 * It commits the completed round before judging the goal or waiting for a
 * gate. A process restart can therefore resume from `nextRound` without
 * replaying an already committed round. The callback still owns all external
 * side effects; this class only governs durable control state.
 */
export class PersistentGoalLoop {
  private controller = new AbortController();
  private readonly externalAbortListener = (): void => {
    this.controller.abort();
  };
  private running = false;
  private pauseRequested = false;
  private stopRequested = false;

  constructor(private readonly options: PersistentGoalLoopOptions) {
    if (options.signal) {
      if (options.signal.aborted) this.controller.abort();
      else options.signal.addEventListener("abort", this.externalAbortListener, { once: true });
    }
  }

  async run(): Promise<LongRun> {
    if (this.running) throw new Error("long run already executing");
    this.running = true;
    try {
      let record = await this.options.repository.get(this.options.runId);
      if (!record) throw new Error("long run not found");
      if (record.status === "succeeded" || record.status === "failed" || record.status === "cancelled" || record.status === "waiting-user") return record;

      this.pauseRequested = record.pauseRequested;
      // A queued run can be paused before its worker reaches the first hook.
      // Keep that durable pause intact; a paused checkpoint with a pending
      // result still needs to pass through goal/gate review on resume.
      if (record.status === "paused" && !record.pauseRequested && !record.pendingResult) return record;
      if (this.controller.signal.aborted && !this.pauseRequested) {
        return await this.finish(record, "cancelled", "cancelled", "长程运行在启动前被取消。");
      }
      if (this.pauseRequested) {
        return await this.pauseRecord(record);
      }
      record = await this.options.repository.update(record.id, {
        status: "running",
        startedAt: record.startedAt ?? new Date().toISOString(),
        finishedAt: null,
        terminalReason: null,
        lastError: null,
        pauseRequested: false,
      }, record.revision);

      for (let round = record.nextRound; round <= record.maxRounds; round += 1) {
        if (this.stopRequested) return await this.finishControl(record, "cancelled", "cancelled");
        // Pause uses the same AbortController as cancellation to interrupt a
        // cooperative provider call. Preserve that distinction at the loop
        // boundary so a pause requested while a hook/judge is running cannot
        // be accidentally committed as a cancelled terminal run.
        if (this.pauseRequested) return await this.pauseRecord(record);
        if (this.controller.signal.aborted) return await this.finishControl(record, "cancelled", "cancelled");
        const current = await this.options.repository.get(record.id);
        if (!current) throw new Error("long run disappeared during execution");
        record = current;
        if (record.pauseRequested || this.pauseRequested) return await this.pauseRecord(record);

        // A pending result was committed before a previous process exited.
        // Resume review from it instead of executing the side-effecting round
        // a second time.
        const resumedPending = record.pendingRound === round && record.pendingResult;
        let result: GoalRoundResult;
        if (resumedPending) {
          result = resumedPending;
        } else {
          try {
            await this.options.onRoundStart?.(round);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return await this.finish(record, "failed", null, `轮次开始钩子失败：${message.slice(0, 2_000)}`);
          }
          // A control request can arrive while the start hook is awaiting an
          // external resource. Do not enter the side-effecting round callback
          // after that request has already won the race.
          if (this.stopRequested) return await this.finishControl(record, "cancelled", "cancelled");
          if (this.pauseRequested || record.pauseRequested) return await this.pauseRecord(record);
          if (this.controller.signal.aborted) return await this.finishControl(record, "cancelled", "cancelled");
          try {
            result = await this.options.runRound(round, record.nextInstruction ?? undefined, this.controller.signal);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (this.stopRequested) return await this.finish(record, "cancelled", "cancelled", "长程运行已停止。");
            if (this.pauseRequested || record.pauseRequested) return await this.pauseRecord(record);
            if (this.controller.signal.aborted) return await this.finish(record, "cancelled", "cancelled", "长程运行已取消。");
            return await this.finish(record, "failed", null, message.slice(0, 2_000));
          }

          // Commit the result before any goal judge or round gate can run. If
          // the process exits after this write, the next process can resume
          // review without replaying the side-effecting round.
          record = await this.commitRound(record.id, {
            pendingRound: round,
            pendingResult: { round, summary: result.summary.slice(0, 20_000), goalMet: result.goalMet, metrics: result.metrics },
            completedRounds: round,
            lastRound: round,
            lastSummary: result.summary.slice(0, 20_000),
            lastMetrics: result.metrics,
            lastError: null,
          });
          try {
            await this.options.onRoundEnd?.(result);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return await this.finish(record, "failed", null, `轮次结束钩子失败：${message.slice(0, 2_000)}`);
          }
        }

        if (this.stopRequested) return await this.finishControl(record, "cancelled", "cancelled");
        if (this.pauseRequested || record.pauseRequested) return await this.pauseRecord(record);
        if (this.controller.signal.aborted) return await this.finishControl(record, "cancelled", "cancelled");

        let goalMet: boolean;
        try {
          goalMet = await this.options.goalCheck(result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return await this.finish(record, "failed", null, message.slice(0, 2_000));
        }
        if (this.stopRequested) return await this.finishControl(record, "cancelled", "cancelled");
        if (this.pauseRequested || record.pauseRequested) return await this.pauseRecord(record);
        if (this.controller.signal.aborted) return await this.finishControl(record, "cancelled", "cancelled");
        if (goalMet) {
          record = await this.commitRound(record.id, {
            nextRound: round + 1,
            completedRounds: round,
            lastRound: round,
            lastSummary: result.summary.slice(0, 20_000),
            lastMetrics: result.metrics,
            pendingRound: null,
            pendingResult: null,
            nextInstruction: null,
          });
          return await this.finish(record, "succeeded", "goal-met");
        }

        if (this.options.roundGate) {
          let decision: LoopDecision;
          try {
            decision = await this.options.roundGate(result);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return await this.finish(record, "failed", null, message.slice(0, 2_000));
          }
          if (this.stopRequested) return await this.finishControl(record, "cancelled", "cancelled");
          if (this.pauseRequested || record.pauseRequested) return await this.pauseRecord(record);
          if (this.controller.signal.aborted) return await this.finishControl(record, "cancelled", "cancelled");
          if (decision.action === "stop") return await this.finish(record, "cancelled", "stopped", "长程运行由闸门停止。");
          record = await this.commitRound(record.id, {
            nextRound: round + 1,
            completedRounds: round,
            lastRound: round,
            lastSummary: result.summary.slice(0, 20_000),
            lastMetrics: result.metrics,
            pendingRound: null,
            pendingResult: null,
            nextInstruction: decision.action === "fix" && decision.instruction ? decision.instruction.slice(0, 8_000) : null,
          });
        } else {
          record = await this.commitRound(record.id, {
            nextRound: round + 1,
            completedRounds: round,
            lastRound: round,
            lastSummary: result.summary.slice(0, 20_000),
            lastMetrics: result.metrics,
            pendingRound: null,
            pendingResult: null,
            nextInstruction: null,
          });
        }
      }

      // Reaching maxRounds is a controlled incomplete terminal state. It is
      // intentionally represented as failed so callers cannot mistake it for
      // a verified goal completion.
      return await this.finish(record, "failed", "max-rounds", `已达到长程场景轮次上限（${record.maxRounds}）。`);
    } finally {
      this.running = false;
    }
  }

  async pause(): Promise<LongRun> {
    const record = await this.options.repository.get(this.options.runId);
    if (!record) throw new Error("long run not found");
    if (record.status !== "running" && record.status !== "queued") return record;
    this.pauseRequested = true;
    this.controller.abort();
    if (record.status === "queued") {
      return await this.commitUpdate(record.id, {
        status: "paused",
        pauseRequested: false,
        terminalReason: null,
        lastError: "已在安全轮次边界暂停，可继续恢复。",
      });
    }
    return await this.commitUpdate(record.id, { pauseRequested: true });
  }

  async stop(): Promise<LongRun> {
    const record = await this.options.repository.get(this.options.runId);
    if (!record) throw new Error("long run not found");
    if (record.status === "succeeded" || record.status === "failed" || record.status === "cancelled") return record;
    this.stopRequested = true;
    this.controller.abort();
    return await this.finish(record, "cancelled", "cancelled", "长程运行已停止。");
  }

  async resume(): Promise<LongRun> {
    const record = await this.options.repository.get(this.options.runId);
    if (!record) throw new Error("long run not found");
    if (record.status !== "paused") return record;
    // pause() aborts the cooperative controller so an in-flight provider call
    // can settle at the safe round boundary. Reusing this worker after that
    // pause must install a fresh controller; otherwise run() would observe
    // the old aborted signal and cancel before executing the resumed round.
    if (this.options.signal?.aborted) return record;
    this.options.signal?.removeEventListener("abort", this.externalAbortListener);
    this.controller = new AbortController();
    if (this.options.signal) {
      this.options.signal.addEventListener("abort", this.externalAbortListener, { once: true });
    }
    this.pauseRequested = false;
    this.stopRequested = false;
    // A stop or a successful worker can win after the first read. Reuse the
    // guarded control update so resume never resurrects a terminal row.
    return await this.commitUpdate(record.id, { status: "queued", pauseRequested: false, lastError: null });
  }

  private async pauseRecord(record: LongRun): Promise<LongRun> {
    return await this.commitUpdate(record.id, {
      status: "paused",
      pauseRequested: false,
      lastError: "已在安全轮次边界暂停，可继续恢复。",
    });
  }

  private async finishControl(record: LongRun, status: "cancelled", reason: "cancelled"): Promise<LongRun> {
    return await this.finish(record, status, reason, "长程运行已取消。");
  }

  private async finish(record: LongRun, status: LongRun["status"], reason: LongRun["terminalReason"], error?: string): Promise<LongRun> {
    // Control requests can race a hook/judge failure or the final checkpoint.
    // Resolve the durable row immediately before the terminal write so a late
    // callback cannot overwrite an explicit stop/pause with a misleading
    // failed/succeeded state. A terminal row won by another control path is
    // already authoritative and needs no second revision bump.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.options.repository.get(record.id);
      if (!current) throw new Error("long run not found");
      if (["succeeded", "failed", "cancelled"].includes(current.status)) return current;

      let effectiveStatus = status;
      let effectiveReason = reason;
      let effectiveError = error ?? null;
      if (this.stopRequested) {
        effectiveStatus = "cancelled";
        effectiveReason = "cancelled";
        effectiveError = "长程运行已停止。";
      } else if (this.pauseRequested || current.pauseRequested) {
        effectiveStatus = "paused";
        effectiveReason = null;
        effectiveError = "已在安全轮次边界暂停，可继续恢复。";
      }

      const patch: Partial<Omit<LongRun, "schemaVersion" | "id" | "createdAt" | "updatedAt" | "revision">> = {
        status: effectiveStatus,
        terminalReason: effectiveReason,
        lastError: effectiveError,
        pauseRequested: false,
      };
      if (effectiveStatus !== "paused") patch.finishedAt = new Date().toISOString();
      try {
        return await this.options.repository.update(record.id, patch, current.revision);
      } catch (error) {
        if (attempt === 2) throw error;
      }
    }
    throw new Error("long run terminal update failed");
  }

  private async commitRound(id: string, patch: Partial<Omit<LongRun, "schemaVersion" | "id" | "createdAt" | "updatedAt" | "revision">>): Promise<LongRun> {
    // A pause/stop request may commit a control flag while the worker is
    // finishing a round. Retry against the newer revision rather than losing
    // the round checkpoint or leaving a permanently running row.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.options.repository.get(id);
      if (!current) throw new Error("long run disappeared during checkpoint");
      try {
        return await this.options.repository.update(id, patch, current.revision);
      } catch (error) {
        if (attempt === 2) throw error;
      }
    }
    throw new Error("long run checkpoint failed");
  }

  private async commitUpdate(id: string, patch: Partial<Omit<LongRun, "schemaVersion" | "id" | "createdAt" | "updatedAt" | "revision">>): Promise<LongRun> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.options.repository.get(id);
      if (!current) throw new Error("long run not found");
      // A late pause/resume callback must never rewrite a terminal row (for
      // example, stop winning just before pause persists its intent).
      if (["succeeded", "failed", "cancelled"].includes(current.status)) return current;
      try {
        return await this.options.repository.update(id, patch, current.revision);
      } catch (error) {
        if (attempt === 2) throw error;
      }
    }
    throw new Error("long run update failed");
  }
}

