import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
await mkdir(".compiler-build", { recursive: true });
await build({
  entryPoints: ["scripts/poros-compiler-entry.ts"],
  outfile: ".compiler-build/compile.cjs",
  bundle: true,
  packages: "external",
  platform: "node",
  target: "node24",
  format: "cjs",
});
