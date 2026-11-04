import type { GateDecision } from "@/orchestrator/state-machine.js";
import { isSubstantiveComment, stripNegationPrefix } from "@/scenario/ledger.js";

/**
 * 闸门决策 → 分寸账本信号分类器（docs/分寸账本改造方案.md §1/§4）。
 * 纯函数：教学≠分寸的机械判定——
 *  - 闸1 意图措辞 / 闸2 步骤标题顺序 = 教学类（模型下次能自己想对）→ 只更新计划缓存，不入账本；
 *  - 闸3 换能力（偏好）/ 闸4 勾验收项（标准）/ reject comment = 分寸 → pendingConfirm 提案；
 *  - reject 原话即条款（去否定前缀）；质量门槛在此先行（废话只记事件，不生成提案）。
 */

export type GateProposalDraft = {
  /** 人可读条款（闸3 模板 / 闸4 模板 / reject 原话） */
  clause: string;
  scope: "goal" | "step" | "capability" | "acceptance" | "output";
  kind: "advisory" | "must_contain" | "must_not_contain";
  pattern: string | null;
  originType: "reject" | "gate-edit";
  /** 人的原话（origin.text，永远保留） */
  originText: string;
  /** 签约面暂用 id（入库后换成 c-xxx） */
  tempId: string;
  /** 编辑距离粗检命中：与本队列中另一条疑似同义（§14 二选一提示） */
  conflictWith?: string;
};

export type GateClassifyContext = {
  /** 决策前的选型快照（diff 出真正被换掉的能力） */
  previousSelections?: Array<{ nodeId: string; capabilityId: string }>;
  /** 决策前的验收快照（diff 出新勾选项） */
  previousAcceptance?: Array<{ layer: string; passed: boolean }>;
  /** nodeId → 人话标题（来自 ctx.dag） */
  nodeTitles?: Record<string, string>;
  /** capabilityId → 人话名（来自闸3 候选载荷） */
  capabilityNames?: Record<string, string>;
};

export type GateClassification = {
  /** true = 教学类（只动计划缓存），提案为空 */
  teaching: boolean;
  proposals: GateProposalDraft[];
};

const GATE_SCOPE: Record<number, GateProposalDraft["scope"]> = { 1: "goal", 2: "step", 3: "capability", 4: "acceptance", 5: "output" };

/** 闸4 验收层的人话名（与面板勾选项文案一致） */
const LAYER_LABELS: Record<string, string> = {
  component: "选中的能力可以正常工作",
  task: "整件任务可以完成",
  generalization: "换一组输入仍然可以完成",
};

let tempCounter = 0;
function nextTempId(): string {
  tempCounter = (tempCounter + 1) % 10_000;
  return `p${Date.now().toString(36)}${tempCounter}`;
}

/** 字符 bigram Jaccard 相似度（编辑距离粗检，§14/§15 冲突提示用） */
export function clauseSimilarity(a: string, b: string): number {
  const grams = (s: string): Set<string> => {
    const t = s.toLowerCase().replace(/\s+/g, "");
    const out = new Set<string>();
    for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2));
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter += 1;
  return inter / (ga.size + gb.size - inter);
}

const CONFLICT_THRESHOLD = 0.6;

/** 与已有条款粗检冲突：返回最相似的一条 id（≥阈值），无则 null */
export function findConflict(clause: string, existing: Array<{ id: string; clause: string }>): string | null {
  let best: { id: string; score: number } | null = null;
  for (const candidate of existing) {
    const score = clauseSimilarity(clause, candidate.clause);
    if (score >= CONFLICT_THRESHOLD && (!best || score > best.score)) best = { id: candidate.id, score };
  }
  return best?.id ?? null;
}

