import type { Store } from "@/core/store.js";
import { MemoryItemSchema, type MemoryItem } from "./contracts.js";

export class MemoryRepository {
  constructor(private readonly store: Store<MemoryItem>) {}

  async list(workspaceId: string, scope?: MemoryItem["scope"]): Promise<MemoryItem[]> {
    return (await this.store.entries())
      .map(([, value]) => MemoryItemSchema.parse(value))
      .filter((item) => item.workspaceId === workspaceId && (scope ? item.scope === scope : true))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /**
   * Return the memories that belong to one active execution context.
   *
   * Workspace memories are intentionally visible everywhere in that
   * workspace. Project, session and scenario memories require an exact owner;
   * treating a missing owner as a wildcard would make a scoped item leak into
   * another project after navigation.
   */
  async listVisible(workspaceId: string, params: { projectId?: string | null; sessionId?: string | null; scenarioId?: string | null } = {}): Promise<MemoryItem[]> {
    const projectId = params.projectId ?? null;
    const sessionId = params.sessionId ?? null;
    const scenarioId = params.scenarioId ?? null;
    return (await this.list(workspaceId)).filter((item) => {
      if (item.scope === "global") return true;
      if (item.scope === "project") return Boolean(projectId && item.projectId === projectId);
      if (item.scope === "session") return Boolean(sessionId && item.sessionId === sessionId && (!item.projectId || item.projectId === projectId));
      if (item.scope === "scenario") return Boolean(scenarioId && item.scenarioId === scenarioId && (!item.projectId || item.projectId === projectId));
      return false;
    });
  }

  async get(id: string): Promise<MemoryItem | undefined> {
    const value = await this.store.get(id);
    return value ? MemoryItemSchema.parse(value) : undefined;
  }

  async create(params: Omit<MemoryItem, "schemaVersion" | "createdAt" | "updatedAt">): Promise<MemoryItem> {
    const now = new Date().toISOString();
    const item = MemoryItemSchema.parse({ schemaVersion: 1, ...params, createdAt: now, updatedAt: now });
    await this.store.set(item.id, item);
    return item;
  }

  async upsert(item: MemoryItem): Promise<MemoryItem> {
    const parsed = MemoryItemSchema.parse(item);
    await this.store.set(parsed.id, parsed);
    return parsed;
  }

  async update(id: string, patch: Partial<Pick<MemoryItem, "name" | "content" | "enabled" | "path">>): Promise<MemoryItem> {
    const current = await this.get(id);
    if (!current) throw new Error("memory item not found");
    const item = MemoryItemSchema.parse({ ...current, ...patch, updatedAt: new Date().toISOString() });
    await this.store.set(id, item);
    return item;
  }

  async delete(id: string): Promise<boolean> { return await this.store.delete(id); }

  async search(workspaceId: string, keyword: string): Promise<MemoryItem[]> {
    const needle = keyword.trim().toLowerCase();
    if (!needle) return [];
    return (await this.list(workspaceId)).filter((item) => `${item.name}\n${item.content}`.toLowerCase().includes(needle));
  }
}
