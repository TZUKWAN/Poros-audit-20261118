import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClusterScheduler, inProcessDelegator, assertDelegationDepth } from "@/execution/cluster";
import { CapabilityInstaller, CapabilityInvoker, PermissionGate } from "@/execution/capability-runtime";
import type { CommandRunner } from "@/execution/capability-runtime";
import { GoalLoop, loopDecisionFromGate, assertLoopParams } from "@/execution/loop";
import { ReactorBridge, startLocalWebhook } from "@/execution/reactor-bridge";
import { RunController } from "@/execution/repair";
import { buildCapability } from "@/federation/adapters/adapter-utils";
import { newBuildContext, type BuildContext } from "@/orchestrator/context";
import type { Capability, Source } from "@/federation/types";

const src: Source = { id: "modelscope", tier: "curated", name: "t", url: "https://t" };

function cap(over: Partial<Capability> & { id: string; name: string }): Capability {
  return buildCapability({
    kind: "mcp-server",
    description: "c",
    source: src,
    install: { type: "npx", package: "pkg", args: [] },
    tags: ["fs"],
    ...over,
  } as Parameters<typeof buildCapability>[0]);
}

function clusterCtx(nodes: Array<[string, string[]]>, selections: Array<[string, string]>, candidates: Array<[string, Capability[]]>): BuildContext {
  const ctx = newBuildContext("b", "r");
  ctx.dag = { nodes: nodes.map(([id, deps]) => ({ id, title: `任务${id}`, deps, expectedOutput: "out" })) };
  ctx.assembly = {
    nodes: selections.map(([nodeId, capabilityId]) => ({ nodeId, capabilityId, glueNeeded: false })),
    edges: nodes.flatMap(([id, deps]) => deps.map((d) => ({ from: d, to: id, alignment: "ok" as const }))),
  };
  ctx.selections = selections.map(([nodeId, capabilityId]) => ({ nodeId, capabilityId, overridden: false }));
  ctx.candidates = candidates.map(([nodeId, caps]) => ({ nodeId, query: "", candidates: caps }));
  return ctx;
}

describe("4.1.1 集群调度：3 并行节点产生 3 委派", () => {
  it("同层 3 节点并发，事件序 started×3 + finished×3，结果回流 trace", async () => {
    const caps = [cap({ id: "a", name: "a" }), cap({ id: "b", name: "b" }), cap({ id: "c", name: "c" })];
    const ctx = clusterCtx(
      [
        ["n1", []],
        ["n2", []],
        ["n3", []],
      ],
      [
        ["n1", "a"],
        ["n2", "b"],
        ["n3", "c"],
      ],
      [["n1", caps]],
    );
    let delegations = 0;
    const events: string[] = [];
    const scheduler = new ClusterScheduler(
      inProcessDelegator(async (req) => {
        delegations++;
        return { nodeId: req.nodeId, ok: true, output: `out-${req.nodeId}`, durationMs: 1 };
      }),
      ctx,
    );
    const summary = await scheduler.run({
      onEvent: (e) => events.push(e.type),
    });
    expect(delegations).toBe(3);
    expect(events.filter((e) => e === "worker:started")).toHaveLength(3);
    expect(events.filter((e) => e === "worker:finished")).toHaveLength(3);
    expect(summary.allPassed).toBe(true);
    expect(ctx.trace).toHaveLength(3);
    expect((ctx.trace[0] as { output?: string }).output).toMatch(/^out-n/);
  });

  it("上游输出经边喂给下游（inputs 收集）", async () => {
    const caps = [cap({ id: "a", name: "a" }), cap({ id: "b", name: "b" })];
    const ctx = clusterCtx(
      [
        ["n1", []],
        ["n2", ["n1"]],
      ],
      [
        ["n1", "a"],
        ["n2", "b"],
      ],
      [["n1", caps]],
    );
    const seenInputs: Array<Record<string, unknown>> = [];
    const scheduler = new ClusterScheduler(
      inProcessDelegator(async (req) => {
        seenInputs.push(req.inputs);
        return { nodeId: req.nodeId, ok: true, output: req.nodeId === "n1" ? "UPSTREAM" : `got:${JSON.stringify(req.inputs)}`, durationMs: 1 };
      }),
      ctx,
    );
    await scheduler.run();
    expect(seenInputs[0]).toEqual({});
    expect(seenInputs[1]).toEqual({ n1: "UPSTREAM" });
  });

  it("worker 失败折叠为 failed 状态（不炸整个 run）", async () => {
    const caps = [cap({ id: "a", name: "a" })];
    const ctx = clusterCtx([["n1", []]], [["n1", "a"]], [["n1", caps]]);
    const scheduler = new ClusterScheduler(
      inProcessDelegator(async (req) => ({ nodeId: req.nodeId, ok: false, error: "boom", durationMs: 1 })),
      ctx,
    );
    const summary = await scheduler.run();
    expect(summary.allPassed).toBe(false);
    expect((ctx.trace[0] as { error?: string }).error).toBe("boom");
  });
});

