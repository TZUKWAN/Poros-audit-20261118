import type { ScheduledTaskRepository } from "./tasks.js";

export interface ScheduledTaskRunResult { ok: boolean; runId?: string; error?: string; skipped?: boolean; }

/** 轻量本地任务调度器：重启后从持久化任务表恢复，单进程内保证同一任务不重入。 */
export class TaskScheduler {
  private timer: NodeJS.Timeout | undefined;
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly repo: ScheduledTaskRepository,
    private readonly workspaceId: string,
    private readonly run: (task: Awaited<ReturnType<ScheduledTaskRepository["get"]>> & object) => Promise<ScheduledTaskRunResult>,
    private readonly intervalMs = 30_000,
  ) {}

  start(): void {
    if (this.timer) return;
    const report = (error: unknown): void => {
      // The interval callback cannot await a rejected promise. Keep failures
      // observable without creating an unhandled rejection that can take down
      // the host process.
      console.error("scheduled task tick failed", error instanceof Error ? error.message : String(error));
    };
    this.timer = setInterval(() => { void this.tick().catch(report); }, this.intervalMs);
    this.timer.unref();
    void this.tick().catch(report);
  }

  /** R3 审计#8：停止定时器并等待 in-flight 任务收尾（上限 30s，超时不强杀），
   *  避免 shutdown 后后台仍在写 runs/artifacts。 */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const pending = [...this.inFlight.values()];
    if (pending.length === 0) return;
    await Promise.race([
      Promise.allSettled(pending),
      new Promise((r) => setTimeout(r, 30_000)),
    ]);
  }

  async tick(now = new Date()): Promise<void> {
    const tasks = await this.repo.list(this.workspaceId);
    await Promise.all(tasks.map(async (task) => {
      if (!task.enabled || (task.maxRuns !== null && task.runCount >= task.maxRuns) || this.inFlight.has(task.id) || !isDue(task.schedule, task.lastRunAt, now)) return;
      this.inFlight.add(task.id);
      // Keep the original operation promise separate from the timeout race.
      // Timing out the scheduler must not release this guard while the
      // underlying run is still mutating runs/artifacts; otherwise the next
      // tick can start the same task a second time.
      const operation = Promise.resolve().then(() => this.run(task));
      let timedOut = false;
      try {
        const result = await withTimeout(operation, task.timeoutMs);
        if (result.skipped) return;
        // R1 审计#11：回写前重读最新值做增量合并（tick 期间用户可能并发
        // update-task 修改 failureCount/runCount/lastRunId，直接用起点快照会互相覆盖）
        const latest = await this.repo.get(task.id);
        await this.repo.update(task.id, {
          lastRunId: result.runId ?? null,
          lastRunAt: new Date().toISOString(),
          lastRunStatus: result.ok ? "succeeded" : "failed",
          lastError: result.ok ? null : (result.error ?? "任务执行失败").slice(0, 500),
          failureCount: result.ok ? (latest?.failureCount ?? task.failureCount) : (latest?.failureCount ?? task.failureCount) + 1,
          runCount: (latest?.runCount ?? task.runCount) + 1,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        timedOut = message === "scheduled task timeout";
        const latest = await this.repo.get(task.id).catch(() => undefined);
        await this.repo.update(task.id, {
          // 超时路径保留 operation 实际产出的 runId（若有）；仅在确认无产出时清空
          lastRunId: latest?.lastRunId ?? null,
          lastRunAt: new Date().toISOString(),
          lastRunStatus: message === "scheduled task timeout" ? "timeout" : "failed",
          lastError: message.slice(0, 500),
          failureCount: (latest?.failureCount ?? task.failureCount) + 1,
          runCount: (latest?.runCount ?? task.runCount) + 1,
        });
      } finally {
        if (timedOut) {
          // A provider call may not support AbortSignal. Retain the in-flight
          // guard until its promise settles, even though the task row already
          // records the timeout outcome.
          void operation.catch(() => undefined).finally(() => this.inFlight.delete(task.id));
        } else {
          this.inFlight.delete(task.id);
        }
      }
    }));
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("scheduled task timeout")), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function isDue(schedule: string, lastRunAt: string | null, now: Date): boolean {
  const value = schedule.trim().toLowerCase();
  if (value === "once") return !lastRunAt;
  const every = /^every\s+(\d+)\s*(s|m|h|d)$/.exec(value);
  if (every) {
    const amount = Number(every[1]);
    if (!Number.isFinite(amount) || amount <= 0) return false;
    if (!lastRunAt) return true;
    // A corrupted or legacy timestamp must not permanently disable a
    // recurring task. Treat it as never having run so the next tick can
    // repair the durable last-run marker.
    const lastRunMs = Date.parse(lastRunAt);
    if (!Number.isFinite(lastRunMs)) return true;
    const unitMs = every[2] === "s" ? 1_000 : every[2] === "m" ? 60_000 : every[2] === "h" ? 3_600_000 : 86_400_000;
    return now.getTime() - lastRunMs >= amount * unitMs;
  }
  // 支持简单的 HH:mm 每日触发；分钟级检查足以覆盖本地桌面场景。
  const clock = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (clock) {
    const targetHour = Number(clock[1]);
    const targetMinute = Number(clock[2]);
    // The scheduler is intentionally polled instead of using a per-task
    // timer.  Requiring an exact minute would therefore lose a daily task
    // whenever the process starts late or a tick is delayed by I/O.  Once the
    // scheduled minute has arrived, allow one catch-up run for the same local
    // day; the persisted lastRunAt marker still prevents duplicates.
    if (targetHour > 23 || targetMinute > 59) return false;
    if (lastRunAt) {
      const lastRun = new Date(lastRunAt);
      if (Number.isFinite(lastRun.getTime()) && lastRun.toDateString() === now.toDateString()) return false;
    }
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const targetMinutes = targetHour * 60 + targetMinute;
    return nowMinutes >= targetMinutes;
  }
  return false;
}
