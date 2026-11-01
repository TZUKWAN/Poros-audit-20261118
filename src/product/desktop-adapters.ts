import path from "node:path";
import { z } from "zod";

export const DesktopContextInputSchema = z.object({ kind: z.enum(["local-file", "clipboard", "terminal", "browser", "note"]), origin: z.string().min(1).max(500), label: z.string().min(1).max(160), content: z.string().max(100_000) });
export type DesktopContextInput = z.infer<typeof DesktopContextInputSchema>;

export function validateDesktopContext(input: DesktopContextInput, options: { allowedRoot?: string; allowBrowser?: boolean } = {}): { ok: true } | { ok: false; error: string } {
  const parsed = DesktopContextInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "桌面上下文字段无效" };
  if (parsed.data.kind === "local-file" && options.allowedRoot) {
    const relative = path.relative(path.resolve(options.allowedRoot), path.resolve(parsed.data.origin));
    if (relative.startsWith("..") || path.isAbsolute(relative)) return { ok: false, error: "本地文件不在允许范围内" };
  }
  if (parsed.data.kind === "browser") {
    if (options.allowBrowser === false) return { ok: false, error: "浏览器上下文权限已关闭" };
    try { const url = new URL(parsed.data.origin); if (!["http:", "https:"].includes(url.protocol)) return { ok: false, error: "浏览器上下文只支持 HTTP/HTTPS" }; } catch { return { ok: false, error: "浏览器来源 URL 无效" }; }
  }
  return { ok: true };
}

