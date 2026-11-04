import type { ScenarioLedger, RunOutcome } from "./ledger.js";

/**
 * 置信度引擎（docs/分寸账本改造方案.md §5）。
 * 铁律 3：置信度外生于账本——只用统计（连续无干预通过、打回衰减），禁用模型自评。
 */

export const TAU_DAYS = 14; // 事件衰减常数
export const WINDOW_DAYS = 30; // 事件计入窗口
export const REPLAY_THRESHOLD = 3; // R_THR
export const SPOT_THRESHOLD = 1; // S_THR

export type Tier = "replay" | "spot" | "full";

function daysSince(at: string, now: Date): number {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return 0; // 未知时刻按最新处理（不放大惩罚）
  return Math.max(0, (now.getTime() - t) / 86400000);
}

/** 事件权重随时间指数衰减：14 天前的 reject 只剩 e^-1 ≈ 0.37，30 天外不计 */
export function decay(at: string, now: Date = new Date()): number {
  return Math.exp(-daysSince(at, now) / TAU_DAYS);
}

/** 窗口内指定结果的衰减加权事件数（事件源 = ledger.inputPatterns，每 run 一条） */
export function countEvents(ledger: Pick<ScenarioLedger, "inputPatterns">, outcomes: RunOutcome[], now: Date = new Date()): number {
  const set = new Set(outcomes);
  let total = 0;
  for (const event of ledger.inputPatterns) {
    if (!set.has(event.outcome)) continue;
    const days = daysSince(event.at, now);
    if (days > WINDOW_DAYS) continue;
    total += decay(event.at, now);
  }
  return total;
}

/** 置信度：1.0×连续无干预通过 − 0.8×近期打回 − 0.5×近期纠正 */
export function confidence(ledger: Pick<ScenarioLedger, "runStats" | "inputPatterns">, now: Date = new Date()): number {
  const s = ledger.runStats;
  const recentRejects = countEvents(ledger, ["rejected"], now);
  const recentCorr = countEvents(ledger, ["corrected"], now);
  return 1.0 * s.consecutiveClean - 0.8 * recentRejects - 0.5 * recentCorr;
}

/** tier 分档：replay ≥3 / spot ≥1 / full（重放/抽查/全开） */
export function tierOf(c: number): Tier {
  if (c >= REPLAY_THRESHOLD) return "replay";
  if (c >= SPOT_THRESHOLD) return "spot";
  return "full";
}

/** 便捷：账本 → 当前 tier */
export function tierOfLedger(ledger: Pick<ScenarioLedger, "runStats" | "inputPatterns">, now: Date = new Date()): Tier {
  return tierOf(confidence(ledger, now));
}
