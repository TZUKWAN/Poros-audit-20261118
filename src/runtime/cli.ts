import { readFile } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { verifyPackage, type AppPackage } from "../agent-project/package.js";
import { buildRuntime } from "./app.js";
export { buildRuntime } from "./app.js";
export { verifyPackage } from "../agent-project/package.js";
export { prepareFreeEngine } from "./free-engine.js";
export { ensureRuntimeImage } from "./environment.js";
export async function launchApp(options: {
  packageFile?: string;
  directory?: string;
  port?: number;
  publicDirectory: string;
}) {
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  if (major !== 24 || minor! < 22 || (minor === 22 && patch! < 3))
    throw new Error("独立运行端需要 Node 24.22.3 或更新的 24.x 安全版本");
  let pkg: AppPackage | undefined;
  if (options.packageFile) {
    const raw = JSON.parse(await readFile(options.packageFile, "utf8"));
    const checked = verifyPackage(raw);
    pkg = { payload: checked.payload, publisher: checked.publisher, signature: checked.signature };
  }
  const directory =
    options.directory ||
    (pkg
      ? path.join(
          process.env.LOCALAPPDATA || path.join(homedir(), ".local", "share"),
          "PorosApps",
          pkg.payload.appId,
        )
      : undefined);
  if (!directory) throw new Error("首次启动需要 --package；已有安装可通过 --data 打开");
  const runtime = await buildRuntime({
    directory,
    package: pkg,
    publicDirectory: options.publicDirectory,
  });
  try {
    const address = await runtime.app.listen({ host: "127.0.0.1", port: options.port ?? 0 });
    return { ...runtime, address, ownerUrl: address + "/#/bootstrap/" + runtime.bootstrap() };
  } catch (error) {
    await runtime.app.close();
    throw error;
  }
}
async function main() {
  const args = process.argv.slice(2),
    values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index],
      value = args[index + 1];
    if (!["--package", "--data", "--port", "--public"].includes(name || "") || !value)
      throw new Error(
        "用法：poros-app --package 文件.poros.json [--data 安装目录] [--port 端口] [--public 界面目录]",
      );
    values.set(name!, value);
  }
  const port = values.has("--port") ? Number(values.get("--port")) : 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("端口无效");
  const runtime = await launchApp({
    packageFile: values.get("--package"),
    directory: values.get("--data"),
    port,
    publicDirectory:
      values.get("--public") || path.join(path.dirname(fileURLToPath(import.meta.url)), "public"),
  });
  process.stdout.write(
    JSON.stringify({
      type: "poros.app.ready",
      address: runtime.address,
      ownerUrl: runtime.ownerUrl,
      appId: runtime.store.package().payload.appId,
    }) + "\n",
  );
  const stop = async () => {
    await runtime.app.close();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : "独立软件启动失败");
    process.exitCode = 1;
  });
