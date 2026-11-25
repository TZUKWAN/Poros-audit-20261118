/** Real bundled Node process + real isolated source + headless browser. SOURCE fixture, no model/supplier acceptance. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import { mkdtemp, cp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { stop } from "esbuild";
import { compileProject } from "../../src/agent-project/compiler.ts";
import { starterProject } from "../../src/agent-project/contract.ts";
import { createPackage } from "../../src/agent-project/package.ts";
const directory = await mkdtemp(path.join(tmpdir(), "poros-bundled-app-"));
const evidence = process.env.POROS_IDE_EVIDENCE || ".audit/evidence/ide-20261126";
let child,
  browser,
  diagnostic = "",
  ready;
try {
  await mkdir(evidence, { recursive: true });
  await cp(".app-runtime/runtime.mjs", path.join(directory, "runtime.mjs"));
  await cp(".app-runtime/public", path.join(directory, "public"), { recursive: true });
  const files = starterProject("AGENT", "独立软件浏览器验收");
  files["agent.ts"] =
    'import {defineAgent} from "@poros/sdk";export default defineAgent(input=>Number(input)*3);';
  const compiled = await compileProject(files);
  assert.equal(compiled.status, "READY", compiled.diagnostics.join("\n"));
  const privateKey = generateKeyPairSync("ed25519")
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const pkg = createPackage({ appIdentity: randomUUID(), files, ...compiled, privateKey });
  await writeFile(path.join(directory, "agent.poros.json"), JSON.stringify(pkg));
  const environment = {
    ...process.env,
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://unavailable:unused@127.0.0.1:1/no_development_database",
  };
  for (const key of [
    "NODE_PATH",
    "NODE_OPTIONS",
    "JWT_SECRET",
    "POROS_SETTINGS_KEY",
    "POROS_DEEPSEEK_API_KEY",
    "MODEL_GATEWAY",
    "POROS_DSH_MODEL_STUB",
    "S3_ACCESS_KEY",
    "S3_SECRET_KEY",
  ])
    delete environment[key];
  child = spawn(
    process.execPath,
    [
      path.join(directory, "runtime.mjs"),
      "--package",
      path.join(directory, "agent.poros.json"),
      "--data",
      path.join(directory, "installation"),
    ],
    { cwd: directory, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (data) => {
    output += data;
    for (const line of output.split("\n")) {
      try {
        const value = JSON.parse(line);
        if (value.type === "poros.app.ready") ready = value;
      } catch {}
    }
  });
  child.stderr.on("data", (data) => {
    diagnostic = (diagnostic + data.toString()).slice(-6000);
  });
  for (let i = 0; i < 200 && !ready && child.exitCode === null; i++)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(ready, "independent bundle failed outside node_modules: " + diagnostic);
  browser = await chromium.launch(
    process.platform === "win32" ? { channel: "msedge", headless: true } : { headless: true },
  );
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } }),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(20000);
  await page.goto(ready.ownerUrl);
  const frame = page.frameLocator('iframe[title="Agent 软件界面"]');
  let lostReceipt = false;
  await page.route("**/api/app/jobs", async (route) => {
    if (route.request().method() === "POST" && !lostReceipt) {
      lostReceipt = true;
      const actual = await route.fetch();
      assert.equal(actual.status(), 202);
      await route.abort("failed");
    } else await route.continue();
  });
  await frame.getByLabel("试用输入").fill("7");
  await frame.getByRole("button", { name: "运行 Agent", exact: true }).click();
  await frame
    .getByRole("status")
    .filter({ hasText: /网络|连接|超时/ })
    .waitFor();
  await page.reload();
  const restored = page.frameLocator('iframe[title="Agent 软件界面"]');
  await restored.getByLabel("试用输入").fill("7");
  await restored.getByRole("button", { name: "运行 Agent", exact: true }).click();
  await restored.getByRole("status").filter({ hasText: "21" }).waitFor();
  const receipts = await page.evaluate(async () => {
    const key = Object.keys(localStorage).find((name) => name.startsWith("poros-app-token:"));
    return (
      await (
        await fetch("/api/app/jobs", {
          headers: { authorization: "Bearer " + localStorage.getItem(key) },
        })
      ).json()
    ).jobs;
  });
  assert.equal(
    receipts.length,
    1,
    "lost acknowledgment + refresh replayed an already executed task",
  );
  const isolation = await page
    .frames()
    .find((item) => item.url().includes("/frame/"))
    ?.evaluate(() => {
      try {
        void parent.localStorage.length;
        return false;
      } catch {
        return true;
      }
    });
  assert.equal(isolation, true, "sandbox frame could read parent storage");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(evidence, "app-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  for (const heading of ["当前软件连接", "大模型 API", "Kdocs 金山文档", "IMA 知识库", "TinyFish"])
    await page.getByRole("heading", { name: heading, exact: true }).waitFor();
  const pwa = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready,
      manifest = await (await fetch("manifest.webmanifest")).json();
    const cacheUrls = (
      await Promise.all((await caches.keys()).map(async (key) => (await caches.open(key)).keys()))
    )
      .flat()
      .map((item) => item.url);
    const icons = await Promise.all(manifest.icons.map(async (icon) => (await fetch(icon.src)).ok));
    return {
      name: manifest.name,
      display: manifest.display,
      icons,
      scope: registration.scope,
      cacheUrls,
    };
  });
  assert.equal(pwa.name, pkg.payload.name);
  assert.equal(pwa.display, "standalone");
  assert.deepEqual(pwa.icons, [true, true]);
  assert.ok(pwa.cacheUrls.every((url) => !/\/(api|frame)\//.test(new URL(url).pathname)));
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await frame.getByRole("status").filter({ hasText: "21" }).waitFor();
  await page.screenshot({ path: path.join(evidence, "app-mobile.png"), fullPage: true });
  await page.reload();
  await page.frameLocator('iframe[title="Agent 软件界面"]').getByLabel("试用输入").waitFor();
  await page.locator("summary").filter({ hasText: "最近任务" }).click();
  await page.getByText('"result": 21', { exact: false }).waitFor();
  assert.ok(!page.url().includes("bootstrap"));
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(evidence, "app-browser.json"),
    JSON.stringify(
      {
        scope: "SOURCE fixture; no model/supplier/physical-phone acceptance",
        bundledOutsideNodeModules: true,
        developmentDatabaseUnavailable: true,
        desktop: "1366x768",
        mobile: "390x844",
        opaqueFrameBoundary: true,
        actualResult: 21,
        reloadRecovery: true,
        lostAcknowledgmentAndRefreshExecutedOnce: true,
        pwa,
        browserErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS App browser: standalone bundle outside node_modules/development DB, actual isolated calculation, owner bootstrap, settings, opaque frame, PC/390px, reload and PWA cache boundary. SOURCE fixture only.",
  );
} finally {
  await browser?.close();
  if (child && child.exitCode === null) {
    const ended = new Promise((resolve) => child.once("close", resolve));
    child.kill("SIGTERM");
    await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 5000))]);
    if (child.exitCode === null) child.kill();
  }
  stop();
  const resolved = path.resolve(directory);
  assert.ok(
    resolved.startsWith(path.resolve(tmpdir()) + path.sep) &&
      path.basename(resolved).startsWith("poros-bundled-app-"),
  );
  await rm(resolved, { recursive: true, force: true });
}
