import type { Capability, SourceTier, Trust } from "./types.js";

/** 来源权重（1.1.3） */
export const TIER_WEIGHT: Record<SourceTier, number> = {
  official: 1.0,
  curated: 0.8,
  aggregate: 0.6,
};

/** 证据归一化上界（超过按 1 计） */
export const EVIDENCE_CAPS = {
  stars: 20_000,
  downloads: 500_000,
  /** 更新鲜度：月数 ≤1 记满分，≥24 记 0 */
  freshMonthsMax: 24,
  freshMonthsMin: 1,
};

export interface EvidenceInput {
  stars?: number;
  downloads?: number;
  updatedAt?: string;
}

function minMaxNorm(value: number | undefined, cap: number): number | undefined {
  if (value === undefined || Number.isNaN(value)) return undefined;
  if (value < 0) return undefined; // 负数视为无效证据，按缺失处理
  if (value === 0) return 0;
  return Math.min(1, value / cap);
}

/** 更新鲜度：1 个月内=1 分线性衰减到 24 个月=0 分 */
function freshness(updatedAt?: string): number | undefined {
  if (!updatedAt) return undefined;
  const t = Date.parse(updatedAt);
  if (Number.isNaN(t)) return undefined;
  const months = (Date.now() - t) / (1000 * 60 * 60 * 24 * 30.44);
  if (months <= EVIDENCE_CAPS.freshMonthsMin) return 1;
  if (months >= EVIDENCE_CAPS.freshMonthsMax) return 0;
  return 1 - (months - EVIDENCE_CAPS.freshMonthsMin) / (EVIDENCE_CAPS.freshMonthsMax - EVIDENCE_CAPS.freshMonthsMin);
}

/**
 * 证据分：三个证据（stars/下载/维护活性）各自 min-max 归一到 [0,1] 后取均值；
 * 全部缺失时按保守 0.5 计（不算功臣也不判死刑——由硬过滤兜底）。
 */
export function evidenceScore(input: EvidenceInput): number {
  const parts: number[] = [];
  const s = minMaxNorm(input.stars, EVIDENCE_CAPS.stars);
  if (s !== undefined) parts.push(s);
  const d = minMaxNorm(input.downloads, EVIDENCE_CAPS.downloads);
  if (d !== undefined) parts.push(d);
  const f = freshness(input.updatedAt);
  if (f !== undefined) parts.push(f);
  if (parts.length === 0) return 0.5;
  return parts.reduce((a, b) => a + b, 0) / parts.length;
}

/**
 * trust 评分 = 来源权重 × 证据分，截到 [0,1]。
 * hardFilterPassed 由 hardFilter() 单独判定后合入。
 */
export function scoreTrust(tier: SourceTier, evidence: EvidenceInput): { score: number; evidenceScore: number } {
  const es = evidenceScore(evidence);
  const score = Math.min(1, TIER_WEIGHT[tier] * es);
  return { score, evidenceScore: es };
}

const AUTH_HINTS = /api[-_ ]?key|secret|token|credential|auth[-_ ]?code|password/i;
const AUTH_SUPPORT = /oauth|bearer|env[: ]|configuration|配置|令牌|密钥/i;
const EXEC_HINTS = /npx|npm|pip|binary|cli|command|server|endpoint|install|运行|安装/;

export interface HardFilterResult {
  passed: boolean;
  reasons: string[];
}

/**
 * 硬过滤（1.1.3.c）—— 三条规则，任一命中即拒入候选池：
 * R1 无鉴权标记：描述表明需要凭据（key/secret/token…）但全文无任何鉴权配置线索（oauth/env/配置说明）。
 * R2 无可执行内容：推不出任何安装/调用规格（无 package/repo/remote/命令线索）。
 * R3 停滞+危险：距上次更新 ≥12 个月 且 命中安全标记（deprecated/CVE/供应链等）。
 */
export function hardFilter(input: {
  description: string;
  installAvailable: boolean;
  updatedAt?: string;
  securityFlagged?: boolean;
}): HardFilterResult {
  const reasons: string[] = [];
  const desc = input.description ?? "";
  if (AUTH_HINTS.test(desc) && !AUTH_SUPPORT.test(desc)) {
    reasons.push("R1-requires-auth-without-auth-markers");
  }
  if (!input.installAvailable && !EXEC_HINTS.test(desc)) {
    reasons.push("R2-no-executable-content");
  }
  const months = input.updatedAt ? (Date.now() - Date.parse(input.updatedAt)) / (1000 * 60 * 60 * 24 * 30.44) : undefined;
  if (input.updatedAt && months !== undefined && months >= 12 && input.securityFlagged) {
    reasons.push("R3-stale-and-security-flagged");
  }
  return { passed: reasons.length === 0, reasons };
}

/** 对 Capability 打 trust 总分（评分 + 硬过滤） */
export function computeTrust(cap: Omit<Capability, "trust">): Trust {
  const hf = hardFilter({
    description: cap.description,
    installAvailable: cap.install.type !== undefined,
    updatedAt: cap.updatedAt,
    securityFlagged: cap.securityFlagged,
  });
  const { score, evidenceScore: es } = scoreTrust(cap.source.tier, {
    stars: cap.stars,
    downloads: cap.downloads,
    updatedAt: cap.updatedAt,
  });
  return {
    score: hf.passed ? score : 0,
    tier: cap.source.tier,
    evidence: {
      stars: cap.stars,
      downloads: cap.downloads,
      monthsSinceUpdate: cap.updatedAt
        ? Math.round((Date.now() - Date.parse(cap.updatedAt)) / (1000 * 60 * 60 * 24 * 30.44))
        : undefined,
      evidenceScore: es,
    },
    hardFilterPassed: hf.passed,
  };
}