describe("4.1.2 递归深度=1 约束", () => {
  it("depth>1 拒绝", async () => {
    expect(() =>
      assertDelegationDepth({ nodeId: "n", capability: cap({ id: "x", name: "x" }), title: "t", expectedOutput: "", inputs: {}, depth: 2 }),
    ).toThrowError();
    try {
      assertDelegationDepth({ nodeId: "n", capability: cap({ id: "x", name: "x" }), title: "t", expectedOutput: "", inputs: {}, depth: 2 });
    } catch (e) {
      expect((e as { code?: string }).code).toBe("DEPTH_EXCEEDED");
    }
  });
  it("skill-knowledge 不可委派（上下文注入语义）", () => {
    expect(() =>
      assertDelegationDepth({
        nodeId: "n",
        capability: cap({ id: "s", name: "s", kind: "skill-knowledge", install: { type: "context", location: "x" } }),
        title: "t",
        expectedOutput: "",
        inputs: {},
        depth: 1,
      }),
    ).toThrowError(/skill-knowledge/);
  });
  it("depth=1 正常通过（回流字段完整）", async () => {
    const d = inProcessDelegator(async (req) => ({ nodeId: req.nodeId, ok: true, output: "ok", durationMs: 1, params: { p: 1 } }));
    const r = await d.delegate({ nodeId: "n1", capability: cap({ id: "x", name: "x" }), title: "t", expectedOutput: "e", inputs: { i: 1 }, depth: 1 });
    expect(r.ok).toBe(true);
    expect(r.params).toEqual({ p: 1 });
  });
});

