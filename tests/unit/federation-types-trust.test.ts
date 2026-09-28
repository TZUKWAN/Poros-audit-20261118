import { describe, expect, it } from "vitest";
import { CapabilitySchema, canonicalName, repoIdentity, SourceIdSchema, SourceTierSchema } from "@/federation/types";
import { evidenceScore, hardFilter, scoreTrust } from "@/federation/trust";

describe("1.1.1.b Capability schema 校验", () => {
  const good = (over: Partial<Record<string, unknown>> = {}) => ({
    id: "modelscope:filesystem",
    name: "filesystem",
    kind: "mcp-server",
    description: "文件系统操作",
    source: { id: "modelscope", tier: "curated", name: "ModelScope", url: "https://mcp.modelscope.cn" },
    trust: {
      score: 0.5,
      tier: "curated",
      evidence: { evidenceScore: 0.5 },
      hardFilterPassed: true,
    },
    install: { type: "npx", package: "@modelcontextprotocol/server-filesystem", args: [] },
    tags: [],
    requiresAuth: false,
    securityFlagged: false,
    ...over,
  });

  it("3 个合法样例通过（npx/git/remote 三种 install）", () => {
    expect(CapabilitySchema.safeParse(good()).success).toBe(true);
    expect(
      CapabilitySchema.safeParse(good({ install: { type: "git", repoUrl: "https://github.com/a/b" } })).success,
    ).toBe(true);
    expect(
      CapabilitySchema.safeParse(
        good({
          install: { type: "remote", url: "https://mcp.example.com/mcp" },
          remoteRun: { url: "https://mcp.example.com/mcp", transport: "streamable-http" },
        }),
      ).success,
    ).toBe(true);
  });

  it("3 个坏样例被拒（坏 kind / 坏 install / 坏 trust 分数）", () => {
    expect(CapabilitySchema.safeParse(good({ kind: "warp-drive" })).success).toBe(false);
    expect(CapabilitySchema.safeParse(good({ install: { type: "carrier-pigeon" } })).success).toBe(false);
    expect(
      CapabilitySchema.safeParse(
        good({ trust: { score: 7.5, tier: "curated", evidence: { evidenceScore: 0.5 }, hardFilterPassed: true } }),
      ).success,
    ).toBe(false);
  });

  it("SourceId/Tier 枚举", () => {
    expect(SourceIdSchema.options).toHaveLength(8);
    expect(SourceTierSchema.options).toEqual(["official", "curated", "aggregate"]);
  });
});

describe("1.1.3.b trust 评分器（≥10 用例）", () => {
  it("官方满证据 = 1.0", () => {
    const { score } = scoreTrust("official", { stars: 50_000, downloads: 1e6, updatedAt: new Date().toISOString() });
    expect(score).toBeCloseTo(1, 5);
  });
  it("聚合零证据 = 0.3（0.6 × 保守 0.5）", () => {
    const { score } = scoreTrust("aggregate", {});
    expect(score).toBeCloseTo(0.3, 5);
  });
  it("策展中等证据", () => {
    const { score } = scoreTrust("curated", { stars: 10_000 });
    expect(score).toBeCloseTo(0.8 * 0.5, 5);
  });
  it("证据封顶：stars 超上限不再涨", () => {
    const a = evidenceScore({ stars: EVIDENCE_CAPS_STARS });
    const b = evidenceScore({ stars: EVIDENCE_CAPS_STARS * 10 });
    expect(a).toBeCloseTo(b, 5);
  });
  it("stars=0 → 证据 0", () => {
    expect(evidenceScore({ stars: 0 })).toBe(0);
  });
  it("新鲜度：今天=1，两年前=0，一年前≈0.457", () => {
    const now = Date.now();
    expect(evidenceScore({ updatedAt: new Date(now).toISOString() })).toBe(1);
    expect(evidenceScore({ updatedAt: new Date(now - 30 * 30.44 * 86400e3).toISOString() })).toBe(0);
    const year = evidenceScore({ updatedAt: new Date(now - 365 * 86400e3).toISOString() });
    expect(year).toBeGreaterThan(0.4);
    expect(year).toBeLessThan(0.6);
  });
  it("证据均值：两证据取均值", () => {
    // stars 满分 + downloads 满分 → 1；stars 满分 + downloads 0 → 0.5
    expect(evidenceScore({ stars: EVIDENCE_CAPS_STARS, downloads: EVIDENCE_CAPS_DOWNLOADS })).toBe(1);
    expect(evidenceScore({ stars: EVIDENCE_CAPS_STARS, downloads: 0 })).toBe(0.5);
  });
  it("来源权重排序 official > curated > aggregate（同证据）", () => {
    const ev = { stars: 5000 };
    const o = scoreTrust("official", ev).score;
    const c = scoreTrust("curated", ev).score;
    const a = scoreTrust("aggregate", ev).score;
    expect(o).toBeGreaterThan(c);
    expect(c).toBeGreaterThan(a);
  });
  it("负数 stars 按缺省处理（不参与均值）", () => {
    expect(evidenceScore({ stars: -5 })).toBe(0.5);
  });
  it("updatedAt 非法字符串按缺省处理", () => {
    expect(evidenceScore({ updatedAt: "not-a-date" })).toBe(0.5);
  });
});

