/** Real API/Postgres/S3/DSH/tools and headless browser; deterministic MODEL fixture, explicitly labelled. */
import { PrismaClient } from "@prisma/client";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, appendFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { createTestModel } from "../../scripts/poros-test-model.mjs";
const database = "poros_e2e_" + randomUUID().replaceAll("-", ""),
  url = new URL(
    process.env.DATABASE_URL ||
      "postgresql://poros:change-me-strong-password@127.0.0.1:55432/poros?schema=public",
  );
const adminUrl = new URL(url);
adminUrl.pathname = "/postgres";
url.pathname = "/" + database;
const control = new PrismaClient({ datasources: { db: { url: adminUrl.href } } });
const environment = {
  ...process.env,
  NODE_ENV: "test",
  PORT: "0",
  DATABASE_URL: url.href,
  JWT_SECRET: randomUUID() + randomUUID(),
  POROS_RUNTIME: "dsh",
  MODEL_GATEWAY: "mock",
  POROS_DSH_MODEL_STUB: "1",
  LOG_LEVEL: "warn",
};
let server,
  browser,
  verificationProvider,
  base = "",
  serverLog = "",
  created = false;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  execFileSync("docker", ["image", "inspect", "poros/dsh:0.2.2-rc.1-audit"], { stdio: "pipe" });
  const verificationKey = randomUUID();
  const verifiedModel = "mobile-wire-contract-model";
  verificationProvider = await createTestModel([], {
    model: verifiedModel,
    apiKey: verificationKey,
    port: 0,
  });
  const verificationBase = "http://127.0.0.1:" + verificationProvider.address().port + "/v1";
  environment.POROS_LOCAL_MODEL_BASES = verificationBase;
  await control.$executeRawUnsafe(`CREATE DATABASE "${database}"`);
  created = true;
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], {
    env: environment,
    stdio: "pipe",
  });
  execFileSync(process.execPath, ["--import", "tsx", "src/server/seed-cli.ts"], {
    env: environment,
    stdio: "pipe",
  });
  server = spawn(process.execPath, ["dist/src/server/index.js"], {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  server.stdout.on("data", (chunk) => {
    serverLog = (serverLog + chunk.toString()).slice(-8000);
    const match = serverLog.match(/Poros Enterprise API: (http:\/\/127\.0\.0\.1:\d+)/);
    if (match) base = match[1];
  });
  server.stderr.on("data", (chunk) => {
    serverLog = (serverLog + chunk.toString()).slice(-8000);
  });
  for (let i = 0; i < 100 && !base; i++) await pause(100);
  assert.ok(base, "compiled server failed to start: " + serverLog);
  const api = async (method, path, token, body, key) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
        ...(key ? { "idempotency-key": key } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: response.status, json, text };
  };
  const login = async (role, organizationId = "org-a") => {
    const r = await api("POST", "/api/auth/login", null, {
      email: role === "outsider" ? "outsider@b.test" : `${role}@a.test`,
      password: `${role}-pass-123`,
      organizationId,
    });
    assert.equal(r.status, 200, r.text);
    return r.json.token;
  };
  const builder = await login("builder"),
    employee = await login("employee"),
    reviewer = await login("reviewer"),
    outsider = await login("outsider", "org-b");
  const nl = await api("POST", "/api/agents/drafts", builder, {
    description: "创建一个在专属任务容器中检查命令输出并报告的 Agent",
  });
  assert.equal(nl.status, 200, nl.text);
  assert.ok(nl.json.agent.nlSource);
  const agentId = nl.json.agent.id;
  for (const grant of [
    { kind: "TOOL", name: "bash" },
    { kind: "MODEL", name: "deepseek-chat" },
  ]) {
    const r = await api("POST", `/api/agents/${agentId}/grants`, builder, {
      ...grant,
      scopeNote: "E2E explicitly scoped capability",
    });
    assert.equal(r.status, 200, r.text);
  }
  const pub = await api("POST", `/api/agents/${agentId}/publish`, builder);
  assert.equal(pub.status, 202, pub.text);
  assert.equal(
    (
      await api("POST", `/api/approvals/${pub.json.approvalId}/decision`, reviewer, {
        decision: "APPROVED",
      })
    ).status,
    200,
  );
  const run = async (prompt) => {
    const r = await api(
      "POST",
      "/api/tasks",
      employee,
      { agentId, prompt, projectId: "proj-market", consent: ["bash"] },
      randomUUID(),
    );
    assert.equal(r.status, 202, r.text);
    assert.equal(r.json.status, "BLOCKED");
    assert.equal(
      (
        await api("POST", `/api/approvals/${r.json.approvalId}/decision`, reviewer, {
          decision: "APPROVED",
        })
      ).status,
      200,
    );
    const sse = await api("GET", `/api/tasks/${r.json.taskId}/events`, employee);
    assert.equal(sse.status, 200, sse.text);
    assert.ok(sse.text.includes("dsh.tool_result"));
    assert.ok(sse.text.includes("POROS-DSH-REAL-EXEC"));
    assert.ok(sse.text.includes("dsh(stub)"));
    const view = await api("GET", `/api/tasks/${r.json.taskId}`, employee);
    assert.ok(
      ["SUCCEEDED", "UNVERIFIED"].includes(view.json.task.status),
      JSON.stringify(view.json),
    );
    const usage = view.json.runs[0].usage;
    assert.ok(Number.isInteger(usage.modelCalls) && usage.modelCalls > 0);
    assert.equal(usage.generation.modelCalls, usage.modelCalls);
    assert.equal(usage.judge.modelCalls, 0);
    assert.equal(usage.monetaryCost, null);
    assert.equal((await api("GET", `/api/tasks/${r.json.taskId}`, outsider)).status, 404);
    return { taskId: r.json.taskId, runId: view.json.runs[0].id, sse: sse.text };
  };
  const first = await run("在隔离工作区执行一次检查");
  const cand = await api("POST", "/api/judgments/candidates", employee, {
    rule: "must_contain:POROS-DSH-OK",
    kind: "MECHANICAL",
    scopeType: "AGENT",
    scopeId: agentId,
    sourceFeedback: "明确纠正：汇报必须包含执行确认标记",
    sourceRunId: first.runId,
  });
  assert.equal(cand.status, 200, cand.text);
  const ruleId = cand.json.candidate.id,
    unapproved = await run("候选未批准时再次执行");
  assert.ok(!unapproved.sse.includes(`"ruleId":"${ruleId}"`));
  const approvals = await api("GET", "/api/approvals", reviewer),
    approval = approvals.json.approvals.find(
      (a) => a.subjectId === ruleId && a.decision === "PENDING",
    );
  assert.ok(approval);
  assert.equal(
    (
      await api("POST", `/api/approvals/${approval.id}/decision`, reviewer, {
        decision: "APPROVED",
      })
    ).status,
    200,
  );
  const approved = await run("批准规则后执行");
  assert.ok(approved.sse.includes(ruleId));
  assert.ok(approved.sse.includes('"evaluation":"PASS"'));
  console.log(
    "PASS E2E: async submit → consent → independent release/task approval → real DSH tool loop → human rule approval/reuse; cross-org API denied",
  );

  // Headless only; never touches the user's visible browser or desktop.
  browser = await chromium.launch(
    process.platform === "win32" ? { channel: "msedge", headless: true } : { headless: true },
  );
  const employeePage = await browser.newPage(),
    reviewPage = await browser.newPage();
  const errors = [];
  for (const page of [employeePage, reviewPage])
    page.on("pageerror", (e) => errors.push(e.message));
  const uiLogin = async (page, role) => {
    await page.goto(base);
    await page.getByLabel("组织 ID").fill("org-a");
    await page.getByLabel("邮箱", { exact: true }).fill(`${role}@a.test`);
    await page.getByLabel("密码", { exact: true }).fill(`${role}-pass-123`);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByRole("heading", { name: "Poros 工作台" }).waitFor();
  };
  await uiLogin(employeePage, "employee");
  await uiLogin(reviewPage, "reviewer");
  await employeePage.getByLabel("Agent", { exact: true }).selectOption(agentId);
  await employeePage.getByLabel("任务", { exact: true }).fill("浏览器真实工作台执行检查");
  await employeePage.getByRole("checkbox").check();
  await employeePage.getByRole("button", { name: "提交任务", exact: true }).click();
  await employeePage.getByText("本次敏感操作已提交", { exact: false }).waitFor();
  await reviewPage.getByRole("tab", { name: "审批与规则" }).click();
  await reviewPage.getByRole("button", { name: "刷新", exact: true }).click();
  await reviewPage.getByRole("button", { name: "批准", exact: true }).click();
  const toolResult = employeePage.getByText("dsh.tool_result", { exact: true });
  await toolResult.waitFor({ timeout: 30000 });
  assert.ok((await toolResult.locator("..").textContent()).includes("POROS-DSH-REAL-EXEC"));
  await employeePage.getByText("已结束", { exact: true }).waitFor();
  assert.equal(await employeePage.getByText("本次敏感操作已提交", { exact: false }).count(), 0);
  assert.equal(await employeePage.getByRole("checkbox").isChecked(), false);
  assert.equal(
    await employeePage.getByRole("button", { name: "取消", exact: true }).isDisabled(),
    true,
  );
  await mkdir(".audit/evidence", { recursive: true });
  const screenshot = await employeePage.screenshot({
    path: ".audit/evidence/workspace.png",
    fullPage: true,
  });
  await employeePage.getByRole("tab", { name: "设置", exact: true }).click();
  await employeePage.getByText("未配置", { exact: false }).first().waitFor();
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  const phone = await mobile.newPage();
  phone.on("pageerror", (e) => errors.push(e.message));
  await uiLogin(phone, "employee");
  await phone.getByRole("button", { name: /浏览器真实工作台执行检查/ }).click();
  await phone.getByText("dsh.tool_result", { exact: true }).waitFor({ timeout: 20000 });
  await phone.getByRole("tab", { name: "设置", exact: true }).click();
  await phone.getByRole("heading", { name: "个人集成设置" }).waitFor();
  for (const name of ["大模型 API", "Kdocs 金山文档", "IMA 知识库", "TinyFish"]) {
    await phone.getByRole("heading", { name, exact: true }).waitFor();
  }
  const modelPanel = phone
    .getByRole("heading", { name: "大模型 API", exact: true })
    .locator("../..");
  await modelPanel.getByLabel("API Base URL").fill(verificationBase);
  await modelPanel.getByLabel("模型 ID").fill(verifiedModel);
  await modelPanel.getByLabel("模型 API Key").fill(verificationKey);
  await modelPanel.getByRole("button", { name: "保存连接" }).click();
  await modelPanel.getByText("已保存，请测试连接").waitFor();
  assert.equal(await modelPanel.getByLabel("模型 API Key").inputValue(), "");
  await modelPanel.getByRole("button", { name: "测试连接" }).click();
  await modelPanel.getByText("已验证", { exact: true }).waitFor();
  const pwa = await phone.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    const manifest = await (await fetch("/manifest.webmanifest")).json();
    const assets = await Promise.all(
      manifest.icons.map(async (icon) => (await fetch(icon.src)).ok),
    );
    const cacheUrls = (
      await Promise.all((await caches.keys()).map(async (name) => (await caches.open(name)).keys()))
    )
      .flat()
      .map((request) => request.url);
    return {
      scope: registration.scope,
      mode: manifest.display,
      assets,
      cacheUrls,
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
  assert.equal(pwa.mode, "standalone");
  assert.ok(pwa.scope.startsWith(base));
  assert.deepEqual(pwa.assets, [true, true]);
  assert.equal(pwa.overflow, false);
  assert.ok(pwa.cacheUrls.every((url) => !new URL(url).pathname.startsWith("/api/")));
  await phone.screenshot({ path: ".audit/evidence/mobile-settings.png", fullPage: true });
  await mobile.setOffline(true);
  await phone.reload();
  await phone.getByRole("heading", { name: "连接已中断" }).waitFor();
  await mobile.close();
  assert.deepEqual(errors, []);
  const screenshotHash = createHash("sha256").update(screenshot).digest("hex");
  console.log(`UI screenshot: ${screenshot.length} bytes, sha256=${screenshotHash}`);
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      [
        "## Real DSH and headless UI evidence",
        "- API/DSH/tools, independent approvals, rule reuse and cross-organization denial: PASS",
        "- Headless Chromium UI, real tool_result, terminal status, consent reset and no page errors: PASS",
        "- Mobile viewport, cross-device task recovery, four connection forms, real HTTP model probe against the wire-contract fixture, PWA manifest and offline cache boundary: PASS",
        `- Screenshot generated by this browser run: ${screenshot.length} bytes; SHA-256: \`${screenshotHash}\``,
        `- Executed commit: \`${process.env.GITHUB_SHA || "local"}\``,
        "- Deterministic test MODEL only; no paid-model or external-connector acceptance.",
        "- Artifact upload is unavailable due to account storage quota. No existing user artifacts were deleted; screenshot bytes/hash and this run's assertions are recorded here and in job logs. The local delivery includes a real browser screenshot.",
        "",
      ].join("\n"),
    );
  console.log(
    "PASS UI: real headless browser login, explicit sensitive consent, independent reviewer decision, live DSH tool result and completed status; no browser errors",
  );
  console.log(
    "PASS mobile: 390px layout, cross-device task replay, personal settings, HTTP probe fixture, installable PWA and offline page",
  );
  console.log(
    "MODEL channel: dsh(stub) = real DSH/tools + deterministic test MODEL. No paid/real-model acceptance claimed.",
  );
} finally {
  await browser?.close();
  if (verificationProvider) {
    verificationProvider.closeAllConnections();
    await new Promise((resolve) => verificationProvider.close(resolve));
  }
  if (server) {
    server.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => server.once("close", resolve)), pause(5000)]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  if (created && /^poros_e2e_[a-f0-9]{32}$/.test(database))
    await control.$executeRawUnsafe(`DROP DATABASE "${database}" WITH (FORCE)`);
  await control.$disconnect();
}
