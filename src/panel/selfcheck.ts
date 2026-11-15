import type { Constraint } from "@/scenario/ledger.js";
import { templateC } from "@/panel/prompts.js";

/**
 * 产出自检时序（docs/分寸账本改造方案.md §10）：
 * 机械项（must_contain/must_not_contain）规则判 → judge（便宜模型一次调用，模板C）只判 advisory
 * → 违规注入修复提示重产出（≤1 次）→ 复检只检违规项。
 * 成本上限：每 run 自检最多 2 次模型调用。从不阻断交付——仍违规只带标注 + suspected。
 * judge 不可达/解析失败 ≠ 违规：advisory 是建议不是标准，fail-open 跳过（机械项照判）。
 */

export type SelfCheckViolation = { id: string; clause: string; reason: string };

export type SelfCheckResult = {
  /** 最终仍未满足的条款（黄标数据源） */
  violations: SelfCheckViolation[];
  /** true = 修复一轮后仍违规 → run 标 suspected（不写 accepted、断连胜） */
  suspected: boolean;
  /** 模型调用次数（≤2） */
  modelCalls: number;
  /** 全部受检条款数 */
  checked: number;
  /** judge 不可达而跳过的 advisory 数（fail-open 透出，不静默） */
  unchecked: number;
  /** 修复后的产出（发生修复时才有） */
  repairedOutput?: string;
};

type Judge = (system: string, input: string) => Promise<string>;

/** 机械判据：must_contain 子串（或 pattern 正则）命中；must_not_contain 反向 */
export function checkMechanical(constraint: Constraint, output: string): { pass: boolean; reason: string } {
  if (constraint.kind === "must_contain") {
    if (constraint.pattern) {
      const probe = constraint.pattern;
      const matched = safeRegex(probe) ? new RegExp(probe).test(output) : output.includes(probe);
      return { pass: matched, reason: matched ? "含指定内容" : "未找到指定内容" };
    }
    // 无 pattern 的 must_contain（闸4 勾选类）→ 交 judge（§4）
    return { pass: true, reason: "交 judge" };
  }
  if (constraint.kind === "must_not_contain") {
    if (constraint.pattern) {
      const probe = constraint.pattern;
      const present = safeRegex(probe) ? new RegExp(probe).test(output) : output.includes(probe);
      return { pass: !present, reason: present ? "出现禁止内容" : "不含禁止内容" };
    }
    // 无 pattern：从条款提取锚（模板形态「不要 {锚} 部分」→ 剥否定前缀与"部分"后缀）
    const anchor = constraint.clause
      .replace(/^(?:不要|别|禁止|不能出现|不得出现)/, "")
      .replace(/(?:部分|内容|段落)$/, "")
      .trim();
    const present = anchor.length >= 2 && output.includes(anchor);
    return { pass: !present, reason: present ? "出现禁止内容" : "不含禁止内容" };
  }
  return { pass: true, reason: "交 judge" };
}

function safeRegex(source: string): boolean {
  if (!/^[\p{L}\p{N}\s\p{P}]+$/u.test(source) || source.length > 80) return false;
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

function parseJudgeVerdicts(raw: string): Array<{ id: string; pass: boolean; reason: string }> {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Array<{ id?: string; pass?: boolean; reason?: string }>;
    return parsed
      .filter((item) => typeof item.id === "string")
      .map((item) => ({ id: item.id!, pass: item.pass === true, reason: String(item.reason ?? "").slice(0, 40) }));
  } catch {
    return [];
  }
}

export type SelfCheckParams = {
  constraints: Constraint[];
  output: string;
  /** 便宜模型 judge（无模型 → 只跑机械项） */
  judge?: Judge;
  /** 修复重产出：注入违规条款 + 原产出，返回修订文本（≤1 次；无则跳过修复） */
  repair?: (violations: SelfCheckViolation[], output: string) => Promise<string | null>;
  onModelCall?: (count: number) => void;
};

