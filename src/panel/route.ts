import { confidence, tierOf, type Tier } from "@/scenario/confidence.js";
import type { ScenarioLedger } from "@/scenario/ledger.js";

/**
 * 双路路由判定（docs/分寸账本改造方案.md §6）——match 命中后、执行前。
 * 纯函数：tier × digest 命中 × 强制体检 × degraded 决定 重放 vs 重规划。
 */

export type RouteDecision = {
  mode: "replay" | "replan";
  /** true = 本轮是每 10 次重放一度的强制体检（§6 防静默漂移） */
  healthCheck: boolean;
  tier: Tier;
  reason: string;
};

/** 近 10 条 accepted 中同 digest 命中 = 同参数已成功过 → 重放素材 */
function digestHitCount(ledger: Pick<ScenarioLedger, "inputPatterns">, digest: string): number {
  return ledger.inputPatterns.filter((e) => e.digest === digest && e.outcome === "accepted").length;
}

export function resolveRoute(
  ledger: Pick<ScenarioLedger, "runStats" | "inputPatterns">,
  options: { degraded?: boolean; digest?: string; now?: Date },
): RouteDecision {
  const now = options.now ?? new Date();
  const tier = tierOf(confidence(ledger, now));
  const digest = options.digest;
  const hits = digest && digest !== "none" ? digestHitCount(ledger, digest) : 0;
  // 体检：同 digest 每 10 次重放强制 1 次重规划（命中数非零且整除 10）
  const healthCheck = hits > 0 && hits % 10 === 0;
  if (options.degraded) return { mode: "replan", healthCheck, tier, reason: "degraded 场景禁重放，强制重规划" };
  if (healthCheck) return { mode: "replan", healthCheck: true, tier, reason: `同输入已重放 ${hits} 次，强制体检重规划` };
  if (tier === "replay" && hits > 0) return { mode: "replay", healthCheck: false, tier, reason: `置信度 ${tier} 且同输入命中 ${hits} 次` };
  const digestProvided = Boolean(digest) && digest !== "none";
  return { mode: "replan", healthCheck, tier, reason: `tier=${tier}${digestProvided && hits === 0 ? " 但 digest 未命中" : ""} → 重规划` };
}
