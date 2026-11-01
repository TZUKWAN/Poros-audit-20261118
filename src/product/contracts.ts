import { z } from "zod";

const TimestampSchema = z.string().datetime({ offset: true });
const IdSchema = z.string().min(1).max(200);

export const ProductStatusSchema = z.enum(["active", "archived", "deleted"]);
export type ProductStatus = z.infer<typeof ProductStatusSchema>;

export const WorkspaceSchema = z.object({
  schemaVersion: z.literal(1),
  id: IdSchema,
  name: z.string().min(1).max(120),
  status: ProductStatusSchema.default("active"),
  projectIds: z.array(IdSchema).default([]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const ProjectSchema = z.object({
  schemaVersion: z.literal(1),
  id: IdSchema,
  workspaceId: IdSchema,
  name: z.string().min(1).max(120),
  /** Native local folder bound as the project's working directory. */
  rootPath: z.string().min(1).nullable().default(null),
  description: z.string().default(""),
  instructions: z.string().default(""),
  status: ProductStatusSchema.default("active"),
  pinned: z.boolean().default(false),
  providerId: IdSchema.nullable().default(null),
  fileIds: z.array(IdSchema).default([]),
  memoryIds: z.array(IdSchema).default([]),
  scenarioIds: z.array(IdSchema).default([]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Project = z.infer<typeof ProjectSchema>;

export const SessionScopeSchema = z.enum(["workspace", "project"]);
export const SessionProductSchema = z.object({
  schemaVersion: z.literal(1),
  id: IdSchema,
  workspaceId: IdSchema,
  projectId: IdSchema.nullable().default(null),
  scope: SessionScopeSchema.default("workspace"),
  title: z.string().min(1).max(120),
  status: z.enum(["active", "archived", "deleted"]).default("active"),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type SessionProduct = z.infer<typeof SessionProductSchema>;

export const RunStatusSchema = z.enum(["queued", "running", "waiting-approval", "waiting-user", "paused", "succeeded", "failed", "cancelled", "discarded"]);
export const RunProductSchema = z.object({
  schemaVersion: z.literal(1),
  id: IdSchema,
  workspaceId: IdSchema,
  projectId: IdSchema.nullable().default(null),
  sessionId: IdSchema.nullable().default(null),
  mode: z.enum(["work", "build"]),
  scenarioId: IdSchema.nullable().default(null),
  providerId: IdSchema.nullable().default(null),
  model: z.string().min(1),
  status: RunStatusSchema,
  requirement: z.string().min(1),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema.nullable().default(null),
  error: z.string().nullable().default(null),
  durationMs: z.number().int().nonnegative().nullable().default(null),
  tokenCount: z.number().int().nonnegative().nullable().default(null),
  cost: z.number().nonnegative().nullable().default(null),
  retryCount: z.number().int().nonnegative().default(0),
  details: z.record(z.string(), z.unknown()).nullable().default(null),
});
export type RunProduct = z.infer<typeof RunProductSchema>;

export const MemoryScopeSchema = z.enum(["global", "project", "session", "scenario"]);
export const MemoryItemSchema = z.object({
  schemaVersion: z.literal(1),
  id: IdSchema,
  workspaceId: IdSchema,
  projectId: IdSchema.nullable().default(null),
  sessionId: IdSchema.nullable().default(null),
  scenarioId: IdSchema.nullable().default(null),
  scope: MemoryScopeSchema,
  name: z.string().min(1).max(200).default("未命名 Memory"),
  content: z.string().min(1),
  path: z.string().min(1).nullable().default(null),
  sourceType: z.enum(["user", "conversation", "file", "run", "scenario"]),
  sourceId: IdSchema.nullable().default(null),
  enabled: z.boolean().default(true),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type MemoryItem = z.infer<typeof MemoryItemSchema>;

export const ArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  id: IdSchema,
  workspaceId: IdSchema,
  projectId: IdSchema.nullable().default(null),
  sessionId: IdSchema.nullable().default(null),
  runId: IdSchema.nullable().default(null),
  name: z.string().min(1).max(200),
  mediaType: z.string().min(1),
  path: z.string().min(1),
  version: z.number().int().min(1).default(1),
  checksum: z.string().nullable().default(null),
  versions: z.array(z.object({ version: z.number().int().min(1), path: z.string().min(1), checksum: z.string().nullable(), content: z.string().optional(), createdAt: TimestampSchema })).default([]),
  status: z.enum(["draft", "ready", "failed", "deleted"]).default("draft"),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const ConnectorSchema = z.object({
  schemaVersion: z.literal(1),
  id: IdSchema,
  workspaceId: IdSchema,
  name: z.string().min(1).max(120),
  kind: z.enum(["mcp-local", "mcp-remote", "cli", "http", "skill"]),
  status: z.enum(["enabled", "disabled", "error"]).default("disabled"),
  endpoint: z.string().nullable().default(null),
  permissionScopes: z.array(z.enum(["read", "write", "install", "network", "send"])).default([]),
  hasSecret: z.boolean().default(false),
  source: z.enum(["user", "catalog", "imported", "host"]).default("user"),
  trustStatus: z.enum(["unverified", "verified", "warning", "blocked"]).default("unverified"),
  trustScore: z.number().min(0).max(1).default(0),
  trustEvidence: z.array(z.object({ kind: z.enum(["healthcheck", "official", "manual", "manifest"]), ref: z.string().max(1000), summary: z.string().max(500), verifiedAt: TimestampSchema })).default([]),
  lastHealthAt: TimestampSchema.nullable().default(null),
  lastError: z.string().nullable().default(null),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Connector = z.infer<typeof ConnectorSchema>;

export const ProviderProfileSchema = z.object({
  schemaVersion: z.literal(1),
  id: IdSchema,
  workspaceId: IdSchema,
  name: z.string().min(1).max(120),
  kind: z.enum(["openai-compatible", "anthropic", "openrouter", "local"]),
  baseUrl: z.string().url(),
  model: z.string().min(1),
  enabled: z.boolean().default(true),
  hasSecret: z.boolean().default(false),
  timeoutMs: z.number().int().min(1_000).max(180_000).default(45_000),
  contextLength: z.number().int().positive().nullable().default(null),
  supportsTools: z.boolean().default(true),
  supportsVision: z.boolean().default(false),
  supportsStructuredOutput: z.boolean().default(true),
  costPerMillion: z.number().nonnegative().nullable().default(null),
  rateLimit: z.number().int().positive().nullable().default(null),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type ProviderProfile = z.infer<typeof ProviderProfileSchema>;

export const ScheduledTaskSchema = z.object({
  schemaVersion: z.literal(1),
  id: IdSchema,
  workspaceId: IdSchema,
  projectId: IdSchema.nullable().default(null),
  scenarioId: IdSchema.nullable().default(null),
  requirement: z.string().min(1),
  schedule: z.string().min(1),
  enabled: z.boolean().default(true),
  lastRunId: IdSchema.nullable().default(null),
  lastRunAt: TimestampSchema.nullable().default(null),
  lastRunStatus: z.enum(["succeeded", "failed", "cancelled", "timeout"]).nullable().default(null),
  lastError: z.string().nullable().default(null),
  failureCount: z.number().int().nonnegative().default(0),
  runCount: z.number().int().nonnegative().default(0),
  maxRuns: z.number().int().positive().nullable().default(null),
  timeoutMs: z.number().int().min(1_000).max(180_000).default(120_000),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type ScheduledTask = z.infer<typeof ScheduledTaskSchema>;

/**
 * 持久化长程场景运行状态。
 *
 * Long runs are deliberately separate from ordinary RunProduct rows: a run
 * represents one worker execution, while this record represents the durable
 * multi-round control plane. `nextRound` is the first round that has not been
 * committed, so resuming never replays a committed round by accident.
 */
export const LongRunStatusSchema = z.enum(["queued", "running", "waiting-user", "paused", "succeeded", "failed", "cancelled"]);
export const LongRunTerminalReasonSchema = z.enum(["goal-met", "max-rounds", "stopped", "cancelled"]).nullable();
export const LongRunSchema = z.object({
  schemaVersion: z.literal(1),
  id: IdSchema,
  workspaceId: IdSchema,
  projectId: IdSchema.nullable().default(null),
  sessionId: IdSchema.nullable().default(null),
  scenarioId: IdSchema,
  goal: z.string().min(1).max(8_000),
  slots: z.record(z.string(), z.string()).default({}),
  /** Durable clarification card. A restarted panel must not guess these inputs. */
  awaitingUser: z.object({
    question: z.string().min(1).max(8_000),
    inputs: z.array(z.object({ name: z.string().min(1).max(80), description: z.string().max(300), type: z.enum(["string", "path", "url", "number"]) })).min(1).max(20),
  }).nullable().default(null),
  maxRounds: z.number().int().min(1).max(50),
  nextRound: z.number().int().min(1).max(51),
  completedRounds: z.number().int().min(0).max(50).default(0),
  status: LongRunStatusSchema,
  terminalReason: LongRunTerminalReasonSchema.default(null),
  nextInstruction: z.string().max(8_000).nullable().default(null),
  /** Result committed before goalCheck/roundGate; allows restart-safe review. */
  pendingRound: z.number().int().min(1).max(50).nullable().default(null),
  pendingResult: z.object({
    round: z.number().int().min(1).max(50),
    summary: z.string().max(20_000),
    goalMet: z.boolean(),
    metrics: z.record(z.string(), z.number().finite()),
  }).nullable().default(null),
  lastRound: z.number().int().min(1).max(50).nullable().default(null),
  lastSummary: z.string().max(20_000).nullable().default(null),
  lastMetrics: z.record(z.string(), z.number().finite()).default({}),
  lastError: z.string().max(2_000).nullable().default(null),
  pauseRequested: z.boolean().default(false),
  revision: z.number().int().nonnegative().default(0),
  startedAt: TimestampSchema.nullable().default(null),
  finishedAt: TimestampSchema.nullable().default(null),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type LongRun = z.infer<typeof LongRunSchema>;

export const ProductModelSchemas = {
  workspace: WorkspaceSchema,
  project: ProjectSchema,
  session: SessionProductSchema,
  run: RunProductSchema,
  memory: MemoryItemSchema,
  artifact: ArtifactSchema,
  connector: ConnectorSchema,
  provider: ProviderProfileSchema,
  scheduledTask: ScheduledTaskSchema,
  longRun: LongRunSchema,
} as const;
