import { EventEmitter } from "node:events";
import { ScenarioError, ScenarioErrorCode } from "@/core/errors.js";
import type { Capability } from "@/federation/types.js";
import type { BuildContext } from "@/orchestrator/context.js";

/**
 * 3.3 执行期干预：
 *  - 自动修复回路（3.3.1）：任务级验收失败 → 按 trust 次优换型 → 重试，上限 3，超限升级事件（自主模式记录并终止该次执行）。
 *  - 暂停/继续/终止（3.3.2）：RunController 状态迁移。
 */

export interface RepairAttempt {
  round: number;
  failedCapabilityId: string;
  switchedTo: string | undefined;
  success: boolean;
}

export interface RepairOutcome {
  repaired: boolean;
  attempts: RepairAttempt[];
  escalated: boolean;
  finalSelections: Array<{ nodeId: string; capabilityId: string; overridden: boolean }>;
}

export interface RepairDeps {
  /** 按 nodeId 给出候选（trust 降序，不含已失败者优先） */
  candidatesFor(nodeId: string): Capability[];
  /** 单节点执行试跑（返回是否通过任务级验收） */
  runNode(nodeId: string, capabilityId: string): Promise<{ passed: boolean; error?: string }>;
  /** Inputs captured from the failed execution, when a repair needs context. */
  inputsFor?(nodeId: string): Record<string, unknown>;
  maxRounds?: number;
}

export interface RepairEvents {
  "repair:switch": { nodeId: string; from: string; to: string; round: number };
  "repair:escalate": { nodeId: string; attempts: RepairAttempt[] };
}

export class RepairLoop {
  private readonly emitter = new EventEmitter();

  constructor(private deps: RepairDeps) {}

  on<K extends keyof RepairEvents>(event: K, handler: (data: RepairEvents[K]) => void): () => void {
    this.emitter.on(event, handler);
    return () => this.emitter.off(event, handler);
  }

  /**
   * 终止性论证（R2.2）：每轮恰好换到一个"未曾失败"的候选（candidates 单调收缩），
 * 候选数有限 → 轮数 ≤ 候选数；再受 maxRounds（默认 3）硬顶 → 必然终止。
   */
  async repairNode(ctx: BuildContext, nodeId: string): Promise<RepairOutcome> {
    const maxRounds = this.deps.maxRounds ?? 3;
    const attempts: RepairAttempt[] = [];
    const failedIds = new Set<string>();
    const selection = ctx.selections.find((s) => s.nodeId === nodeId);
    let currentId = selection?.capabilityId;

    for (let round = 1; round <= maxRounds; round++) {
      if (!currentId) break;
      const run = await this.deps.runNode(nodeId, currentId);
      if (run.passed) {
        attempts.push({ round, failedCapabilityId: currentId, switchedTo: currentId, success: true });
        return this.finish(ctx, nodeId, attempts, false);
      }
      failedIds.add(currentId);
      // trust 次优换型：排除全部失败者后的最高分
      const next = this.deps
        .candidatesFor(nodeId)
        .filter((c) => !failedIds.has(c.id))
        .sort((a, b) => b.trust.score - a.trust.score)[0];
      attempts.push({ round, failedCapabilityId: currentId, switchedTo: next?.id, success: false });
      if (!next) {
        this.emitter.emit("repair:escalate", { nodeId, attempts });
        return this.finish(ctx, nodeId, attempts, true);
      }
      this.emitter.emit("repair:switch", { nodeId, from: currentId, to: next.id, round });
      currentId = next.id;
      this.setSelection(ctx, nodeId, currentId);
    }
    // maxRounds 用尽仍失败 → 升级
    this.emitter.emit("repair:escalate", { nodeId, attempts });
    return this.finish(ctx, nodeId, attempts, true);
  }

  private finish(ctx: BuildContext, nodeId: string, attempts: RepairAttempt[], escalated: boolean): RepairOutcome {
    const selection = ctx.selections.find((s) => s.nodeId === nodeId);
    return {
      repaired: attempts.at(-1)?.success === true,
      attempts,
      escalated,
      finalSelections: selection ? [{ nodeId, capabilityId: selection.capabilityId, overridden: true }] : [],
    };
  }

