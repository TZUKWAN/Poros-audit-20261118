import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, readFile, writeFile, stat, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;
const powershell = path.join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const docker =
  process.env.POROS_DOCKER_BINARY || (process.platform === "win32" ? "docker.exe" : "docker");
const hashFile = async (file) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
};
const command = (binary, args, options = {}) =>
  new Promise((resolve, reject) => {
    const { signal, timeoutMs, ...spawnOptions } = options;
    signal?.throwIfAborted();
    const child = spawn(binary, args, {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...spawnOptions,
    });
    let stdout = "",
      stderr = "",
      settled = false,
      stopped;
    let termination;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(termination);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(stdout);
    };
    const stop = (message) => {
      if (stopped) return;
      stopped = new Error(message);
      if (process.platform === "win32" && child.pid)
        spawn(
          path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore" },
        );
      else child.kill();
      termination = setTimeout(() => finish(stopped), 5000);
      termination.unref();
    };
    const abort = () => stop("Windows 安装构建已取消");
    const timer = setTimeout(() => stop("Desktop build command timed out"), timeoutMs || 180000);
    timer.unref();
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (data) => {
      stdout = (stdout + data.toString()).slice(-200000);
    });
    child.stderr.on("data", (data) => {
      stderr = (stderr + data.toString()).slice(-10000);
    });
    child.on("error", finish);
    child.on("close", (code) =>
      finish(
        stopped || (code === 0 ? undefined : new Error("Desktop build failed: " + stderr + stdout)),
      ),
    );
  });
