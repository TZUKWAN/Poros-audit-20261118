import { describe, expect, it } from "vitest";
import {
  templateIntent,
  templateDag,
  handleParsing,
  handlePlanning,
  handleRetrieving,
  handleAssembling,
  handleVerifying,
  handleExecuting,
  handleDistilling,
  alignInterfaces,
} from "@/orchestrator/handlers";
import type { HandlerDeps } from "@/orchestrator/handlers";
import { newBuildContext, type BuildContext } from "@/orchestrator/context";
import { buildCapability } from "@/federation/adapters/adapter-utils";
import type { Capability, Source } from "@/federation/types";
import type { FederatedResult } from "@/federation/search";
import type { BuildAwaitingUserError } from "@/orchestrator/state-machine";

const src: Source = { id: "modelscope", tier: "curated", name: "t", url: "https://t" };

function cap(id: string, tags: string[] = [], install: Capability["install"] = { type: "npx", package: id, args: [] as string[] }): Capability {
  return buildCapability({ id, name: id, kind: "mcp-server", description: id, source: src, install, tags });
}

function fakeSearch(caps: Capability[]): HandlerDeps["search"] {
  return async (q: string): Promise<FederatedResult> => ({
    query: q,
    capabilities: caps,
    statuses: [{ source: "modelscope", ok: true, degraded: false, latencyMs: 1, count: caps.length }],
    totalMs: 1,
  });
}

function ctx(requirement = "测试需求"): BuildContext {
  return newBuildContext("b1", requirement);
}

describe("2.3.1 parsing", () => {
  it("LLM 正常路径：3 样例 schema 通过", async () => {
    for (const goal of ["整理仓库并生成周报", "爬取天气数据画图", "批量重命名文件"]) {
      const c = ctx(goal);
      await handleParsing(c, {
        search: fakeSearch([]),
        llm: { parseIntent: async () => ({ goal, domain: "dev", slots: [], keywords: ["x"], via: "llm" }), planTasks: async () => null },
      });
      expect(c.intent?.goal).toBe(goal);
      expect(c.intent?.via).toBe("llm");
    }
  });
  it("LLM 畸形输出 → 降级模板", async () => {
    const c = ctx("帮我整理下载文件夹并清理重复文件");
    await handleParsing(c, {
      search: fakeSearch([]),
      llm: { parseIntent: async () => ({ totally: "wrong" }), planTasks: async () => null },
    });
    expect(c.intent?.via).toBe("template");
    expect(c.intent?.keywords.length).toBeGreaterThan(0);
  });
  it("LLM 抛错 → 降级模板", async () => {
    const c = ctx("r");
    await handleParsing(c, {
      search: fakeSearch([]),
      llm: { parseIntent: async () => { throw new Error("LLM_UNAVAILABLE"); }, planTasks: async () => null },
    });
    expect(c.intent?.via).toBe("template");
    expect(c.planner).toMatchObject({ requested: "llm", actual: "template", fallbackReason: "LLM_UNAVAILABLE", attempts: 1 });
  });
  it("模型明确返回 clarification 时保留结构化问题，不降级成猜测", async () => {
    const c = ctx("整理项目");
    await expect(handleParsing(c, {
      search: fakeSearch([]),
      llm: { parseIntent: async () => ({ clarification: { question: "哪个目录？", inputs: [{ name: "path", type: "path", description: "项目根目录" }] } }), planTasks: async () => null },
    })).rejects.toMatchObject({ name: "BuildAwaitingUserError", request: { phase: "parsing", question: "哪个目录？" } } as Partial<BuildAwaitingUserError>);
    expect(c.intent).toBeNull();
  });
  it("无 LLM → 模板直出", async () => {
    const c = ctx("批量下载图片并压缩");
    await handleParsing(c, { search: fakeSearch([]) });
    expect(c.intent?.via).toBe("template");
    expect(templateIntent("x").via).toBe("template");
  });
});

