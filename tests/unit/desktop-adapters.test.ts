import { describe, expect, it } from "vitest";
import { validateDesktopContext } from "@/product/desktop-adapters";

describe("桌面上下文适配器边界", () => {
  it("限制本地文件安全范围并校验浏览器来源", () => {
    const allowed = validateDesktopContext({ kind: "local-file", origin: "C:/workspace/a.md", label: "a", content: "x" }, { allowedRoot: "C:/workspace" });
    expect(allowed.ok).toBe(true);
    const denied = validateDesktopContext({ kind: "local-file", origin: "C:/secret/a.md", label: "a", content: "x" }, { allowedRoot: "C:/workspace" });
    expect(denied.ok).toBe(false);
    expect(validateDesktopContext({ kind: "browser", origin: "file:///secret", label: "page", content: "x" }).ok).toBe(false);
  });
});

