import { describe, expect, it } from "vitest";
import { renderGate1, renderGate2, renderGate3, renderGate4, renderGate5, renderCandidateCard, renderApprovalsSummary } from "@/gates/views";
import { GATES, validateDecision, StubDecisionMemory } from "@/gates/framework";
import { buildCapability } from "@/federation/adapters/adapter-utils";
import type { Capability, Source } from "@/federation/types";
import type { Intent, Dag, AssemblyGraph } from "@/orchestrator/context";

const src: Source = { id: "modelscope", tier: "curated", name: "ModelScope", url: "https://m" };

function cap(over: Partial<Capability> & { id: string; name: string }): Capability {
  return buildCapability({
    kind: "mcp-server",
    description: "测试能力",
    source: src,
    install: { type: "npx", package: "pkg", args: [] },
    tags: ["fs"],
    ...over,
  } as Parameters<typeof buildCapability>[0]);
}

describe("3.1 闸门框架", () => {
  it("五闸门注册表完整（名称/默认驳回目标/提示）", () => {
    expect(Object.keys(GATES)).toHaveLength(5);
    expect(GATES[1].defaultRejectTarget).toBe("parsing");
    expect(GATES[3].name).toBe("能力选型");
    expect(GATES[5].prompt).toContain("三选一");
  });

  it("validateDecision 合法/非法", () => {
    expect(validateDecision({ gate: 2, action: "approve" }).action).toBe("approve");
    expect(() => validateDecision({ gate: 9, action: "approve" })).toThrow();
  });

  it("StubDecisionMemory 记录完整（阶段七前桩）", async () => {
    const mem = new StubDecisionMemory();
    await mem.recordApproval("b1", {
      gate: 3,
      action: "reject",
      targetPhase: "retrieving",
      comment: "换批",
      decidedBy: "virtual-user",
      decidedAt: "2026-09-29T00:00:00Z",
    });
    expect(mem.records[0]?.record.gate).toBe(3);
  });
});

describe("3.2.x 闸门1 意图确认（快照 + 编辑路径）", () => {
  const intent: Intent = {
    goal: "整理 GitHub 仓库并生成周报",
    domain: "dev",
    slots: [
      { name: "repo", value: "TZUKWAN/METIS_PARALLEL" },
      { name: "周期", value: "本周" },
    ],
    keywords: ["github", "周报"],
    via: "llm",
  };

  it("快照：提案展示 + 槽位 + 操作提示", () => {
    const v = renderGate1(intent);
    expect(v.lines[0]).toContain("闸门1");
    expect(v.lines.join("\n")).toMatchInlineSnapshot(`
      "═ 闸门1 · 意图确认 ═
      确认意图与槽位；可逐项编辑后批准
      
      目标: 整理 GitHub 仓库并生成周报
      领域: dev   解析方式: llm
      槽位（可逐项编辑）:
        · repo = TZUKWAN/METIS_PARALLEL
        · 周期 = 本周
      关键词: github, 周报
      
      [a] 批准   [e] 编辑槽位   [r] 驳回重析"
    `);
  });

  it("空意图空态", () => {
    expect(renderGate1(null).lines[0]).toContain("闸门1");
    expect(renderGate1(null).lines[3]).toContain("尚未解析");
  });
});

describe("3.2.2 闸门2 任务清单（DAG + 环提示）", () => {
  const dag: Dag = {
    nodes: [
      { id: "n1", title: "拉取提交记录", deps: [], expectedOutput: "提交列表" },
      { id: "n2", title: "汇总变更", deps: ["n1"], expectedOutput: "变更摘要" },
      { id: "n3", title: "生成周报", deps: ["n2"], expectedOutput: "周报.md" },
    ],
  };
  it("快照：节点/依赖/期望输出", () => {
    const v = renderGate2(dag);
    const text = v.lines.join("\n");
    expect(text).toContain("任务节点 ×3");
    expect(text).toContain("[n2] 汇总变更 ← 依赖: n1");
    expect(text).toContain("期望输出: 周报.md");
  });
  it("空 DAG 空态", () => {
    expect(renderGate2(null).lines[3]).toContain("尚未生成");
  });
});

describe("3.2.3 闸门3 能力选型（候选卡片）", () => {
  const candidates = [
    cap({ id: "a:fs", name: "filesystem-pro", description: "文件系统读写工具" }),
    cap({
      id: "b:net",
      name: "net-tools",
      install: { type: "remote", url: "https://x/mcp" },
      requiresAuth: true,
    }),
  ];
  it("卡片含来源徽章/trust 条/风险标/远程标/安装方式", () => {
    const lines = renderCandidateCard(candidates[0]!);
    expect(lines[0]).toContain("[策展]");
    expect(lines[0]).toContain("trust");
    expect(lines[1]).toContain("npx pkg");
    const lines2 = renderCandidateCard(candidates[1]!);
    expect(lines2[0]).toContain("⚠需鉴权");
    expect(lines2[0]).toContain("☁可远程");
    expect(lines2[1]).toContain("remote https://x/mcp");
  });
  it("视图按节点分组渲染", () => {
    const v = renderGate3([{ nodeId: "n1", candidates }]);
    const text = v.lines.join("\n");
    expect(text).toContain("节点 n1 候选 ×2");
    expect(text).toContain("[a] 批准默认选型");
  });
  it("空候选空态", () => {
    expect(renderGate3([]).lines[3]).toContain("尚未检索");
  });
});

describe("3.2.4 闸门4 装配与验收", () => {
  const assembly: AssemblyGraph = {
    nodes: [
      { nodeId: "n1", capabilityId: "a:fs", glueNeeded: false },
      { nodeId: "n2", capabilityId: "b:net", glueNeeded: true },
    ],
    edges: [
      { from: "n1", to: "n2", alignment: "glue-needed", reason: "形态不一致" },
    ],
  };
  it("快照：流水线图 + 胶水标注 + 三层验收清单", () => {
    const v = renderGate4({
      assembly,
      acceptance: [
        { layer: "component", passed: true },
        { layer: "task", passed: false },
      ],
    });
    const text = v.lines.join("\n");
    expect(text).toContain("(n1) a:fs");
    expect(text).toContain("⟲glue");
    expect(text).toContain("形态不一致");
    expect(text).toContain("[✓] component");
    expect(text).toContain("[✗] task");
    expect(text).toContain("[ ] generalization");
  });
});

describe("3.2.5 闸门5 固化评审（三选一）", () => {
  it("快照：前后对照 + 泛化 + 三选一", () => {
    const v = renderGate5({
      intent: { goal: "整理仓库", domain: "dev", slots: [], keywords: [], via: "template" },
      trace: [{}, {}, {}],
      acceptance: [
        { layer: "component", passed: true },
        { layer: "task", passed: true },
        { layer: "generalization", passed: true },
      ],
    });
    const text = v.lines.join("\n");
    expect(text).toContain("升维前后对照");
    expect(text).toContain("执行步骤: 3");
    expect(text).toContain("generalization:过");
    expect(text).toContain("[1] 固化入库 (pin)");
    expect(text).toContain("[3] 丢弃 (discard)");
  });
});

describe("approvals 摘要渲染", () => {
  it("驳回回退目标可见", () => {
    const lines = renderApprovalsSummary([
      { gate: 3, action: "reject", targetPhase: "retrieving", comment: "换批", decidedBy: "human", decidedAt: "t" },
      { gate: 3, action: "approve", decidedBy: "virtual-user", decidedAt: "t" },
    ]);
    expect(lines[0]).toContain("驳回→retrieving");
    expect(lines[1]).toContain("✓批准");
  });
});
