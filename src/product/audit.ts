import { z } from "zod";
import type { Store } from "@/core/store.js";

export const AuditRecordSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  actor: z.string().min(1).max(80).default("user"),
  action: z.string().min(1).max(120),
  resourceType: z.string().min(1).max(80),
  resourceId: z.string().min(1).max(200),
  summary: z.string().min(1).max(500),
  details: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string().datetime({ offset: true }),
});
export type AuditRecord = z.infer<typeof AuditRecordSchema>;

export class AuditRepository {
  constructor(private readonly store: Store<AuditRecord>) {}
  async append(params: Omit<AuditRecord, "createdAt">): Promise<AuditRecord> {
    const record = AuditRecordSchema.parse({ ...params, createdAt: new Date().toISOString() });
    await this.store.set(record.id, record);
    return record;
  }
  async list(workspaceId: string, limit = 100): Promise<AuditRecord[]> {
    return (await this.store.entries())
      .map(([, value]) => AuditRecordSchema.parse(value))
      .filter((entry) => entry.workspaceId === workspaceId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }
}

