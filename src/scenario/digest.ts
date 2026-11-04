import { createHash } from "node:crypto";

/**
 * 输入 digest（docs/分寸账本改造方案.md §6）：路由重放判据。
 * goal 不进 digest——goal 变 = match 层已换场景；slots 排序后归一化拼接。
 */

/** 全角 → 半角 + 空白折叠 + 小写 */
export function normalizeSlotValue(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/g, " ");
}

/**
 * 同一场景同参数 → 恒定 digest（重放命中的依据）。
 * requirement 参数保留以对齐规格签名，但刻意不参与散列。
 */
export function inputDigest(requirement: string, slots: Record<string, string>): string {
  void requirement;
  const keys = Object.keys(slots).sort();
  const body = keys.map((k) => `${k}:${normalizeSlotValue(slots[k] ?? "")}`).join("|");
  return createHash("sha1").update(body).digest("hex");
}

/** 无 slots 场景的恒定 digest（永远命中——drift 由 goal/match 层管） */
export function emptyDigest(): string {
  return inputDigest("", {});
}
