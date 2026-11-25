/** Real IDE/DB/files/DSH/compiler/SDK/browser. Explicit model wire fixture, never paid-model acceptance. */
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { chromium } from "playwright-core";
import { sourceDigest } from "../../src/agent-project/files.ts";
const name = "poros_ide_browser_" + randomUUID().replaceAll("-", ""),
  directory = await mkdtemp(path.join(tmpdir(), "poros-ide-browser-"));
const evidence = process.env.POROS_IDE_EVIDENCE || ".audit/evidence/ide-20261126";
const url = new URL(process.env.DATABASE_URL);
url.pathname = "/postgres";
const control = new PrismaClient({ datasources: { db: { url: url.href } } });
let app,
  browser,
  created = false,
  calls = [],
  actualModelRequests = 0;
const key = randomUUID(),
  errors = [];
const provider = createServer(async (req, res) => {
  if (req.headers.authorization !== "Bearer " + key) {
    res.writeHead(401).end();
    return;
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const input = JSON.parse(raw);
  const text = input.messages?.[0]?.content,
    nonce =
      input.messages?.length === 1 && typeof text === "string"
        ? text.match(/^Output this verification code alone: (POROS-[0-9a-f]{8})$/)?.[1]
        : null;
  if (!input.stream) {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: "EXPLICIT MODEL WIRE FIXTURE: " + String(input.messages?.at(-1)?.content),
            },
          },
        ],
      }),
    );
    return;
  }
  const step = (input.messages || []).filter((message) => message.role === "tool").length,
    call = nonce ? null : calls[step];
  if (!nonce) actualModelRequests++;
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (delta, finish_reason = null) =>
    res.write(
      "data: " +
        JSON.stringify({
          id: "ide-browser-model-fixture",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta, finish_reason }],
        }) +
        "\n\n",
    );
  if (call) {
    send({
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: "call-" + step,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        },
      ],
    });
    send({}, "tool_calls");
  } else {
    send({
      role: "assistant",
      content:
        nonce ||
        "Explicit MODEL protocol fixture completed. Inspect real source, compiler failure, repair and evaluation.",
    });
    send({}, "stop");
  }
  res.end("data: [DONE]\n\n");
});
try {
  await mkdir(evidence, { recursive: true });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const baseModel = "http://127.0.0.1:" + provider.address().port + "/v1";
  await control.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  created = true;
  url.pathname = "/" + name;
  Object.assign(process.env, {
    DATABASE_URL: url.href,
    JWT_SECRET: randomUUID() + randomUUID(),
    POROS_SETTINGS_KEY: randomBytes(32).toString("hex"),
    POROS_WORKSPACE_ROOT: path.join(directory, "workspaces"),
    POROS_RELEASE_ROOT: path.join(directory, "publisher"),
    POROS_LOCAL_MODEL_BASES: baseModel,
    LOG_LEVEL: "silent",
    POROS_RUNTIME: "dsh",
    MODEL_GATEWAY: "mock",
    POROS_DSH_MODEL_STUB: "1",
  });
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], {
    env: process.env,
    stdio: "pipe",
  });
  const { seedForTests } = await import("../../src/server/seed.ts");
  await seedForTests();
  const { buildApp } = await import("../../src/server/app.ts");
  app = await buildApp();
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "builder@a.test", password: "builder-pass-123", organizationId: "org-a" },
  });
  const authorization = { authorization: "Bearer " + login.json().token };
  browser = await chromium.launch(
    process.platform === "win32" ? { channel: "msedge", headless: true } : { headless: true },
  );
  const page = await browser.newPage({
    viewport: { width: 1366, height: 768 },
    acceptDownloads: true,
  });
  page.setDefaultTimeout(30000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  await page.getByLabel("组织 ID").fill("org-a");
  await page.getByLabel("邮箱", { exact: true }).fill("builder@a.test");
  await page.getByLabel("密码", { exact: true }).fill("builder-pass-123");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByLabel("开发要求").waitFor();
  const prompt = "开发真实乘法 Agent，保留可用界面并验证 7 乘 3。";
  await page.getByLabel("开发要求").fill(prompt);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  assert.equal(await page.getByLabel("开发要求").inputValue(), prompt);
  const workspaces = (
    await app.inject({ method: "GET", url: "/api/ide/workspaces", headers: authorization })
  ).json().workspaces;
  assert.equal(workspaces.length, 1);
  const id = workspaces[0].id,
    detail = (
      await app.inject({ method: "GET", url: "/api/ide/workspaces/" + id, headers: authorization })
    ).json();
  const wrong = {
    ...detail.files,
    "agent.ts": 'const bad:number="bad";export default()=>bad;',
    "tests/cases.json": JSON.stringify([{ name: "actual multiply", input: 7, expected: 21 }]),
  };
  wrong["poros.json"] = JSON.stringify({
    ...JSON.parse(wrong["poros.json"]),
    tests: "tests/cases.json",
  });
  calls = [
    { name: "workspace_read", arguments: { path: "poros.json", offset: "0" } },
    {
      name: "workspace_patch",
      arguments: {
        expectedDigest: detail.workspace.sourceDigest,
        files: JSON.stringify({
          "agent.ts": wrong["agent.ts"],
          "poros.json": wrong["poros.json"],
          "tests/cases.json": wrong["tests/cases.json"],
        }),
      },
    },
    { name: "workspace_build", arguments: {} },
    {
      name: "workspace_patch",
      arguments: {
        expectedDigest: sourceDigest(wrong),
        files: JSON.stringify({
          "agent.ts":
            'import {defineAgent} from "@poros/sdk";export default defineAgent(input=>Number(input)*3);',
        }),
      },
    },
    { name: "workspace_build", arguments: {} },
    { name: "workspace_test", arguments: {} },
  ];
  const model = page.getByRole("heading", { name: "大模型 API", exact: true }).locator("../..");
  await model.getByLabel("API Base URL").fill(baseModel);
  await model.getByLabel("模型 ID").fill("ide-wire-contract-fixture");
  await model.getByLabel("模型 API Key").fill(key);
  await model.getByRole("button", { name: "保存连接", exact: true }).click();
  await model.getByText("已保存，请测试连接", { exact: true }).waitFor();
  await model.getByRole("button", { name: "测试连接", exact: true }).click();
  await model.getByText("已验证", { exact: true }).waitFor();
  assert.equal(await model.getByLabel("模型 API Key").inputValue(), "");
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  assert.equal(await page.getByLabel("开发要求").inputValue(), prompt);
  let lostDevelopmentReceipt = false;
  await page.route("**/api/ide/workspaces/*/jobs", async (route) => {
    if (
      route.request().method() === "POST" &&
      route.request().postDataJSON().kind === "DEVELOP" &&
      !lostDevelopmentReceipt
    ) {
      lostDevelopmentReceipt = true;
      const actual = await route.fetch();
      assert.equal(actual.status(), 202);
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page
    .getByText("Explicit MODEL protocol fixture completed.", { exact: false })
    .waitFor({ timeout: 120000 });
  assert.equal(lostDevelopmentReceipt, true);
  await page.reload();
  await page.getByLabel("开发要求").waitFor();
  assert.equal(await page.getByLabel("开发要求").inputValue(), prompt);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('textarea[aria-label="开发要求"]')?.value === "",
  );
  const recovered = (
    await app.inject({ url: "/api/ide/workspaces/" + id, headers: authorization })
  ).json();
  assert.equal(
    recovered.jobs.filter((job) => job.kind === "DEVELOP").length,
    1,
    "source changed before lost acknowledgment recovery created a second development job",
  );
  const preview = page.frameLocator('iframe[title="Agent 实际运行界面"]');
  await preview.getByLabel("试用输入").fill("7");
  await preview.getByRole("button", { name: "运行 Agent", exact: true }).click();
  await preview.getByRole("status").filter({ hasText: "21" }).waitFor();
  await page.getByRole("button", { name: "手机", exact: true }).click();
  assert.equal(await preview.getByLabel("试用输入").inputValue(), "7");
  await preview.getByRole("status").filter({ hasText: "21" }).waitFor();
  await page.getByRole("button", { name: "PC", exact: true }).click();
  await page.getByLabel("开发要求").fill("设置往返必须保留的修改草稿");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("tab", { name: "当前工程", exact: true }).click();
  await page.getByRole("heading", { name: "技能", exact: true }).waitFor();
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  assert.equal(await page.getByLabel("开发要求").inputValue(), "设置往返必须保留的修改草稿");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(evidence, "ide-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 1920, height: 1080 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await preview.getByRole("status").filter({ hasText: "21" }).waitFor();
  await page.screenshot({ path: path.join(evidence, "ide-wide.png"), fullPage: true });
  await page.setViewportSize({ width: 1366, height: 768 });
  const oldFrame = await page.locator('iframe[title="Agent 实际运行界面"]').getAttribute("src");
  await page.getByRole("button", { name: "代码", exact: true }).click();
  const source = page.getByRole("dialog");
  await source.getByLabel("选择工程文件").selectOption("agent.ts");
  assert.match(await source.getByLabel("工程源代码").inputValue(), /Number\(input\)\*3/);
  await source
    .getByLabel("工程源代码")
    .fill('const broken:number="compile-failure";export default()=>broken;');
  await source.getByRole("button", { name: "保存修改", exact: true }).click();
  await source.getByText("已保存真实源码版本", { exact: false }).waitFor();
  await source.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "构建", exact: true }).click();
  await page.getByText("本次构建失败", { exact: false }).first().waitFor();
  assert.equal(
    await page.locator('iframe[title="Agent 实际运行界面"]').getAttribute("src"),
    oldFrame,
  );
  await page.getByText("上次可运行版本", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(evidence, "ide-failed-build.png"), fullPage: true });
  await page.getByLabel("当前工程").selectOption("new:MCP");
  const newProject = page.getByRole("dialog");
  await newProject.getByLabel("名称").fill("真实 MCP 协议测试");
  await newProject.getByRole("button", { name: "创建工程", exact: true }).click();
  await page.getByRole("button", { name: "构建当前工程", exact: true }).click();
  await page.getByRole("heading", { name: "MCP 工具测试", exact: true }).waitFor();
  await page.getByRole("button", { name: "连接并发现工具", exact: true }).click();
  await page.getByLabel("选择工具", { exact: true }).waitFor();
  await page.getByLabel(/^text/).fill("ACTUAL-MCP-BROWSER");
  await page.getByRole("button", { name: "调用工具", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "ACTUAL-MCP-BROWSER" }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("tab", { name: "运行预览", exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole("status").filter({ hasText: "ACTUAL-MCP-BROWSER" }).waitFor();
  await page.screenshot({ path: path.join(evidence, "ide-mobile.png"), fullPage: true });
  await page.getByLabel("当前工程").selectOption(id);
  await page.getByRole("tab", { name: "开发对话", exact: true }).click();
  assert.equal(await page.getByLabel("开发要求").inputValue(), "设置往返必须保留的修改草稿");
  await page.reload();
  await page.getByLabel("开发要求").waitFor();
  assert.equal(await page.getByLabel("开发要求").inputValue(), "设置往返必须保留的修改草稿");
  const final = (
    await app.inject({ method: "GET", url: "/api/ide/workspaces/" + id, headers: authorization })
  ).json();
  assert.ok(final.jobs.some((job) => job.kind === "DEVELOP" && job.status === "SUCCEEDED"));
  assert.ok(final.jobs.some((job) => job.kind === "BUILD" && job.status === "FAILED"));
  assert.ok(actualModelRequests >= 7);
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(evidence, "ide-browser.json"),
    JSON.stringify(
      {
        mode: "Explicit model protocol fixture; real DSH/compiler/files/browser",
        actualModelRequests,
        lostDevelopmentAcknowledgmentRecoveredOnce: true,
        desktop: "1366x768",
        mobile: "390x844",
        defaultEntry: "IDE",
        firstPromptRecovery: true,
        settingsDraftRecovery: true,
        realCompileErrorAndRepair: true,
        actualAgentResult: 21,
        failedBuildKeepsOldPreview: true,
        actualMcpProtocol: true,
        refreshRecovery: true,
        browserErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS IDE browser: default split UI, first model setup/draft recovery, real DSH patch→compiler error→repair→case, actual preview, PC/mobile preserves input, failed build preserves version, real MCP tools and refresh. Explicit MODEL wire fixture only.",
  );
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page)
    await page
      .screenshot({ path: path.join(evidence, "ide-failure-debug.png"), fullPage: true })
      .catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await app?.close();
  provider.closeAllConnections();
  await new Promise((resolve) => provider.close(resolve));
  const { closeDb } = await import("../../src/server/db.ts");
  await closeDb();
  if (created) await control.$executeRawUnsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
  await control.$disconnect();
  const resolved = path.resolve(directory);
  assert.ok(
    resolved.startsWith(path.resolve(tmpdir()) + path.sep) &&
      path.basename(resolved).startsWith("poros-ide-browser-"),
  );
  await rm(resolved, { recursive: true, force: true });
}