export function classifyGateDecision(decision: GateDecision, context: GateClassifyContext = {}): GateClassification {  const scope = GATE_SCOPE[decision.gate] ?? "output";
  const comment = decision.comment?.trim() ?? "";

  if (decision.action === "reject") {
    // reject 原话即条款（§4）；废话（不对/重做/…）只记事件不生成提案（质量门槛）
    if (!comment || !isSubstantiveComment(comment)) return { teaching: false, proposals: [] };
    const draft: GateProposalDraft = {
      clause: stripNegationPrefix(comment).slice(0, 300),
      scope,
      kind: "advisory",
      pattern: null,
      originType: "reject",
      originText: comment,
      tempId: nextTempId(),
    };
    return { teaching: false, proposals: [draft] };
  }

  if (decision.action === "approve") return { teaching: false, proposals: [] };

  // edit 分支
  if (decision.gate === 1 || decision.gate === 2) {
    // 教学：闸1 goal 措辞 / 闸2 步骤标题顺序 → 下次重规划模型自己能想对
    return { teaching: true, proposals: [] };
  }
  const proposals: GateProposalDraft[] = [];
  const originText = comment || `闸门${decision.gate}人工修改`;
  if (decision.gate === 3 && decision.edit?.kind === "selections") {
    const previous = new Map((context.previousSelections ?? []).map((s) => [s.nodeId, s.capabilityId]));
    for (const selection of decision.edit.selections) {
      const before = previous.get(selection.nodeId);
      if (before !== undefined && before === selection.capabilityId) continue; // 未变化
      const nodeTitle = context.nodeTitles?.[selection.nodeId] ?? selection.nodeId;
      const capName = context.capabilityNames?.[selection.capabilityId] ?? selection.capabilityId;
      const base = `步骤「${nodeTitle}」使用「${capName}」`;
      proposals.push({
        clause: (comment ? `${base}（${comment}）` : base).slice(0, 300),
        scope: "capability",
        kind: "advisory",
        pattern: null,
        originType: "gate-edit",
        originText,
        tempId: nextTempId(),
      });
    }
  }
  if (decision.gate === 4 && decision.edit?.kind === "acceptance") {
    const previous = new Map((context.previousAcceptance ?? []).map((a) => [a.layer, a.passed]));
    for (const record of decision.edit.acceptance) {
      if (!record.passed) continue;
      if (previous.get(record.layer) === true) continue; // 之前已勾，非新标准
      const label = LAYER_LABELS[record.layer] ?? record.layer;
      proposals.push({
        clause: `验收必须包含：${label}`,
        scope: "acceptance",
        kind: "must_contain",
        pattern: null, // 走 judge（§4）
        originType: "gate-edit",
        originText,
        tempId: nextTempId(),
      });
    }
  }
  // 队列内冲突粗检（§14：签约面并排提示）
  for (const draft of proposals) {
    const others = proposals.filter((p) => p !== draft).map((p) => ({ id: p.tempId, clause: p.clause }));
    const conflict = findConflict(draft.clause, others);
    if (conflict) draft.conflictWith = conflict;
  }
  return { teaching: false, proposals };
}

/**
 * 构建收尾：approvals（闸门决策记录）→ gateEvents 摘要。
 * approve→passes / edit→edits / reject→rejects， founding build 的闸门统计入新场景账本。
 */
export function gateEventsFromApprovals(approvals: Array<{ gate: number; action: string }>): Record<string, { passes?: number; rejects?: number; edits?: number }> {
  const events: Record<string, { passes?: number; rejects?: number; edits?: number }> = {};
  for (const approval of approvals) {
    if (approval.gate < 1 || approval.gate > 5) continue;
    const key = String(approval.gate);
    const current = events[key] ?? {};
    if (approval.action === "approve") current.passes = (current.passes ?? 0) + 1;
    else if (approval.action === "edit") current.edits = (current.edits ?? 0) + 1;
    else if (approval.action === "reject") current.rejects = (current.rejects ?? 0) + 1;
    events[key] = current;
  }
  return events;
}
