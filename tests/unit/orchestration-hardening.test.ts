import { describe, expect, it } from "vitest";
import { Orchestrator } from "@/orchestrator/state-machine";
import { newBuildContext } from "@/orchestrator/context";
import { ClusterScheduler, inProcessDelegator } from "@/execution/cluster";
import { GoalLoop } from "@/execution/loop";
import { RunController } from "@/execution/repair";
import { CapabilityInstaller } from "@/execution/capability-runtime";
import { topoSort, findDownstreamNodes } from "@/orchestrator/dag";
import { buildCapability } from "@/federation/adapters/adapter-utils";
import type { Capability, Source } from "@/federation/types";
import type { OrchestratorDeps } from "@/orchestrator/state-machine";

const source: Source = { id: "modelscope", tier: "curated", name: "test", url: "https://example.com" };

function cap(id: string): Capability {
  return buildCapability({
    id,
    name: id,
    kind: "mcp-server",
    description: "test",
    source,
    install: { type: "npx", package: "pkg", args: [] },
    tags: ["test"],
  });
}

function noopDeps(over: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  const noop = async () => {};
  return {
    handlers: { parsing: noop, planning: noop, retrieving: noop, assembling: noop, verifying: noop, executing: noop, distilling: noop },
    persist: async () => {},
    ...over,
  };
}

async function approveAll(orch: Orchestrator, fromGate: 1 | 2 | 3 | 4 | 5 = 1, finalChoice: "pin" | "discard" = "discard"): Promise<void> {
  const gates = ([1, 2, 3, 4, 5] as const).slice(fromGate - 1);
  for (const gate of gates) {
    const request = await orch.waitForGate();
    expect(request.gate).toBe(gate);
    await orch.decide(gate === 5 ? { gate, action: "approve", choice: finalChoice } : { gate, action: "approve" });
  }
}