export async function buildDesktopPackage(options) {
  if (process.platform !== "win32") throw new Error("Windows 安装包需要 Windows 构建器");
  const run = (binary, args, settings = {}) =>
    command(binary, args, { ...settings, signal: options.signal });
  const { verifyPackage } = await import(
    pathToFileURL(path.join(root, ".app-runtime", "runtime.mjs")).href
  );
  const packageFile = path.resolve(options.packageFile),
    pkg = verifyPackage(JSON.parse(await readFile(packageFile, "utf8")));
  const output = path.resolve(options.outputDirectory || ".desktop-build"),
    stage = path.join(output, "stage-" + pkg.payload.appId),
    artifacts = path.join(output, pkg.payload.appId, pkg.payload.version.slice(0, 16));
  if (!stage.startsWith(output + path.sep) || !artifacts.startsWith(output + path.sep))
    throw new Error("Invalid desktop output path");
  await mkdir(stage, { recursive: true });
  await mkdir(artifacts, { recursive: true });
  const name =
    pkg.payload.name
      .replace(/[^\p{L}\p{N} ._-]/gu, " ")
      .trim()
      .slice(0, 60) || "Agent";
  const image = process.env.POROS_DSH_IMAGE || "poros/dsh:0.2.2-rc.1-audit";
  const [imageInfo] = JSON.parse(await run(docker, ["image", "inspect", image]));
  if (
    !/^sha256:[a-f0-9]{64}$/.test(imageInfo.Id) ||
    imageInfo.Config?.Labels?.["org.poros.bridge-protocol"] !== "3" ||
    imageInfo.Config?.Labels?.["org.poros.dsh-version"] !== "0.2.2-rc.1" ||
    (imageInfo.Config?.Env || []).some((value) =>
      /^(?:[^=]*(?:api.?key|secret|password|token|credential)[^=]*)=/i.test(value),
    )
  )
    throw new Error("运行组件版本、协议或凭证检查失败");
  const cache = path.join(output, "runtime-components");
  await mkdir(cache, { recursive: true });
  const imageArchive = path.join(cache, imageInfo.Id.slice(7) + ".tar");
  const cacheRecord = imageArchive + ".json";
  let cached;
  try {
    cached = JSON.parse(await readFile(cacheRecord, "utf8"));
  } catch {
    /* A partial or old archive is rebuilt. */
  }
  if (
    cached?.id !== imageInfo.Id ||
    !/^[a-f0-9]{64}$/.test(cached?.sha256 || "") ||
    (await hashFile(imageArchive).catch(() => "")) !== cached.sha256
  ) {
    const temporary = imageArchive + ".partial-" + process.pid;
    try {
      await run(docker, ["image", "save", "--output", temporary, imageInfo.Id]);
      const sha256 = await hashFile(temporary);
      await rename(temporary, imageArchive);
      await writeFile(cacheRecord, JSON.stringify({ id: imageInfo.Id, sha256 }));
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  const imageHash = await hashFile(imageArchive),
    meta = {
      appId: pkg.payload.appId,
      productName: name,
      publisher: pkg.fingerprint,
      agentVersion: pkg.payload.version,
      runtimeImage: { id: imageInfo.Id, sha256: imageHash },
    };
  await cp(path.join(root, "desktop", "main.cjs"), path.join(stage, "main.cjs"));
  await writeFile(path.join(stage, "app-meta.json"), JSON.stringify(meta));
  await writeFile(
    path.join(stage, "package.json"),
    JSON.stringify(
      {
        name: pkg.payload.appId.replaceAll(".", "-"),
        productName: name,
        version: "1.0.0",
        main: "main.cjs",
        private: true,
        license: "UNLICENSED",
        author: "Poros",
        description: "Independent Agent application",
      },
      null,
      2,
    ),
  );
  const icon = path.join(stage, "icon.ico");
  await run(powershell, [
    "-NoProfile",
    "-File",
    path.join(root, "scripts", "write-app-icon.ps1"),
    "-Source",
    path.join(root, "src", "server", "public", "icons", "poros-512.png"),
    "-Destination",
    icon,
  ]);
  const config = {
    executableName: pkg.payload.appId,
    appId: pkg.payload.appId,
    productName: name,
    electronVersion: "45.5.0",
    electronDist: path.join(root, "desktop", "node_modules", "electron", "dist"),
    directories: { output: artifacts },
    npmRebuild: false,
    files: ["main.cjs", "app-meta.json", "package.json"],
    extraResources: [
      { from: path.join(root, ".app-runtime"), to: "runtime" },
      { from: packageFile, to: "payload/agent.poros.json" },
      { from: imageArchive, to: "runtime-component.tar" },
      {
        from: path.join(root, "src", "server", "public", "icons", "poros-192.png"),
        to: "poros-icon.png",
      },
    ],
    win: {
      target: [{ target: "nsis", arch: ["x64"] }],
      icon,
      artifactName: pkg.payload.appId + "-Setup-1.0.0.exe",
    },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowElevation: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: false,
      createStartMenuShortcut: true,
      shortcutName: name + " " + pkg.payload.appId.slice(-8),
      uninstallDisplayName: name + " (" + pkg.payload.appId.slice(-8) + ")",
      deleteAppDataOnUninstall: false,
      runAfterFinish: false,
    },
  };
  const configuration = path.join(stage, "builder.json");
  await writeFile(configuration, JSON.stringify(config, null, 2));
  const environment = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" };
  for (const key of Object.keys(environment))
    if (/^(?:WIN_)?CSC_/.test(key) && key !== "CSC_IDENTITY_AUTO_DISCOVERY")
      delete environment[key];
  try {
    const proxy = execFileSync(
      powershell,
      [
        "-NoProfile",
        "-Command",
        "$u=[Uri]'https://github.com';$p=[System.Net.WebRequest]::DefaultWebProxy.GetProxy($u);if($p.AbsoluteUri-ne$u.AbsoluteUri){$p.AbsoluteUri}",
      ],
      { encoding: "utf8", windowsHide: true, timeout: 10000 },
    ).trim();
    if (proxy) {
      environment.HTTPS_PROXY = proxy;
      environment.HTTP_PROXY = proxy;
      environment.NODE_USE_ENV_PROXY = "1";
      environment.NODE_USE_SYSTEM_CA = "1";
    }
  } catch {
    /* Direct connections remain available. */
  }
  const builderArguments = [
    path.join(root, "desktop", "node_modules", "electron-builder", "out", "cli", "cli.js"),
    "--projectDir",
    stage,
    "--config",
    configuration,
    "--win",
    "nsis",
    "--x64",
    "--publish",
    "never",
  ];
  let log = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      log += await run(node, builderArguments, { env: environment, timeoutMs: 300000 });
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Windows can briefly reject writes to a just-copied executable. Repeat
      // the same build with ASAR integrity enabled; other failures remain fatal.
      if (
        attempt === 2 ||
        !message.includes("addWinAsarIntegrity") ||
        !/UNKNOWN: unknown error, open '[^'\r\n]+\.exe'/.test(message)
      )
        throw error;
      log += message + "\nRetrying transient executable write (" + (attempt + 1) + "/2)\n";
      await delay(1000 * (attempt + 1), undefined, { signal: options.signal });
    }
  }
  const installer = path.join(artifacts, pkg.payload.appId + "-Setup-1.0.0.exe"),
    details = await stat(installer),
    sha256 = await hashFile(installer);
  const signatureStatus = (
    await run(powershell, [
      "-NoProfile",
      "-File",
      path.join(root, "scripts", "check-app-signature.ps1"),
      "-File",
      installer,
    ])
  ).trim();
  const result = {
    appId: pkg.payload.appId,
    name,
    version: pkg.payload.version,
    installer,
    sha256,
    bytes: details.size,
    runtimeImageId: imageInfo.Id,
    runtimeImageSha256: imageHash,
    windowsCodeSigned: signatureStatus === "Valid",
    windowsSignatureStatus: signatureStatus,
    log,
  };
  await writeFile(path.join(artifacts, "build-evidence.json"), JSON.stringify(result, null, 2));
  return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2),
    values = new Map();
  for (let index = 0; index < args.length; index += 2) values.set(args[index], args[index + 1]);
  if (!values.get("--package"))
    throw new Error(
      "用法：node scripts/build-desktop.mjs --package 文件.poros.json [--out 输出目录]",
    );
  const result = await buildDesktopPackage({
    packageFile: values.get("--package"),
    outputDirectory: values.get("--out"),
  });
  console.log(JSON.stringify({ ...result, log: undefined }));
}
