import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  sessionMemoryMd,
  scenarioReuseEntryMd,
  KnowledgeMemory,
  knowledgeEntryMd,
  memoryTree,
  memoryPaths,
  type MemoryTreeNode,
} from "@/memory/memory";
import { InMemoryRetriever, ContextModeRetriever, renderExperienceBlock } from "@/memory/retriever";
import { newBuildContext } from "@/orchestrator/context";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "memory-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function richCtx() {
  const ctx = newBuildContext("b-mem", "整理 GitHub 仓库并生成周报");
  ctx.intent = { goal: "整理 GitHub 仓库并生成周报", domain: "dev", slots: [{ name: "repo", value: "a/b" }], keywords: ["github"], via: "llm" };
  ctx.dag = { nodes: [{ id: "n1", title: "拉取提交", deps: [], expectedOutput: "list" }] };
  ctx.trace.push({ nodeId: "n1", startedAt: "t", finishedAt: "t", status: "success", output: "ok" });
  ctx.approvals.push({ gate: 1, action: "approve", decidedBy: "virtual-user", decidedAt: "t" });
  ctx.acceptance.push({ layer: "task", passed: true, detail: {}, at: "t" });
  return ctx;
}

describe("7.1 会话 Memory 生成器", () => {
  it("字段完整 + Markdown 合法（标题层级闭合）", () => {
    const md = sessionMemoryMd(richCtx());
    expect(md).toContain("# 会话 b-mem");
    expect(md).toContain("- 需求: 整理 GitHub 仓库并生成周报");
    expect(md).toContain("## 执行轨迹");
    expect(md).toContain("- n1: success");
    expect(md).toContain("## 闸门决策");
    expect(md).toContain("闸门1 批准");
    // 二级标题全部配对闭合（## 开头行至少 4 个）
    expect(md.split("\n").filter((l) => l.startsWith("## ")).length).toBeGreaterThanOrEqual(4);
  });

  it("含验收报告时展示三层结论", () => {
    const md = sessionMemoryMd(richCtx(), {
      buildId: "b-mem",
      at: "t",
      component: { passed: true, results: [] },
      task: { passed: false, verdicts: [], failedNode: "n1" },
      generalization: { passed: false, skipped: true, reason: "no slots" },
      attribution: ["L2 任务级失败: 节点 n1"],
      allPassed: false,
    });
    expect(md).toContain("存在失败");
    expect(md).toContain("L2 任务级失败");
  });
});

describe("7.2 场景 Memory 追加器", () => {
  it("复用 2 次 → 2 条追加记录", async () => {
    const scenariosDir = path.join(dir, "scenarios");
    await mkdir(scenariosDir, { recursive: true });
    const file = path.join(scenariosDir, "sc-a.md");
    await writeFile(file, "# 场景 sc-a\n\n", "utf8");
    for (const [i, ok] of [true, false].entries()) {
      await writeFile(
        file,
        scenarioReuseEntryMd({ scenarioId: "sc-a", at: `2026-09-29T0${i + 1}`, slots: { path: `/x${i}` }, ok }),
        { encoding: "utf8", flag: "a" },
      );
    }
    const content = await readFile(file, "utf8");
    expect(content.match(/## 复用 /g)).toHaveLength(2);
    expect(content).toContain("- 结果: 成功");
    expect(content).toContain("- 结果: 失败");
  });
});

describe("7.3 知识 Memory（2 次同类失败 → 1 条目）", () => {
  it("同类签名合并计数，不同类新条目", () => {
    const km = new KnowledgeMemory();
    km.recordFailure("timeout:mcp.so", "超时：降级到 slug 直查", new Date("2026-09-29T01:00:00Z"));
    km.recordFailure("timeout:mcp.so", "超时：降级到 slug 直查 + 指数退避", new Date("2026-09-29T02:00:00Z"));
    km.recordFailure("drift:cap-fs", "漂移：探活失败换型 v2", new Date("2026-09-29T03:00:00Z"));
    expect(km.all()).toHaveLength(2);
    const dup = km.all().find((e) => e.signature === "timeout:mcp.so")!;
    expect(dup.occurrences).toBe(2);
    expect(dup.lesson).toContain("指数退避"); // lesson 更新
    expect(knowledgeEntryMd(dup)).toContain("累计: 2 次");
  });
});

describe("7.4 检索（写 5 条检索命中）", () => {
  it("InMemoryRetriever：5 条命中正确排序", () => {
    const r = new InMemoryRetriever();
    r.add({ id: "kb-1", text: "mcp.so 搜索页是 SPA，用 slug 详情页解析", source: "knowledge" });
    r.add({ id: "kb-2", text: "github 限流用指数退避与 token", source: "knowledge" });
    r.add({ id: "kb-3", text: "漂移检测在复用前逐能力探活", source: "knowledge" });
    r.add({ id: "kb-4", text: "场景库命中三档：复用/派生/新建", source: "knowledge" });
    r.add({ id: "kb-5", text: "mcp.so slug 检索失败时降级为空结果不阻塞", source: "knowledge" });
    const hits = r.search("mcp.so slug", 5);
    expect(hits).toHaveLength(2); // kb-1, kb-5
    expect(hits[0]?.id).toBe("kb-1"); // 双词命中分更高
    expect(renderExperienceBlock(hits)).toContain("历史经验");
  });

  it("context-mode ContentStore：真实 SQLite FTS5 + BM25 写 5 检 5", async () => {
    const db = path.join(dir, "exp.db");
    const r = new ContextModeRetriever(db);
    const docs = [
      { id: "kb-1", text: "mcp.so 搜索页是纯 SPA，适配器降级为 slug 详情页解析 JSON-LD", source: "knowledge" },
      { id: "kb-2", text: "github api 限流时用指数退避重试并携带 token", source: "knowledge" },
      { id: "kb-3", text: "漂移检测在场景复用前逐能力探活，失效即局部换型", source: "knowledge" },
      { id: "kb-4", text: "场景库命中三档：命中复用、部分命中派生、未命中从零构建", source: "knowledge" },
      { id: "kb-5", text: "mcp.so slug 不存在时返回空结果且不阻塞其他源", source: "knowledge" },
    ];
    for (const d of docs) await r.add(d);
    expect(r.count()).toBe(5);
    const hits = r.search("mcp.so slug", 5);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0]?.text).toContain("mcp.so");
    // BM25 排序：含全部查询词的文档靠前
    expect(hits[0]?.text).toContain("slug");
    r.dispose(); // 释放 SQLite 句柄（Windows 文件锁）
  }, 30_000);
});

describe("7.5 Memory 文件树数据接口", () => {
  it("结构正确 + 空态安全", async () => {
    const paths = memoryPaths(dir);
    await mkdir(paths.sessions, { recursive: true });
    await mkdir(paths.knowledge, { recursive: true });
    await writeFile(path.join(paths.sessions, "b-1.md"), "# 会话 b-1", "utf8");
    await writeFile(path.join(paths.knowledge, "kb-1.md"), "## kb-1", "utf8");
    const tree = await memoryTree(paths);
    expect(tree.kind).toBe("dir");
    const sessions = tree.children?.find((c: MemoryTreeNode) => c.name === "sessions");
    expect(sessions?.children?.map((c) => c.name)).toEqual(["b-1.md"]);
    expect(sessions?.children?.[0]?.size).toBeGreaterThan(0);
    // 空态：不存在的根不抛错
    const empty = await memoryTree(memoryPaths(path.join(dir, "not-exist")));
    expect(empty.children).toEqual([]);
  });
});
