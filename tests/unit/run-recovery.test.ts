import { describe, expect, it } from "vitest";
import { matchResumableBuildRunIds, restartCancellationPatch, selectResumableBuildContext, shouldCancelAfterRestart } from "@/panel/run-recovery";

describe("面板重启运行恢复边界", () => {
  const resumable = new Set(["等待闸门确认"]);

  it("清理无检查点的 running/paused work run", () => {
    expect(shouldCancelAfterRestart({ id: "work-running", mode: "work", status: "running", requirement: "工作", startedAt: "2026-10-16T00:00:00.000Z" }, resumable)).toBe(true);
    expect(shouldCancelAfterRestart({ id: "work-paused", mode: "work", status: "paused", requirement: "工作", startedAt: "2026-10-16T00:00:00.000Z" }, resumable)).toBe(true);
  });

  it("保留有 pending gate 的 construction build", () => {
    expect(shouldCancelAfterRestart({ id: "build-pending", mode: "build", status: "running", requirement: "等待闸门确认", startedAt: "2026-10-16T00:00:00.000Z" }, new Set(["build-pending"]))).toBe(false);
    // Same text in another session must not be treated as the resumable row.
    expect(shouldCancelAfterRestart({ id: "build-other", mode: "build", status: "running", requirement: "等待闸门确认", startedAt: "2026-10-16T00:00:00.000Z" }, new Set(["build-pending"]))).toBe(true);
  });

  it("不触碰终态记录", () => {
    for (const status of ["succeeded", "failed", "cancelled", "discarded"]) {
      expect(shouldCancelAfterRestart({ id: `terminal-${status}`, mode: "work", status, requirement: "历史运行", startedAt: "2026-10-16T00:00:00.000Z" }, resumable)).toBe(false);
    }
  });

  it("重启取消会保留可读终止时间和运行时长", () => {
    expect(restartCancellationPatch({ mode: "work", status: "running", requirement: "工作", startedAt: "2026-10-16T00:00:00.000Z" }, Date.parse("2026-10-16T00:00:12.345Z"))).toEqual({ status: "cancelled", finishedAt: "2026-10-16T00:00:12.345Z", durationMs: 12_345, error: "面板进程重启，运行没有可恢复的执行检查点。" });
  });

  it("同一需求存在多个历史运行时不误恢复错误会话", () => {
    const contexts = [{ id: "checkpoint-a", requirement: "整理报告", projectId: "project-a" }];
    const runs = [
      { id: "run-a", mode: "build" as const, status: "running", requirement: "整理报告", projectId: "project-a", startedAt: "2026-10-16T00:00:00.000Z", details: null },
      { id: "run-b", mode: "build" as const, status: "running", requirement: "整理报告", projectId: "project-a", startedAt: "2026-10-16T00:00:01.000Z", details: null },
    ];
    expect(matchResumableBuildRunIds(contexts, runs)).toEqual(new Set());
  });

  it("优先使用明确 buildId 链接，即使其它运行文本相同", () => {
    const contexts = [{ id: "checkpoint-a", requirement: "整理报告", projectId: "project-a" }];
    const runs = [
      { id: "run-a", mode: "build" as const, status: "running", requirement: "整理报告", projectId: "project-a", startedAt: "2026-10-16T00:00:00.000Z", details: { buildId: "checkpoint-a" } },
      { id: "run-b", mode: "build" as const, status: "running", requirement: "整理报告", projectId: "project-a", startedAt: "2026-10-16T00:00:01.000Z", details: null },
    ];
    expect(matchResumableBuildRunIds(contexts, runs)).toEqual(new Set(["run-a"]));
    expect(matchResumableBuildRunIds(contexts, runs.map((run) => ({ ...run, sessionId: run.id === "run-a" ? "current" : "other" })), "current")).toEqual(new Set(["run-a"]));
  });

  it("重启恢复只选择当前会话的 checkpoint", () => {
    const contexts = [
      { id: "checkpoint-other", requirement: "同一需求", projectId: "project-a", updatedAt: "2026-10-16T00:00:00.000Z" },
      { id: "checkpoint-current", requirement: "同一需求", projectId: "project-a", updatedAt: "2026-10-16T00:00:01.000Z" },
    ];
    const runs = [
      { id: "run-other", mode: "build" as const, status: "running", requirement: "同一需求", projectId: "project-a", sessionId: "session-other", startedAt: "2026-10-16T00:00:00.000Z", details: { buildId: "checkpoint-other" } },
      { id: "run-current", mode: "build" as const, status: "running", requirement: "同一需求", projectId: "project-a", sessionId: "session-current", startedAt: "2026-10-16T00:00:01.000Z", details: { buildId: "checkpoint-current" } },
    ];
    expect(selectResumableBuildContext(contexts, runs, "session-current")?.id).toBe("checkpoint-current");
    expect(selectResumableBuildContext(contexts, runs, "session-missing")).toBeUndefined();
  });
});