describe("orchestration hardening", () => {
  it("can start a fresh run after abort", async () => {
    const orch = new Orchestrator(noopDeps());
    orch.start("first", "first");
    const first = orch.run().catch((error: unknown) => error);
    await orch.waitForGate();
    orch.abort();
    expect((await first) as { code?: string }).toMatchObject({ code: "CANCELLED" });

    orch.start("second", "second");
    const second = orch.run();
    await approveAll(orch);
    expect((await second).id).toBe("second");
  });

  it("rejects concurrent run calls instead of driving two loops", async () => {
    const orch = new Orchestrator(noopDeps());
    orch.start("r", "r");
    const run = orch.run();
    await orch.waitForGate();
    await expect(orch.run()).rejects.toMatchObject({ code: "CONFLICT" });
    await orch.decide({ gate: 1, action: "approve" });
    await approveAll(orch, 2);
    await run;
  });

  it("does not retain failed acceptance after a rejected phase is rerun", async () => {
    let verifyRuns = 0;
    const deps = noopDeps();
    deps.handlers.verifying = async (ctx) => {
      verifyRuns += 1;
      ctx.acceptance.push({ layer: "component", passed: verifyRuns > 1, detail: {}, at: String(verifyRuns) });
    };
    const orch = new Orchestrator(deps);
    orch.start("r", "rollback");
    const run = orch.run();
    for (const gate of [1, 2, 3] as const) {
      await orch.waitForGate();
      await orch.decide({ gate, action: "approve" });
    }
    await orch.waitForGate();
    await orch.decide({ gate: 4, action: "reject", targetPhase: "verifying" });
    await orch.waitForGate();
    await orch.decide({ gate: 4, action: "approve" });
    await orch.waitForGate();
    await orch.decide({ gate: 5, action: "approve", choice: "discard" });
    const result = await run;
    expect(verifyRuns).toBe(2);
    expect(result.acceptance.filter((record) => record.layer === "component")).toHaveLength(1);
    expect(result.acceptance[0]?.passed).toBe(true);
  });

  it("normalizes stale selections when a new DAG is assembled", async () => {
    const ctx = newBuildContext("b", "r");
    ctx.intent = { goal: "r", domain: "general", slots: [], keywords: [], via: "template" };
    ctx.dag = { nodes: [{ id: "new", title: "new", deps: [], expectedOutput: "" }] };
    ctx.candidates = [{ nodeId: "new", query: "", candidates: [cap("new-cap")] }];
    ctx.selections = [{ nodeId: "old", capabilityId: "old-cap", overridden: true }];
    const { handleAssembling } = await import("@/orchestrator/handlers");
    await handleAssembling(ctx, { search: async () => ({ query: "", capabilities: [], statuses: [], totalMs: 0 }) });
    expect(ctx.selections).toEqual([{ nodeId: "new", capabilityId: "new-cap", overridden: false }]);
    expect(ctx.assembly?.nodes).toEqual([{ nodeId: "new", capabilityId: "new-cap", glueNeeded: false }]);
  });

  it("blocks dependent nodes after an upstream failure", async () => {
    const ctx = newBuildContext("b", "r");
    ctx.dag = { nodes: [{ id: "a", title: "a", deps: [], expectedOutput: "" }, { id: "b", title: "b", deps: ["a"], expectedOutput: "" }] };
    ctx.assembly = { nodes: [{ nodeId: "a", capabilityId: "a", glueNeeded: false }, { nodeId: "b", capabilityId: "b", glueNeeded: false }], edges: [{ from: "a", to: "b", alignment: "ok" }] };
    ctx.selections = [{ nodeId: "a", capabilityId: "a", overridden: false }, { nodeId: "b", capabilityId: "b", overridden: false }];
    ctx.candidates = [{ nodeId: "a", query: "", candidates: [cap("a")] }, { nodeId: "b", query: "", candidates: [cap("b")] }];
    const calls: string[] = [];
    const result = await new ClusterScheduler(
      inProcessDelegator(async (request) => {
        calls.push(request.nodeId);
        return { nodeId: request.nodeId, ok: false, error: "failed", durationMs: 1 };
      }),
      ctx,
    ).run();
    expect(calls).toEqual(["a"]);
    expect(result.allPassed).toBe(false);
    expect(ctx.trace.find((step) => step.nodeId === "b")?.error).toContain("upstream node a");
  });

  it("rejects empty and duplicate DAGs instead of treating them as success", () => {
    expect(() => topoSort({ nodes: [] })).toThrow(/at least one/);
    expect(() => topoSort({ nodes: [{ id: "x", title: "x", deps: [], expectedOutput: "" }, { id: "x", title: "again", deps: [], expectedOutput: "" }] })).toThrow(/unique/);
  });

  it("findDownstreamNodes correctly identifies all transitive dependents for cascade redo", () => {
    const dag = {
      nodes: [
        { id: "n1", title: "A", deps: [], expectedOutput: "" },
        { id: "n2", title: "B", deps: ["n1"], expectedOutput: "" },
        { id: "n3", title: "C", deps: ["n2"], expectedOutput: "" },
        { id: "n4", title: "D", deps: [], expectedOutput: "" },
      ],
    };
    expect(findDownstreamNodes(dag, "n1")).toEqual(["n2", "n3"]);
    expect(findDownstreamNodes(dag, "n2")).toEqual(["n3"]);
    expect(findDownstreamNodes(dag, "n3")).toEqual([]);
    expect(findDownstreamNodes(dag, "n4")).toEqual([]);
  });

  it("requires an execution trace for every assembled node before completion", async () => {
    const deps = noopDeps();
    deps.handlers.assembling = async (ctx) => {
      ctx.assembly = { nodes: [{ nodeId: "n", capabilityId: "c", glueNeeded: false }], edges: [] };
    };
    deps.handlers.verifying = async (ctx) => {
      ctx.acceptance.push({ layer: "component", passed: true, detail: {}, at: "now" });
    };
    deps.handlers.executing = async (ctx) => {
      ctx.acceptance.push({ layer: "task", passed: true, detail: {}, at: "now" });
    };
    deps.handlers.distilling = async (ctx) => {
      ctx.acceptance.push({ layer: "generalization", passed: true, detail: {}, at: "now" });
    };
    const orch = new Orchestrator(deps);
    orch.start("r", "trace-required");
    const run = orch.run();
    await approveAll(orch, 1, "pin");
    const result = await run;
    expect(result.outcome).toBe("failed");
  });

  it("releases all paused workers and validates loop limits", async () => {
    const controller = new RunController();
    controller.pause();
    const waits = [controller.checkpoint(), controller.checkpoint()];
    controller.resume();
    await Promise.all(waits);
    await expect(new GoalLoop({ goal: "bad", maxRounds: 0, goalCheck: () => false, runRound: async (round) => ({ round, summary: "", goalMet: false, metrics: {} }) }).run()).rejects.toMatchObject({ code: "LOOP_LIMIT" });
  });

  it("treats a failed npx preflight as an install failure and forwards args", async () => {
    let seen: string[] = [];
    const installer = new CapabilityInstaller({ runner: { run: async (_command, args) => { seen = args; return { code: 1, stdout: "", stderr: "no package" }; } } });
    await expect(installer.install(buildCapability({ id: "x", name: "x", kind: "mcp-server", description: "", source, install: { type: "npx", package: "pkg", args: ["--stdio"] }, tags: [] }))).rejects.toMatchObject({ code: "INSTALL_FAILED" });
    expect(seen).toEqual(["--yes", "pkg", "--stdio", "--version"]);
  });
});