describe("4.2.1 安装器四方式 + 安装锁", () => {
  const fakeRunner = (log: string[]): CommandRunner => {
    return {
      run: async (command, args) => {
        log.push(`${command} ${args.join(" ")}`);
        return { code: 0, stdout: "1.0.0\n", stderr: "" };
      },
    };
  };

  it("npx / cli / remote 三方式", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "inst-"));
    const log: string[] = [];
    const installer = new CapabilityInstaller({ runner: fakeRunner(log), installsDir: dir });
    const npx = await installer.install(cap({ id: "p:n", name: "n", install: { type: "npx", package: "@x/y", args: [] } }));
    expect(npx.method).toBe("npx");
    expect(log[0]).toContain("npx --yes @x/y --version");
    const cli = await installer.install(cap({ id: "p:c", name: "c", install: { type: "cli", command: "tool", args: [] } }));
    expect(cli.method).toBe("cli");
    const remote = await installer.install(cap({ id: "p:r", name: "r", install: { type: "remote", url: "https://x/mcp" } }));
    expect(remote.method).toBe("remote");
    expect(remote.location).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });

  it("git clone：runner 收到正确参数；二次安装命中缓存不再 clone", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "inst-git-"));
    const log: string[] = [];
    const installer = new CapabilityInstaller({ runner: fakeRunner(log), installsDir: dir });
    const c = cap({ id: "p:g", name: "g", install: { type: "git", repoUrl: "https://github.com/a/b" } });
    await installer.install(c);
    expect(log.some((l) => l.startsWith("git clone --depth 1"))).toBe(true);
    await installer.install(c);
    expect(log.filter((l) => l.startsWith("git clone"))).toHaveLength(1); // 缓存
    await rm(dir, { recursive: true, force: true });
  });

  it("并发同包只装一次（安装锁）", async () => {
    const log: string[] = [];
    let running = 0;
    let maxConcurrent = 0;
    const installer = new CapabilityInstaller({
      runner: {
        run: async (command, args) => {
          running++;
          maxConcurrent = Math.max(maxConcurrent, running);
          await new Promise((r) => setTimeout(r, 30));
          running--;
          log.push(`${command} ${args.join(" ")}`);
          return { code: 0, stdout: "1.0.0", stderr: "" };
        },
      },
    });
    const c = cap({ id: "p:lock", name: "lock", install: { type: "npx", package: "slow-pkg", args: [] } });
    const results = await Promise.all([installer.install(c), installer.install(c), installer.install(c)]);
    expect(results).toHaveLength(3);
    expect(log).toHaveLength(1); // 只装一次
    expect(maxConcurrent).toBe(1);
  });

  it("权限拒绝：install 不执行", async () => {
    const gate = new PermissionGate();
    gate.onRequest((_req, respond) => respond("deny"));
    const log: string[] = [];
    const installer = new CapabilityInstaller({ runner: fakeRunner(log) });
    await expect(installer.install(cap({ id: "p:denied", name: "d" }), gate)).rejects.toMatchObject({ code: "CANCELLED" });
    expect(log).toHaveLength(0);
  });

  it("git clone 失败 → INSTALL_FAILED", async () => {
    const installer = new CapabilityInstaller({
      runner: {
        run: async () => ({ code: 128, stdout: "", stderr: "fatal: not found" }),
      },
    });
    await expect(
      installer.install(cap({ id: "p:badgit", name: "bg", install: { type: "git", repoUrl: "https://github.com/no/no" } })),
    ).rejects.toMatchObject({ code: "INSTALL_FAILED" });
  });
});

describe("4.2.2 调用器", () => {
  it("remote JSON-RPC：真实本地 HTTP 服务一次完整调用", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += String(c)));
      req.on("end", () => {
        const parsed = JSON.parse(body) as { method: string; params: { name: string; arguments: unknown } };
        expect(parsed.method).toBe("tools/call");
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ text: `done:${parsed.params.name}` }] } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      const invoker = new CapabilityInvoker();
      const c = cap({ id: "r:real", name: "real-fs", install: { type: "remote", url: `http://127.0.0.1:${port}/mcp` } });
      const out = await invoker.invoke(c, "real-fs", { path: "/tmp/x" });
      expect(out.ok).toBe(true);
      expect(JSON.stringify(out.output)).toContain("done:real-fs");
      expect(out.latencyMs).toBeGreaterThanOrEqual(0);
    } finally {
      server.close();
    }
  });

  it("remote SSE 形态响应解析", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "text/event-stream");
      res.end('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"sse":true}}\n\n');
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      const invoker = new CapabilityInvoker();
      const c = cap({ id: "r:sse", name: "sse", install: { type: "remote", url: `http://127.0.0.1:${port}/mcp` } });
      const out = await invoker.invoke(c, "sse", {});
      expect(out.ok).toBe(true);
      expect(out.output).toEqual({ sse: true });
    } finally {
      server.close();
    }
  });

  it("remote JSON-RPC error → ok=false 且 message 可读", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((_req, res) => {
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "method not found" } }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      const invoker = new CapabilityInvoker();
      const c = cap({ id: "r:err", name: "err", install: { type: "remote", url: `http://127.0.0.1:${port}/mcp` } });
      const out = await invoker.invoke(c, "nope", {});
      expect(out.ok).toBe(false);
      expect(out.error).toContain("-32601");
    } finally {
      server.close();
    }
  });

  it("stdio 协议：本地 node 脚本完整 initialize→tools/call 往返（npx 同路径）", async () => {
    const invoker = new CapabilityInvoker();
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "stdio-echo-server.mjs");
    const out = await invoker.runStdioJsonRpc([script], "echo", { hello: "世界" }, { timeoutMs: 15000 }, Date.now(), "node");
    expect(out.ok).toBe(true);
    const content = (out.output as { content: Array<{ text: string }> }).content[0]?.text;
    expect(content).toBe(`echo:{"hello":"世界"}`);
  });

  it("skill-knowledge：上下文注入（描述降级路径）", async () => {
    const invoker = new CapabilityInvoker();
    const c = cap({ id: "s:x", name: "skill-x", kind: "skill-knowledge", install: { type: "context", location: "nowhere" }, description: "SKILL 内容" });
    const out = await invoker.invoke(c, "read", {});
    expect(out.ok).toBe(true);
    expect((out.output as { mode: string }).mode).toBe("context-injection");
    expect((out.output as { content: string }).content).toContain("SKILL 内容");
  });

  it("git 能力：context-handoff 装配说明", async () => {
    const invoker = new CapabilityInvoker();
    const c = cap({ id: "g:x", name: "git-x", install: { type: "git", repoUrl: "https://github.com/a/b" } });
    const out = await invoker.invoke(c, "run", {});
    expect(out.ok).toBe(true);
    expect((out.output as { mode: string }).mode).toBe("context-handoff");
  });
});

