import type { Store } from "@/core/store.js";
import { RunProductSchema, type RunProduct } from "./contracts.js";

export interface RunSummary {
  id: string;
  mode: RunProduct["mode"];
  status: RunProduct["status"];
  requirement: string;
  sessionId: string | null;
  scenarioId: string | null;
  model: string;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  durationMs: number | null;
  tokenCount: number | null;
  cost: number | null;
  retryCount: number;
}

export class RunRepository {
  constructor(private readonly store: Store<RunProduct>) {}

  async create(params: Omit<RunProduct, "schemaVersion" | "durationMs" | "tokenCount" | "cost" | "retryCount" | "details"> & Partial<Pick<RunProduct, "durationMs" | "tokenCount" | "cost" | "retryCount" | "details">>): Promise<RunProduct> {
    const run = RunProductSchema.parse({ schemaVersion: 1, ...params });
    await this.store.set(run.id, run);
    return run;
  }

  async get(id: string): Promise<RunProduct | undefined> {
    const value = await this.store.get(id);
    return value ? RunProductSchema.parse(value) : undefined;
  }

  /** Return the newest full run for one conversation without a global limit. */
  async latestForSession(sessionId: string): Promise<RunProduct | undefined> {
    return (await this.store.entries())
      .map(([, value]) => RunProductSchema.parse(value))
      .filter((run) => run.sessionId === sessionId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  }

  /**
   * Return runs owned by one workspace.  The panel is backed by a shared
   * store, so callers that render a workspace view must never use `list()`
   * directly: that method intentionally has no workspace filter for global
   * maintenance and migrations.
   */
  async listForWorkspace(workspaceId: string, limit = 50): Promise<RunSummary[]> {
    return (await this.store.entries())
      .map(([, value]) => RunProductSchema.parse(value))
      .filter((run) => run.workspaceId === workspaceId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit)
      .map((run) => ({ id: run.id, mode: run.mode, status: run.status, requirement: run.requirement, sessionId: run.sessionId, scenarioId: run.scenarioId, model: run.model, startedAt: run.startedAt, finishedAt: run.finishedAt, error: run.error, durationMs: run.durationMs, tokenCount: run.tokenCount, cost: run.cost, retryCount: run.retryCount }));
  }

  /** Return every run owned by one workspace for restart reconciliation. */
  async listAllForWorkspace(workspaceId: string): Promise<RunProduct[]> {
    return (await this.store.entries())
      .map(([, value]) => RunProductSchema.parse(value))
      .filter((run) => run.workspaceId === workspaceId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async update(id: string, patch: Partial<Pick<RunProduct, "status" | "finishedAt" | "error" | "durationMs" | "tokenCount" | "cost" | "retryCount" | "details">>): Promise<RunProduct> {
    const run = await this.get(id);
    if (!run) throw new Error("run not found");
    const updated = RunProductSchema.parse({ ...run, ...patch });
    await this.store.set(id, updated);
    return updated;
  }

  async list(limit = 50): Promise<RunSummary[]> {
    return (await this.store.entries())
      .map(([, value]) => RunProductSchema.parse(value))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit)
      .map((run) => ({ id: run.id, mode: run.mode, status: run.status, requirement: run.requirement, sessionId: run.sessionId, scenarioId: run.scenarioId, model: run.model, startedAt: run.startedAt, finishedAt: run.finishedAt, error: run.error, durationMs: run.durationMs, tokenCount: run.tokenCount, cost: run.cost, retryCount: run.retryCount }));
  }
}
