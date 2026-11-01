import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveProjectToolPath } from "@/panel/runtime-path";

describe("runtime project tool path", () => {
  it("allows a new nested write target while keeping it inside the bound root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "runtime-path-"));
    try {
      const target = await resolveProjectToolPath(root, "notes/2026/plan.md", false);
      expect(path.relative(root, target)).toBe(path.join("notes", "2026", "plan.md"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves existing files and rejects traversal or absolute paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "runtime-path-"));
    try {
      await mkdir(path.join(root, "docs"), { recursive: true });
      await writeFile(path.join(root, "docs", "brief.md"), "brief", "utf8");
      expect(await resolveProjectToolPath(root, "docs/brief.md", true)).toBe(path.join(root, "docs", "brief.md"));
      await expect(resolveProjectToolPath(root, "../outside.txt", false)).rejects.toThrow("inside the project root");
      await expect(resolveProjectToolPath(root, path.join(root, "docs", "brief.md"), true)).rejects.toThrow("inside the project root");
      await expect(resolveProjectToolPath(root, "docs/missing.md", true)).rejects.toThrow("does not exist");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

