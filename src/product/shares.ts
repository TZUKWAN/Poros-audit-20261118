import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { Store } from "@/core/store.js";

// R1 审计#15：分享 token 只存哈希（sha256），原 token 仅在 create 时返回给
// 调用方一次。泄漏数据目录/备份无法还原有效分享链接。
export const ShareLinkSchema = z.object({ id: z.string().min(1), workspaceId: z.string().min(1), resourceType: z.enum(["workspace", "project", "scenario", "artifact"]), resourceId: z.string().min(1), role: z.enum(["viewer", "user", "editor", "publisher", "admin"]), tokenHash: z.string().min(16), expiresAt: z.string().datetime({ offset: true }).nullable().default(null), createdAt: z.string().datetime({ offset: true }) });
export type ShareLink = z.infer<typeof ShareLinkSchema>;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class ShareLinkRepository {
  constructor(private readonly store: Store<ShareLink>) {}
  async create(params: Omit<ShareLink, "tokenHash" | "createdAt" | "token">): Promise<{ share: ShareLink; token: string }> {
    const token = randomBytes(18).toString("base64url");
    const share = ShareLinkSchema.parse({ ...params, tokenHash: hashToken(token), createdAt: new Date().toISOString() });
    await this.store.set(share.id, share);
    return { share, token };
  }
  async getByToken(token: string): Promise<ShareLink | undefined> {
    const hash = hashToken(token);
    const items = await this.store.entries();
    const value = items.map(([, item]) => ShareLinkSchema.parse(item)).find((item) => item.tokenHash === hash);
    if (!value || (value.expiresAt && Date.parse(value.expiresAt) <= Date.now())) return undefined;
    return value;
  }
  async list(workspaceId: string): Promise<ShareLink[]> { return (await this.store.entries()).map(([, item]) => ShareLinkSchema.parse(item)).filter((item) => item.workspaceId === workspaceId); }
  async delete(id: string): Promise<boolean> { return await this.store.delete(id); }
}
