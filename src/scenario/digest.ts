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
 * **只锚定归一化原文**——实机根因（2026-11-07 调试日志定位）：LLM 逐次解析的
 * 槽位名（feedback_content/feedback/customer_feedback…）**和数量、值摘要都漂移**，
 * 任何 slots 参与散列都会让同一需求每次 digest 不同，重放路由与强制体检因此
 * 永不命中。参数区分改由「归一化原文」承担——同一场景的请求差异本就体现在
 * 原文措辞上，措辞不同 → 保守重规划，语义安全。goal 不参与（match 层管）。
 */
export function inputDigest(requirement: string, _slots?: Record<string, string>): string {
  void _slots; // 槽位刻意不参与——LLM 解析漂移（名/数量/值摘要皆不稳定）
  return createHash("sha1").update(normalizeRequirementText(requirement)).digest("hex");
}

/** 无 slots 场景：digest = 归一化原文（同需求恒定，永远命中——drift 由 goal/match 层管） */
export function emptyDigest(): string {
  return inputDigest("", {});
}
