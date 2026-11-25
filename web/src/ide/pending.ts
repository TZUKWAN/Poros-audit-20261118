/** Persist only an input digest and receipt key. Business inputs and API credentials stay out of this cache. */
interface Receipt {
  digest: string;
  key: string;
  expectedDigest?: string;
}
export async function submissionKey(
  namespace: string,
  signature: string,
  expectedDigest?: string,
): Promise<Receipt> {
  if (!crypto.subtle) throw new Error("请通过 HTTPS 或本机 localhost 打开，以便可靠保存请求回执");
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(signature)),
    digest = Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join(
      "",
    );
  try {
    const raw = localStorage.getItem(namespace),
      saved: Receipt | undefined = raw ? JSON.parse(raw) : undefined;
    if (
      saved?.digest === digest &&
      /^[A-Za-z0-9_-]{16,128}$/.test(saved.key) &&
      (!saved.expectedDigest || /^[a-f0-9]{64}$/.test(saved.expectedDigest))
    )
      return saved;
    const key =
        typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) =>
              value.toString(16).padStart(2, "0"),
            ).join(""),
      next = { digest, key, ...(expectedDigest ? { expectedDigest } : {}) };
    localStorage.setItem(namespace, JSON.stringify(next));
    return next;
  } catch {
    throw new Error("浏览器无法保存请求回执，请允许本站存储后再运行");
  }
}
export function forgetSubmission(namespace: string, key: string) {
  try {
    const saved = JSON.parse(localStorage.getItem(namespace) || "null") as Receipt | null;
    if (saved?.key === key) localStorage.removeItem(namespace);
  } catch {
    /* A later attempt will still use server-side idempotency checks. */
  }
}
export const definiteRejection = (status: number) =>
  status >= 400 && status < 500 && ![408, 425, 429].includes(status);
