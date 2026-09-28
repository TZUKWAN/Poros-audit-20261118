import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createOrchestrator, attachVirtualUser } from "@/orchestrator/runner";
import { memoryBuildStore } from "@/orchestrator/build-store";
import { handleExecutingReal, makeNodeExecutor } from "@/execution/wire-executing";
import { CapabilityInvoker } from "@/execution/capability-runtime";
import { GoalLoop, loopDecisionFromGate } from "@/execution/loop";
import { RunController } from "@/execution/repair";
import { VirtualUser } from "../virtual-user/driver";
import { buildCapability } from "@/federation/adapters/adapter-utils";
import type { Capability, Source } from "@/federation/types";
import type { FederatedResult } from "@/federation/search";
import type { HandlerDeps } from "@/orchestrator/handlers";
import type { BuildContext } from "@/orchestrator/context";
import type { ExecutingDeps } from "@/execution/wire-executing";

/**
 * 阶段四集成：真实闭环「需求 → 五闸门 → 集群执行（含一次真实能力调用：本地 JSON-RPC
 * HTTP 服务作为 remote 能力）→ 任务级验收 → 输出」；目标模式 2 轮逐轮放行。
 */

const src: Source = { id: "modelscope", tier: "curated", name: "t", url: "https://t" };

/** 本地 JSON-RPC 能力服务器（"真实能力调用"的被调方） */
async function startEchoRpc(): Promise<{ server: Server; port: number; calls: Array<{ name: string; args: unknown }> }> {
  const calls: Array<{ name: string; args: unknown }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += String(c)));
    req.on("end", () => {
      const msg = JSON.parse(body) as { method: string; params?: { name: string; arguments: unknown } };
      if (msg.method === "tools/call" && msg.params) {
        calls.push({ name: msg.params.name, args: msg.params.arguments });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ text: `done:${msg.params.name}` }], ok: true } }));
      } else {
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "unknown method" } }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server, port, calls };
}

function remoteCap(port: number): Capability {
  return buildCapability({
    id: "local:echo-cap",
    name: "echo-cap",
    kind: "mcp-server",
    description: "本地回声能力",
    source: src,
    install: { type: "remote", url: `http://127.0.0.1:${port}/mcp` },
    remoteRun: { url: `http://127.0.0.1:${port}/mcp`, transport: "streamable-http" },
    tags: ["fs"],
  });
}

function handlerDeps(cap: Capability): HandlerDeps {
  return {
    search: async (q: string, _limit?: number): Promise<FederatedResult> => ({
      query: q,
      capabilities: [cap],
      statuses: [{ source: "modelscope", ok: true, degraded: false, latencyMs: 1, count: 1 }],
      totalMs: 1,
    }),
    llm: {
      parseIntent: async (req) => ({ goal: req, domain: "test", slots: [], keywords: ["echo"], via: "llm" as const }),
      planTasks: async () => ({
        nodes: [
          { id: "n1", title: "调用回声能力", deps: [], expectedOutput: "done:echo-cap" },
          { id: "n2", title: "汇总输出", deps: ["n1"], expectedOutput: "summary" },
        ],
      }),
    },
  };
}

