/**
 * Judgment Layer V2（PRD §7 语义落地）。与旧 ledger 的区别（§1.2 六条错误全部规避）：
 * - 没有自动晋级、没有 holdout 因果推断、没有 silent-accepted；
 * - candidate 只能来自显式用户反馈或机器可观测失败（路由层强制 source）；
 * - 只有 APPROVED 规则才进入正式运行注入；注入逐条留痕 ruleId+version；
 * - 评估：机械规则确定性检查；语义规则无 Judge 时恒为 UNCHECKED（绝不记 PASS）。
 */
import type { JudgmentRule, PrismaClient, ScopeType } from "@prisma/client";
import { ApiError } from "./releases.js";

export function parseMechanical(rule: string): { op: string; arg: string; n?: number } {
  const colon = rule.indexOf(":");
  const op = rule.slice(0, colon),
    arg = rule.slice(colon + 1);
  if (colon < 1 || !arg.trim() || !["must_contain", "must_not_contain", "max_length"].includes(op))
    throw new ApiError(400, "非法机械规则：需要有效指令与非空参数");
  if (op === "max_length" && (!/^[1-9]\d{0,5}$/.test(arg) || Number(arg) > 100000))
    throw new ApiError(400, "max_length 必须为 1–100000 的整数");
  return { op, arg, ...(op === "max_length" ? { n: Number(arg) } : {}) };
}
export function ruleConflict(a: string, b: string): boolean {
  let x: ReturnType<typeof parseMechanical>, y: ReturnType<typeof parseMechanical>;
  try {
    x = parseMechanical(a);
    y = parseMechanical(b);
  } catch {
    return false;
  }
  if (x.op === "must_contain" && y.op === "must_not_contain") return x.arg.includes(y.arg);
  if (y.op === "must_contain" && x.op === "must_not_contain") return y.arg.includes(x.arg);
  if (x.op === "must_contain" && y.op === "max_length") return x.arg.length > y.n!;
  if (y.op === "must_contain" && x.op === "max_length") return y.arg.length > x.n!;
  return false;
}

export interface EffectiveRule {
  id: string;
  version: number;
  rule: string;
  kind: "MECHANICAL" | "SEMANTIC";
  scopeType: ScopeType;
  scopeId: string;
}

/** 作用域筛选：组织 > 部门 > 项目 > Agent，窄作用域优先；只取 APPROVED。 */
export async function effectiveRules(
  db: PrismaClient,
  organizationId: string,
  context: { projectId?: string | null; agentId?: string | null; department?: string | null },
): Promise<EffectiveRule[]> {
  const rows = await db.judgmentRule.findMany({ where: { organizationId, status: "APPROVED" } });
  const matches = rows.filter((r) => {
    if (r.scopeType === "ORGANIZATION") return r.scopeId === organizationId;
    if (r.scopeType === "DEPARTMENT")
      return !!context.department && r.scopeId === context.department;
    if (r.scopeType === "PROJECT") return !!context.projectId && r.scopeId === context.projectId;
    if (r.scopeType === "AGENT") return !!context.agentId && r.scopeId === context.agentId;
    return false;
  });
  // 同 scope 下版本去重：只取每个 rule 的最大 version
  const byId = new Map<string, JudgmentRule>();
  for (const r of matches) {
    const prev = byId.get(r.id);
    if (!prev || r.version > prev.version) byId.set(r.id, r);
  }
  const selected = [...byId.values()];
  for (let i = 0; i < selected.length; i++)
    for (let j = i + 1; j < selected.length; j++)
      if (
        selected[i]!.kind === "MECHANICAL" &&
        selected[j]!.kind === "MECHANICAL" &&
        ruleConflict(selected[i]!.rule, selected[j]!.rule)
      )
        throw new ApiError(409, "作用域规则冲突，运行已阻止");
  return selected.map((r) => ({
    id: r.id,
    version: r.version,
    rule: r.rule,
    kind: r.kind,
    scopeType: r.scopeType,
    scopeId: r.scopeId,
  }));
}

/** 机械规则：确定性检查（可审计、无模型参与）。规则语法约定：
 *   must_contain:<substring>   输出必须包含子串
 *   must_not_contain:<substring> 输出必须不包含
 *   max_length:<n>             输出长度上限
 * 未知机械规则 → UNCHECKED（保守，不猜）。
 */
export function evaluateMechanical(
  rule: string,
  output: string,
): { status: "PASS" | "FAIL" | "UNCHECKED"; reason: string } {
  try {
    parseMechanical(rule);
  } catch {
    return { status: "UNCHECKED", reason: "机械规则语法或参数无效" };
  }
  const [head, ...rest] = rule.split(":");
  const arg = rest.join(":");
  switch (head) {
    case "must_contain":
      return output.includes(arg)
        ? { status: "PASS", reason: "" }
        : { status: "FAIL", reason: `输出缺少必需内容: ${arg}` };
    case "must_not_contain":
      return output.includes(arg)
        ? { status: "FAIL", reason: `输出包含禁止内容: ${arg}` }
        : { status: "PASS", reason: "" };
    case "max_length": {
      const n = Number(arg);
      if (!Number.isFinite(n)) return { status: "UNCHECKED", reason: `无法解析长度上限: ${arg}` };
      return output.length <= n
        ? { status: "PASS", reason: "" }
        : { status: "FAIL", reason: `输出长度 ${output.length} 超过上限 ${n}` };
    }
    default:
      return { status: "UNCHECKED", reason: `未知机械规则指令: ${head}` };
  }
}
