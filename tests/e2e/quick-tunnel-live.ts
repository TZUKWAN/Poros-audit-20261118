/** Opt-in real public Cloudflare Quick Tunnel acceptance, no Cloudflare account or paid model. */
import assert from "node:assert/strict";
import { mkdir, writeFile, mkdtemp, cp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import { chromium } from "playwright-core";
import { stop } from "esbuild";
import { starterProject } from "../../src/agent-project/contract.js";
import { compileProject } from "../../src/agent-project/compiler.js";
import { createPackage } from "../../src/agent-project/package.js";
import { buildRuntime } from "../../src/runtime/app.js";
const directory = await mkdtemp(path.join(tmpdir(), "poros-public-tunnel-")),
  evidence = process.env.POROS_IDE_EVIDENCE || ".audit/evidence/ide-20261126";
let runtime: Awaited<ReturnType<typeof buildRuntime>> | undefined,
  browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await mkdir(evidence, { recursive: true });
  if (process.env.POROS_CLOUDFLARED_CACHE) {
    await mkdir(path.join(directory, "remote-components"), { recursive: true });
    await cp(
      process.env.POROS_CLOUDFLARED_CACHE,
      path.join(directory, "remote-components", "cloudflared-2026.11.2.exe"),
    );
  }
  const files = starterProject("AGENT", "公网通道验收 Agent");
  files["agent.ts"] =
    'import{defineAgent}from"@poros/sdk";export default defineAgent(input=>Number(input)*3);';
  const build = await compileProject(files);
  assert.equal(build.status, "READY", build.diagnostics.join("\n"));
  const privateKey = generateKeyPairSync("ed25519")
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString(),
    pkg = createPackage({ appIdentity: randomUUID(), files, ...build, privateKey });
  runtime = await buildRuntime({
    directory,
    package: pkg,
    publicDirectory: path.resolve("src/server/public"),
  });
  const owner = (
      await runtime.app.inject({
        method: "POST",
        url: "/api/app/bootstrap",
        payload: { code: runtime.bootstrap() },
      })
    ).json().token,
    headers = { authorization: "Bearer " + owner };
  await runtime.remote.configure({ mode: "QUICK" });
  for (let i = 0; i < 1500; i++) {
    const state = runtime.remote.status();
    if (state.state === "ONLINE") break;
    if (state.state === "FAILED") throw new Error(state.message);
    await new Promise((r) => setTimeout(r, 100));
  }
  const status = runtime.remote.status();
  assert.equal(status.state, "ONLINE", JSON.stringify(status));
  assert.ok(status.url?.startsWith("https://"));
  const url = status.url!;
  browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    proxy: process.env.POROS_BROWSER_PROXY
      ? { server: process.env.POROS_BROWSER_PROXY }
      : undefined,
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(25000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const invite = (
    await runtime.app.inject({
      method: "POST",
      url: "/api/app/pair/invites",
      headers,
      payload: { grants: [] },
    })
  ).json();
  await page.goto(url + "#/pair/" + invite.code, { timeout: 45000 });
  await page.getByLabel("设备名称").fill("公网手机浏览器验收");
  await page.getByRole("button", { name: "请求连接", exact: true }).click();
  await page.getByText("请在电脑端的设置中同意这台设备。", { exact: true }).waitFor();
  const request = (await runtime.app.inject({ url: "/api/app/pair/requests", headers })).json()
    .requests[0];
  assert.ok(request);
  assert.equal(
    (
      await runtime.app.inject({
        method: "POST",
        url: "/api/app/pair/" + request.id + "/approve",
        headers,
      })
    ).statusCode,
    200,
  );
  const frame = page.frameLocator('iframe[title="Agent 软件界面"]');
  await frame.getByLabel("试用输入").fill("7");
  await frame.getByRole("button", { name: "运行 Agent", exact: true }).click();
  await frame.getByRole("status").filter({ hasText: "21" }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const responses = await page.evaluate(async () => {
    const routes = ["api/app/info", "api/app/settings", "api/app/bootstrap"];
    return Promise.all(
      routes.map(async (route) => ({ route, status: (await fetch(route)).status })),
    );
  });
  assert.deepEqual(
    responses.map((item) => item.status),
    [200, 404, 404],
  );
  await page.screenshot({ path: path.join(evidence, "quick-public-mobile.png"), fullPage: true });
  const device = (await runtime.app.inject({ url: "/api/app/devices", headers })).json().devices[0];
  await runtime.app.inject({ method: "DELETE", url: "/api/app/devices/" + device.id, headers });
  await page.reload();
  await page.getByRole("heading", { name: "连接这台 Agent", exact: true }).waitFor();
  const jobs = (await runtime.app.inject({ url: "/api/app/jobs", headers })).json().jobs;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].output.result, 21);
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(evidence, "quick-public.json"),
    JSON.stringify(
      {
        scope:
          "Real public trycloudflare.com HTTPS + headless phone-sized browser; source fixture, not physical cellular phone or paid-model acceptance",
        at: new Date().toISOString(),
        cloudflared: "2026.11.2",
        publicHttps: true,
        computerApproval: true,
        actualIsolatedResult: 21,
        ownerRoutesBlocked: true,
        revocation: true,
        browserErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS real public Quick Tunnel: HTTPS, phone browser pairing + computer approval, actual isolated21, management routes blocked, revoked device rejected.",
  );
} catch (error) {
  console.error("Public acceptance failure:", error instanceof Error ? error.message : "unknown");
  throw error;
} finally {
  await browser?.close();
  await runtime?.app.close();
  stop();
  const resolved = path.resolve(directory);
  assert.ok(
    resolved.startsWith(path.resolve(tmpdir()) + path.sep) &&
      path.basename(resolved).startsWith("poros-public-tunnel-"),
  );
  await rm(resolved, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
}
