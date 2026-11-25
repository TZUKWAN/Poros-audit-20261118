import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProjectStore, sourceDigest, validateFiles } from "../../src/agent-project/files.js";

describe("IDE real source snapshots", () => {
  it("writes checkable immutable files, detects external edits and rejects unsafe project paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "poros-source-"));
    try {
      const store = new ProjectStore(root);
      const files = { "src/agent.ts": "export default () => 42;", "README.md": "Actual source" };
      const digest = await store.save("workspace1", files);
      expect(await readFile(path.join(root, "workspace1", digest, "src/agent.ts"), "utf8")).toBe(
        files["src/agent.ts"],
      );
      expect(await store.read("workspace1", digest, Object.keys(files))).toEqual(files);
      expect(
        sourceDigest({ "README.md": files["README.md"], "src/agent.ts": files["src/agent.ts"] }),
      ).toBe(digest);
      await writeFile(path.join(root, "workspace1", digest, "src/agent.ts"), "external edit");
      await expect(store.read("workspace1", digest, Object.keys(files))).rejects.toThrow(
        "外部变更",
      );
      for (const name of [
        "../escape.ts",
        "C:/secret",
        "a/../../x",
        ".env",
        "src/.git/key",
        "nul",
        "foo\\bar",
      ])
        expect(() => validateFiles({ [name]: "x" })).toThrow();
      expect(() => validateFiles({ "a.ts": "x", "A.ts": "y" })).toThrow("大小写");
      expect(() => validateFiles({ a: "x", "a/b": "y" })).toThrow("冲突");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
