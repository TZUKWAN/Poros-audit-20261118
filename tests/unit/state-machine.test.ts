import { describe, expect, it, vi } from "vitest";
import { BuildAwaitingUserError, Orchestrator, GATE_ON_EXIT, isLegalTransition, WORK_STATES, type OrchestratorDeps } from "@/orchestrator/state-machine";
import { memoryBuildStore } from "@/orchestrator/build-store";
import type { BuildContext } from "@/orchestrator/context";

/** 无操作处理器（状态机层测试不关心处理器语义） */
function noopDeps(over: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  const noop = async () => {};
  return {
    handlers: {
      parsing: noop,
      planning: noop,
      retrieving: noop,
      assembling: noop,
      verifying: noop,
      executing: noop,
      distilling: noop,
    },
    persist: async () => {},
    ...over,
  };
}

async function runUntilGate(deps = noopDeps()): Promise<{ orch: Orchestrator; gate: number; payload: unknown }> {
  const orch = new Orchestrator(deps);
  orch.start("测试需求");
  void orch.run();
  const gateReq = await orch.waitForGate();
  return { orch, gate: gateReq.gate, payload: gateReq.payload };
}

/**
 * 逐闸门驱动：先 waitForGate 再 decide。
 * （decide() 在决策送达时即返回，不代表下一道闸门已挂起——时序契约）
 */
async function driveThrough(
  orch: Orchestrator,
  decisions: Array<{ gate: 1 | 2 | 3 | 4 | 5; action: "approve" | "reject"; targetPhase?: "parsing" | "planning" | "retrieving" | "assembling" | "verifying" | "executing" | "distilling"; comment?: string }>,
): Promise<void> {
  for (const d of decisions) {
    const req = await orch.waitForGate();
    if (req.gate !== d.gate) {
      throw new Error(`expected gate ${d.gate}, pending is ${req.gate}`);
    }
    await orch.decide(d);
  }
}

describe("2.1.2 状态机转换（≥15 用例）", () => {
  it("start 冻结项目/Memory 运行时上下文并可序列化", () => {
    const orch = new Orchestrator(noopDeps());
    orch.start("测试需求", "build-context", { projectId: "p1", projectInstructions: "中文 Markdown", files: [], memories: [{ id: "m1", name: "偏好", scope: "project", content: "先给结论", sourceType: "user", sourceId: null }], connectors: [], desktopContexts: [], provider: { id: null, baseUrl: "http://127.0.0.1:1/v1", model: "m", timeoutMs: 1000 } });
    expect(orch.ctx.runtimeContext?.projectInstructions).toBe("中文 Markdown");
    expect(orch.ctx.runtimeContext?.memories[0]?.content).toBe("先给结论");
  });
  it("合法主干全序列", () => {
    for (let i = 0; i < WORK_STATES.length - 1; i++) {
      expect(isLegalTransition(WORK_STATES[i]!, WORK_STATES[i + 1]!)).toBe(true);
    }
  });
  it("非法跳转：parsing→executing", () => {
    expect(isLegalTransition("parsing", "executing")).toBe(false);
  });
  it("非法自环：planning→planning", () => {
    expect(isLegalTransition("planning", "planning")).toBe(false);
  });
  it("done 之后无再前进", () => {
    expect(isLegalTransition("done", "parsing")).toBe(false);
    expect(isLegalTransition("done", "distilling")).toBe(false);
  });
  it("驳回回退（向后）合法", () => {
    expect(isLegalTransition("retrieving", "planning")).toBe(true);
    expect(isLegalTransition("distilling", "parsing")).toBe(true);
  });
  it("闸门挂点映射：1/2/3/4/5 分别在 parsing/planning/retrieving/verifying/distilling 出口", () => {
    expect(GATE_ON_EXIT.parsing).toBe(1);
    expect(GATE_ON_EXIT.planning).toBe(2);
    expect(GATE_ON_EXIT.retrieving).toBe(3);
    expect(GATE_ON_EXIT.assembling).toBe(0);
    expect(GATE_ON_EXIT.verifying).toBe(4);
    expect(GATE_ON_EXIT.executing).toBe(0);
    expect(GATE_ON_EXIT.distilling).toBe(5);
    expect(GATE_ON_EXIT.done).toBe(0);
  });
});

