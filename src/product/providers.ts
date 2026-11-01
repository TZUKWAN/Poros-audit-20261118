import type { Store } from "@/core/store.js";
import { ProviderProfileSchema, type ProviderProfile } from "./contracts.js";

export type ProviderProfileSummary = Omit<ProviderProfile, "hasSecret"> & { hasSecret: boolean };

export class ProviderProfileRepository {
  constructor(private readonly store: Store<ProviderProfile>) {}

  async list(workspaceId: string): Promise<ProviderProfileSummary[]> {
    return (await this.store.entries())
      .map(([, value]) => ProviderProfileSchema.parse(value))
      .filter((profile) => profile.workspaceId === workspaceId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<ProviderProfile | undefined> {
    const value = await this.store.get(id);
    return value ? ProviderProfileSchema.parse(value) : undefined;
  }

  async create(params: Omit<ProviderProfile, "schemaVersion" | "createdAt" | "updatedAt" | "contextLength" | "supportsTools" | "supportsVision" | "supportsStructuredOutput" | "costPerMillion" | "rateLimit"> & Partial<Pick<ProviderProfile, "contextLength" | "supportsTools" | "supportsVision" | "supportsStructuredOutput" | "costPerMillion" | "rateLimit">>): Promise<ProviderProfile> {
    const now = new Date().toISOString();
    const profile = ProviderProfileSchema.parse({ schemaVersion: 1, ...params, createdAt: now, updatedAt: now });
    await this.store.set(profile.id, profile);
    return profile;
  }

  async update(id: string, patch: Partial<Pick<ProviderProfile, "name" | "baseUrl" | "model" | "enabled" | "timeoutMs" | "hasSecret">>): Promise<ProviderProfile> {
    const current = await this.get(id);
    if (!current) throw new Error("provider profile not found");
    const profile = ProviderProfileSchema.parse({ ...current, ...patch, updatedAt: new Date().toISOString() });
    await this.store.set(id, profile);
    return profile;
  }

  async delete(id: string): Promise<boolean> { return await this.store.delete(id); }
}
