import { Text, VStack } from "@earendil-works/pi-tui";
import { GATES, type GateId } from "./framework.js";
import type { Intent, Dag, AssemblyGraph, ApprovalRecord } from "@/orchestrator/context.js";
import type { Capability } from "@/federation/types.js";

/**
 * 3.2 五闸门 TUI 视图：纯渲染函数（payload → 文本行），TUI 与 Web 面板共用。
 * 渲染输出可快照测试；TUI 侧经 pi-tui 组件（Box/VStack/Text）承载同一 renderer。
 */

export interface GateView {
  title: string;
  lines: string[];
}

export function renderGateView(gate: GateId, payload: unknown): GateView {
  switch (gate) {
    case 1:
      return renderGate1(payload as Intent | null);
    case 2:
      return renderGate2(payload as Dag | null);
    case 3:
      return renderGate3(payload as Array<{ nodeId: string; candidates: Capability[] }> | null);
    case 4:
      return renderGate4(payload as { assembly: AssemblyGraph | null; acceptance: Array<{ layer: string; passed: boolean }> });
    case 5:
      return renderGate5(payload as { intent: Intent | null; trace: unknown[]; acceptance: Array<{ layer: string; passed: boolean }> });
  }
}

function header(gate: GateId): string[] {
  const def = GATES[gate];
  return [`═ 闸门${gate} · ${def.name} ═`, def.prompt, ""];
}

export function renderGate1(intent: Intent | null): GateView {
  const lines = header(1);
  if (!intent) {
    lines.push("（意图尚未解析）");
    return { title: GATES[1].name, lines };
  }
  lines.push(`目标: ${intent.goal}`);
  lines.push(`领域: ${intent.domain}   解析方式: ${intent.via}`);
  if (intent.slots.length > 0) {
    lines.push("槽位（可逐项编辑）:");
    for (const s of intent.slots) lines.push(`  · ${s.name} = ${s.value}`);
  }
  if (intent.keywords.length > 0) lines.push(`关键词: ${intent.keywords.join(", ")}`);
  lines.push("", "[a] 批准   [e] 编辑槽位   [r] 驳回重析");
  return { title: GATES[1].name, lines };
}

export function renderGate2(dag: Dag | null): GateView {
  const lines = header(2);
  if (!dag) {
    lines.push("（任务清单尚未生成）");
    return { title: GATES[2].name, lines };
  }
  lines.push(`任务节点 ×${dag.nodes.length}:`);
  for (const n of dag.nodes) {
    const deps = n.deps.length > 0 ? ` ← 依赖: ${n.deps.join(", ")}` : "（起点）";
    lines.push(`  [${n.id}] ${n.title}${deps}`);
    if (n.expectedOutput) lines.push(`      期望输出: ${n.expectedOutput}`);
  }
  lines.push("", "[a] 批准   [n] 增删节点   [d] 改依赖   [r] 驳回重规划");
  return { title: GATES[2].name, lines };
}

const TRUST_FILL = "█";
const TRUST_EMPTY = "░";

export function renderCandidateCard(cap: Capability): string[] {
  const badge = { official: "[官方]", curated: "[策展]", aggregate: "[聚合]" }[cap.source.tier];
  const barLen = Math.round(cap.trust.score * 10);
  const bar = TRUST_FILL.repeat(barLen) + TRUST_EMPTY.repeat(10 - barLen);
  const risk = cap.requiresAuth ? " ⚠需鉴权" : "";
  const remote = cap.remoteRun || cap.install.type === "remote" ? " ☁可远程" : "";
  const install = cap.install.type === "npx" ? `npx ${cap.install.package}` : cap.install.type === "git" ? `git ${cap.install.repoUrl}` : cap.install.type === "remote" ? `remote ${cap.install.url}` : cap.install.type;
  const lines = [
    `  ${badge} ${cap.name}  trust ${bar} ${(cap.trust.score).toFixed(2)}${risk}${remote}`,
    `    来源: ${cap.source.name}   安装: ${install}`,
  ];
  if (cap.description) lines.push(`    ${cap.description.slice(0, 80)}${cap.description.length > 80 ? "…" : ""}`);
  return lines;
}

export function renderGate3(sets: Array<{ nodeId: string; candidates: Capability[] }> | null): GateView {
  const lines = header(3);
  if (!sets || sets.length === 0) {
    lines.push("（候选尚未检索）");
    return { title: GATES[3].name, lines };
  }
  for (const set of sets) {
    lines.push(`节点 ${set.nodeId} 候选 ×${set.candidates.length}:`);
    for (const cap of set.candidates) lines.push(...renderCandidateCard(cap));
    lines.push("");
  }
  lines.push("[a] 批准默认选型   [s] 换批   [c] 自定义   [r] 驳回重检索");
  return { title: GATES[3].name, lines };
}

export function renderGate4(payload: { assembly: AssemblyGraph | null; acceptance: Array<{ layer: string; passed: boolean }> }): GateView {
  const lines = header(4);
  const asm = payload.assembly;
  if (!asm) {
    lines.push("（装配图尚未生成）");
  } else {
    lines.push("流水线图:");
    for (const n of asm.nodes) {
      lines.push(`  (${n.nodeId}) ${n.capabilityId}${n.glueNeeded ? "  ⟲需胶水" : ""}`);
    }
    for (const e of asm.edges) {
      lines.push(`  ${e.from} ──${e.alignment === "ok" ? "▶" : "⟲glue"}──▶ ${e.to}${e.reason ? `  (${e.reason})` : ""}`);
    }
  }
  lines.push("", "验收清单（可改）:");
  const layers = ["component", "task", "generalization"];
  for (const layer of layers) {
    const rec = payload.acceptance.find((a) => a.layer === layer);
    lines.push(`  [${rec ? (rec.passed ? "✓" : "✗") : " "}] ${layer}`);
  }
  lines.push("", "[a] 批准进入执行   [m] 改验收标准   [r] 驳回重装配");
  return { title: GATES[4].name, lines };
}

export function renderGate5(payload: { intent: Intent | null; trace: unknown[]; acceptance: Array<{ layer: string; passed: boolean }> }): GateView {
  const lines = header(5);
  lines.push("升维前后对照:");
  lines.push(`  需求: ${payload.intent?.goal ?? "—"}`);
  lines.push(`  执行步骤: ${payload.trace.length}`);
  const passed = payload.acceptance.every((a) => a.passed);
  lines.push(`  验收: ${payload.acceptance.map((a) => `${a.layer}:${a.passed ? "过" : "挂"}`).join("  ")}`);
  lines.push("", "泛化结果: 槽位化/分支化/验收泛化/意图签名 已生成（见蒸馏产物）");
  lines.push("", "[1] 固化入库 (pin)   [2] 重跑一次 (rerun)   [3] 丢弃 (discard)");
  void passed;
  return { title: GATES[5].name, lines };
}

/** TUI 承载：同一 renderer 的 pi-tui 组件形态（overlay 内容；children 数组式 API） */
export function gateViewComponents(gate: GateId, payload: unknown): VStack {
  const view = renderGateView(gate, payload);
  const children = view.lines.map((line) => new Text(line));
  return new VStack(children);
}

export function renderApprovalsSummary(approvals: ApprovalRecord[]): string[] {
  return approvals.map((a) => `闸门${a.gate} ${a.action === "approve" ? "✓批准" : `✗驳回→${a.targetPhase}`} ${a.comment ?? ""} [${a.decidedBy}]`);
}
