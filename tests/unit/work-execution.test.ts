import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeScenarioWork, artifactChecksum, type WorkModel } from "@/panel/work-execution";
import type { ModelResult } from "@/panel/model-client";
import { localDefinition } from "@/scenario/definition";
import type { RuntimeContext } from "@/orchestrator/context";
import { jsonStore } from "@/core/store";
import { RunRepository } from "@/product/runs";
import { RunProductSchema } from "@/product/contracts";

function context(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  return {
    projectId: "project-a",
    projectInstructions: "只使用提供的证据。",
    files: [{ id: "file-a", name: "source.md", path: "", mediaType: "text/markdown", size: 13, content: "FACT: source" }],
    memories: [],
    connectors: [],
    desktopContexts: [],
    provider: null,
    ...overrides,
  };
}

function result(text: string, model = "audit-model", totalTokens = 3): ModelResult {
  return { text, model, streamed: false, totalTokens };
}

function definition() {
  return localDefinition("把输入资料整理成可核查的报告");
}

describe("任务 4：保存场景的真实工作执行", () => {
  it("缺少场景必填输入时等待用户，明确返回缺口并落盘可追溯产物", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "work-execution-awaiting-user-"));
    try {
      const required = { ...definition(), inputs: [{ name: "sourcePath", description: "源文件路径", required: true, type: "path" as const }] };
      let called = false;
      const execution = await executeScenarioWork({
        definition: required,
        requirement: "整理源文件",
        context: context(),
        model: { complete: async () => { called = true; return result("不应调用"); } },
        outputPath: path.join(dir, "awaiting.md"),
      });
      expect(execution.status).toBe("awaiting-user");
      expect(execution.validation).toBe("untested");
      expect(execution.missingInputs).toEqual([{ name: "sourcePath", description: "源文件路径", type: "path" }]);
      expect(called).toBe(false);
      expect(execution.artifactContent).toContain("缺少必填输入");
      expect(await readFile(execution.artifactPath, "utf8")).toContain("运行状态：awaiting-user");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("模型成功：按拓扑执行、传递上游输出、读取上下文并落盘可读产物", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "work-execution-success-"));
    try {
      const calls: string[] = [];
      const systems: string[] = [];
      const chunks: string[] = [];
      const thinking: string[] = [];
      const finishes: Array<{ title: string; durationMs: number }> = [];
      const model: WorkModel = {
        complete: async (system, input, options) => {
          systems.push(system);
          calls.push(input);
          const output = calls.length === 1 ? "准备结果：FACT-1" : calls.length === 2 ? "整理结果" : "最终报告";
          if (calls.length === 1) options?.onEvent?.({ type: "thinking", chunk: "先检查资料" });
          options?.onChunk?.(output);
          return result(output);
        },
      };
      const outputPath = path.join(dir, "result.md");
      const execution = await executeScenarioWork({
        definition: definition(),
        requirement: "把输入资料整理成可核查的报告",
        context: context(),
        model,
        outputPath,
        onEvent: (event) => { if (event.type === "chunk") chunks.push(event.chunk); if (event.type === "thinking") thinking.push(event.chunk); if (event.type === "step-finish") finishes.push({ title: event.title, durationMs: event.durationMs }); },
      });

      expect(execution.status).toBe("succeeded");
      expect(execution.validation).toBe("passed");
      expect(execution.trace.map((step) => step.status)).toEqual(["success", "success", "success"]);
      expect(execution.outputs).toMatchObject({ prepare: "准备结果：FACT-1", produce: "整理结果", review: "最终报告" });
      expect(calls).toHaveLength(3);
      expect(systems[0]).toContain("skipped");
      expect(systems[0]).toContain("方案/目录/流程设计也不等于实际落盘");
      expect(calls[0]).toContain("FACT: source");
      expect(calls[1]).toContain("准备结果：FACT-1");
      expect(calls[2]).toContain("整理结果");
      expect(chunks).toEqual(["准备结果：FACT-1", "整理结果", "最终报告"]);
      expect(thinking).toEqual(["先检查资料"]);
      expect(finishes).toHaveLength(3);
      expect(finishes.every((event) => event.durationMs >= 0)).toBe(true);
      expect(await readFile(outputPath, "utf8")).toBe(execution.artifactContent);
      expect(execution.artifactContent).toContain("运行状态：succeeded");
      expect(execution.artifactContent).toContain("最终报告");
      expect(artifactChecksum(execution.artifactContent)).toHaveLength(64);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("模型失败：停止后续节点，产物和 trace 明确失败，不能伪报成功", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "work-execution-failure-"));
    try {
      let calls = 0;
      const model: WorkModel = {
        complete: async () => {
          calls++;
          if (calls === 1) return result("准备结果");
          throw new Error("provider failed: Bearer super-secret");
        },
      };
      const execution = await executeScenarioWork({
        definition: definition(),
        requirement: "失败场景",
        context: context(),
        model,
        outputPath: path.join(dir, "failed.md"),
      });

      expect(execution.status).toBe("failed");
      expect(execution.validation).toBe("failed");
      expect(execution.error).toContain("provider failed");
      expect(execution.error).not.toContain("super-secret");
      expect(execution.trace.map((step) => step.status)).toEqual(["success", "failed"]);
      expect(execution.trace.some((step) => step.nodeId === "review")).toBe(false);
      expect(execution.artifactContent).toContain("运行状态：failed");
      expect(execution.artifactContent).toContain("provider failed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("模型明确说明本次未执行时，不把文字生成伪装成任务成功", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "work-execution-evidence-gap-"));
    try {
      const model: WorkModel = { complete: async () => result("执行状态：未执行。缺少真实数据，无法确认本次任务结果。") };
      const execution = await executeScenarioWork({ definition: definition(), requirement: "缺少数据", context: context(), model, outputPath: path.join(dir, "gap.md") });
      expect(execution.status).toBe("untested");
      expect(execution.validation).toBe("untested");
      expect(execution.error).toContain("缺少真实执行证据");
      expect(execution.artifactContent).toContain("没有形成可验证的任务结果");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("没有模型：只生成计划，状态为 untested，不能当作任务成功", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "work-execution-untested-"));
    try {
      const execution = await executeScenarioWork({
        definition: definition(),
        requirement: "离线运行",
        context: context(),
        model: null,
        outputPath: path.join(dir, "plan.md"),
      });

      expect(execution.status).toBe("untested");
      expect(execution.validation).toBe("untested");
      expect(execution.trace.every((step) => step.status === "planned")).toBe(true);
      expect(execution.artifactContent).toContain("模型 Provider 不可用");
      expect(await readFile(execution.artifactPath, "utf8")).toContain("运行状态：untested");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("文件上下文只读取已授权工作区内的文件，越界文件被排除并告警", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "work-execution-context-"));
    try {
      const allowed = path.join(dir, "allowed.md");
      const outside = path.join(path.dirname(dir), "outside.md");
      await writeFile(allowed, "ALLOWED_FACT", "utf8");
      await writeFile(outside, "OUTSIDE_SECRET", "utf8");
      const calls: string[] = [];
      const model: WorkModel = { complete: async (_system, input) => { calls.push(input); return result("done"); } };
      const execution = await executeScenarioWork({
        definition: definition(),
        requirement: "读取项目资料",
        context: context({ files: [
          { id: "inside", name: "allowed.md", path: allowed, mediaType: "text/markdown", size: 12 },
          // Even a preloaded content field must not bypass the realpath boundary.
          { id: "outside", name: "outside.md", path: outside, mediaType: "text/markdown", size: 13, content: "OUTSIDE_SECRET" },
        ] }),
        model,
        outputPath: path.join(dir, "result.md"),
        allowedRoot: dir,
      });

      expect(execution.status).toBe("succeeded");
      expect(calls[0]).toContain("ALLOWED_FACT");
      expect(calls[0]).not.toContain("OUTSIDE_SECRET");
      expect(execution.trace[0]?.inputSources).toContain("file:inside");
      expect(execution.trace[0]?.inputSources).not.toContain("file:outside");
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(path.join(path.dirname(dir), "outside.md"), { force: true });
    }
  });

  it("取消：中断模型等待，写入 cancelled 产物并且不继续下游", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "work-execution-cancel-"));
    try {
      const controller = new AbortController();
      const model: WorkModel = {
        complete: async (_system, _input, options) => await new Promise<never>((_resolve, reject) => {
          const abort = () => reject(new DOMException("Aborted", "AbortError"));
          if (options?.signal?.aborted) abort();
          else options?.signal?.addEventListener("abort", abort, { once: true });
          setTimeout(() => controller.abort(), 10);
        }),
      };
      const execution = await executeScenarioWork({
        definition: definition(),
        requirement: "取消运行",
        context: context(),
        model,
        outputPath: path.join(dir, "cancelled.md"),
        signal: controller.signal,
      });

      expect(execution.status).toBe("cancelled");
      expect(execution.validation).toBe("failed");
      expect(execution.trace).toHaveLength(1);
      expect(execution.trace[0]?.status).toBe("skipped");
      expect(execution.artifactContent).toContain("运行状态：cancelled");
      expect(execution.trace.some((step) => step.nodeId === "produce")).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("取消竞态：模型刚返回但信号已取消时，不提交成功输出", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "work-execution-cancel-race-"));
    try {
      const controller = new AbortController();
      const model: WorkModel = { complete: async () => { controller.abort(); return result("late output"); } };
      const execution = await executeScenarioWork({ definition: definition(), requirement: "取消竞态", context: context(), model, outputPath: path.join(dir, "cancel-race.md"), signal: controller.signal });
      expect(execution.status).toBe("cancelled");
      expect(execution.trace[0]?.status).toBe("skipped");
      expect(execution.outputs).toEqual({});
      expect(execution.artifactContent).toContain("运行状态：cancelled");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("步骤级暂停：暂停时不调用下一步，继续后才恢复执行", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "work-execution-pause-"));
    try {
      let paused = true;
      let release!: () => void;
      const calls: string[] = [];
      const model: WorkModel = { complete: async (_system, input) => { calls.push(input); return result(`step-${calls.length}`); } };
      const checkpoint = async () => {
        if (!paused) return;
        await new Promise<void>((resolve) => { release = resolve; });
        paused = false;
      };
      const pending = executeScenarioWork({ definition: definition(), requirement: "暂停恢复", context: context(), model, outputPath: path.join(dir, "paused.md"), checkpoint });
      await new Promise((resolve) => setTimeout(resolve, 15));
      expect(calls).toHaveLength(0);
      release();
      const execution = await pending;
      expect(execution.status).toBe("succeeded");
      expect(calls).toHaveLength(3);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("任务 5：运行终态在重启后保持", () => {
  it("运行被取消后，新的 RunRepository 实例仍读取 cancelled 终态", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "run-restart-"));
    try {
      const filePath = path.join(dir, "runs.json");
      const createRepository = () => new RunRepository(jsonStore({ filePath, schema: RunProductSchema }));
      const startedAt = "2026-10-16T00:00:00.000Z";
      const first = createRepository();
      await first.create({ id: "run-restart", workspaceId: "workspace-a", projectId: null, sessionId: "session-a", mode: "work", scenarioId: "scenario-a", providerId: null, model: "audit-model", status: "running", requirement: "重启测试", startedAt, finishedAt: null, error: null });
      await first.update("run-restart", { status: "cancelled", finishedAt: "2026-10-16T00:00:01.000Z", error: "运行已取消", durationMs: 1000 });
      const afterRestart = createRepository();
      await expect(afterRestart.get("run-restart")).resolves.toMatchObject({ status: "cancelled", error: "运行已取消", finishedAt: "2026-10-16T00:00:01.000Z" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

});
