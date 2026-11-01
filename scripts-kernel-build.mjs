// pi 包内核打包：kernel-entry → pi-package/dist/kernel.js（供 pi 扩展薄层 import）
import { build } from "esbuild";

const result = await build({
  entryPoints: ["src/kernel-entry.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "pi-package/dist/kernel.js",
  external: ["@earendil-works/*", "ws", "pi-*", "context-mode", "typebox"],
  logLevel: "info",
});

if (result.errors.length > 0) process.exit(1);
