export type Kind = "AGENT" | "SKILL" | "MCP";
export const kindLabel = (kind: string) =>
  (({ AGENT: "Agent", SKILL: "技能", MCP: "MCP 服务" }) as Record<string, string>)[kind] || kind;
export interface Workspace {
  id: string;
  name: string;
  kind: Kind;
  sourceDigest: string;
  latestBuildId: string | null;
  settings: {
    runtimeModel?: "inherit" | "own";
    authorizedTools?: string[];
    enabledSkills?: string[];
  };
  updatedAt: string;
}
export interface IdeEvent {
  seq: number;
  type: string;
  data: unknown;
  at: string;
}
export interface Job {
  id: string;
  kind: string;
  status: string;
  stage: string;
  requestKey: string;
  input: { prompt?: string; input?: unknown; target?: string; tool?: string; consent?: string[] };
  output: {
    installer?: { filename: string; bytes: number; windowsSignatureStatus: string; sha256: string };
    error?: string;
    summary?: string;
    result?: unknown;
    buildId?: string;
    evaluation?: { status: string; cases: unknown[] };
    verification?: string;
  };
  usage: { modelCalls?: number | null; inputTokens?: number | null; outputTokens?: number | null };
  events: IdeEvent[];
  createdAt: string;
}
export interface Build {
  id: string;
  sourceDigest: string;
  status: string;
  diagnostics: string[];
  manifest: {
    name?: string;
    kind?: Kind;
    preview?: string;
    skills?: string[];
    mcp?: Array<{ name: string; entry: string }>;
    permissions?: string[];
  };
  evidence: {
    typecheck?: boolean;
    compiled?: boolean;
    businessVerified?: boolean;
    evaluation?: { status: string; cases: unknown[] };
  };
  createdAt: string;
}
export interface Details {
  workspace: Workspace;
  files: Record<string, string>;
  jobs: Job[];
  builds: Build[];
}
export const activeJob = (job: Job) => ["QUEUED", "RUNNING"].includes(job.status);
export const jobLabel = (status: string) =>
  (
    ({
      QUEUED: "等待执行",
      RUNNING: "正在执行",
      SUCCEEDED: "执行完成",
      FAILED: "执行失败",
      CANCELLED: "已停止",
      INTERRUPTED: "执行中断",
    }) as Record<string, string>
  )[status] || status;
export const pretty = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);
