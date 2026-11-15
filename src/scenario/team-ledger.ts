import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ConstraintSchema, type Constraint } from "./ledger.js";

/**
 * 团队层账本（docs/两角色模型优化方案.md §4）：
 * `~/.pi/scenario/team-ledger.json`（git 同步），存团队级偏好/标准条款。
 * 场景层覆盖团队层（同 clauseKey 时场景胜出）；冲突可见于面板。
 * v0 = 文件即组织——不建服务端/账号体系，团队同步 = 提交这个文件。
 */

const TeamLedgerSchema = z.object({
  version: z.literal(1),
  constraints: z.array(ConstraintSchema),
  updatedAt: z.string(),
});
export type TeamLedger = z.infer<typeof TeamLedgerSchema>;

/** 条款归一 key：全半角/空白折叠/小写，用于场景层覆盖团队层的去重 */
function clauseKey(clause: string): string {
  return clause
    .toLowerCase()
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/g, "")
    .slice(0, 120);
}

/** 团队层文件路径（默认 ~/.pi/scenario/team-ledger.json） */
export function teamLedgerPath(dataRoot: string): string {
  return path.join(dataRoot, "team-ledger.json");
}

/** 读团队层条款（文件不存在/损坏 → 空数组，不抛错） */
export function readTeamConstraints(dataRoot: string): Constraint[] {
  const filePath = teamLedgerPath(dataRoot);
  try {
    const parsed = TeamLedgerSchema.parse(JSON.parse(fs.readFileSync(filePath, "utf8")));
    return parsed.constraints.filter((c) => c.active && c.supersededBy === null);
  } catch {
    return [];
  }
}

/** 写团队层条款（原子性：tmp+rename 不做——量小，直接覆写；调用方需 catch） */
export function writeTeamConstraints(dataRoot: string, constraints: Constraint[]): void {
  const filePath = teamLedgerPath(dataRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body: TeamLedger = {
    version: 1,
    constraints: constraints.map((c) => ({ ...c, layer: "team" })),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(filePath, JSON.stringify(body, null, 2), "utf8");
}

/**
 * 合并解析：场景层 ∪ 团队层，clauseKey 冲突时场景层胜出。
 * 返回注入/自检用的最终条款列表（带来源标记）。
 */
export function resolveConstraints(
  scenarioConstraints: Constraint[],
  teamConstraints: Constraint[],
): Array<Constraint & { fromTeam: boolean }> {
  const scenarioKeys = new Set(scenarioConstraints.map((c) => clauseKey(c.clause)));
  const teamOverrides = teamConstraints.filter((c) => !scenarioKeys.has(clauseKey(c.clause)));
  return [
    ...scenarioConstraints.map((c) => ({ ...c, fromTeam: false })),
    ...teamOverrides.map((c) => ({ ...c, fromTeam: true })),
  ];
}

/** 幂等初始化：无 team 文件时创建空壳（首次启动常态） */
export function ensureTeamLedger(dataRoot: string): void {
  const filePath = teamLedgerPath(dataRoot);
  if (fs.existsSync(filePath)) return;
  writeTeamConstraints(dataRoot, []);
}