const EVIDENCE_CAPS_STARS = 20_000;
const EVIDENCE_CAPS_DOWNLOADS = 500_000;

describe("1.1.3.d 硬过滤（每规则命中/不命中各 ≥2 例，共 ≥12 用例）", () => {
  const base = { installAvailable: true, securityFlagged: false };

  it("R1 需要鉴权但无鉴权标记 → 拒", () => {
    expect(hardFilter({ ...base, description: "Requires an API key to call the service" }).passed).toBe(false);
    expect(hardFilter({ ...base, description: "需要提供 token 才能使用" }).passed).toBe(false);
  });
  it("R1 需要鉴权但有配置说明 → 过", () => {
    expect(hardFilter({ ...base, description: "Requires API key. Configure via env OPENAI_API_KEY." }).passed).toBe(true);
    expect(hardFilter({ ...base, description: "需要 token，支持 oauth 登录配置" }).passed).toBe(true);
  });
  it("R1 无鉴权诉求 → 过", () => {
    expect(hardFilter({ ...base, description: "Local filesystem access server" }).passed).toBe(true);
    expect(hardFilter({ ...base, description: "纯本地计算，无需任何配置" }).passed).toBe(true);
  });
  it("R2 无安装方式且无可执行线索 → 拒", () => {
    expect(hardFilter({ installAvailable: false, securityFlagged: false, description: "A collection of ideas" }).passed).toBe(false);
    expect(hardFilter({ installAvailable: false, securityFlagged: false, description: "概念白皮书" }).passed).toBe(false);
  });
  it("R2 有安装方式 → 过（即使描述平淡）", () => {
    expect(hardFilter({ ...base, description: "Some server" }).passed).toBe(true);
    expect(hardFilter({ installAvailable: false, securityFlagged: false, description: "run with npx foo-server" }).passed).toBe(true);
  });
  it("R3 停滞+安全标记 → 拒（两种标记词）", () => {
    const stale = "2023-01-01T00:00:00Z";
    expect(hardFilter({ installAvailable: true, description: "old server", updatedAt: stale, securityFlagged: true }).passed).toBe(false);
    expect(
      hardFilter({ installAvailable: true, description: "deprecated upstream", updatedAt: stale, securityFlagged: true }).passed,
    ).toBe(false);
  });
  it("R3 新近+安全标记 → 过（交给闸门3展示风险）", () => {
    expect(
      hardFilter({
        installAvailable: true,
        description: "recent",
        updatedAt: new Date().toISOString(),
        securityFlagged: true,
      }).passed,
    ).toBe(true);
  });
  it("R3 停滞但无安全标记 → 过", () => {
    expect(hardFilter({ installAvailable: true, description: "stable old server", updatedAt: "2020-01-01T00:00:00Z", securityFlagged: false }).passed).toBe(true);
  });
  it("无更新时间的 R3 不触发", () => {
    expect(hardFilter({ installAvailable: true, description: "x", securityFlagged: true }).passed).toBe(true);
  });
});

describe("规范名与仓库归属", () => {
  it("canonicalName", () => {
    expect(canonicalName("Filesystem Server")).toBe("filesystem-server");
    expect(canonicalName("  Postman_API ")).toBe("postman-api");
    expect(canonicalName("github-mcp!")).toBe("github-mcp");
  });
  it("repoIdentity 提取 owner/repo", () => {
    expect(repoIdentity("https://github.com/PostmanLabs/postman-mcp-server/")).toBe("postmanlabs/postman-mcp-server");
    expect(repoIdentity("https://github.com/a/b.git")).toBe("a/b");
    expect(repoIdentity(undefined)).toBeUndefined();
    expect(repoIdentity("https://gitlab.com/a/b")).toBeUndefined();
  });
});
