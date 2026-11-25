/** Actual local Cloudflare workerd/Durable Object + outbound WebSocket + isolated App.
 * Relay service is started by run-relay.mjs. Source fixture; no paid model/vendor/physical-phone claim. */
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import { chromium } from "playwright-core";
import { stop } from "esbuild";
import { starterProject } from "../../src/agent-project/contract.js";
import { compileProject } from "../../src/agent-project/compiler.js";
import { createPackage } from "../../src/agent-project/package.js";
import { buildRuntime } from "../../src/runtime/app.js";
import { remoteAllowed } from "../../src/remote/protocol.js";
process.env.POROS_RELAY_ALLOW_LOCAL = "1";
const endpoint = process.env.POROS_RELAY_TEST_URL || "http://127.0.0.1:58847",
  relayKey =
    process.env.POROS_RELAY_TEST_KEY ||
    JSON.parse(await readFile(".audit/relay-test-key.json", "utf8")).relayKey;
const directory = await mkdtemp(path.join(tmpdir(), "poros-relay-test-")),
  evidence = process.env.POROS_IDE_EVIDENCE || ".audit/evidence/ide-20261126";
const applications: Awaited<ReturnType<typeof buildRuntime>>[] = [],
  owners: string[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const local = async (index: number, method: string, url: string, payload?: unknown) =>
  applications[index]!.app.inject({
    method: method as "GET" | "POST" | "PUT" | "DELETE",
    url,
    headers: { authorization: "Bearer " + owners[index] },
    payload: payload as object | undefined,
  });
try {
  await mkdir(evidence, { recursive: true });
  for (const [index, expression] of ["Number(input)*3", "Number(input)+5"].entries()) {
    const files = starterProject("AGENT", "远控验收 " + index);
    files["agent.ts"] =
      'import{defineAgent}from"@poros/sdk";export default defineAgent(input=>' + expression + ");";
    const compiled = await compileProject(files);
    assert.equal(compiled.status, "READY", compiled.diagnostics.join("\n"));
    const key = generateKeyPairSync("ed25519")
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString(),
      pkg = createPackage({ appIdentity: randomUUID(), files, ...compiled, privateKey: key });
    const app = await buildRuntime({
      directory: path.join(directory, "app-" + index),
      package: index === 0 ? pkg : (applications[0]!.store.snapshot().package as typeof pkg),
      publicDirectory: path.resolve("src/server/public"),
    });
    applications.push(app);
    owners.push(
      (
        await app.app.inject({
          method: "POST",
          url: "/api/app/bootstrap",
          payload: { code: app.bootstrap() },
        })
      ).json().token,
    );
    const config = await local(index, "PUT", "/api/app/remote", {
      mode: "WORKER",
      endpoint,
      relayKey,
    });
    assert.equal(config.statusCode, 200, config.body);
  }
  for (
    let i = 0;
    i < 200 && !applications.every((app) => app.remote.status().state === "ONLINE");
    i++
  )
    await new Promise((r) => setTimeout(r, 50));
  assert.ok(
    applications.every((app) => app.remote.status().state === "ONLINE"),
    JSON.stringify(applications.map((app) => app.remote.status())),
  );
  const urls = applications.map((app) => app.remote.status().url!);
  assert.notEqual(urls[0], urls[1]);
  const get = async (index: number, route: string, token?: string) =>
    fetch(urls[index] + route, {
      headers: token ? { authorization: "Bearer " + token } : undefined,
    });
  assert.equal((await get(0, "api/app/session", owners[0])).status, 403);
  for (const route of [
    "api/app/settings",
    "api/app/connections",
    "api/app/bootstrap",
    "api/app/remote",
    "api/app/devices",
  ])
    assert.equal((await get(0, route, owners[0])).status, 404);
  for (const raw of [
    "/api/app/../settings",
    "//api/app/jobs",
    "/api/app/jobs?secret=x",
    "/api/app/%73ettings",
  ])
    assert.equal(remoteAllowed("GET", raw), false);
  browser = await chromium.launch(
    process.platform === "win32" ? { channel: "msedge", headless: true } : { headless: true },
  );
  const address = await applications[0]!.app.listen({ host: "127.0.0.1", port: 0 }),
    ownerPage = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await ownerPage.goto(address + "/#/bootstrap/" + applications[0]!.bootstrap());
  await ownerPage.getByRole("button", { name: "设置", exact: true }).click();
  await ownerPage.getByRole("button", { name: "使用稳定的中继地址", exact: true }).click();
  await ownerPage.getByLabel("中继 HTTPS 地址").fill(endpoint);
  await ownerPage.getByLabel("中继管理密钥").fill(relayKey);
  await ownerPage.getByRole("button", { name: "连接此中继", exact: true }).click();
  await ownerPage.waitForFunction(
    () =>
      document.querySelector<HTMLInputElement>('input[placeholder="填写自己部署时设置的 HOST_KEY"]')?.value === "",
  );
  await ownerPage.getByText("已连接", { exact: true }).waitFor();
  await ownerPage.getByRole("link", { name: urls[0] }).waitFor();
  await ownerPage.screenshot({
    path: path.join(evidence, "app-remote-settings.png"),
    fullPage: true,
  });
  await ownerPage.getByRole("button", { name: "关闭", exact: true }).click();
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await phoneContext.newPage(),
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(20000);
  const invite = (await local(0, "POST", "/api/app/pair/invites", { grants: [] })).json();
  await page.goto(urls[0] + "#/pair/" + invite.code);
  await page.getByLabel("设备名称").fill("手机浏览器验收");
  await page.getByRole("button", { name: "请求连接", exact: true }).click();
  await page.getByText("请在电脑端的设置中同意这台设备。", { exact: true }).waitFor();
  const request = (await local(0, "GET", "/api/app/pair/requests"))
    .json()
    .requests.find((item: { status: string }) => item.status === "PENDING");
  assert.ok(request);
  assert.equal(
    (await local(0, "POST", "/api/app/pair/" + request.id + "/approve")).statusCode,
    200,
  );
  const frame = page.frameLocator('iframe[title="Agent 软件界面"]');
  await frame.getByLabel("试用输入").fill("7");
  await frame.getByRole("button", { name: "运行 Agent", exact: true }).click();
  await frame.getByRole("status").filter({ hasText: "21" }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const credentials = await page.evaluate(() =>
    Object.keys(localStorage)
      .filter((key) => key.startsWith("poros-app-token:"))
      .map((key) => localStorage.getItem(key)),
  );
  const deviceToken = credentials[0]!;
  assert.ok(deviceToken);
  assert.equal((await get(1, "api/app/session", deviceToken)).status, 401);
  // Same signed Agent installed twice, using the same relay origin and browser storage.
  assert.equal(
    applications[0]!.store.package().payload.appId,
    applications[1]!.store.package().payload.appId,
  );
  const second = await phoneContext.newPage(),
    inviteB = (await local(1, "POST", "/api/app/pair/invites", { grants: [] })).json();
  await second.goto(urls[1] + "#/pair/" + inviteB.code);
  await second.getByLabel("设备名称").fill("同浏览器中的另一安装");
  await second.getByRole("button", { name: "请求连接", exact: true }).click();
  await second.getByText("请在电脑端的设置中同意这台设备。", { exact: true }).waitFor();
  const requestB = (await local(1, "GET", "/api/app/pair/requests")).json().requests[0];
  await local(1, "POST", "/api/app/pair/" + requestB.id + "/approve");
  const frameB = second.frameLocator('iframe[title="Agent 软件界面"]');
  await frameB.getByLabel("试用输入").fill("8");
  await frameB.getByRole("button", { name: "运行 Agent", exact: true }).click();
  await frameB.getByRole("status").filter({ hasText: "24" }).waitFor();
  await page.reload();
  await page.frameLocator('iframe[title="Agent 软件界面"]').getByLabel("试用输入").waitFor();
  for (const current of [page, second]) {
    await current.getByRole("button", { name: "设置", exact: true }).click();
    await current.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await current.getByRole("button", { name: "关闭", exact: true }).click();
  }
  const caches = await page.evaluate(async () => await window.caches.keys());
  assert.equal(caches.filter((name) => name.startsWith("poros-app-offline-")).length, 2);
  assert.equal((await local(1, "GET", "/api/app/jobs")).json().jobs[0].output.result, 24);

  const [manifest, html] = await Promise.all([
    (await get(0, "manifest.webmanifest")).json(),
    (await get(0, "")).text(),
  ]);
  assert.ok(manifest.start_url.startsWith("/c/"));
  assert.ok(html.includes('<base href="/c/'));
  await page.screenshot({ path: path.join(evidence, "relay-mobile.png"), fullPage: true });
  const jobs = (await local(0, "GET", "/api/app/jobs")).json().jobs;
  assert.equal(jobs.length, 1);
  const original = jobs[0];
  await local(0, "PUT", "/api/app/remote", { mode: "OFF" });
  assert.equal((await get(0, "api/app/info")).status, 503);
  await local(0, "PUT", "/api/app/remote", { mode: "WORKER", endpoint, relayKey });
  for (let i = 0; i < 200 && applications[0]!.remote.status().state !== "ONLINE"; i++)
    await new Promise((r) => setTimeout(r, 50));
  assert.equal(applications[0]!.remote.status().url, urls[0]);
  const recovered = await get(0, "api/app/jobs/" + original.id, deviceToken);
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).job.output.result, 21);
  assert.equal((await local(0, "GET", "/api/app/jobs")).json().jobs.length, 1);
  const device = (await local(0, "GET", "/api/app/devices")).json().devices[0];
  await local(0, "DELETE", "/api/app/devices/" + device.id);
  assert.equal((await get(0, "api/app/session", deviceToken)).status, 401);
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(evidence, "relay-local.json"),
    JSON.stringify(
      {
        scope:
          "Actual local Cloudflare workerd + SQLite Durable Object + outbound WS; source fixtures; not deployed Cloudflare or physical cellular phone acceptance",
        apps: applications.map((app) => app.store.package().payload.appId),
        oneRelayMultipleApps: true,
        samePackageTwoInstallationsOneBrowser: true,
        ownerBlockedRemotely: true,
        phonePairApproval: true,
        actualResult: 21,
        stableChannelReconnect: true,
        oldJobRecoveredWithoutReplay: true,
        deviceRevoked: true,
        browserErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS relay: actual workerd/SQLite DO + outbound WS, two Apps, phone browser pairing, opaque frame and isolated task21, owner routes denied, stable reconnect, history recovery, revocation.",
  );
} finally {
  await browser?.close();
  for (const app of applications) await app.app.close();
  stop();
  const resolved = path.resolve(directory);
  assert.ok(
    resolved.startsWith(path.resolve(tmpdir()) + path.sep) &&
      path.basename(resolved).startsWith("poros-relay-test-"),
  );
  await rm(resolved, { recursive: true, force: true });
}