export async function runSelfCheck(params: SelfCheckParams): Promise<SelfCheckResult> {
  const active = params.constraints.filter((c) => c.active && c.supersededBy === null);
  if (!active.length) return { violations: [], suspected: false, modelCalls: 0, checked: 0, unchecked: 0 };
  let modelCalls = 0;
  let unchecked = 0;
  const violations: SelfCheckViolation[] = [];
  const judgeClauses: Constraint[] = [];
  for (const constraint of active) {
    const verdict = checkMechanical(constraint, params.output);
    if (verdict.reason !== "交 judge") {
      if (!verdict.pass) violations.push({ id: constraint.id, clause: constraint.clause, reason: verdict.reason });
      continue;
    }
    judgeClauses.push(constraint);
  }
  // judge：一次调用判所有 advisory（§10）；失败 = 不可判，跳过并计数，绝不把 advisory 判成违规
  if (judgeClauses.length && params.judge) {
    const { system, input } = templateC(judgeClauses.map((c) => ({ id: c.id, clause: c.clause })), params.output);
    modelCalls += 1;
    params.onModelCall?.(modelCalls);
    const raw = await params.judge(system, input).catch(() => "");
    const verdicts = parseJudgeVerdicts(raw);
    if (!verdicts.length) {
      unchecked += judgeClauses.length;
    } else {
      for (const clause of judgeClauses) {
        const verdict = verdicts.find((v) => v.id === clause.id);
        if (!verdict) {
          unchecked += 1;
        } else if (!verdict.pass) {
          violations.push({ id: clause.id, clause: clause.clause, reason: verdict.reason || "judge 判定未满足" });
        }
      }
    }
  }
  if (!violations.length) return { violations: [], suspected: false, modelCalls, checked: active.length, unchecked };
  // 修复：违规条款注入修正提示 → 重产出 ≤1 次 → 复检只检违规项
  if (params.repair) {
    const repaired = await params.repair(violations, params.output).catch(() => null);
    if (repaired && repaired !== params.output) {
      const remaining: SelfCheckViolation[] = [];
      const recheckIds = new Set(violations.map((v) => v.id));
      const recheckClauses = active.filter((c) => recheckIds.has(c.id));
      const recheckJudge: Constraint[] = [];
      for (const constraint of recheckClauses) {
        const verdict = checkMechanical(constraint, repaired);
        if (verdict.reason !== "交 judge") {
          if (!verdict.pass) remaining.push({ id: constraint.id, clause: constraint.clause, reason: verdict.reason });
        } else {
          recheckJudge.push(constraint);
        }
      }
      // 复检 judge：仍然一次调用判全部复检项，守住 ≤2 次预算；失败 fail-open 计入 unchecked
      if (recheckJudge.length && params.judge) {
        const { system, input } = templateC(recheckJudge.map((c) => ({ id: c.id, clause: c.clause })), repaired);
        modelCalls += 1;
        params.onModelCall?.(modelCalls);
        const raw = await params.judge(system, input).catch(() => "");
        const verdicts = parseJudgeVerdicts(raw);
        for (const clause of recheckJudge) {
          const verdict = verdicts.find((v) => v.id === clause.id);
          if (!verdict) unchecked += 1;
          else if (!verdict.pass) remaining.push({ id: clause.id, clause: clause.clause, reason: verdict.reason || "judge 判定未满足" });
        }
      } else if (recheckJudge.length) {
        unchecked += recheckJudge.length;
      }
      if (remaining.length) return { violations: remaining, suspected: true, modelCalls, checked: active.length, unchecked, repairedOutput: repaired };
      return { violations: [], suspected: false, modelCalls, checked: active.length, unchecked, repairedOutput: repaired };
    }
  }
  return { violations, suspected: true, modelCalls, checked: active.length, unchecked };
}

/** 修复提示（注入重产出调用） */
export function repairPrompt(violations: SelfCheckViolation[], output: string): string {
  return [
    "以下产出未满足部分工作约束。请修订产出使其全部满足，保持其余内容与结构不变，直接输出修订后的完整产出。",
    `【未满足条款】\n${violations.map((v) => `- [${v.id}] ${v.clause}（${v.reason}）`).join("\n")}`,
    `【原产出】\n${output.slice(0, 12_000)}`,
  ].join("\n\n");
}
