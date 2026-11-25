import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
const directory = await mkdtemp(path.join(tmpdir(), "poros-relay-service-")),
  key = randomBytes(32).toString("base64url"),
  root = process.cwd();
const probe = net.createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const configuration = {
  name: "poros-relay-acceptance",
  main: path.join(root, "relay", "worker.mjs"),
  compatibility_date: "2026-11-25",
  durable_objects: { bindings: [{ name: "AGENTS", class_name: "AgentChannel" }] },
  migrations: [{ tag: "v1", new_sqlite_classes: ["AgentChannel"] }],
  vars: { HOST_KEY: key },
  observability: { enabled: false },
};
const config = path.join(directory, "wrangler.json");
await writeFile(config, JSON.stringify(configuration), { mode: 0o600 });
const environment = { ...process.env, WRANGLER_SEND_METRICS: "false" };
for (const name of Object.keys(environment))
  if (/^CLOUDFLARE_|^CF_API_/.test(name)) delete environment[name];
const service = spawn(
  process.execPath,
  [
    path.resolve("relay/node_modules/wrangler/bin/wrangler.js"),
    "dev",
    "--config",
    config,
    "--local",
    "--persist-to",
    path.join(directory, "state"),
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--inspector-port",
    "0",
    "--show-interactive-dev-session=false",
    "--log-level",
    "warn",
  ],
  {
    cwd: directory,
    env: environment,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let diagnostic = "";
service.stdout.on("data", (data) => {
  diagnostic = (diagnostic + data.toString()).slice(-6000);
});
service.stderr.on("data", (data) => {
  diagnostic = (diagnostic + data.toString()).slice(-6000);
});
async function stopService() {
  if (service.exitCode !== null) return;
  const ended = new Promise((resolve) => service.once("close", resolve));
  if (process.platform === "win32")
    spawn(
      path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
      ["/PID", String(service.pid), "/T", "/F"],
      { windowsHide: true, stdio: "ignore" },
    );
  else
    try {
      process.kill(-service.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  let timer;
  try {
    await Promise.race([
      ended,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Owned workerd did not stop")), 10000);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
try {
  const endpoint = "http://127.0.0.1:" + port;
  let ready = false;
  for (let i = 0; i < 300 && service.exitCode === null; i++) {
    try {
      if ((await fetch(endpoint, { signal: AbortSignal.timeout(1000) })).status === 404) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, "Local workerd failed: " + diagnostic.replaceAll(key, "[redacted]"));
  const child = spawn(process.execPath, ["--import", "tsx", "tests/e2e/relay-workflows.ts"], {
    cwd: root,
    env: { ...process.env, POROS_RELAY_TEST_URL: endpoint, POROS_RELAY_TEST_KEY: key },
    windowsHide: true,
    stdio: "inherit",
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, 0, "Relay acceptance failed");
} finally {
  await stopService();
  const resolved = path.resolve(directory);
  assert.ok(
    resolved.startsWith(path.resolve(tmpdir()) + path.sep) &&
      path.basename(resolved).startsWith("poros-relay-service-"),
  );
  await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
