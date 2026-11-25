/** Actual NSIS silent install + hidden Electron windows. No visible desktop automation. */
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { _electron as electron } from "playwright-core";
if (process.platform !== "win32") throw new Error("This acceptance requires Windows");
const fixtures = path.resolve(process.env.POROS_WINDOWS_FIXTURES || ".audit/windows-fixtures"),
  buildRoot = path.resolve(process.env.POROS_DESKTOP_OUTPUT || ".desktop-build"),
  base = path.resolve(".audit/windows-install-" + Date.now()),
  evidence = path.resolve(process.env.POROS_IDE_EVIDENCE || ".audit/evidence/ide-20261126");
await mkdir(base, { recursive: true });
await mkdir(evidence, { recursive: true });
const command = (binary, args, timeoutMs = 90000) =>
  new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Installer command timed out"));
    }, timeoutMs);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error("Installer command failed: " + code));
    });
  });
const packages = await Promise.all(
  ["A", "B"].map(async (label) => {
    const pkg = JSON.parse(await readFile(path.join(fixtures, label + ".poros.json"), "utf8"));
    const id = pkg.payload.appId,
      folder = path.join(buildRoot, id, pkg.payload.version.slice(0, 16));
    const build = JSON.parse(await readFile(path.join(folder, "build-evidence.json"), "utf8"));
    return { label, pkg, build, install: path.join(base, id), data: path.join(base, id + "-data") };
  }),
);
let live = [];
const run = async (entry, expected, update = false) => {
  const started = Date.now(),
    env = { ...process.env, DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/absent" };
  for (const key of [
    "ELECTRON_RUN_AS_NODE",
    "NODE_OPTIONS",
    "NODE_PATH",
    "JWT_SECRET",
    "POROS_SETTINGS_KEY",
    "POROS_DEEPSEEK_API_KEY",
    "MODEL_GATEWAY",
    "POROS_DSH_MODEL_STUB",
  ])
    delete env[key];
  const application = await electron.launch({
    executablePath: path.join(entry.install, entry.pkg.payload.appId + ".exe"),
    args: [
      "--poros-headless",
      ...(process.env.POROS_FREE_RUNTIME_DIRECTORY ? ["--poros-free-runtime"] : []),
      "--data",
      entry.data,
    ],
    env,
    timeout: process.env.POROS_FREE_RUNTIME_DIRECTORY ? 180000 : 60000,
  });
  live.push(application);
  const page = await application.firstWindow();
  page.setDefaultTimeout(25000);
  const frame = page.frameLocator('iframe[title="Agent 软件界面"]');
  await frame.getByLabel("试用输入").fill("7");
  await frame
    .getByRole("button", { name: "运行 Agent", exact: true })
    .evaluate((element) => element.click());
  await frame
    .getByRole("status")
    .filter({ hasText: String(expected) })
    .waitFor();
  const startupMs = Date.now() - started,
    processInfo = await application.evaluate(async ({ app, BrowserWindow }) => ({
      versions: process.versions,
      freeLinuxEngine: Boolean(process.env.POROS_DOCKER_SOCKET?.includes("poros-engine-")),
      visible: BrowserWindow.getAllWindows().some((window) => window.isVisible()),
      memory: app
        .getAppMetrics()
        .map((item) => ({ type: item.type, workingSetKiB: item.memory.workingSetSize })),
    }));
  assert.equal(processInfo.visible, false);
  assert.equal(processInfo.versions.electron, "45.5.0");
  if (process.env.POROS_FREE_RUNTIME_DIRECTORY) assert.equal(processInfo.freeLinuxEngine, true);
  if (update) {
    await page
      .getByRole("button", { name: "设置", exact: true })
      .evaluate((element) => element.click());
    const oldFrame = await page.locator("iframe").getAttribute("src"),
      updated = page.waitForResponse(
        (r) => new URL(r.url()).pathname === "/api/app/update" && r.status() === 200,
      );
    await page
      .getByLabel("选择已签名工程包")
      .setInputFiles(path.join(fixtures, "A-update.poros.json"));
    await updated;
    await page.waitForFunction(
      (old) => document.querySelector("iframe")?.getAttribute("src") !== old,
      oldFrame,
    );
    await page
      .getByRole("button", { name: "关闭", exact: true })
      .evaluate((element) => element.click());
    const newFrame = page.frameLocator('iframe[title="Agent 软件界面"]');
    await newFrame.getByLabel("试用输入").fill("7");
    await newFrame
      .getByRole("button", { name: "运行 Agent", exact: true })
      .evaluate((element) => element.click());
    await newFrame.getByRole("status").filter({ hasText: "28" }).waitFor();
  }
  // Hidden native windows do not receive OS mouse events; DOM dispatch executes the same real UI handler.
  // PC/mobile rendering and real pointer interaction are covered by the separate headless browser acceptance.
  await application.close();
  live = live.filter((item) => item !== application);
  return {
    label: entry.label,
    appId: entry.pkg.payload.appId,
    installerBytes: entry.build.bytes,
    signature: entry.build.windowsSignatureStatus,
    startupAndFirstTaskMs: startupMs,
    expected,
    updated: update ? 28 : undefined,
    ...processInfo,
  };
};
const results = [];
try {
  for (const entry of packages) await command(entry.build.installer, ["/S", "/D=" + entry.install]);
  for (const entry of packages)
    assert.ok((await stat(path.join(entry.install, entry.pkg.payload.appId + ".exe"))).isFile());
  results.push(await run(packages[0], 21, true));
  results.push(await run(packages[1], 12));
  const uninstaller = (await readdir(packages[0].install)).find((name) =>
    /^Uninstall.*\.exe$/.test(name),
  );
  assert.ok(uninstaller);
  await command(path.join(packages[0].install, uninstaller), ["/S"]);
  for (
    let i = 0;
    i < 100 &&
    (await stat(path.join(packages[0].install, packages[0].pkg.payload.appId + ".exe")).catch(
      () => null,
    ));
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    await stat(path.join(packages[0].install, packages[0].pkg.payload.appId + ".exe")).catch(
      () => null,
    ),
    null,
  );
  assert.ok(
    (await stat(path.join(packages[1].install, packages[1].pkg.payload.appId + ".exe"))).isFile(),
  );
  assert.ok((await stat(path.join(packages[0].data, "data", "state.json"))).isFile());
  results.push(await run(packages[1], 12));
  const bUninstaller = (await readdir(packages[1].install)).find((name) =>
    /^Uninstall.*\.exe$/.test(name),
  );
  assert.ok(bUninstaller);
  await command(path.join(packages[1].install, bUninstaller), ["/S"]);
  await writeFile(
    path.join(evidence, "windows-install.json"),
    JSON.stringify(
      {
        scope:
          "source fixtures; real NSIS/Electron/Linux Engine; no paid model/vendor/physical phone acceptance",
        independentApps: true,
        uninstallPreservesOtherApp: true,
        uninstallPreservesData: true,
        installationRoot: base,
        results,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS Windows: two actual NSIS installs, hidden Electron software, actual isolated tasks, same-publisher update, separate storage, uninstall one leaves the other usable.",
  );
} finally {
  for (const application of live) await application.close().catch(() => {});
}
