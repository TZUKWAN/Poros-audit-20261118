import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  source = path.join(root, "src/server/public"),
  target = path.resolve(root, "dist/src/server/public");
if (!target.startsWith(path.join(root, "dist") + path.sep))
  throw new Error("Invalid generated-public target");
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
