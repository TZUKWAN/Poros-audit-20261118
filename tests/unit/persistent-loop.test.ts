import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { jsonStore } from "@/core/store.js";
import { LongRunSchema } from "@/product/contracts.js";
import { LongRunRepository } from "@/product/long-runs.js";
import { PersistentGoalLoop } from "@/execution/persistent-loop.js";

const roots: string[] = [];
async function makeRepo(): Promise<LongRunRepository> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-long-run-"));
  roots.push(root);
  return new LongRunRepository(jsonStore({ filePath: path.join(root, "long-runs.json"), schema: LongRunSchema }));
}

async function createRun(repo: LongRunRepository, patch: Partial<Parameters<LongRunRepository["create"]>[0]> = {}) {
  return repo.create({
    id: "long-run-1",
    workspaceId: "ws-1",
    projectId: null,
    sessionId: "session-1",
    scenarioId: "scenario-1",
    goal: "完成两轮资料整理并通过检查",
    slots: {},
    maxRounds: 3,
    nextRound: 1,
    completedRounds: 0,
    status: "queued",
    terminalReason: null,
    nextInstruction: null,
    pendingRound: null,
    pendingResult: null,
    lastRound: null,
    lastSummary: null,
    lastMetrics: {},
    lastError: null,
    pauseRequested: false,
    startedAt: null,
    finishedAt: null,
    ...patch,
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("PersistentGoalLoop", () => {
  it("先提交轮次检查点，再在目标达成时结束", async () => {
    const repo = await makeRepo();
    await createRun(repo, { maxRounds: 3 });
    const rounds: number[] = [];
    const result = await new PersistentGoalLoop({
      repository: repo,
      runId: "long-run-1",
      runRound: async (round) => { rounds.push(round); return { round, summary: `完成第 ${round} 轮`, goalMet: false, metrics: { progress: round / 2 } }; },
      goalCheck: (round) => round.round >= 2,
    }).run();

    expect(rounds).toEqual([1, 2]);
    expect(result.status).toBe("succeeded");
    expect(result.terminalReason).toBe("goal-met");
    expect(result.completedRounds).toBe(2);
    expect(result.nextRound).toBe(3);
    expect(result.lastSummary).toBe("完成第 2 轮");
    expect(result.lastMetrics.progress).toBe(1);
  });

  it("暂停会保留未提交轮次，恢复实例可从同一轮继续", async () => {
    const repo = await makeRepo();
    await createRun(repo, { maxRounds: 2 });
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const runner = new PersistentGoalLoop({
      repository: repo,
      runId: "long-run-1",
      runRound: async (_round, _instruction, signal) => await new Promise((resolve, reject) => {
        started();
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
      goalCheck: () => false,
    });
    const running = runner.run();
    await startedPromise;
    await runner.pause();
    const paused = await running;
    expect(paused.status).toBe("paused");
    expect(paused.nextRound).toBe(1);
    expect(paused.completedRounds).toBe(0);

    await runner.resume();
    const resumed = await new PersistentGoalLoop({
      repository: repo,
      runId: "long-run-1",
      runRound: async (round) => ({ round, summary: `恢复第 ${round} 轮`, goalMet: round === 1, metrics: {} }),
      goalCheck: (round) => round.round === 1,
    }).run();
    expect(resumed.status).toBe("succeeded");
    expect(resumed.lastRound).toBe(1);
  });

  it("重启恢复把孤儿 running 标为 paused，绝不伪造完成", async () => {
    const repo = await makeRepo();
    await createRun(repo, { status: "running", nextRound: 2, completedRounds: 1, lastRound: 1 });
    const recovered = await repo.recoverAfterRestart("ws-1");
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.status).toBe("paused");
    expect(recovered[0]?.nextRound).toBe(2);
    expect(recovered[0]?.lastError).toContain("面板重启");
  });

  it("重启时有待判定检查点只恢复判定，不重复执行已提交轮次", async () => {
    const repo = await makeRepo();
    await createRun(repo, {
      status: "paused",
      pendingRound: 1,
      pendingResult: { round: 1, summary: "已完成但尚未判定", goalMet: false, metrics: { coverage: 0.8 } },
      completedRounds: 1,
      lastRound: 1,
      lastSummary: "已完成但尚未判定",
      lastMetrics: { coverage: 0.8 },
    });
    let executed = false;
    const result = await new PersistentGoalLoop({
      repository: repo,
      runId: "long-run-1",
      runRound: async () => { executed = true; throw new Error("不应重复执行"); },
      goalCheck: (round) => round.summary === "已完成但尚未判定",
    }).run();
    expect(executed).toBe(false);
    expect(result.status).toBe("succeeded");
    expect(result.completedRounds).toBe(1);
    expect(result.pendingResult).toBeNull();
  });

  it("达到轮次上限进入失败终态，不能标为成功", async () => {
    const repo = await makeRepo();
    await createRun(repo, { maxRounds: 2 });
    const result = await new PersistentGoalLoop({
      repository: repo,
      runId: "long-run-1",
      runRound: async (round) => ({ round, summary: "仍需继续", goalMet: false, metrics: {} }),
      goalCheck: () => false,
    }).run();
    expect(result.status).toBe("failed");
    expect(result.terminalReason).toBe("max-rounds");
    expect(result.completedRounds).toBe(2);
    expect(result.lastError).toContain("轮次上限");
  });

  it("仓库按工作区隔离，并拒绝过期 revision 覆盖检查点", async () => {
    const repo = await makeRepo();
    const own = await createRun(repo);
    await createRun(repo, { id: "long-run-other", workspaceId: "ws-2" });
    expect((await repo.list("ws-1")).map((run) => run.id)).toEqual(["long-run-1"]);
    await expect(repo.update(own.id, { lastError: "first" }, own.revision)).resolves.toMatchObject({ revision: 1 });
    await expect(repo.update(own.id, { lastError: "stale" }, own.revision)).rejects.toThrow("revision conflict");
  });

  it("重启恢复扫描超过 100 条记录，且不触碰其它工作区", async () => {
    const repo = await makeRepo();
    for (let index = 0; index < 105; index += 1) {
      await repo.create({
        id: `active-${index}`,
        workspaceId: "ws-1",
        projectId: null,
        sessionId: null,
        scenarioId: "scenario-1",
        goal: `目标 ${index}`,
        slots: {},
        maxRounds: 2,
        nextRound: 1,
        completedRounds: 0,
        status: "running",
        terminalReason: null,
        nextInstruction: null,
        pendingRound: null,
        pendingResult: null,
        lastRound: null,
        lastSummary: null,
        lastMetrics: {},
        lastError: null,
        pauseRequested: false,
        startedAt: null,
        finishedAt: null,
      });
    }
    await repo.create({
      id: "foreign-running",
      workspaceId: "ws-2",
      projectId: null,
      sessionId: null,
      scenarioId: "scenario-1",
      goal: "foreign",
      slots: {},
      maxRounds: 2,
      nextRound: 1,
      completedRounds: 0,
      status: "running",
      terminalReason: null,
      nextInstruction: null,
      pendingRound: null,
      pendingResult: null,
      lastRound: null,
      lastSummary: null,
      lastMetrics: {},
      lastError: null,
      pauseRequested: false,
      startedAt: null,
      finishedAt: null,
    });
    const recovered = await repo.recoverAfterRestart("ws-1");
    expect(recovered).toHaveLength(105);
    expect((await repo.listAll("ws-1")).every((run) => run.status === "paused")).toBe(true);
    expect((await repo.get("foreign-running"))?.status).toBe("running");
  });

  it("轮次 hook 出错会写入失败终态，不留下永久 running", async () => {
    const repo = await makeRepo();
    await createRun(repo, { maxRounds: 2 });
    const started = await new PersistentGoalLoop({
      repository: repo,
      runId: "long-run-1",
      onRoundStart: () => { throw new Error("start hook down"); },
      runRound: async (round) => ({ round, summary: "never", goalMet: false, metrics: {} }),
      goalCheck: () => false,
    }).run();
    expect(started.status).toBe("failed");
    expect(started.lastError).toContain("轮次开始钩子失败");

    await repo.update("long-run-1", { status: "queued", terminalReason: null, finishedAt: null, lastError: null, nextRound: 1 }, started.revision);
    const ended = await new PersistentGoalLoop({
      repository: repo,
      runId: "long-run-1",
      onRoundEnd: () => { throw new Error("end hook down"); },
      runRound: async (round) => ({ round, summary: "committed", goalMet: false, metrics: {} }),
      goalCheck: () => false,
    }).run();
    expect(ended.status).toBe("failed");
    expect(ended.lastError).toContain("轮次结束钩子失败");
    expect(ended.completedRounds).toBe(1);
  });

  it("目标检查或闸门等待期间暂停不会被误记为取消", async () => {
    const repo = await makeRepo();
    await createRun(repo, { maxRounds: 2 });
    let goalStarted!: () => void;
    let releaseGoal!: () => void;
    const goalReady = new Promise<void>((resolve) => { goalStarted = resolve; });
    const goalRelease = new Promise<void>((resolve) => { releaseGoal = resolve; });
    const runner = new PersistentGoalLoop({
      repository: repo,
      runId: "long-run-1",
      runRound: async (round) => ({ round, summary: "已提交待检查", goalMet: false, metrics: {} }),
      goalCheck: async () => { goalStarted(); await goalRelease; return false; },
    });
    const running = runner.run();
    await goalReady;
    await runner.pause();
    releaseGoal();
    const paused = await running;
    expect(paused.status).toBe("paused");
    expect(paused.terminalReason).toBeNull();
    expect(paused.pendingRound).toBe(1);
    expect(paused.completedRounds).toBe(1);
  });

  it("轮次开始钩子等待期间暂停不会再进入有副作用的轮次执行", async () => {
    const repo = await makeRepo();
    await createRun(repo, { maxRounds: 2 });
    let releaseStart!: () => void;
    let startedRun = false;
    const startReady = new Promise<void>((resolve) => { releaseStart = resolve; });
    const runner = new PersistentGoalLoop({
      repository: repo,
      runId: "long-run-1",
      onRoundStart: async () => { await startReady; },
      runRound: async (round) => { startedRun = true; return { round, summary: "不应执行", goalMet: true, metrics: {} }; },
      goalCheck: () => true,
    });
    const running = runner.run();
    for (let attempt = 0; attempt < 20 && (await repo.get("long-run-1"))?.status !== "running"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    await runner.pause();
    releaseStart();
    const paused = await running;
    expect(startedRun).toBe(false);
    expect(paused.status).toBe("paused");
    expect(paused.nextRound).toBe(1);
    expect(paused.completedRounds).toBe(0);
  });

  it("暂停与轮次钩子失败同时发生时保留可恢复暂停而不是误记失败", async () => {
    const repo = await makeRepo();
    await createRun(repo, { maxRounds: 2 });
    let releaseStart!: () => void;
    const startReady = new Promise<void>((resolve) => { releaseStart = resolve; });
    const runner = new PersistentGoalLoop({
      repository: repo,
      runId: "long-run-1",
      onRoundStart: async () => { await startReady; throw new Error("hook aborted"); },
      runRound: async (round) => ({ round, summary: "不应执行", goalMet: true, metrics: {} }),
      goalCheck: () => true,
    });
    const running = runner.run();
    for (let attempt = 0; attempt < 20 && (await repo.get("long-run-1"))?.status !== "running"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    await runner.pause();
    releaseStart();
    const paused = await running;
    expect(paused.status).toBe("paused");
    expect(paused.lastError).toContain("安全轮次边界");
  });

  it("停止赢过暂停竞态时迟到的暂停回调不会复活终态", async () => {
    const repo = await makeRepo();
    await createRun(repo, { maxRounds: 2 });
    let releaseRound!: () => void;
    const roundReady = new Promise<void>((resolve) => { releaseRound = resolve; });
    const runner = new PersistentGoalLoop({
      repository: repo,
      runId: "long-run-1",
      runRound: async (round) => { await roundReady; return { round, summary: "迟到结果", goalMet: false, metrics: {} }; },
      goalCheck: () => false,
    });
    const running = runner.run();
    for (let attempt = 0; attempt < 20 && (await repo.get("long-run-1"))?.status !== "running"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const pausing = runner.pause();
    for (let attempt = 0; attempt < 20 && !(await repo.get("long-run-1"))?.pauseRequested; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const current = await repo.get("long-run-1");
    if (!current) throw new Error("expected long run");
    await repo.update(current.id, { status: "cancelled", terminalReason: "cancelled", finishedAt: new Date().toISOString(), pauseRequested: false }, current.revision);
    releaseRound();
    await pausing;
    const final = await running;
    expect(final.status).toBe("cancelled");
    expect((await repo.get("long-run-1"))?.status).toBe("cancelled");
  });

  it("worker 尚未进入首轮时也可以安全暂停 queued 运行", async () => {
    const repo = await makeRepo();
    await createRun(repo, { maxRounds: 2 });
    const runner = new PersistentGoalLoop({
      repository: repo,
      runId: "long-run-1",
      runRound: async (round) => ({ round, summary: "不应执行", goalMet: true, metrics: {} }),
      goalCheck: () => true,
    });
    const paused = await runner.pause();
    expect(paused.status).toBe("paused");
    expect(paused.lastError).toContain("安全轮次边界");
    const result = await runner.run();
    expect(result.status).toBe("paused");
    expect(result.nextRound).toBe(1);
  });

  it("同一执行器暂停后继续会重建控制器并执行恢复轮次", async () => {
    const repo = await makeRepo();
    await createRun(repo, { maxRounds: 2 });
    let executions = 0;
    const runner = new PersistentGoalLoop({
      repository: repo,
      runId: "long-run-1",
      runRound: async (round, _instruction, signal) => {
        executions += 1;
        if (executions === 1) {
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        }
        return { round, summary: `第 ${round} 轮`, goalMet: true, metrics: {} };
      },
      goalCheck: () => true,
    });
    const running = runner.run();
    for (let attempt = 0; attempt < 50 && (await repo.get("long-run-1"))?.status !== "running"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    const pausing = runner.pause();
    const pauseRequested = await pausing;
    expect(pauseRequested).toMatchObject({ status: "running", pauseRequested: true });
    expect(await running).toMatchObject({ status: "paused", nextRound: 1 });
    await runner.resume();
    const resumed = await runner.run();
    expect(resumed.status).toBe("succeeded");
    expect(resumed.lastRound).toBe(1);
    expect(executions).toBe(2);
  });
});

