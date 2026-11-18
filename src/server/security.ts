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
export function redact(value: unknown, additionalSecrets: readonly string[] = []): unknown {
  const secrets = [
    process.env.JWT_SECRET,
    process.env.POROS_DEEPSEEK_API_KEY,
    process.env.S3_SECRET_KEY,
    process.env.DATABASE_URL,
    ...additionalSecrets,
  ].filter((x): x is string => Boolean(x));
  const clean = (s: string) =>
    secrets
      .reduce((v, key) => v.replaceAll(key, "[REDACTED]"), s)
      .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [REDACTED]")
      .replace(/(?:sk|ctx7sk)-[A-Za-z0-9_-]{12,}/g, "[REDACTED]");
  if (typeof value === "string") return clean(value).slice(0, 16000);
  if (Array.isArray(value))
    return value.slice(0, 100).map((item) => redact(item, additionalSecrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /password|secret|api.?key|authorization|ticket|token/i.test(k) && !/Tokens$/.test(k)
          ? "[REDACTED]"
          : redact(v, additionalSecrets),
      ]),
    );
  return value;
}
