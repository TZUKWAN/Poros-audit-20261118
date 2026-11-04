import { describe, expect, it } from "vitest";
import { classifyGateDecision, clauseSimilarity, findConflict, gateEventsFromApprovals } from "@/panel/gate-classify";
import type { GateDecision } from "@/orchestrator/state-machine";

const d = (partial: Partial<GateDecision> & { gate: number; action: GateDecision["action"] }): GateDecision => partial as GateDecision;

describe("§1/§4 闸门决策分类器", () => {
  it("闸2 title 改动 → 无提案（教学类，只更新计划缓存）", () => {
    const result = classifyGateDecision(d({ gate: 2, action: "edit", edit: { kind: "dag", dag: { nodes: [{ id: "n1", title: "改过的标题", deps: [], expectedOutput: "x" }] } } }));
    expect(result.teaching).toBe(true);
    expect(result.proposals).toEqual([]);
  });

  it("闸1 goal 措辞改动 → 无提案（教学类）", () => {
    const result = classifyGateDecision(d({ gate: 1, action: "edit", edit: { kind: "intent", intent: { goal: "生成周报", domain: "dev", slots: [], keywords: [], via: "llm" } } }));
    expect(result.teaching).toBe(true);
    expect(result.proposals).toEqual([]);
  });

  it("闸3 换能力 → 提案（capability, 步骤「x」使用「y」），未变化的节点不提案", () => {
    const result = classifyGateDecision(
      d({ gate: 3, action: "edit", edit: { kind: "selections", selections: [{ nodeId: "n1", capabilityId: "cap-file", overridden: true }, { nodeId: "n2", capabilityId: "cap-same", overridden: false }] } }),
      {
        previousSelections: [
          { nodeId: "n1", capabilityId: "cap-crawler" },
          { nodeId: "n2", capabilityId: "cap-same" },
        ],
        nodeTitles: { n1: "获取数据" },
        capabilityNames: { "cap-file": "文件读取" },
      },
    );
    expect(result.teaching).toBe(false);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]!.clause).toBe("步骤「获取数据」使用「文件读取」");
    expect(result.proposals[0]!.scope).toBe("capability");
    expect(result.proposals[0]!.originType).toBe("gate-edit");
  });

  it("闸4 新勾验收项 → must_contain 提案（pattern=null 走 judge），已勾项不重复", () => {
    const result = classifyGateDecision(
      d({ gate: 4, action: "edit", edit: { kind: "acceptance", acceptance: [{ layer: "generalization", passed: true, detail: {}, at: "t" }, { layer: "task", passed: true, detail: {}, at: "t" }] } }),
      { previousAcceptance: [{ layer: "task", passed: true }] },
    );
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]!.clause).toBe("验收必须包含：换一组输入仍然可以完成");
    expect(result.proposals[0]!.kind).toBe("must_contain");
    expect(result.proposals[0]!.pattern).toBeNull();
  });

  it("reject「不对」→ 无提案只记事件；reject 带实质原因 → 原话即条款（去否定前缀）", () => {
    const junk = classifyGateDecision(d({ gate: 3, action: "reject", targetPhase: "retrieving", comment: "不对" }));
    expect(junk.proposals).toEqual([]);
    expect(junk.teaching).toBe(false);
    const real = classifyGateDecision(d({ gate: 1, action: "reject", targetPhase: "parsing", comment: "不对，目标里要写清楚输出是周报" }));
    expect(real.proposals).toHaveLength(1);
    expect(real.proposals[0]!.clause).toBe("目标里要写清楚输出是周报");
    expect(real.proposals[0]!.scope).toBe("goal");
    expect(real.proposals[0]!.originType).toBe("reject");
    expect(real.proposals[0]!.originText).toBe("不对，目标里要写清楚输出是周报");
  });

  it("reject 无 comment → 无提案", () => {
    expect(classifyGateDecision(d({ gate: 5, action: "reject", targetPhase: "planning" })).proposals).toEqual([]);
  });

  it("approve 不产生提案", () => {
    expect(classifyGateDecision(d({ gate: 4, action: "approve" })).proposals).toEqual([]);
  });

  it("队列内条款相似 → conflictWith 标记（§14 签约面二选一提示）", () => {
    const result = classifyGateDecision(
      d({
        gate: 3,
        action: "edit",
        comment: "都用文件读取，不要爬虫",
        edit: { kind: "selections", selections: [{ nodeId: "n1", capabilityId: "cap-file", overridden: true }, { nodeId: "n2", capabilityId: "cap-file2", overridden: true }] },
      }),
      {
        previousSelections: [
          { nodeId: "n1", capabilityId: "cap-a" },
          { nodeId: "n2", capabilityId: "cap-b" },
        ],
        nodeTitles: { n1: "获取数据", n2: "清洗数据" },
        capabilityNames: { "cap-file": "文件读取", "cap-file2": "文件读取增强" },
      },
    );
    expect(result.proposals).toHaveLength(2);
    // 两条「使用文件读取」高度相似 → 至少一条带冲突标记
    expect(result.proposals.some((p) => p.conflictWith)).toBe(true);
  });

  it("clauseSimilarity / findConflict 边界", () => {
    expect(clauseSimilarity("", "abc")).toBe(0);
    expect(clauseSimilarity("行动项必须带负责人和截止日", "行动项必须带负责人和截止日")).toBe(1);
    expect(findConflict("完全不同的两句话之一", [{ id: "c1", clause: "行动项必须带负责人和截止日" }])).toBeNull();
    expect(findConflict("行动项必须带负责人和截止日期", [{ id: "c1", clause: "行动项必须带负责人和截止日" }])).toBe("c1");
  });

  it("gateEventsFromApprovals 聚合闸门事件", () => {
    const events = gateEventsFromApprovals([
      { gate: 1, action: "approve" },
      { gate: 3, action: "edit" },
      { gate: 3, action: "reject" },
      { gate: 4, action: "approve" },
    ]);
    expect(events["1"]).toEqual({ passes: 1 });
    expect(events["3"]).toEqual({ edits: 1, rejects: 1 });
    expect(events["4"]).toEqual({ passes: 1 });
  });
});