describe("4.2.3 权限门控（审批事件）", () => {
  it("远程调用触发审批；允许后放行", async () => {
    const gate = new PermissionGate();
    const requests: string[] = [];
    gate.onRequest((req, respond) => {
      requests.push(`${req.kind}:${req.capabilityId}`);
      respond("allow");
    });
    const { createServer } = await import("node:http");
    const server = createServer((_req, res) => res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" })));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      const invoker = new CapabilityInvoker(gate);
      const c = cap({ id: "p:perm", name: "perm", install: { type: "remote", url: `http://127.0.0.1:${port}/mcp` } });
      const out = await invoker.invoke(c, "act", {});
      expect(out.ok).toBe(true);
      expect(requests).toEqual([`remote-call:p:perm`]);
    } finally {
      server.close();
    }
  });

  it("审批拒绝：调用返回 denied 不发请求", async () => {
    const gate = new PermissionGate();
    gate.onRequest((_req, respond) => respond("deny"));
    let httpCalled = false;
    const fakeFetch = (async () => {
      httpCalled = true;
      throw new Error("should not reach");
    }) as unknown as typeof fetch;
    const invoker = new CapabilityInvoker(gate, fakeFetch);
    const c = cap({ id: "p:denied", name: "denied", install: { type: "remote", url: "http://127.0.0.1:9/mcp" } });
    const out = await invoker.invoke(c, "act", {});
    expect(out.ok).toBe(false);
    expect(out.error).toContain("denied");
    expect(httpCalled).toBe(false);
  });
});

describe("4.3.1 循环引擎（goal 模式）", () => {
  it("2 轮达成的目标恰好 2 轮完成", async () => {
    let round = 0;
    const events: string[] = [];
    const loop = new GoalLoop({
      goal: "测试目标",
      maxRounds: 5,
      goalCheck: (r) => (r.metrics.progress ?? 0) >= 1,
      runRound: async (n) => {
        round = n;
        return { round: n, summary: `round ${n}`, goalMet: false, metrics: { progress: n / 2 } };
      },
    });
    loop.on((e) => events.push(e.type));
    const out = await loop.run();
    expect(out.reason).toBe("goal-met");
    expect(out.rounds).toBe(2);
    expect(round).toBe(2);
    expect(events.filter((e) => e === "round:start")).toHaveLength(2);
    expect(events).toContain("loop:done");
  });

  it("max-rounds 硬顶终止", async () => {
    const loop = new GoalLoop({
      goal: "g",
      maxRounds: 3,
      goalCheck: () => false,
      runRound: async (n) => ({ round: n, summary: "", goalMet: false, metrics: {} }),
    });
    const out = await loop.run();
    expect(out.reason).toBe("max-rounds");
    expect(out.rounds).toBe(3);
  });

  it("maxRounds 非法参数拒绝", () => {
    expect(() => assertLoopParams(0)).toThrowError();
    expect(() => assertLoopParams(51)).toThrowError();
    expect(() => assertLoopParams(2.5)).toThrowError();
    expect(() => assertLoopParams(5)).not.toThrow();
  });

  it("GateDecision 适配：approve/fix(comment)/stop", () => {
    expect(loopDecisionFromGate({ action: "approve" })).toEqual({ action: "approve" });
    expect(loopDecisionFromGate({ action: "reject", comment: "改成 X" })).toEqual({ action: "fix", instruction: "改成 X" });
    expect(loopDecisionFromGate({ action: "reject" })).toEqual({ action: "stop" });
  });
});

