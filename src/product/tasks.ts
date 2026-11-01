import type { Store } from "@/core/store.js";
import { ScheduledTaskSchema, type ScheduledTask } from "./contracts.js";

export class ScheduledTaskRepository {
  constructor(private readonly store: Store<ScheduledTask>) {}

  async list(workspaceId: string): Promise<ScheduledTask[]> {
    return (await this.store.entries())
      .map(([, value]) => ScheduledTaskSchema.parse(value))
      .filter((task) => task.workspaceId === workspaceId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<ScheduledTask | undefined> {
    const value = await this.store.get(id);
    return value ? ScheduledTaskSchema.parse(value) : undefined;
  }

  async create(params: Omit<ScheduledTask, "schemaVersion" | "createdAt" | "updatedAt" | "lastRunStatus" | "lastError" | "failureCount"> & Partial<Pick<ScheduledTask, "lastRunStatus" | "lastError" | "failureCount">>): Promise<ScheduledTask> {
    const now = new Date().toISOString();
    const task = ScheduledTaskSchema.parse({ schemaVersion: 1, ...params, createdAt: now, updatedAt: now });
    await this.store.set(task.id, task);
    return task;
  }

  async update(id: string, patch: Partial<Pick<ScheduledTask, "requirement" | "schedule" | "enabled" | "lastRunId" | "lastRunAt" | "lastRunStatus" | "lastError" | "failureCount" | "runCount" | "maxRuns" | "timeoutMs" | "projectId" | "scenarioId">>): Promise<ScheduledTask> {
    const current = await this.get(id);
    if (!current) throw new Error("scheduled task not found");
    const task = ScheduledTaskSchema.parse({ ...current, ...patch, updatedAt: new Date().toISOString() });
    await this.store.set(id, task);
    return task;
  }

  async delete(id: string): Promise<boolean> { return await this.store.delete(id); }
}