describe("阶段四集成：真实闭环", () => {
  it("需求 → 五闸门 → 集群执行（真实能力调用）→ 任务级验收 → 输出", async () => {
    const { server, port, calls } = await startEchoRpc();
    try {
      const cap = remoteCap(port);
      const store = memoryBuildStore();
      const invoker = new CapabilityInvoker();
      const deps = handlerDeps(cap);
      deps.execute = (ctx: BuildContext) =>
        handleExecutingReal(ctx, {
          invoke: (c, action, inputs) => invoker.invoke(c, action, inputs),
        });
      const orch = createOrchestrator({ handlerDeps: deps, store });
      attachVirtualUser(orch, new VirtualUser({ kind: "approve-all" }));
      orch.start("对 /tmp/data 做一次回声处理", "build-e2e4");
      const final = await orch.run();

      expect(final.phase).toBe("done");
      // 真实能力调用发生过（每个节点一次，2 节点）
      expect(calls.length).toBe(2);
      expect(calls[0]?.name).toBe("echo-cap");
      // 执行轨迹真实回写
      expect(final.trace.filter((s) => s.status === "success")).toHaveLength(2);
      // 任务级验收通过记录
      const taskAcc = final.acceptance.find((a) => a.layer === "task");
      expect(taskAcc?.passed).toBe(true);
      // 组件级验收（verifying 探活——本地端点存活）
      const compAcc = final.acceptance.find((a) => a.layer === "component");
      expect(compAcc?.passed).toBe(true);
    } finally {
      server.close();
    }
  });

  it("执行失败 → RepairLoop 换型重试（坏能力→好能力）→ 最终通过", async () => {
    const { server, port, calls } = await startEchoRpc();
    try {
      const goodCap = remoteCap(port);
      const badCap = buildCapability({
        id: "local:bad-cap",
        name: "bad-cap",
        kind: "mcp-server",
        description: "坏能力",
        source: src,
        install: { type: "remote", url: "http://127.0.0.1:9/mcp" },
        remoteRun: { url: "http://127.0.0.1:9/mcp" },
        tags: ["fs"],
      });
      // trust 排序：bad 分更高排第一（默认选型），good 次优（修复目标）
      const badHigh = { ...badCap, trust: { ...badCap.trust, score: 0.9 } };
      const goodLower = { ...goodCap, trust: { ...goodCap.trust, score: 0.5 } };
      const deps = handlerDeps(badHigh);
      deps.search = async (q, limit) => ({
        query: q,
        capabilities: [badHigh, goodLower].slice(0, limit ?? 5),
        statuses: [{ source: "modelscope", ok: true, degraded: false, latencyMs: 1, count: 2 }],
        totalMs: 1,
      });
      const invokeDeps: ExecutingDeps = {
        invoke: async (c, action, inputs) => {
          // bad-cap 端口 9 连接拒绝 → invoke 失败；good 走真实服务
          const invoker = new CapabilityInvoker();
          return await invoker.invoke(c, action, inputs);
        },
      };
      deps.execute = (ctx: BuildContext) => handleExecutingReal(ctx, invokeDeps);
      const store = memoryBuildStore();
      const orch = createOrchestrator({ handlerDeps: deps, store });
      attachVirtualUser(orch, new VirtualUser({ kind: "approve-all" }));
      orch.start("修复路径验证", "build-repair4");
      const final = await orch.run();
      expect(final.phase).toBe("done");
      expect(calls.length).toBeGreaterThanOrEqual(1); // 好能力被真实调用
      const taskAcc = final.acceptance.filter((a) => a.layer === "task");
      expect(taskAcc.some((a) => a.passed)).toBe(true);
    } finally {
      server.close();
    }
  }, 60_000);

  it("目标模式：2 轮达成 + 逐轮放行（虚拟用户每轮决策）", async () => {
    const decisions: Array<{ round: number; action: string }> = [];
    const summaries: string[] = [];
    const loop = new GoalLoop({
      goal: "两轮内让 progress 达标",
      maxRounds: 5,
      goalCheck: (r) => (r.metrics.progress ?? 0) >= 1,
      runRound: async (n) => ({
        round: n,
        summary: `第 ${n} 轮执行完成`,
        goalMet: false,
        metrics: { progress: n / 2 },
      }),
      roundGate: async (result) => {
        summaries.push(result.summary);
        const d = loopDecisionFromGate({ action: "approve" });
        decisions.push({ round: result.round, action: d.action });
        return d;
      },
    });
    const out = await loop.run();
    expect(out.reason).toBe("goal-met");
    expect(out.rounds).toBe(2);
    expect(summaries).toHaveLength(1); // 第 1 轮后 gate（第 2 轮 goal-met 不再过闸）
    expect(decisions).toEqual([{ round: 1, action: "approve" }]);
  });

  it("目标模式：fix 决策注入下一轮修正", async () => {
    const instructions: Array<string | undefined> = [];
    const loop = new GoalLoop({
      goal: "g",
      maxRounds: 3,
      goalCheck: (r) => r.round >= 3,
      runRound: async (n, instruction) => {
        instructions.push(instruction);
        return { round: n, summary: "", goalMet: false, metrics: { progress: n / 3 } };
      },
      roundGate: async (result) =>
        result.round === 1 ? { action: "fix", instruction: "把输入翻倍" } : { action: "approve" },
    });
    await loop.run();
    expect(instructions[0]).toBeUndefined();
    expect(instructions[1]).toBe("把输入翻倍");
  });

  it("stop 决策提前终止 + RunController.terminate 联动", async () => {
    const ctl = new RunController();
    ctl.onTerminateCallback(() => {
      /* 终止钩子（真实场景：abort 编排器） */
    });
    const loop = new GoalLoop({
      goal: "g",
      maxRounds: 10,
      goalCheck: () => false,
      runRound: async (n) => ({ round: n, summary: "", goalMet: false, metrics: {} }),
      roundGate: async () => {
        ctl.terminate();
        return { action: "stop" };
      },
    });
    const out = await loop.run();
    expect(out.reason).toBe("stopped");
    expect(out.rounds).toBe(1);
    expect(ctl.currentState).toBe("terminated");
  });
});

// makeNodeExecutor 冒烟（生产路径默认实现存在）
describe("makeNodeExecutor", () => {
  it("返回可调用执行器（委托 CapabilityInvoker）", async () => {
    const invoker = new CapabilityInvoker();
    const exec = makeNodeExecutor({ invoke: (c, a, i) => invoker.invoke(c, a, i) });
    expect(typeof exec).toBe("function");
    void exec;
  });
});
