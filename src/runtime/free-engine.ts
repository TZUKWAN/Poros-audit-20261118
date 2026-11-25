import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { hostCommand, systemBinary } from "./host-process.js";
import { trustedDownload } from "./trusted-download.js";
const ROOTFS = {
  version: "3.24.4",
  branch: "v3.24",
  sha256: "cdaa38cb8de3537967ee5b6c9b6cd00cc962da2b018e6eea48696bb274923012",
};
type Ledger = {
  format: 1;
  distro: string;
  directory: string;
  token: string;
  ready: boolean;
  packages?: string[];
};
export async function prepareFreeEngine(options: {
  directory: string;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}) {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("自动免费环境当前支持 Windows x64 + WSL2");
  const directory = path.resolve(options.directory),
    ledgerFile = path.join(directory, "engine.json"),
    wsl = systemBinary("wsl.exe");
  const progress = (message: string) => options.onProgress?.(message);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) throw new Error("运行环境目录不能是链接");
  const run = (
    args: string[],
    input?: string | ReturnType<typeof createReadStream>,
    timeoutMs = 60000,
  ) => hostCommand(wsl, args, { input, timeoutMs, signal: options.signal });
  const inventory = () =>
    hostCommand(wsl, ["--list", "--quiet"], { encoding: "utf16le", signal: options.signal }).then(
      (value) =>
        value
          .replaceAll("\0", "")
          .split(/\r?\n/)
          .map((item) => item.trim())
          .filter(Boolean),
    );
  let ledger: Ledger;
  try {
    ledger = JSON.parse(await readFile(ledgerFile, "utf8")) as Ledger;
    if (
      ledger.format !== 1 ||
      ledger.directory !== directory ||
      !/^PorosRuntime-[a-f0-9]{16}$/.test(ledger.distro) ||
      !/^[a-f0-9-]{36}$/.test(ledger.token)
    )
      throw new Error("运行环境归属记录无效");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    ledger = {
      format: 1,
      directory,
      distro:
        "PorosRuntime-" +
        createHash("sha256").update(directory.toLowerCase()).digest("hex").slice(0, 16),
      token: randomUUID(),
      ready: false,
    };
    if ((await inventory()).includes(ledger.distro)) throw new Error("同名 WSL 环境已存在，未修改");
    await writeFile(ledgerFile, JSON.stringify(ledger), { flag: "wx", mode: 0o600 });
  }
  const guest = (
    args: string[],
    input?: string | ReturnType<typeof createReadStream>,
    timeoutMs = 60000,
  ) =>
    run(
      [
        "--distribution",
        ledger.distro,
        "--user",
        "root",
        "--exec",
        "/bin/sh",
        "-c",
        'export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; exec "$@"',
        "sh",
        ...args,
      ],
      input,
      timeoutMs,
    );
  if (!(await inventory()).includes(ledger.distro)) {
    if (ledger.ready) throw new Error("已登记的运行环境被移除，请修复环境后重试");
    progress("下载并校验官方 Alpine Linux（约 4 MB）");
    const archive = path.join(directory, "alpine-" + ROOTFS.version + ".tar.gz");
    await trustedDownload(
      "https://dl-cdn.alpinelinux.org/alpine/" +
        ROOTFS.branch +
        "/releases/x86_64/alpine-minirootfs-" +
        ROOTFS.version +
        "-x86_64.tar.gz",
      archive,
      ROOTFS.sha256,
      options.signal,
    );
    await run(
      ["--import", ledger.distro, path.join(directory, "linux"), archive, "--version", "2"],
      undefined,
      120000,
    );
    await guest(["sh", "-c", "mkdir -p /opt/poros; cat > /opt/poros/owner"], ledger.token);
    await guest(
      ["sh", "-c", "cat > /etc/wsl.conf"],
      "[automount]\nenabled=false\n[interop]\nenabled=false\nappendWindowsPath=false\n",
    );
    await run(["--terminate", ledger.distro]);
  }
  if ((await guest(["cat", "/opt/poros/owner"])).trim() !== ledger.token)
    throw new Error("WSL 运行环境归属检查失败");
  if (!ledger.ready) {
    progress("准备签名验证的免费 Linux Engine 组件");
    // Download on Windows to respect its system proxy. apk verifies the official signed indexes and packages in WSL.
    for (const repository of ["main", "community"]) {
      const folder = path.join(directory, "downloads", repository);
      await mkdir(folder, { recursive: true });
      const index = path.join(folder, "APKINDEX.tar.gz");
      await trustedDownload(
        "https://dl-cdn.alpinelinux.org/alpine/" +
          ROOTFS.branch +
          "/" +
          repository +
          "/x86_64/APKINDEX.tar.gz",
        index,
        undefined,
        options.signal,
      );
      await guest(["mkdir", "-p", "/opt/poros/repo/" + repository + "/x86_64"]);
      await guest(
        [
          "sh",
          "-c",
          'cat > "$1"',
          "sh",
          "/opt/poros/repo/" + repository + "/x86_64" + "/APKINDEX.tar.gz",
        ],
        createReadStream(index),
      );
    }
    await guest(
      ["sh", "-c", "cat > /etc/apk/repositories"],
      "/opt/poros/repo/main\n/opt/poros/repo/community\n",
    );
    await guest(["apk", "update"]);
    const urls = (
      await guest(["apk", "fetch", "--simulate", "--recursive", "--url", "docker-engine", "socat"])
    )
      .split(/\r?\n/)
      .filter((item) => item.includes(".apk"))
      .map((item) => item.trim());
    for (const localUrl of urls) {
      const match = /(?:^|\/)repo\/(main|community)\/x86_64\/([A-Za-z0-9+_.-]+\.apk)$/.exec(
        localUrl,
      );
      if (!match) throw new Error("无法解析已签名的组件目录: " + localUrl);
      const [, repository, name] = match,
        file = path.join(directory, "downloads", repository!, name!);
      progress("校验并准备组件：" + name);
      await trustedDownload(
        "https://dl-cdn.alpinelinux.org/alpine/" +
          ROOTFS.branch +
          "/" +
          repository +
          "/x86_64/" +
          name,
        file,
        undefined,
        options.signal,
      );
      await guest(
        ["sh", "-c", 'cat > "$1"', "sh", "/opt/poros/repo/" + repository + "/x86_64" + "/" + name],
        createReadStream(file),
      );
    }
    const install = await guest(
      ["apk", "add", "--no-network", "docker-engine", "socat"],
      undefined,
      120000,
    );
    ledger.packages = install.split(/\r?\n/).filter((line) => line.includes("Installing "));
    ledger.ready = true;
    await writeFile(ledgerFile, JSON.stringify(ledger), { mode: 0o600 });
  }
  await guest(
    ["sh", "-c", "cat > /opt/poros/start-engine"],
    [
      "#!/bin/sh",
      "set -eu",
      "if [ -S /var/run/docker.sock ] && printf 'GET /_ping HTTP/1.0\\r\\n\\r\\n' | socat - UNIX-CONNECT:/var/run/docker.sock 2>/dev/null | grep -q OK; then exit 0; fi",
      "mkdir -p /var/log",
      "nohup dockerd --host=unix:///var/run/docker.sock --bridge=none --iptables=false --ip-forward=false > /var/log/poros-engine.log 2>&1 < /dev/null &",
      "for attempt in $(seq 1 100); do if [ -S /var/run/docker.sock ] && printf 'GET /_ping HTTP/1.0\\r\\n\\r\\n' | socat - UNIX-CONNECT:/var/run/docker.sock 2>/dev/null | grep -q OK; then exit 0; fi; sleep 0.3; done",
      "tail -30 /var/log/poros-engine.log; exit 1",
      "",
    ].join("\n"),
  );
  progress("启动隔离运行环境");
  await guest(["sh", "/opt/poros/start-engine"]);
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const value = await guest(
        [
          "sh",
          "-c",
          "printf 'GET /_ping HTTP/1.0\r\n\r\n' | socat - UNIX-CONNECT:/var/run/docker.sock",
        ],
        undefined,
        5000,
      );
      if (value.endsWith("OK")) {
        ready = true;
        break;
      }
    } catch {
      /* Bounded initialization wait; no global WSL changes. */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (!ready)
    throw new Error(
      "Linux Engine 未启动: " +
        (await guest(["tail", "-30", "/var/log/poros-engine.log"])).slice(-2500),
    );
  const pipe = "\\\\.\\pipe\\poros-engine-" + randomUUID(),
    sockets = new Set<net.Socket>(),
    children = new Set<ReturnType<typeof spawn>>();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    const child = spawn(
      wsl,
      [
        "--distribution",
        ledger.distro,
        "--user",
        "root",
        "--exec",
        "/usr/bin/socat",
        "-",
        "UNIX-CONNECT:/var/run/docker.sock",
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    children.add(child);
    socket.pipe(child.stdin);
    child.stdout.pipe(socket);
    child.stderr.resume();
    child.on("error", () => socket.destroy());
    child.on("close", () => {
      children.delete(child);
      socket.end();
    });
    socket.on("error", () => {});
    child.stdin.on("error", () => socket.destroy());
    socket.on("close", () => {
      sockets.delete(socket);
      child.kill();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipe, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    socket: pipe,
    distro: ledger.distro,
    directory,
    packages: ledger.packages || [],
    close: async () => {
      for (const socket of sockets) socket.destroy();
      for (const child of children) child.kill();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
