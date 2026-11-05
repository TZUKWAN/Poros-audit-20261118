import { createHash } from "node:crypto";

/**
 * 输入 digest（docs/分寸账本改造方案.md §6）：路由重放判据。
 *
 * 实机修正（2026-11-05）：原实现只用 slots——但 slots 来自 LLM 逐次意图解析，
 * 槽位名/数量会漂移，导致同一原始需求的 digest 每次都变，重放路由与强制体检
 * 永不命中（"tier=spot 但 digest 未命中"）。修正为：**归一化原文为主源**（LLM
 * 无关、同文本恒定），slots 为辅（同场景不同参数 → 不同 digest → 保守重规划）。
 * goal 依旧不参与（goal 变 = match 层已换场景）。
 */

/** 全角 → 半角 + 空白折叠 + 小写 */
export function normalizeSlotValue(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/g, " ");
}

/** 原文归一（digest 主源）：去标点差异、全半角、空白折叠、小写 */
export function normalizeRequirementText(text: string): string {
  return normalizeSlotValue(text).replace(/[\p{P}\p{S}]+/gu, "");
}

/**
 * 同一场景同参数 → 恒定 digest（重放命中的依据）。
 * 归一化原文为主源 + slots 排序归一化拼接为辅。
 */
export function inputDigest(requirement: string, slots: Record<string, string>): string {
  const reqPart = normalizeRequirementText(requirement);
  const keys = Object.keys(slots).sort();
  const slotPart = keys.map((k) => `${k}:${normalizeSlotValue(slots[k] ?? "")}`).join("|");
  return createHash("sha1").update(`${reqPart}|${slotPart}`).digest("hex");
}

/** 无 slots 场景：digest = 归一化原文（同需求恒定，永远命中——drift 由 goal/match 层管） */
export function emptyDigest(): string {
  return inputDigest("", {});
}
