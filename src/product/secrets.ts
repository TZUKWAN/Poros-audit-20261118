import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Store } from "@/core/store.js";
import { z } from "zod";

export const SecretRecordSchema = z.object({ id: z.string().min(1), workspaceId: z.string().min(1), ownerType: z.enum(["connector", "provider"]), ownerId: z.string().min(1), encrypted: z.string().min(1), updatedAt: z.string().datetime({ offset: true }) });
export type SecretRecord = z.infer<typeof SecretRecordSchema>;

export class SecretRepository {
  constructor(private readonly store: Store<SecretRecord>) {}
  async set(workspaceId: string, ownerType: SecretRecord["ownerType"], ownerId: string, secret: string): Promise<void> {
    const now = new Date().toISOString();
    await this.store.set(`${ownerType}:${ownerId}`, { id: `${ownerType}:${ownerId}`, workspaceId, ownerType, ownerId, encrypted: encrypt(secret), updatedAt: now });
  }
  async get(ownerType: SecretRecord["ownerType"], ownerId: string): Promise<string | undefined> {
    const record = await this.store.get(`${ownerType}:${ownerId}`);
    return record ? decrypt(record.encrypted) : undefined;
  }
  async delete(ownerType: SecretRecord["ownerType"], ownerId: string): Promise<boolean> { return await this.store.delete(`${ownerType}:${ownerId}`); }
}

const prefix = "secret:v1:";
function key(): Buffer { return createHash("sha256").update(`${process.env.USERPROFILE ?? process.env.HOME ?? "unknown"}|pi-scenario-secrets`).digest(); }
function encrypt(value: string): string { const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key(), iv); const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return `${prefix}${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${body.toString("base64url")}`; }
function decrypt(value: string): string | undefined { try { if (!value.startsWith(prefix)) return undefined; const [iv, tag, body] = value.slice(prefix.length).split("."); if (!iv || !tag || !body) return undefined; const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url")); decipher.setAuthTag(Buffer.from(tag, "base64url")); return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8"); } catch { return undefined; } }

