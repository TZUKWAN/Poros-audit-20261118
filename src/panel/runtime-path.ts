import path from "node:path";
import { realpath } from "node:fs/promises";

/**
 * Resolve a model supplied project-relative path without allowing a lexical
 * or symlink escape from the bound project directory.
 *
 * `mustExist=false` intentionally permits a new file below directories that
 * do not exist yet. The nearest existing ancestor is canonicalised first so
 * an existing symlink cannot redirect a write outside the project root.
 */
export async function resolveProjectToolPath(root: string, value: unknown, mustExist: boolean): Promise<string> {
  if (typeof value !== "string" || !value.trim()) throw new Error("path is required");
  const raw = value.trim().replaceAll("\\", "/");
  if (path.isAbsolute(raw) || raw.split("/").includes("..")) throw new Error("path must stay inside the project root");
  const canonicalRoot = await realpath(root).catch(() => path.resolve(root));
  const lexical = path.resolve(canonicalRoot, raw);
  assertInside(canonicalRoot, lexical);

  let target: string | undefined;
  if (mustExist) {
    target = await realpath(lexical).catch(() => undefined);
  } else {
    let ancestor = path.dirname(lexical);
    while (true) {
      const resolvedAncestor = await realpath(ancestor).catch(() => undefined);
      if (resolvedAncestor) {
        assertInside(canonicalRoot, resolvedAncestor);
        target = path.join(resolvedAncestor, path.relative(ancestor, lexical));
        // If the leaf already exists and is a symlink, canonicalise it too;
        // a write must not follow a leaf link outside the project root.
        const existingLeaf = await realpath(target).catch(() => undefined);
        if (existingLeaf) {
          assertInside(canonicalRoot, existingLeaf);
          target = existingLeaf;
        }
        break;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
  }
  if (!target) throw new Error("path does not exist");
  assertInside(canonicalRoot, target);
  return target;
}

function assertInside(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("path escapes the project root");
}

