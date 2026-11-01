import { z } from "zod";
import type { Store } from "@/core/store.js";

export const DesktopContextSchema = z.object({
  id: z.string().min(1), workspaceId: z.string().min(1), projectId: z.string().nullable().default(null), kind: z.enum(["local-file", "clipboard", "terminal", "browser", "note"]), origin: z.string().min(1).max(500), label: z.string().min(1).max(160), content: z.string().max(100_000), enabled: z.boolean().default(true), createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }),
});
export type DesktopContext = z.infer<typeof DesktopContextSchema>;

export class DesktopContextRepository {
  constructor(private readonly store: Store<DesktopContext>) {}
  async list(workspaceId: string, projectId?: string | null): Promise<DesktopContext[]> { return (await this.store.entries()).map(([, value]) => DesktopContextSchema.parse(value)).filter((item) => item.workspaceId === workspaceId && (projectId === undefined || item.projectId === projectId)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  async get(id: string): Promise<DesktopContext | undefined> { const value = await this.store.get(id); return value ? DesktopContextSchema.parse(value) : undefined; }
  async create(params: Omit<DesktopContext, "createdAt" | "updatedAt">): Promise<DesktopContext> { const now = new Date().toISOString(); const context = DesktopContextSchema.parse({ ...params, createdAt: now, updatedAt: now }); await this.store.set(context.id, context); return context; }
  async update(id: string, patch: Partial<Pick<DesktopContext, "label" | "content" | "enabled">>): Promise<DesktopContext> { const current = await this.get(id); if (!current) throw new Error("context not found"); const context = DesktopContextSchema.parse({ ...current, ...patch, updatedAt: new Date().toISOString() }); await this.store.set(id, context); return context; }
  async delete(id: string): Promise<boolean> { return await this.store.delete(id); }
}

