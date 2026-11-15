/**
 * 产出编辑结构化 diff（docs/分寸账本改造方案.md §7 Edit-to-Accept）。
 * 行级 LCS → 改动块 → 四类归因（removed/reworded/added/format）。
 * 尺寸控制：锚 ≤40 字、片段 ≤200 字、每 run 最多 5 块入提案、原文不落账本只落锚+块。
 */

export type EditKind = "removed" | "reworded" | "added" | "format";

export type EditBlock = {
  kind: EditKind;
  /** 定位锚：改动块上方最近的标题/句首行，≤40 字 */
  anchor: string;
  before?: string;
  after?: string;
};

const MAX_ANCHOR = 40;
const MAX_FRAGMENT = 200;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** 行切分（容忍 CRLF） */
function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

/** 格式层等价：去空白/标点/markdown 层级记号后相等 → format 而非内容改动 */
function formatEquivalent(a: string, b: string): boolean {
  const norm = (s: string): string =>
    s
      .replace(/^[#>\-*+\s]+/, "")
      .replace(/[*_`~]/g, "")
      .replace(/[\s\p{P}]+/gu, "")
      .toLowerCase();
  return norm(a) === norm(b) && norm(a).length > 0;
}

/** 行级 LCS 的 DP 表（产出为文本规模，200k 上限内可控；超限护栏见 computeOutputDiff） */
function lcsTable(a: string[], b: string[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  return table;
}

/** LCS DP 表内存护栏：单元格数超过 400 万（约 32MB）时退化为整段替换，不算精细归因 */
const MAX_LCS_CELLS = 4_000_000;

/**
 * 结构化 diff：先由 LCS 生成 eq/del/ins 算子序列，再把连续 del/ins 游程归并为改动块。
 * 相邻删+增 → reworded（格式等价时降级 format）；仅删 → removed；仅增 → added。
 */
export function computeOutputDiff(original: string, revised: string): EditBlock[] {
  if (original === revised) return [];
  const a = splitLines(original);
  const b = splitLines(revised);
  // 超限护栏：跳过 LCS，整段视为一个 reworded 块（锚=开头）——宁可粗不爆内存
  if ((a.length + 1) * (b.length + 1) > MAX_LCS_CELLS) {
    return [{ kind: "reworded", anchor: "（开头）", before: truncate(original, MAX_FRAGMENT), after: truncate(revised, MAX_FRAGMENT) }];
  }
  const table = lcsTable(a, b);
  type Op = { t: "eq" | "del" | "ins"; line: string };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ t: "eq", line: a[i]! });
      i += 1;
      j += 1;
      continue;
    }
    if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      ops.push({ t: "del", line: a[i]! });
      i += 1;
    } else {
      ops.push({ t: "ins", line: b[j]! });
      j += 1;
    }
  }
  while (i < a.length) {
    ops.push({ t: "del", line: a[i]! });
    i += 1;
  }
  while (j < b.length) {
    ops.push({ t: "ins", line: b[j]! });
    j += 1;
  }
  // 连续非 eq 游程 → 改动块；锚 = 游程上方最近的非空 eq 行（跳过执行器内部标记行）
  const blocks: EditBlock[] = [];
  let anchor = "（开头）";
  let k = 0;
  while (k < ops.length) {
    if (ops[k]!.t === "eq") {
      const line = ops[k]!.line.trim();
      // GOAL_MET/执行器内部标记不作锚——锚应指向人类可读的正文
      if (line && !/^(?:GOAL_MET|STEP_STATUS|EXEC_)[:_]/.test(line)) anchor = truncate(line, MAX_ANCHOR);
      k += 1;
      continue;
    }
    const del: string[] = [];
    const ins: string[] = [];
    while (k < ops.length && ops[k]!.t !== "eq") {
      const bucket = ops[k]!.t === "del" ? del : ins;
      if (ops[k]!.line.trim()) bucket.push(ops[k]!.line);
      k += 1;
    }
    if (!del.length && !ins.length) continue;
    if (del.length && ins.length) {
      const kind = del.length === ins.length && del.every((line, idx) => formatEquivalent(line, ins[idx]!)) ? "format" : "reworded";
      blocks.push({ kind, anchor, before: truncate(del.join("\n"), MAX_FRAGMENT), after: truncate(ins.join("\n"), MAX_FRAGMENT) });
    } else if (del.length) {
      blocks.push({ kind: "removed", anchor, before: truncate(del.join("\n"), MAX_FRAGMENT) });
    } else {
      blocks.push({ kind: "added", anchor, after: truncate(ins.join("\n"), MAX_FRAGMENT) });
    }
  }
  return blocks;
}

/** 改动块 → 账本提案素材（§7 表；每 run 最多 5 块；format 不结晶——与内容条款隔离，独立 scope 留 schema 演进） */
export function blocksToProposals(
  blocks: EditBlock[],
): Array<{ clause: string; scope: "output"; kind: "advisory" | "must_contain" | "must_not_contain"; pattern: string | null; kind_source: EditKind; addedText?: string }> {
  return blocks
    .filter((block) => block.kind !== "format")
    .slice(0, 5)
    .map((block) => {
      if (block.kind === "removed") {
        return { clause: truncate(`不要 ${block.anchor} 部分`, 300), scope: "output" as const, kind: "must_not_contain" as const, pattern: null, kind_source: block.kind };
      }
      if (block.kind === "added") {
        return { clause: truncate(`${block.anchor} 之后应包含「${block.after ?? ""}」`, 300), scope: "output" as const, kind: "must_contain" as const, pattern: null, kind_source: block.kind, addedText: block.after };
      }
      return { clause: truncate(`${block.anchor} 的表述应为「${truncate((block.after ?? "").replace(/\n/g, " "), 60)}」`, 300), scope: "output" as const, kind: "advisory" as const, pattern: null, kind_source: block.kind };
    });
}
