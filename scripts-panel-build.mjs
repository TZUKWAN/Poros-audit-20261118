// 面板浏览器端打包：chat-client（pi-web-ui + lit + tailwind css）
// 用 JS API 规避 shell 转义；字体资源 external（包内未随附，仅 KaTeX 公式使用，404 无碍）。
import { build } from "esbuild";
import path from "node:path";

const result = await build({
  entryPoints: ["src/panel/chat-client.ts"],
  bundle: true,
  minify: true,
  format: "esm",
  outfile: "dist/panel-chat.js",
  external: ["*.woff2", "*.woff", "*.ttf"],
  alias: { process: path.resolve("scripts/process-shim.js") },
  logLevel: "info",
});

if (result.errors.length > 0) process.exit(1);