  private setSelection(ctx: BuildContext, nodeId: string, capabilityId: string): void {
    const s = ctx.selections.find((x) => x.nodeId === nodeId);
    if (s) {
      s.capabilityId = capabilityId;
      s.overridden = true;
    } else {
      ctx.selections.push({ nodeId, capabilityId, overridden: true });
    }
  }
}

// ── 3.3.2 暂停/继续/终止 ──

export type RunControlState = "running" | "paused" | "terminated";

export interface ControlEvents {
  "control:changed": { from: RunControlState; to: RunControlState };
}

/**
 * 运行控制器：与编排器协作的暂停/继续/终止。
 * - terminate() → 编排器 abort（运行循环在下一检查点抛 CANCELLED）
 * - pause() → 设置暂停闸：执行底座在节点间调用 checkpoint()，暂停时挂起等待 resume
 */
export class RunController {
  private state: RunControlState = "running";
  private readonly emitter = new EventEmitter();
  // Cluster execution can have several workers paused at the same boundary.
  // Keep all waiters so one resume/terminate releases every worker.
  private readonly resumeWaiters = new Set<() => void>();
  private readonly guidanceQueue: string[] = [];
  private onTerminate: Array<() => void> = [];

  get currentState(): RunControlState {
    return this.state;
  }

  /** 独立读取（绕过 TS 属性收窄，await 后状态可能已被并发改变） */
  private stateNow(): RunControlState {
    return this.state;
  }

  on<K extends keyof ControlEvents>(event: K, handler: (data: ControlEvents[K]) => void): () => void {
    this.emitter.on(event, handler);
    return () => this.emitter.off(event, handler);
  }

  pause(): void {
    this.assertRunning();
    this.transition("paused");
  }

  resume(): void {
    if (this.state !== "paused") {
      throw new ScenarioError({ code: ScenarioErrorCode.CONFLICT, message: `cannot resume from ${this.state}`, phase: "executing" });
    }
    this.transition("running");
    this.releaseWaiters();
  }

  terminate(): void {
    if (this.state === "terminated") return;
    const from = this.state;
    this.state = "terminated";
    this.releaseWaiters(); // 暂停中被终止 → checkpoint 返回，随后 checkpoint 抛 CANCELLED
    this.emitter.emit("control:changed", { from, to: "terminated" });
    for (const fn of this.onTerminate) {
      try {
        fn();
      } catch {
        // One integration callback must not prevent the remaining termination
        // hooks (including the abort hook) from running.
      }
    }
  }

  onTerminateCallback(fn: () => void): void {
    this.onTerminate.push(fn);
  }

  /** Queue a user correction for the next executable step. It never mutates
   * an in-flight provider response, so the current step remains auditable. */
  guide(instruction: string): void {
    const value = instruction.trim();
    if (value) this.guidanceQueue.push(value.slice(0, 8_000));
  }

  takeGuidance(): string[] {
    return this.guidanceQueue.splice(0, this.guidanceQueue.length);
  }

  /** 执行底座在节点边界调用：暂停则等待；终止则抛 CANCELLED */
  async checkpoint(): Promise<void> {
    if (this.state === "terminated") {
      throw new ScenarioError({ code: ScenarioErrorCode.CANCELLED, message: "run terminated by controller", phase: "executing" });
    }
    if (this.state === "paused") {
      await new Promise<void>((resolve) => {
        this.resumeWaiters.add(resolve);
      });
      if (this.stateNow() === "terminated") {
        throw new ScenarioError({ code: ScenarioErrorCode.CANCELLED, message: "run terminated while paused", phase: "executing" });
      }
    }
  }

  private transition(to: RunControlState): void {
    const from = this.state;
    this.state = to;
    this.emitter.emit("control:changed", { from, to });
  }

  private releaseWaiters(): void {
    const waiters = [...this.resumeWaiters];
    this.resumeWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  private assertRunning(): void {
    if (this.state !== "running") {
      throw new ScenarioError({ code: ScenarioErrorCode.CONFLICT, message: `cannot pause from ${this.state}`, phase: "executing" });
    }
  }
}
