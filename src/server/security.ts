import { createHash } from "node:crypto";
import { getDb } from "./db.js";
import { ApiError } from "./errors.js";
/** Shared PostgreSQL rate limit: multi-worker/multi-instance atomic window. */
export async function consumeLimit(key: string, limit: number, windowMs: number): Promise<void> {
  const id = createHash("sha256").update(key).digest("hex");
  const rows = await getDb().$queryRaw<
    Array<{ count: number }>
  >`INSERT INTO "RateLimitBucket" (id,count,"resetAt") VALUES (${id},1,now()+${windowMs}*interval '1 millisecond') ON CONFLICT (id) DO UPDATE SET count=CASE WHEN "RateLimitBucket"."resetAt"<now() THEN 1 ELSE "RateLimitBucket".count+1 END,"resetAt"=CASE WHEN "RateLimitBucket"."resetAt"<now() THEN EXCLUDED."resetAt" ELSE "RateLimitBucket"."resetAt" END RETURNING count`;
  if ((rows[0]?.count ?? limit + 1) > limit) throw new ApiError(429, "操作过于频繁，请稍后重试");
}
export { redact } from "./redact.js";
