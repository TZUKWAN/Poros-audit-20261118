import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createOrchestrator, attachVirtualUser } from "@/orchestrator/runner";
import { memoryBuildStore } from "@/orchestrator/build-store";
import { sessionMemoryMd, scenarioReuseEntryMd, knowledgeEntryMd, KnowledgeMemory, memoryPaths, memoryTree } from "@/memory/memory";
import { ScenarioLibrary, recordFromDistilled } from "@/scenario/library";
import { distill } from "@/distill/distill";
import { InMemoryRetriever, renderExperienceBlock } from "@/memory/retriever";
import { VirtualUser } from "../virtual-user/driver";
import { writeFile, mkdir } from "node:fs/promises";
import { buildCapability } from "@/federation/adapters/adapter-utils";
import type { Source } from "@/federation/types";
import type { FederatedResult } from "@/federation/search";
import type { HandlerDeps } from "@/orchestrator/handlers";

/**
 * 阶段七集成：一次构建 + 两次复用后，三层 Memory 文档真实可读（自审断言）。
 */

const src: Source = { id: "modelscope", tier: "curated", name: "t", url: "https://t" };

function deps(): HandlerDeps {
  const cap = buildCapability({
    id: "cap-fs",
    name: "cap-fs",
    kind: "mcp-server",
    description: "fs",
    source: src,
    install: { type: "npx", package: "pkg", args: [] },
    tags: ["fs"],
  });
  return {
    search: async (q: string, _limit?: number): Promise<FederatedResult> => ({
      query: q,
      capabilities: [cap],
      statuses: [{ source: "modelscope", ok: true, degraded: false, latencyMs: 1, count: 1 }],
      totalMs: 1,
    }),
    execute: async (ctx) => {
      ctx.trace.push({ nodeId: "n1", startedAt: "t", finishedAt: "t", status: "success", params: { path: "/data/in.csv" } });
      ctx.acceptance.push({ layer: "task", passed: true, detail: { echo: "/data/in.csv" }, at: "t" });
    },
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "mem-int-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("阶段七集成：构建 + 两次复用 → 三层文档", () => {
  it("会话/场景/知识三层真实可读 + 检索命中", async () => {
    const paths = memoryPaths(dir);
    for (const p of [paths.sessions, paths.scenarios, paths.knowledge]) await mkdir(p, { recursive: true });
    const knowledge = new KnowledgeMemory();
    const retriever = new InMemoryRetriever();

    // ── 一次构建 ──
    const store = memoryBuildStore();
    const orch = createOrchestrator({ handlerDeps: deps(), store });
    attachVirtualUser(orch, new VirtualUser({ kind: "approve-all" }));
    orch.start("整理 /data 下的数据并生成报告", "b-mem-1");
    const final = await orch.run();
    expect(final.phase).toBe("done");

    // 会话 Memory 落盘
    const sessionFile = path.join(paths.sessions, `${final.id}.md`);
    await writeFile(sessionFile, sessionMemoryMd(final), "utf8");

    // 固化场景（真 jsonStore：z.unknown 模式全收，仅测库逻辑）
    const { jsonStore } = await import("@/core/store");
    const { z } = await import("zod");
    const library = new ScenarioLibrary({
      store: jsonStore({ filePath: path.join(dir, "scen.json"), schema: z.unknown() }),
    });
    const distilled = await distill(final);
    await library.save(
      recordFromDistilled({ id: "sc-mem", name: "数据整理报告", ctx: final, distilled, capabilityIds: ["cap-fs"] }),
    );

    // ── 两次复用 ──
    const scenarioFile = path.join(paths.scenarios, "sc-mem.md");
    await writeFile(scenarioFile, "# 场景 sc-mem\n\n", "utf8");
    for (const [i, ok] of [true, true].entries()) {
      await library.execute("sc-mem", { path: `/data/in${i}.csv` }, async () => ({ ok }));
      await writeFile(
        scenarioFile,
        scenarioReuseEntryMd({ scenarioId: "sc-mem", at: `2026-09-29T0${i + 1}:00:00Z`, slots: { path: `/data/in${i}.csv` }, ok }),
        { encoding: "utf8", flag: "a" },
      );
    }

    // 知识 Memory：一次失败事件（同类两次合并）
    knowledge.recordFailure("install:npx-timeout", "npx 预取超时 → 改 --prefer-offline", new Date("2026-09-29T01:00:00Z"));
    knowledge.recordFailure("install:npx-timeout", "npx 预取超时 → --prefer-offline + 90s 超时", new Date("2026-09-29T02:00:00Z"));
    for (const entry of knowledge.all()) {
      await writeFile(path.join(paths.knowledge, `${entry.id}.md`), knowledgeEntryMd(entry), "utf8");
      retriever.add({ id: entry.id, text: `${entry.signature}：${entry.lesson}`, source: "knowledge" });
    }

    // ── 自审：三层文档真实可读 ──
    const sessionMd = await readFile(sessionFile, "utf8");
    expect(sessionMd).toContain("# 会话 b-mem-1");
    expect(sessionMd).toContain("整理 /data 下的数据并生成报告");
    expect(sessionMd).toContain("- n1: success");

    const scenarioMd = await readFile(scenarioFile, "utf8");
    expect(scenarioMd.match(/## 复用 /g)).toHaveLength(2);
    expect(scenarioMd).toContain("path=/data/in0.csv");

    const kbFiles = await readdir(paths.knowledge);
    expect(kbFiles).toHaveLength(1); // 同类失败合并为 1 条
    const kbMd = await readFile(path.join(paths.knowledge, kbFiles[0]!), "utf8");
    expect(kbMd).toContain("累计: 2 次");
    expect(kbMd).toContain("--prefer-offline");

    // 检索命中（经验注入形态）
    const hits = retriever.search("npx 预取 超时", 3);
    expect(hits.length).toBe(1);
    expect(renderExperienceBlock(hits)).toContain("kb-");

    // 文件树接口贯通（根目录还可能有库文件，只断言三层目录齐备）
    const tree = await memoryTree(paths);
    const names = tree.children?.map((c) => c.name) ?? [];
    for (const expected of ["knowledge", "scenarios", "sessions"]) {
      expect(names).toContain(expected);
    }
  });
});
