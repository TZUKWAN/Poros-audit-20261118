import { afterEach, describe, expect, it } from "vitest";
import { isDue, TaskScheduler } from "@/product/scheduler";
import { ScheduledTaskRepository } from "@/product/tasks";
import { ScheduledTaskSchema } from "@/product/contracts";
import { jsonStore } from "@/core/store";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const tempDirs: string[] = [];
afterEach(async () => { await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("本地任务调度策略", () => {
  const now = new Date("2026-10-03T10:00:00.000Z");
  it("支持一次性和间隔计划，并避免重复执行", () => {
    expect(isDue("once", null, now)).toBe(true);
    expect(isDue("once", now.toISOString(), now)).toBe(false);
    expect(isDue("every 1h", "2026-10-03T08:30:00.000Z", now)).toBe(true);
    expect(isDue("every 2h", "2026-10-03T08:30:00.000Z", now)).toBe(false);
    expect(isDue("every 0s", null, now)).toBe(false);
  });
  it("支持每日 HH:mm 计划和未知计划安全降级", () => {
    const clock = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    expect(isDue(clock, null, now)).toBe(true);
    expect(isDue(clock, "2026-10-02T10:00:00.000Z", now)).toBe(true);
    const nextMinute = (now.getHours() * 60 + now.getMinutes() + 1) % (24 * 60);
    const nextClock = `${String(Math.floor(nextMinute / 60)).padStart(2, "0")}:${String(nextMinute % 60).padStart(2, "0")}`;
    expect(isDue(nextClock, null, now)).toBe(false);
    expect(isDue("24:00", null, now)).toBe(false);
    expect(isDue("not-a-schedule", null, now)).toBe(false);
  });

  it("损坏的上次运行时间不会让计划永久停摆", () => {
    expect(isDue("every 1h", "not-a-timestamp", now)).toBe(true);
    const clock = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    expect(isDue(clock, "not-a-timestamp", now)).toBe(true);
  });

  it("失败和超时都会留下状态，重启后 once 任务不会重复执行", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "scheduler-")); tempDirs.push(dir);
    const repo = new ScheduledTaskRepository(jsonStore({ filePath: path.join(dir, "tasks.json"), schema: ScheduledTaskSchema }));
    await repo.create({ id: "failed", workspaceId: "ws", projectId: null, scenarioId: null, requirement: "失败任务", schedule: "every 1s", enabled: true, lastRunId: null, lastRunAt: null, runCount: 0, maxRuns: null, timeoutMs: 1_000 });
    const first = new TaskScheduler(repo, "ws", async () => ({ ok: false, error: "远端拒绝" }), 60_000);
    await first.tick(new Date("2026-10-03T10:00:00.000Z"));
    const failed = await repo.get("failed");
    expect(failed).toMatchObject({ runCount: 1, failureCount: 1, lastRunStatus: "failed", lastError: "远端拒绝" });
    await repo.update("failed", { lastRunAt: "2026-10-03T08:00:00.000Z", runCount: 0, failureCount: 0, lastRunStatus: null, lastError: null });
    let timeoutCalls = 0;
    const timeout = new TaskScheduler(repo, "ws", async () => { timeoutCalls += 1; return await new Promise(() => undefined); }, 60_000);
    await timeout.tick(new Date("2026-10-03T10:00:00.000Z"));
    expect(await repo.get("failed")).toMatchObject({ runCount: 1, failureCount: 1, lastRunStatus: "timeout", lastError: "scheduled task timeout" });
    await timeout.tick(new Date("2026-10-03T10:00:01.000Z"));
    expect(timeoutCalls).toBe(1);
    const persisted = await repo.get("failed");
    await repo.update("failed", { enabled: false });
    await repo.create({ id: "once", workspaceId: "ws", projectId: null, scenarioId: null, requirement: "一次任务", schedule: "once", enabled: true, lastRunId: "r1", lastRunAt: "2026-10-03T09:00:00.000Z", runCount: 1, maxRuns: null, timeoutMs: 1_000, lastRunStatus: "succeeded" });
    const afterRestart: Array<string> = [];
    const restarted = new TaskScheduler(repo, "ws", async () => { afterRestart.push("ran"); return { ok: true }; }, 60_000);
    await restarted.tick(new Date("2026-10-03T10:00:00.000Z"));
    expect(afterRestart).toHaveLength(0);
    expect((await repo.get("failed"))?.runCount).toBe(persisted?.runCount);
  });

  it("被活动运行占用时跳过，不消耗任务次数", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "scheduler-skip-")); tempDirs.push(dir);
    const repo = new ScheduledTaskRepository(jsonStore({ filePath: path.join(dir, "tasks.json"), schema: ScheduledTaskSchema }));
    await repo.create({ id: "busy", workspaceId: "ws", projectId: null, scenarioId: null, requirement: "稍后执行", schedule: "every 1m", enabled: true, lastRunId: null, lastRunAt: null, runCount: 0, maxRuns: null, timeoutMs: 1_000 });
    const scheduler = new TaskScheduler(repo, "ws", async () => ({ ok: false, skipped: true, error: "当前运行尚未结束" }));
    await scheduler.tick(now);
    expect(await repo.get("busy")).toMatchObject({ runCount: 0, lastRunAt: null, lastRunStatus: null });
  });

  it("单个任务超时不会阻塞同一轮其它任务", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "scheduler-parallel-")); tempDirs.push(dir);
    const repo = new ScheduledTaskRepository(jsonStore({ filePath: path.join(dir, "tasks.json"), schema: ScheduledTaskSchema }));
    await repo.create({ id: "slow", workspaceId: "ws", projectId: null, scenarioId: null, requirement: "慢任务", schedule: "once", enabled: true, lastRunId: null, lastRunAt: null, runCount: 0, maxRuns: null, timeoutMs: 1_000 });
    await repo.create({ id: "fast", workspaceId: "ws", projectId: null, scenarioId: null, requirement: "快任务", schedule: "once", enabled: true, lastRunId: null, lastRunAt: null, runCount: 0, maxRuns: null, timeoutMs: 1_000 });
    const scheduler = new TaskScheduler(repo, "ws", async (task) => task.id === "slow" ? await new Promise(() => undefined) : { ok: true, runId: "fast-run" }, 60_000);
    await scheduler.tick(now);
    expect(await repo.get("slow")).toMatchObject({ runCount: 1, lastRunStatus: "timeout" });
    expect(await repo.get("fast")).toMatchObject({ runCount: 1, lastRunStatus: "succeeded", lastRunId: "fast-run" });
  });
});
