import { z } from "zod";
import type { Store } from "@/core/store.js";

export const PermissionPolicySchema = z.object({
  id: z.string().min(1), workspaceId: z.string().min(1), read: z.boolean().default(true), write: z.boolean().default(false), install: z.boolean().default(false), network: z.boolean().default(false), send: z.boolean().default(false), approvalMode: z.enum(["ask", "always-allow", "always-deny"]).default("ask"), updatedAt: z.string().datetime({ offset: true }),
});
export type PermissionPolicy = z.infer<typeof PermissionPolicySchema>;

export class PermissionPolicyRepository {
  constructor(private readonly store: Store<PermissionPolicy>) {}
  async get(workspaceId: string): Promise<PermissionPolicy> { const value = await this.store.get(workspaceId); if (value) return PermissionPolicySchema.parse(value); const policy = PermissionPolicySchema.parse({ id: `policy-${workspaceId}`, workspaceId, updatedAt: new Date().toISOString() }); await this.store.set(workspaceId, policy); return policy; }
  async update(workspaceId: string, patch: Partial<Pick<PermissionPolicy, "read" | "write" | "install" | "network" | "send" | "approvalMode">>): Promise<PermissionPolicy> { const current = await this.get(workspaceId); const next = PermissionPolicySchema.parse({ ...current, ...patch, updatedAt: new Date().toISOString() }); await this.store.set(workspaceId, next); return next; }
}

