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
      // R1 审计#14：启动窗口可能与调度器首个 tick / WS 动作并发，乐观锁
      // 冲突需重读重试（3 次），否则一次冲突即阻塞整个面板恢复流程。
      let done = false;
      let last: LongRun | undefined = run;
      for (let attempt = 0; attempt < 3 && !done; attempt += 1) {
        try {
          recovered.push(await this.update(last!.id, {
            status: "paused",
            pauseRequested: false,
            lastError: "面板重启，长程运行已在安全轮次边界暂停；可继续恢复。",
          }, last!.revision));
          done = true;
        } catch {
          last = await this.get(run.id).catch(() => undefined);
          if (!last || last.status !== "running") done = true; // 已被并发路径处理或终态
        }
      }
    }
    return recovered;
  }
}