describe("4.3.3 pi-reactor 桥 + 本地 webhook", () => {
  it("cron trigger add/rm 命令构造正确（fake runner）", async () => {
    const log: Array<[string, string[]]> = [];
    const bridge = new ReactorBridge({
      run: async (command, args) => {
        log.push([command, args]);
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await bridge.addCronTrigger({ id: "demo", schedule: "*/5 * * * *", agent: "scenario", task: "跑目标" });
    await bridge.removeTrigger("demo");
    expect(log[0]).toEqual(["pi-reactor", ["trigger", "add", "demo", "--schedule", "*/5 * * * *", "--agent", "scenario", "--task", "跑目标"]]);
    expect(log[1]).toEqual(["pi-reactor", ["trigger", "rm", "demo"]]);
  });

  it("失败命令抛 INVOKE_FAILED", async () => {
    const bridge = new ReactorBridge({ run: async () => ({ code: 1, stdout: "", stderr: "no daemon" }) });
    await expect(bridge.addCronTrigger({ id: "x", schedule: "* * * * *", agent: "a", task: "t" })).rejects.toMatchObject({
      code: "INVOKE_FAILED",
    });
  });

  it("本地 webhook：真实 POST 触发一次 + 自动注销 + 重复 POST 忽略", async () => {
    const payloads: unknown[] = [];
    const hook = await startLocalWebhook({
      onStart: (p) => {
        payloads.push(p);
      },
    });
    const r1 = await fetch(hook.url, { method: "POST", body: JSON.stringify({ goal: "触发" }) });
    expect(r1.status).toBe(202);
    await new Promise((r) => setTimeout(r, 150)); // onStart + close
    expect(payloads).toEqual([{ goal: "触发" }]);
    // 自动关闭后连接被拒
    await expect(fetch(hook.url, { method: "POST", body: "{}" })).rejects.toThrow();
  }, 15_000);

  it("webhook token 鉴权：无 token 401", async () => {
    let started = 0;
    const hook = await startLocalWebhook({
      token: "secret",
      onStart: () => {
        started++;
      },
    });
    try {
      const bad = await fetch(hook.url, { method: "POST", body: "{}" });
      expect(bad.status).toBe(401);
      const good = await fetch(hook.url, { method: "POST", body: "{}", headers: { "x-scenario-token": "secret" } });
      expect(good.status).toBe(202);
      await new Promise((r) => setTimeout(r, 150));
      expect(started).toBe(1);
    } finally {
      await hook.close();
    }
  });

  it("GET 405", async () => {
    const hook = await startLocalWebhook({ onStart: () => {
      /* noop */
} });
    try {
      const r = await fetch(hook.url);
      expect(r.status).toBe(405);
    } finally {
      await hook.close();
    }
  });
});

describe("4.3.2 RunController 与循环联动（三决策路径）", () => {
  it("checkpoint 终止传播到执行循环", async () => {
    const ctl = new RunController();
    ctl.terminate();
    await expect(ctl.checkpoint()).rejects.toMatchObject({ code: "CANCELLED" });
  });
});
