import type { Constraint } from "@/scenario/ledger.js";

/**
 * 分寸账本 Prompt 模板三件套（docs/分寸账本改造方案.md §11，写死不调参）。
 * 模板 A：约束注入（重放/重规划共用）；B：先例注入（仅重规划）；C：自检 judge。
 */

/** 模板 A · 约束注入——必须全部满足；确实无法满足时显式标注编号，禁止静默违反 */
export function templateA(constraints: Constraint[]): string {
  if (!constraints.length) return "";
  const lines = constraints.map((c, index) => `${index + 1}. [${c.id}] ${c.clause}`);
  return `【该场景已积累的工作约束——必须全部满足】\n${lines.join("\n")}\n若计划确实无法满足某条，在产出中显式标注 [编号] 及原因，禁止静默违反。`;
}

/**
 * 模板 B · 先例注入（仅重规划，最近 2 条 accepted 先行）。
 * 账本 schema 不落产出原文（§3 隐私边界），先例以时间+digest 短码的元数据形态呈现，
 * 给模型的信号是"这类输入曾被接受过 N 次"，而非内容示例。
 */
export function templateB(patterns: Array<{ digest: string; at: string; outcome: string }>): string {
  const accepted = patterns.filter((p) => p.outcome === "accepted").slice(-2);
  if (!accepted.length) return "";
  const lines = accepted.map((p, index) => `--- 先例 #${index + 1}（${p.at.slice(0, 10)} · 输入指纹 ${p.digest.slice(0, 8)}）---\n该输入形态此前被用户接受，规划保持同等结构。`);
  return `【历史被接受的运行记录（参考形态，勿复制内容）】\n${lines.join("\n")}`;
}

/** 模板 C · 自检 judge：逐条字面判定，从严 */
export function templateC(clauses: Array<{ id: string; clause: string }>, output: string): { system: string; input: string } {
  const system =
    "你是验收检查员。逐条判定【产出】是否满足【条款】，只依据字面。\n" +
    '输出 JSON 数组，每条：{"id":"条款id","pass":true/false,"reason":"≤20字"}。\n' +
    "判定从严：无法确认满足即 false。不要输出数组以外的任何内容。";
  const input = `【条款】\n${clauses.map((c) => `[${c.id}] ${c.clause}`).join("\n")}\n\n【产出】\n${output.slice(0, 12_000)}`;
  return { system, input };
}
