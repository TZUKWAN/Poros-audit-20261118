export function redact(
  value: unknown,
  additionalSecrets: readonly string[] = [],
  maxStringLength = 16000,
  maxArrayLength = 100,
): unknown {
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
  if (typeof value === "string") return clean(value).slice(0, maxStringLength);
  if (Array.isArray(value))
    return value
      .slice(0, maxArrayLength)
      .map((item) => redact(item, additionalSecrets, maxStringLength, maxArrayLength));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /password|secret|api.?key|authorization|ticket|token/i.test(k) && !/Tokens$/.test(k)
          ? "[REDACTED]"
          : redact(v, additionalSecrets, maxStringLength, maxArrayLength),
      ]),
    );
  return value;
}
