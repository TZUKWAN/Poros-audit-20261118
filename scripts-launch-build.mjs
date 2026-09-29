// launcher（node 端）打包：kernel-entry + panel/launch 装配
import { build } from "esbuild";

const result = await build({
  entryPoints: ["src/panel/launch.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "dist/panel-launcher.js",
  external: ["@earendil-works/*", "ws", "pi-*", "context-mode", "typebox"],
  logLevel: "info",
});

if (result.errors.length > 0) process.exit(1);
