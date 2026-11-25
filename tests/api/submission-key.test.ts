import { it, expect } from "vitest";
import { submissionKey, forgetSubmission, definiteRejection } from "../../web/src/ide/pending.js";
it("keeps the original source revision and receipt across a retry while persisting no input or credentials", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage"),
    values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  try {
    const signature = JSON.stringify({
        prompt: "private-source-material",
        secret: "explicit-unit-fixture-secret",
      }),
      first = await submissionKey("test:receipt", signature, "a".repeat(64)),
      retry = await submissionKey("test:receipt", signature, "b".repeat(64));
    expect(retry.key).toBe(first.key);
    expect(retry.expectedDigest).toBe("a".repeat(64));
    expect(values.get("test:receipt")).not.toContain("private-source-material");
    expect(values.get("test:receipt")).not.toContain("fixture-secret");
    for (const status of [0, 408, 425, 429, 500, 502, 503, 504])
      expect(definiteRejection(status)).toBe(false);
    for (const status of [400, 401, 403, 404, 409, 413, 422])
      expect(definiteRejection(status)).toBe(true);
    forgetSubmission("test:receipt", first.key);
    expect(values.size).toBe(0);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
