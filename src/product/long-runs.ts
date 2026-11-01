import type { Store } from "@/core/store.js";
import { LongRunSchema, type LongRun } from "./contracts.js";

/** Durable repository for multi-round scenario runs. */
export class LongRunRepository {
  constructor(private readonly store: Store<LongRun>) {}

  async get(id: string): Promise<LongRun | undefined> {
    const value = await this.store.get(id);
    return value ? LongRunSchema.parse(value) : undefined;
  }

  async list(workspaceId: string, limit = 100): Promise<LongRun[]> {
    return (await this.store.entries())
      .map(([, value]) => LongRunSchema.parse(value))
      .filter((run) => run.workspaceId === workspaceId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  /** Return every durable long run in a workspace for recovery/ownership checks. */
  async listAll(workspaceId: string): Promise<LongRun[]> {
    return (await this.store.entries())
      .map(([, value]) => LongRunSchema.parse(value))
      .filter((run) => run.workspaceId === workspaceId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async activeForSession(workspaceId: string, sessionId: string): Promise<LongRun | undefined> {
    return (await this.listAll(workspaceId)).find((run) => run.sessionId === sessionId && ["queued", "running", "waiting-user", "paused"].includes(run.status));
  }

  async create(params: Omit<LongRun, "schemaVersion" | "createdAt" | "updatedAt" | "revision" | "awaitingUser"> & Partial<Pick<LongRun, "revision" | "awaitingUser">>): Promise<LongRun> {
    const now = new Date().toISOString();
    const run = LongRunSchema.parse({ schemaVersion: 1, ...params, revision: params.revision ?? 0, createdAt: now, updatedAt: now });
    await this.store.set(run.id, run);
    return run;
  }

  async update(id: string, patch: Partial<Omit<LongRun, "schemaVersion" | "id" | "createdAt" | "updatedAt" | "revision">>, expectedRevision?: number): Promise<LongRun> {
    const current = await this.get(id);
    if (!current) throw new Error("long run not found");
    if (expectedRevision !== undefined && current.revision !== expectedRevision) {
      throw new Error(`long run revision conflict: expected ${expectedRevision}, got ${current.revision}`);
    }
    const next = LongRunSchema.parse({ ...current, ...patch, revision: current.revision + 1, updatedAt: new Date().toISOString() });
    await this.store.set(id, next);
    return next;
  }

  /**
   * A process cannot safely resume a worker callback after it has exited. A
   * running durable record is therefore converted to paused on startup; the
   * committed round remains intact and the caller must explicitly resume it.
   */
  async recoverAfterRestart(workspaceId: string): Promise<LongRun[]> {
    const recovered: LongRun[] = [];
    for (const run of await this.listAll(workspaceId)) {
      if (run.status !== "running") continue;
      recovered.push(await this.update(run.id, {
        status: "paused",
        pauseRequested: false,
        lastError: "面板重启，长程运行已在安全轮次边界暂停；可继续恢复。",
      }, run.revision));
    }
    return recovered;
  }
}

