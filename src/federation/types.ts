import { z } from "zod";

/** 能力种类 */
export const CapabilityKindSchema = z.enum(["mcp-server", "cli-tool", "http-api", "skill-knowledge"]);
export type CapabilityKind = z.infer<typeof CapabilityKindSchema>;

/** 8 个联邦源（1.2 × 5 MCP 源 + 1.3 × 3 技能源） */
export const SourceIdSchema = z.enum([
  "mcp-so",
  "modelcontextprotocol-servers",
  "modelscope",
  "cline-marketplace",
  "awesome-mcp-servers",
  "skills-sh",
  "skillsmp",
  "tencent-skillhub",
  // SceneFlow 领域本地源（ares 竞赛库 / metis 研究脊柱，全部 local:// 无网络）
  "ares-competitions",
  "ares-rubrics",
  "ares-pipeline-skills",
  "metis-spine",
  "metis-engine",
  "metis-adapters",
]);
export type SourceId = z.infer<typeof SourceIdSchema>;

/** 来源档位：官方 / 策展 / 聚合（trust 权重 1.0 / 0.8 / 0.6） */
export const SourceTierSchema = z.enum(["official", "curated", "aggregate"]);
export type SourceTier = z.infer<typeof SourceTierSchema>;

export const SourceSchema = z.object({
  id: SourceIdSchema,
  tier: SourceTierSchema,
  name: z.string(),
  url: z.string().url(),
});
export type Source = z.infer<typeof SourceSchema>;

/** 安装/调用规格（四方式 + 技能上下文注入） */
export const InstallSpecSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("npx"), package: z.string(), args: z.array(z.string()).default([]) }),
  z.object({ type: z.literal("cli"), command: z.string(), args: z.array(z.string()).default([]) }),
  z.object({ type: z.literal("git"), repoUrl: z.string().url(), subdir: z.string().optional() }),
  z.object({ type: z.literal("remote"), url: z.string().url(), transport: z.string().optional() }),
  z.object({ type: z.literal("context"), /** 技能知识：上下文注入，不安装 */ location: z.string() }),
]);
export type InstallSpec = z.infer<typeof InstallSpecSchema>;

/**
 * Explicit host execution contract for CLI/git capabilities.
 *
 * Catalog metadata is untrusted by default, so a capability is never allowed
 * to execute a command merely because `install.type` is `cli` or `git`.
 * A producer must opt in with this bounded contract and the host must still
 * provide a command allow-list and a scoped working directory.
 */
export const HostExecutionInputSchema = z.object({
  flag: z.string().regex(/^--?[A-Za-z0-9][A-Za-z0-9_-]*$/),
  type: z.enum(["string", "number", "boolean"]).default("string"),
  required: z.boolean().default(false),
});

export const HostExecutionSpecSchema = z.object({
  /** Executable basename; paths and shell fragments are rejected. */
  command: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  /** Static argv tokens. They are passed to spawn(shell:false) verbatim. */
  args: z.array(z.string().max(4_000).refine((value) => !value.includes("\u0000"), "NUL is not allowed")).max(64).default([]),
  /** Explicit input-to-argv bindings. Unknown user/model inputs are ignored. */
  inputArgs: z.record(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/), HostExecutionInputSchema).default({}),
  /** Working directory is selected by the host, never by model-provided input. */
  cwd: z.enum(["project", "workspace", "install"]).default("project"),
  timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
  maxOutputBytes: z.number().int().min(1_024).max(1_000_000).default(200_000),
});
export type HostExecutionSpec = z.infer<typeof HostExecutionSpecSchema>;
export type HostExecutionSpecInput = z.input<typeof HostExecutionSpecSchema>;

/** 信任分：来源权重 × 证据分，[0,1] */
export const TrustSchema = z.object({
  score: z.number().min(0).max(1),
  tier: SourceTierSchema,
  evidence: z.object({
    stars: z.number().optional(),
    downloads: z.number().optional(),
    monthsSinceUpdate: z.number().optional(),
    /** 证据分部分（未乘来源权重前），[0,1] */
    evidenceScore: z.number().min(0).max(1),
  }),
  hardFilterPassed: z.boolean(),
});
export type Trust = z.infer<typeof TrustSchema>;

export const CapabilitySchema = z.object({
  /** 全局唯一：`${sourceId}:${slug}`；跨源去重靠规范名+repoUrl（1.4.2） */
  id: z.string().min(1),
  name: z.string().min(1),
  kind: CapabilityKindSchema,
  description: z.string().default(""),
  source: SourceSchema,
  trust: TrustSchema,
  install: InstallSpecSchema,
  /** Optional explicit contract; absent means CLI/git remains delegated. */
  hostExecution: HostExecutionSpecSchema.optional(),
  /** 远程运行标记（1.2 适配器须标注） */
  remoteRun: z
    .object({
      url: z.string(),
      transport: z.string().optional(),
      /** 探活用最小调用描述 */
      probeHint: z.string().optional(),
    })
    .optional(),
  repoUrl: z.string().url().optional(),
  homepage: z.string().url().optional(),
  tags: z.array(z.string()).default([]),
  updatedAt: z.string().optional(),
  stars: z.number().optional(),
  downloads: z.number().optional(),
  /** 需要凭据/鉴权标记 */
  requiresAuth: z.boolean().default(false),
  /** 安全相关标记（deprecated/security/advisory 关键词命中） */
  securityFlagged: z.boolean().default(false),
});
export type Capability = z.infer<typeof CapabilitySchema>;

/** 跨源规范名：小写、去空格连字符，用于去重合并 */
export function canonicalName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** 仓库归属（github.com/owner/repo），用于跨源同仓合并 */
export function repoIdentity(repoUrl?: string): string | undefined {
  if (!repoUrl) return undefined;
  const m = repoUrl.match(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/);
  return m ? `${m[1]}/${m[2]}`.toLowerCase().replace(/\.git$/, "") : undefined;
}

// ── 适配器契约（1.1.2；放本文件避免 base↔types 循环 import）──

/** 单源状态报告 */
export interface SourceStatus {
  source: SourceId;
  ok: boolean;
  /** degraded：部分成功（如限流重试后拿到旧数据/截断结果） */
  degraded: boolean;
  message?: string;
  latencyMs: number;
  count: number;
}

export interface AdapterResult {
  capabilities: Capability[];
  status: SourceStatus;
}

export interface CapabilityQuery {
  text: string;
  limit?: number;
  signal?: AbortSignal;
}

export interface CapabilityAdapter {
  readonly source: Source;
  supports(query: CapabilityQuery): boolean;
  search(query: CapabilityQuery): Promise<AdapterResult>;
}
