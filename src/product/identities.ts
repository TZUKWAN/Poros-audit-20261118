import { createHash, randomBytes } from "node:crypto";
import type { Store } from "@/core/store.js";
import { z } from "zod";

export const IdentityRoleSchema = z.enum(["viewer", "user", "editor", "publisher", "admin"]);
export const IdentitySchema = z.object({ id: z.string().min(1), workspaceId: z.string().min(1), displayName: z.string().min(1).max(120), role: IdentityRoleSchema, status: z.enum(["active", "revoked"]).default("active"), tokenHash: z.string().min(1), createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }) });
export type Identity = z.infer<typeof IdentitySchema>;

export class IdentityRepository {
  constructor(private readonly store: Store<Identity>) {}

  async create(params: Omit<Identity, "tokenHash" | "createdAt" | "updatedAt" | "status">): Promise<{ identity: Identity; token: string }> {
    const token = `id_${randomBytes(24).toString("base64url")}`;
    const now = new Date().toISOString();
    const identity = IdentitySchema.parse({ ...params, status: "active", tokenHash: hash(token), createdAt: now, updatedAt: now });
    await this.store.set(identity.id, identity);
    return { identity, token };
  }

  async list(workspaceId: string): Promise<Array<Omit<Identity, "tokenHash">>> {
    return (await this.store.entries()).map(([, value]) => IdentitySchema.parse(value)).filter((identity) => identity.workspaceId === workspaceId).map(({ tokenHash: _tokenHash, ...identity }) => identity);
  }

  async authenticate(workspaceId: string, token: string): Promise<Identity | undefined> {
    const wanted = hash(token);
    for (const [, raw] of await this.store.entries()) { const identity = IdentitySchema.parse(raw); if (identity.workspaceId === workspaceId && identity.status === "active" && identity.tokenHash === wanted) return identity; }
    return undefined;
  }

  async update(id: string, patch: Partial<Pick<Identity, "displayName" | "role" | "status">>): Promise<Identity> { const current = await this.store.get(id); if (!current) throw new Error("identity not found"); const identity = IdentitySchema.parse({ ...current, ...patch, updatedAt: new Date().toISOString() }); await this.store.set(id, identity); return identity; }
  async revoke(id: string): Promise<Identity> { return await this.update(id, { status: "revoked" }); }
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