import { confirmConstraints, proposeConstraint, activeConstraints, emptyLedger } from "@/scenario/ledger";

describe("最小闭环（PR1+PR2）：打回一句话 → 闸5 签约 → 入账本", () => {
  it("reject 原话 → 提案队列 → drain → propose+confirm → 场景账本出现 active 条款", () => {
    // 1) 闸3 打回带原因（服务器 classifyGateDecision 同参调用）
    const classification = classifyGateDecision(
      d({ gate: 3, action: "reject", targetPhase: "retrieving", comment: "别用爬虫，读本地文件" }),
      { previousSelections: [{ nodeId: "n1", capabilityId: "cap-crawler" }], nodeTitles: { n1: "获取数据" }, capabilityNames: {} },
    );
    expect(classification.proposals).toHaveLength(1);
    // 2) 面板队列（服务器 gate-decision handler 同构）+ drain（finishBuild 同构）
    const queued = classification.proposals.map((p) => ({ ...p, at: "2026-11-05T00:00:00.000Z", runId: "run-1" }));
    // 3) 入账本：propose（质量门槛/去重）→ confirm（闸5 全量签约）
    let ledger = emptyLedger();
    const ids: string[] = [];
    for (const seed of queued) {
      const proposed = proposeConstraint(ledger, { clause: seed.clause, scope: seed.scope, kind: seed.kind, pattern: seed.pattern, origin: { type: seed.originType, text: seed.originText, at: seed.at, runId: seed.runId } });
      if (proposed) { ledger = proposed.ledger; ids.push(proposed.constraint.id); }
    }
    ledger = confirmConstraints(ledger, ids, "2026-11-05T01:00:00.000Z");
    const active = activeConstraints(ledger);
    expect(active).toHaveLength(1);
    expect(active[0]!.clause).toContain("读本地文件");
    expect(active[0]!.scope).toBe("capability");
    expect(active[0]!.confirmedAt).toBe("2026-11-05T01:00:00.000Z");
    // 4) 下次重放/重规划的注入素材（模板A）就绪
    expect(active.map((c) => `[${c.id}] ${c.clause}`)).toEqual(expect.arrayContaining([expect.stringContaining("读本地文件")]));
  });
});