describe("2.3.2 planning", () => {
  it("LLM 合法 DAG 采纳（≥3 节点 + 拓扑有效）", async () => {
    const c = ctx();
    c.intent = templateIntent("g");
    await handlePlanning(c, {
      search: fakeSearch([]),
      llm: {
        parseIntent: async () => null,
        planTasks: async () => ({
          nodes: [
            { id: "a", title: "A", deps: [], expectedOutput: "oa" },
            { id: "b", title: "B", deps: ["a"], expectedOutput: "ob" },
            { id: "c", title: "C", deps: ["a", "b"], expectedOutput: "oc" },
          ],
        }),
      },
    });
    expect(c.dag?.nodes).toHaveLength(3);
  });
  it("规划模型可在没有 DAG 时请求结构化澄清", async () => {
    const c = ctx();
    c.intent = templateIntent("整理项目");
    await expect(handlePlanning(c, {
      search: fakeSearch([]),
      llm: { parseIntent: async () => null, planTasks: async () => ({ clarification: { question: "要输出什么格式？", inputs: [{ name: "format", type: "string", description: "交付格式" }] } }) },
    })).rejects.toMatchObject({ name: "BuildAwaitingUserError", request: { phase: "planning", question: "要输出什么格式？" } } as Partial<BuildAwaitingUserError>);
    expect(c.dag).toBeNull();
  });
  it("环被拒：LLM 给出带环 DAG → 上抛 VALIDATION（不放行）", async () => {
    const c = ctx();
    c.intent = templateIntent("g");
    await expect(
      handlePlanning(c, {
        search: fakeSearch([]),
        llm: {
          parseIntent: async () => null,
          planTasks: async () => ({
            nodes: [
              { id: "a", title: "A", deps: ["b"] },
              { id: "b", title: "B", deps: ["a"] },
            ],
          }),
        },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
  it("LLM 失败 → 模板 DAG（3 节点链）", async () => {
    const c = ctx();
    c.intent = templateIntent("g");
    await handlePlanning(c, { search: fakeSearch([]), llm: { parseIntent: async () => null, planTasks: async () => { throw new Error("down"); } } });
    expect(c.dag?.nodes).toHaveLength(3);
    expect(templateDag(c.intent!).nodes[0]?.deps).toEqual([]);
  });
  it("单节点 DAG 合法", async () => {
    const c = ctx();
    c.intent = templateIntent("g");
    await handlePlanning(c, {
      search: fakeSearch([]),
      llm: { parseIntent: async () => null, planTasks: async () => ({ nodes: [{ id: "only", title: "only", deps: [], expectedOutput: "" }] }) },
    });
    expect(c.dag?.nodes).toHaveLength(1);
  });
});

describe("2.3.3 retrieving", () => {
  it("每节点产出候选集（数量/查询词），skill 矿产物注入记录", async () => {
    const c = ctx();
    c.intent = templateIntent("整理 github 仓库");
    c.dag = templateDag(c.intent);
    const products = [
      {
        skillId: "s1",
        sourceUrl: "https://x/s1",
        processFragments: [{ title: "w", steps: ["a", "b"] }],
        pitfalls: [{ pitfall: "p", countermeasure: "c" }],
        acceptancePoints: ["验收A"],
        capabilityLeads: ["github mcp"],
        actionable: true,
        vendored: [],
      },
    ];
    await handleRetrieving(c, {
      search: fakeSearch([cap("a:fs"), cap("b:git")]),
      skillMine: async () => products,
    });
    const sets = c.candidates as Array<{ nodeId: string; candidates: Capability[] }>;
    expect(sets).toHaveLength(3); // 模板 DAG 3 节点
    expect(sets[0]?.candidates).toHaveLength(2);
    expect(c.skillNotes).toHaveLength(1);
    expect(c.skillNotes[0]?.injectedInto).toEqual(["planning", "assembling", "acceptance"]);
    expect(c.candidates.length).toBe(3); // 候选已入上下文
  });
  it("无 skillMine 时跳过矿流水线", async () => {
    const c = ctx();
    c.intent = templateIntent("g");
    c.dag = templateDag(c.intent);
    await handleRetrieving(c, { search: fakeSearch([cap("a")]) });
    expect(c.skillNotes).toHaveLength(0);
  });
  it("检索器抛错直接上抛（由联邦层降级，处理器不吞）", async () => {
    const c = ctx();
    c.intent = templateIntent("g");
    c.dag = templateDag(c.intent);
    await expect(handleRetrieving(c, { search: async () => { throw new Error("all sources down"); } })).rejects.toThrow("all sources down");
  });
});

describe("2.3.4 assembling", () => {
  const sets = [
    { nodeId: "n1", candidates: [cap("a:fetch", ["http"], { type: "remote" as const, url: "https://r1/mcp" })] },
    { nodeId: "n2", candidates: [cap("b:fs", ["fs"], { type: "npx" as const, package: "fs", args: [] })] },
  ];

  it("匹配：同形态同域 → ok", async () => {
    const c = ctx();
    c.intent = templateIntent("g");
    c.dag = { nodes: [
      { id: "n1", title: "t1", deps: [], expectedOutput: "" },
      { id: "n2", title: "t2", deps: ["n1"], expectedOutput: "" },
    ] };
    c.candidates = [
      { nodeId: "n1", query: "", candidates: [cap("a", ["fs"])] },
      { nodeId: "n2", query: "", candidates: [cap("b", ["fs"])] },
    ];
    await handleAssembling(c, { search: fakeSearch([]) });
    const assembly = c.assembly as { edges: Array<{ alignment: string }> };
    expect(assembly.edges[0]?.alignment).toBe("ok");
  });

  it("不匹配：remote 上游 vs npx 下游 → glue-needed", () => {
    const r = alignInterfaces(sets[0]!.candidates[0], sets[1]!.candidates[0]);
    expect(r.alignment).toBe("glue-needed");
    expect(r.reason).toContain("形态不一致");
  });

  it("缺上游候选 → 报 NOT_FOUND", async () => {
    const c = ctx();
    c.intent = templateIntent("g");
    c.dag = { nodes: [{ id: "n1", title: "t", deps: [], expectedOutput: "" }] };
    c.candidates = [{ nodeId: "n1", query: "", candidates: [] }];
    await expect(handleAssembling(c, { search: fakeSearch([]) })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("selections 已存在（闸门3 编辑）→ 尊重用户选择", async () => {
    const c = ctx();
    c.intent = templateIntent("g");
    c.dag = { nodes: [{ id: "n1", title: "t", deps: [], expectedOutput: "" }] };
    c.candidates = [{ nodeId: "n1", query: "", candidates: [cap("a"), cap("b")] }];
    c.selections = [{ nodeId: "n1", capabilityId: "b", overridden: true }];
    await handleAssembling(c, { search: fakeSearch([]) });
    expect((c.assembly as { nodes: Array<{ capabilityId: string }> }).nodes[0]?.capabilityId).toBe("b");
  });
});

describe("2.3.5 verifying", () => {
  function verifyCtx(): BuildContext {
    const c = ctx();
    c.dag = { nodes: [{ id: "n1", title: "t", deps: [], expectedOutput: "" }] };
    c.candidates = [{ nodeId: "n1", query: "", candidates: [cap("a")] }];
    c.assembly = { nodes: [{ nodeId: "n1", capabilityId: "a", glueNeeded: false }], edges: [] };
    return c;
  }
  it("全过", async () => {
    const c = verifyCtx();
    await handleVerifying(c, { search: fakeSearch([]), probe: async () => ({ available: true, latencyMs: 5 }) });
    const rec = c.acceptance.find((a) => a.layer === "component");
    expect(rec?.passed).toBe(true);
  });
  it("单点失败", async () => {
    const c = verifyCtx();
    await handleVerifying(c, { search: fakeSearch([]), probe: async () => ({ available: false, latencyMs: 5, message: "refused" }) });
    expect(c.acceptance.find((a) => a.layer === "component")?.passed).toBe(false);
  });
  it("无探活器不得伪造通过", async () => {
    const c = verifyCtx();
    await handleVerifying(c, { search: fakeSearch([]) });
    expect(c.acceptance.find((a) => a.layer === "component")?.passed).toBe(false);
  });
});

describe("2.3.6/2.3.7 executing 与 distilling 桩", () => {
  it("桩被调用：executing 产出 trace + task 验收", async () => {
    const c = ctx();
    c.assembly = { nodes: [{ nodeId: "n1", capabilityId: "a", glueNeeded: false }], edges: [] };
    let executed = false;
    await handleExecuting(c, { search: fakeSearch([]), execute: async () => { executed = true; } });
    expect(executed).toBe(true);
  });
  it("无注入 execute → 明确记录失败而非假成功", async () => {
    const c = ctx();
    c.assembly = { nodes: [{ nodeId: "n1", capabilityId: "a", glueNeeded: false }], edges: [] };
    await handleExecuting(c, { search: fakeSearch([]) });
    expect(c.trace).toHaveLength(1);
    expect((c.trace[0] as { status: string }).status).toBe("failed");
    expect(c.acceptance.some((a) => a.layer === "task")).toBe(true);
  });
  it("distilling 桩", async () => {
    const c = ctx();
    await handleDistilling(c, { search: fakeSearch([]) });
    expect(c.acceptance.some((a) => a.layer === "generalization")).toBe(true);
  });
});