describe("2.1.3 闸门挂起/恢复", () => {
  it("模型结构化澄清会持久化为 awaiting-user，回答后从原阶段恢复", async () => {
    const store = memoryBuildStore();
    const deps = noopDeps({ persist: (ctx) => store.save(ctx) });
    let parsingRuns = 0;
    deps.handlers.parsing = async (ctx: BuildContext) => {
      parsingRuns += 1;
      if (parsingRuns === 1) {
        throw new BuildAwaitingUserError({
          phase: "parsing",
          question: "要处理哪个目录？",
          inputs: [{ name: "path", type: "path", description: "项目目录" }],
        });
      }
      ctx.intent = { goal: ctx.requirement, domain: "general", slots: [{ name: "path", value: ctx.clarificationAnswers.path! }], keywords: [], via: "template" };
    };
    const orch = new Orchestrator(deps);
    orch.start("整理项目");
    const waiting = await orch.run();
    expect(waiting.awaitingUser).toMatchObject({ phase: "parsing", question: "要处理哪个目录？", source: "model" });
    expect(waiting.outcome).toBe("running");
    expect(waiting.pendingGate).toBeNull();
    expect((await store.load(waiting.id))?.awaitingUser?.inputs[0]?.name).toBe("path");
    const restored = Orchestrator.restore(await store.load(waiting.id), deps);
    // A refresh/restart cannot silently rerun the model while the answer is missing.
    expect((await restored.run()).awaitingUser?.question).toBe("要处理哪个目录？");
    await restored.answerAwaitingUser({ path: "/workspace/project" });
    const resumed = restored.run();
    await driveThrough(restored, [
      { gate: 1, action: "approve" },
      { gate: 2, action: "approve" },
      { gate: 3, action: "approve" },
      { gate: 4, action: "approve" },
      { gate: 5, action: "approve" },
    ]);
    const final = await resumed;
    expect(parsingRuns).toBe(2);
    expect(final.clarificationAnswers).toMatchObject({ path: "/workspace/project" });
    expect(final.awaitingUser).toBeNull();
  });

  it("parsing 完成后挂起在闸门1，payload 为 intent", async () => {
    const deps = noopDeps();
    deps.handlers.parsing = async (ctx: BuildContext) => {
      ctx.intent = { goal: ctx.requirement, domain: "d", slots: [], keywords: [], via: "template" };
    };
    const { orch, gate, payload } = await runUntilGate(deps);
    expect(gate).toBe(1);
    expect((payload as { goal: string }).goal).toBe("测试需求");
    expect(orch.state).toBe("parsing");
    expect(orch.ctx.pendingGate).toBe(1);
    await orch.decide({ gate: 1, action: "approve" });
  });

  it("批准后恢复前进到 planning（state:enter 收到 planning）", async () => {
    const deps = noopDeps();
    deps.handlers.parsing = async (ctx: BuildContext) => {
      ctx.intent = { goal: "g", domain: "d", slots: [], keywords: [], via: "template" };
    };
    const { orch } = await runUntilGate(deps);
    const entered: string[] = [];
    orch.on("state:enter", ({ to }) => entered.push(to));
    await orch.decide({ gate: 1, action: "approve" });
    const g2 = await orch.waitForGate();
    expect(g2.gate).toBe(2);
    expect(entered).toContain("planning");
    await orch.decide({ gate: 2, action: "approve" });
  });

  it("驳回回退到 planning：闸门3 驳回 → 重新进入 planning → 再次过闸 2/3", async () => {
    const deps = noopDeps();
    const visits: string[] = [];
    for (const s of ["parsing", "planning", "retrieving"] as const) {
      deps.handlers[s] = async () => {
        visits.push(s);
      };
    }
    const orch = new Orchestrator(deps);
    orch.start("r");
    void orch.run();
    await driveThrough(orch, [
      { gate: 1, action: "approve" },
      { gate: 2, action: "approve" },
      { gate: 3, action: "reject", targetPhase: "planning", comment: "清单不对" },
      { gate: 2, action: "approve" },
      { gate: 3, action: "approve" },
      { gate: 4, action: "approve" },
      { gate: 5, action: "approve" },
    ]);
    expect(visits.filter((v) => v === "planning")).toHaveLength(2); // 两次进入 planning
  });

  it("同阶段驳回（闸门1→parsing）重跑该阶段", async () => {
    const deps = noopDeps();
    let parsingRuns = 0;
    deps.handlers.parsing = async () => {
      parsingRuns++;
    };
    const orch = new Orchestrator(deps);
    orch.start("r");
    void orch.run();
    await driveThrough(orch, [
      { gate: 1, action: "reject", targetPhase: "parsing", comment: "意图不对，重来" },
      { gate: 1, action: "approve" },
      { gate: 2, action: "approve" },
      { gate: 3, action: "approve" },
      { gate: 4, action: "approve" },
      { gate: 5, action: "approve" },
    ]);
    expect(parsingRuns).toBe(2);
  });

  it("驳回记录写入 approvals（含 targetPhase 与 comment）", async () => {
    const deps = noopDeps();
    const orch = new Orchestrator(deps);
    orch.start("r");
    void orch.run();
    await driveThrough(orch, [
      { gate: 1, action: "reject", targetPhase: "parsing", comment: "意图不符" },
      { gate: 1, action: "approve" },
      { gate: 2, action: "approve" },
      { gate: 3, action: "approve" },
      { gate: 4, action: "approve" },
      { gate: 5, action: "approve" },
    ]);
    const approvals = orch.ctx.approvals;
    expect(approvals).toHaveLength(6);
    expect(approvals[0]).toMatchObject({ gate: 1, action: "reject", targetPhase: "parsing", comment: "意图不符" });
  });

  it("reject 无 targetPhase 被拒（协议校验），闸门保持挂起可重试", async () => {
    const { orch } = await runUntilGate();
    await expect(orch.decide({ gate: 1, action: "reject" })).rejects.toMatchObject({ code: "VALIDATION" });
    // 闸门仍挂起：合法决策照常生效
    await orch.decide({ gate: 1, action: "approve" });
    await driveThrough(orch, [
      { gate: 2, action: "approve" },
      { gate: 3, action: "approve" },
      { gate: 4, action: "approve" },
      { gate: 5, action: "approve" },
    ]);
  });

  it("错闸门决策被拒，当前闸门仍保持挂起", async () => {
    const { orch } = await runUntilGate();
    await expect(orch.decide({ gate: 2, action: "approve" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(orch.ctx.pendingGate).toBe(1);
    await orch.decide({ gate: 1, action: "approve" });
  });

  it("编辑动作重新发出同一闸门，不重跑已生成阶段", async () => {
    const deps = noopDeps();
    deps.handlers.parsing = async (ctx: BuildContext) => {
      if (!ctx.intent) ctx.intent = { goal: "原目标", domain: "general", slots: [], keywords: [], via: "template" };
    };
    const orch = new Orchestrator(deps);
    orch.start("需求");
    const runP = orch.run();
    await orch.waitForGate();
    await orch.decide({ gate: 1, action: "edit", edit: { kind: "intent", intent: { goal: "新目标", domain: "general", slots: [], keywords: ["新目标"], via: "template" } } });
    const editedGate = await orch.waitForGate();
    expect(editedGate.gate).toBe(1);
    expect((editedGate.payload as { goal: string }).goal).toBe("新目标");
    await orch.decide({ gate: 1, action: "approve" });
    await driveThrough(orch, [
      { gate: 2, action: "approve" },
      { gate: 3, action: "approve" },
      { gate: 4, action: "approve" },
      { gate: 5, action: "approve" },
    ]);
    await runP;
  });

  it("闸门5 discard 记录为 discarded，不进入固化成功语义", async () => {
    const orch = new Orchestrator(noopDeps());
    orch.start("r");
    const runP = orch.run();
    await driveThrough(orch, [
      { gate: 1, action: "approve" },
      { gate: 2, action: "approve" },
      { gate: 3, action: "approve" },
      { gate: 4, action: "approve" },
    ]);
    const gate5 = await orch.waitForGate();
    expect(gate5.gate).toBe(5);
    await orch.decide({ gate: 5, action: "approve", choice: "discard" });
    const final = await runP;
    expect(final.outcome).toBe("discarded");
    expect(final.finalizeChoice).toBe("discard");
  });

  it("reject 目标不得晚于当前阶段", async () => {
    const { orch } = await runUntilGate();
    await expect(orch.decide({ gate: 1, action: "reject", targetPhase: "executing" })).rejects.toMatchObject({
      code: "ILLEGAL_TRANSITION",
    });
    await orch.decide({ gate: 1, action: "approve" });
    await driveThrough(orch, [
      { gate: 2, action: "approve" },
      { gate: 3, action: "approve" },
      { gate: 4, action: "approve" },
      { gate: 5, action: "approve" },
    ]);
  });

  it("无闸门挂起时 decide 报 CONFLICT", async () => {
    const orch = new Orchestrator(noopDeps());
    orch.start("r");
    await expect(orch.decide({ gate: 1, action: "approve" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("事件顺序：state:exit 先于 state:enter，gate:decided 在前进前", async () => {
    const deps = noopDeps();
    const seq: string[] = [];
    const orch = new Orchestrator(deps);
    orch.on("state:exit", () => seq.push("exit"));
    orch.on("state:enter", () => seq.push("enter"));
    orch.on("gate:pending", () => seq.push("pending"));
    orch.on("gate:decided", () => seq.push("decided"));
    orch.start("r");
    void orch.run();
    await driveThrough(orch, [
      { gate: 1, action: "approve" },
      { gate: 2, action: "approve" },
      { gate: 3, action: "approve" },
      { gate: 4, action: "approve" },
      { gate: 5, action: "approve" },
    ]);
    // 序列：pending1 decided1 exit enter pending2 ...
    expect(seq.slice(0, 4)).toEqual(["pending", "decided", "exit", "enter"]);
    expect(seq.filter((s) => s === "pending")).toHaveLength(5);
  });

  it("run:done 事件在 distilling 闸门5 批准后触发", async () => {
    const deps = noopDeps();
    const orch = new Orchestrator(deps);
    const doneSpy = vi.fn();
    orch.on("run:done", doneSpy);
    orch.start("r");
    const runP = orch.run();
    await driveThrough(orch, [
      { gate: 1, action: "approve" },
      { gate: 2, action: "approve" },
      { gate: 3, action: "approve" },
      { gate: 4, action: "approve" },
      { gate: 5, action: "approve" },
    ]);
    const finalCtx = await runP;
    expect(finalCtx.phase).toBe("done");
    expect(doneSpy).toHaveBeenCalledTimes(1);
  });

  it("重复 start 报 CONFLICT（运行中）", async () => {
    const orch = new Orchestrator(noopDeps());
    orch.start("r");
    void orch.run();
    await orch.waitForGate();
    expect(() => orch.start("r2")).toThrow();
    await orch.decide({ gate: 1, action: "approve" });
    await driveThrough(orch, [
      { gate: 2, action: "approve" },
      { gate: 3, action: "approve" },
      { gate: 4, action: "approve" },
      { gate: 5, action: "approve" },
    ]);
  });

  it("abort 后 run 抛 CANCELLED（等待决策中被中止）", async () => {
    const deps = noopDeps();
    const orch = new Orchestrator(deps);
    orch.start("r");
    const runP = orch.run().catch((e) => e);
    await orch.waitForGate();
    orch.abort();
    const err = (await runP) as { code?: string };
    expect(err.code).toBe("CANCELLED");
  });

  it("restore：坏 schema 抛 CONTEXT_CORRUPT", async () => {
    expect(() => Orchestrator.restore({ nonsense: 1 }, noopDeps())).toThrowError();
    try {
      Orchestrator.restore({ nonsense: 1 }, noopDeps());
    } catch (e) {
      expect((e as { code?: string }).code).toBe("CONTEXT_CORRUPT");
    }
  });

  it("restore：合法 context 可恢复并续跑（闸门2 继续）", async () => {
    const deps = noopDeps();
    const saved: BuildContext[] = [];
    deps.persist = async (ctx) => {
      saved.push(JSON.parse(JSON.stringify(ctx)) as BuildContext);
    };
    deps.handlers.parsing = async (ctx: BuildContext) => {
      ctx.intent = { goal: "g", domain: "d", slots: [], keywords: [], via: "template" };
    };
    const orch = new Orchestrator(deps);
    orch.start("需求 A", "build-x");
    void orch.run();
    await orch.waitForGate();
    await orch.decide({ gate: 1, action: "approve" });
    const g2 = await orch.waitForGate();
    expect(g2.gate).toBe(2);
    // 模拟崩溃：丢弃 orch，从最后一次持久化恢复
    const last = saved[saved.length - 1]!;
    expect(last.id).toBe("build-x");
    expect(last.phase).toBe("planning");
    const orch2 = Orchestrator.restore(last, noopDeps());
    expect(orch2.state).toBe("planning");
    const runP2 = orch2.run();
    await driveThrough(orch2, [
      { gate: 2, action: "approve" },
      { gate: 3, action: "approve" },
      { gate: 4, action: "approve" },
      { gate: 5, action: "approve" },
    ]);
    const final = await runP2;
    expect(final.phase).toBe("done");
  });

  it("persist 在每闸门后调用（≥10 次：闸门前+决策后）", async () => {
    const store = memoryBuildStore();
    const deps = noopDeps({ persist: (ctx) => store.save(ctx) });
    const orch = new Orchestrator(deps);
    orch.start("r");
    const runP = orch.run();
    await driveThrough(orch, [
      { gate: 1, action: "approve" },
      { gate: 2, action: "approve" },
      { gate: 3, action: "approve" },
      { gate: 4, action: "approve" },
      { gate: 5, action: "approve" },
    ]);
    await runP;
    expect(store.saves).toBeGreaterThanOrEqual(10);
  });

  it("ctx 暴露的是深拷贝（外部改不坏内部）", async () => {
    const { orch } = await runUntilGate();
    const snapshot = orch.ctx;
    snapshot.pendingGate = null;
    snapshot.requirement = "篡改";
    expect(orch.ctx.pendingGate).toBe(1);
    expect(orch.ctx.requirement).toBe("测试需求");
    await orch.decide({ gate: 1, action: "approve" });
    await driveThrough(orch, [
      { gate: 2, action: "approve" },
      { gate: 3, action: "approve" },
      { gate: 4, action: "approve" },
      { gate: 5, action: "approve" },
    ]);
  });
});
