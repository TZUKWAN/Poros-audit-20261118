import { z } from "zod";
import type { Store } from "@/core/store.js";

export const CommentSchema = z.object({ id: z.string().min(1), workspaceId: z.string().min(1), resourceType: z.enum(["run", "scenario", "artifact", "project"]), resourceId: z.string().min(1), author: z.string().min(1).max(80), body: z.string().min(1).max(10_000), resolved: z.boolean().default(false), createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }) });
export type Comment = z.infer<typeof CommentSchema>;

export class CommentRepository {
  constructor(private readonly store: Store<Comment>) {}
  async list(workspaceId: string, resourceType?: Comment["resourceType"], resourceId?: string): Promise<Comment[]> { return (await this.store.entries()).map(([, value]) => CommentSchema.parse(value)).filter((comment) => comment.workspaceId === workspaceId && (!resourceType || comment.resourceType === resourceType) && (!resourceId || comment.resourceId === resourceId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }
  async create(params: Omit<Comment, "createdAt" | "updatedAt">): Promise<Comment> { const now = new Date().toISOString(); const comment = CommentSchema.parse({ ...params, createdAt: now, updatedAt: now }); await this.store.set(comment.id, comment); return comment; }
  async resolve(id: string, resolved: boolean): Promise<Comment> { const current = await this.store.get(id); if (!current) throw new Error("comment not found"); const comment = CommentSchema.parse({ ...current, resolved, updatedAt: new Date().toISOString() }); await this.store.set(id, comment); return comment; }
}

