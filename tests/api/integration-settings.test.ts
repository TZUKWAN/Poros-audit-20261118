import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createPersonalGateway } from "../../src/server/model-gateway.js";
import { createSemanticJudge } from "../../src/server/semantic-judge.js";

const dbName = "poros_settings_" + randomUUID().replaceAll("-", "");
const url = new URL(
  process.env.DATABASE_URL ??
    "postgresql://poros:change-me-strong-password@127.0.0.1:55432/poros?schema=public",
);
const controlUrl = new URL(url);
controlUrl.pathname = "/postgres";
url.pathname = "/" + dbName;
const control = new PrismaClient({ datasources: { db: { url: controlUrl.href } } });
const aliveRequests: string[] = [];
const referenceProvider = createServer(async (req, res) => {
  req.setEncoding("utf8");
  let input = "";
  for await (const chunk of req) input += chunk;
  const body = JSON.parse(input);
  if (
    req.url !== "/v1/chat/completions" ||
    req.headers.authorization !== "Bearer test-settings-key"
  ) {
    res.writeHead(401).end();
    return;
  }
  aliveRequests.push(body.model);
  if (/^fault-\d+$/.test(body.model)) {
    res.writeHead(Number(body.model.slice(6))).end('{"error":{"message":"HTTP protocol fixture"}}');
    return;
  }
  if (body.model === "fault-timeout") {
    await new Promise<void>((resolve) => res.once("close", resolve));
    return;
  }
  if (body.model === "upstream-needs-validation") {
    res
      .writeHead(503)
      .end(
        '{"error":{"reason":"VALIDATION_REQUIRED","message":"Verify your account to continue."}}',
      );
    return;
  }
  const last = body.messages.at(-1).content as string;
  if (body.stream) {
    const code = last.match(/POROS-[0-9a-f]{8}$/)?.[0];
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      "data: " +
        JSON.stringify({ choices: [{ delta: { content: code }, finish_reason: "stop" }] }) +
        "\n\ndata: [DONE]\n\n",
    );
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      choices: [
        {
          message: {
            content: String(body.messages[0]?.content).includes("Poros Agent Builder")
              ? JSON.stringify({
                  name: "Provider draft",
                  department: "PC test",
                  config: { persona: last, outputKind: "chat-answer" },
                })
              : "custom model generation",
          },
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    }),
  );
});

let app: FastifyInstance;
let db: PrismaClient;
let baseUrl: string;
let created = false;
const tokens: Record<string, string> = {};

beforeAll(async () => {
  await control.$executeRawUnsafe('CREATE DATABASE "' + dbName + '"');
  created = true;
  process.env.DATABASE_URL = url.href;
  process.env.JWT_SECRET = "integration-tests-only-0123456789";
  process.env.LOG_LEVEL = "silent";
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], {
    stdio: "pipe",
  });
  await new Promise<void>((resolve) => referenceProvider.listen(0, "127.0.0.1", resolve));
  baseUrl = "http://127.0.0.1:" + (referenceProvider.address() as AddressInfo).port + "/v1";
  process.env.POROS_LOCAL_MODEL_BASES = baseUrl;
  const { getDb } = await import("../../src/server/db.js");
  const { signSession } = await import("../../src/server/auth.js");
  db = getDb();
  for (const organizationId of ["org-settings", "org-other"]) {
    await db.organization.create({ data: { id: organizationId, name: organizationId } });
  }
  for (const identity of [
    { id: "builder", organizationId: "org-settings", role: "BUILDER" },
    { id: "reviewer", organizationId: "org-settings", role: "REVIEWER" },
    { id: "outsider", organizationId: "org-other", role: "ADMIN" },
    {
      id: "same-email-other",
      organizationId: "org-other",
      role: "BUILDER",
      email: "builder@example.test",
    },
  ] as const) {
    const userId = identity.email ?? identity.id + "@example.test";
    const context = { userId, organizationId: identity.organizationId, role: identity.role };
    await db.membership.create({ data: context });
    tokens[identity.id] = await signSession({ ...context, email: userId });
  }
  app = await (await import("../../src/server/app.js")).buildApp({ worker: false });
});
afterAll(async () => {
  await app?.close();
  await db?.$disconnect();
  referenceProvider.closeAllConnections();
  await new Promise<void>((resolve) => referenceProvider.close(() => resolve()));
  if (created && /^poros_settings_[a-f0-9]{32}$/.test(dbName))
    await control.$executeRawUnsafe('DROP DATABASE "' + dbName + '" WITH (FORCE)');
  await control.$disconnect();
});

const settings = "/api/settings/integrations";
const caller = (
  method: "GET" | "PUT" | "POST" | "DELETE",
  url: string,
  payload?: object,
  user = "builder",
) => app.inject({ method, url, payload, headers: { authorization: "Bearer " + tokens[user] } });

it("encrypts personal credentials, refuses host-internal URLs and never reads back a key", async () => {
  const initial = await caller("GET", settings);
  expect(initial.headers["cache-control"]).toBe("no-store");
  expect(initial.json().connections).toEqual([]);
  expect((await app.inject({ method: "GET", url: settings })).statusCode).toBe(401);
  for (const destination of [
    "https://127.0.0.1/v1",
    "http://127.0.0.1:1/v1",
    "https://[::ffff:127.0.0.1]/v1",
    "https://someone:pass@example.org/v1",
    "http://example.com/v1",
  ]) {
    expect(
      (
        await caller("PUT", settings + "/model", {
          apiKey: "test-settings-key",
          baseUrl: destination,
          model: "fixture-chat",
        })
      ).statusCode,
    ).toBe(400);
  }
  const saved = await caller("PUT", settings + "/model", {
    apiKey: "test-settings-key",
    baseUrl: baseUrl + "/",
    model: "fixture-chat",
  });
  expect(saved.statusCode).toBe(200);
  expect(saved.body).not.toContain("test-settings-key");
  expect(saved.json().connection).toMatchObject({
    verified: false,
    settings: { baseUrl, model: "fixture-chat" },
  });
  expect((await db.integrationConnection.findFirstOrThrow()).encryptedKey).not.toContain(
    "test-settings-key",
  );
  for (const user of ["reviewer", "outsider", "same-email-other"]) {
    expect((await caller("GET", settings, undefined, user)).json().connections).toEqual([]);
    expect((await caller("POST", settings + "/model/test", undefined, user)).statusCode).toBe(404);
  }
});

it("runs the real HTTP probe, pins approved model and blocks changed or unverified credentials", async () => {
  const verify = await caller("POST", settings + "/model/test");
  expect(verify.json()).toMatchObject({ passed: true, code: "OK" });
  expect(aliveRequests).toContain("fixture-chat");
  const generated = await caller("POST", "/api/agents/drafts", {
    description: "Caller-specific draft instruction",
    generationMode: "live",
  });
  expect(generated.statusCode).toBe(200);
  expect(generated.json().generation).toEqual({ origin: "MODEL", model: "fixture-chat" });
  expect(generated.json().agent.draftConfig.persona).toBe("Caller-specific draft instruction");
  const registered = await caller("POST", "/api/agents/drafts", {
    name: "Personal endpoint",
    config: { persona: "Approved fixture" },
  });
  const id = registered.json().agent.id;
  const grant = await caller("POST", "/api/agents/" + id + "/grants", {
    kind: "MODEL",
    name: "fixture-chat",
    source: "personal-openai-compatible:" + baseUrl,
    scopeNote: "Contract fixture",
  });
  expect(grant.statusCode).toBe(200);
  const publish = await caller("POST", "/api/agents/" + id + "/publish");
  expect(publish.statusCode).toBe(202);
  const approved = await caller(
    "POST",
    "/api/approvals/" + publish.json().approvalId + "/decision",
    { decision: "APPROVED" },
    "reviewer",
  );
  expect(approved.statusCode).toBe(200);
  expect(
    (
      await caller(
        "POST",
        "/api/tasks",
        { agentId: id, prompt: "reviewer cannot use builder's model" },
        "reviewer",
      )
    ).statusCode,
  ).toBe(409);
  const queued = await caller("POST", "/api/tasks", {
    agentId: id,
    prompt: "fixture to check binding",
  });
  expect(queued.statusCode).toBe(202);
  const { runTask } = await import("../../src/server/runner.js");
  const result = await runTask({ db, runtime: "gateway" }, queued.json().taskId);
  expect(result.status).toBe("SUCCEEDED");
  expect((await db.run.findUniqueOrThrow({ where: { id: result.runId } })).output).toBe(
    "custom model generation",
  );
  expect((await caller("GET", "/api/tasks", undefined, "reviewer")).json().tasks).toEqual([]);
  const gateway = createPersonalGateway({
    baseUrl,
    model: "fixture-chat",
    apiKey: "test-settings-key",
  });
  expect(createSemanticJudge(gateway)).not.toBeNull();
  const second = await caller("POST", "/api/tasks", {
    agentId: id,
    prompt: "rotate before execution",
  });
  expect(second.statusCode).toBe(202);
  await caller("PUT", settings + "/model", {
    apiKey: "test-settings-key",
    baseUrl,
    model: "upstream-needs-validation",
  });
  const blocked = await caller("POST", settings + "/model/test");
  expect(blocked.json()).toMatchObject({
    passed: false,
    code: "ACCOUNT_VALIDATION_REQUIRED",
    http: 503,
  });
  expect((await runTask({ db, runtime: "gateway" }, second.json().taskId)).status).toBe("BLOCKED");
  expect((await caller("DELETE", settings + "/model")).statusCode).toBe(200);
  expect((await caller("GET", settings)).json().connections).toEqual([]);
});

it("reports actual HTTP 401, 403, 429, 503 and timeout as failed model verification", async () => {
  for (const [http, code] of [
    [401, "AUTH_REJECTED"],
    [403, "AUTH_REJECTED"],
    [429, "RATE_LIMITED"],
    [503, "UPSTREAM_FAILURE"],
  ] as const) {
    const saved = await caller("PUT", settings + "/model", {
      apiKey: "test-settings-key",
      baseUrl,
      model: "fault-" + http,
    });
    expect(saved.statusCode).toBe(200);
    const tested = await caller("POST", settings + "/model/test");
    expect(tested.json()).toMatchObject({ passed: false, http, code });
    expect(aliveRequests).toContain("fault-" + http);
  }
  const saved = await caller("PUT", settings + "/model", {
    apiKey: "test-settings-key",
    baseUrl,
    model: "fault-timeout",
  });
  expect(saved.statusCode).toBe(200);
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  const timer = vi
    .spyOn(AbortSignal, "timeout")
    .mockImplementation((duration) => timeout(Math.min(duration, 250)));
  try {
    const tested = await caller("POST", settings + "/model/test");
    expect(tested.json()).toMatchObject({ passed: false, code: "TIMEOUT" });
    expect(aliveRequests).toContain("fault-timeout");
    expect((await caller("GET", settings)).json().connections[0]).toMatchObject({
      verified: false,
      testCode: "TIMEOUT",
    });
  } finally {
    timer.mockRestore();
    await caller("DELETE", settings + "/model");
  }
});

it("uses provider-specific credential headers and real endpoint contracts for Kdocs, IMA and TinyFish", async () => {
  const calls: Array<{ url: string; method?: string; headers: Headers; body?: unknown }> = [];
  // Vendor response contract fixtures. Actual provider accounts are not part of this test.
  const fetchVendor = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = {
      url: String(input),
      method: init?.method,
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(request);
    if (request.url.endsWith("/search_knowledge"))
      return Response.json({
        retcode: 0,
        data: {
          info_list: [
            {
              title: "Authorized matching article",
              highlight_content: "Verified excerpt fixture",
              media_id: "article-a",
            },
          ],
        },
      });
    if (request.url.includes("ima.qq.com"))
      return Response.json({
        retcode: 0,
        data: { info_list: [{ id: "knowledge-a", name: "Knowledge base" }] },
      });
    if (request.url.includes("api.search.tinyfish.ai"))
      return Response.json({ results: [{ title: "TinyFish", url: "https://www.tinyfish.ai/" }] });
    if (request.url.includes("api.fetch.tinyfish.ai"))
      return Response.json({
        results: [
          {
            title: "TinyFetch result",
            url: "https://www.tinyfish.ai/",
            text: "Extracted page text",
          },
        ],
      });
    if (request.url.includes("openapi.wps.cn")) {
      const message = request.body as { method: string; id?: number; params?: unknown };
      if (message.method === "initialize")
        return Response.json({ id: message.id, result: { protocolVersion: "2025-03-26" } });
      if (message.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      return Response.json({
        id: message.id,
        result: { content: [{ type: "text", text: "Cloud document" }] },
      });
    }
    throw new Error("Unexpected fixture URL");
  });
  try {
    for (const provider of ["kdocs", "ima", "tinyfish"]) {
      expect(
        (
          await caller("PUT", settings + "/" + provider, {
            apiKey: "fixture-" + provider,
            ...(provider === "ima" ? { clientId: "fixture-client" } : {}),
          })
        ).statusCode,
      ).toBe(200);
      const probe = await caller("POST", settings + "/" + provider + "/test");
      expect(probe.json(), provider + " connection check").toMatchObject({
        passed: true,
        code: "OK",
      });
      expect(
        (
          await caller("POST", settings + "/" + provider + "/use", {
            action: "search",
            input: "Poros",
          })
        ).json().items,
      ).toHaveLength(1);
    }
    expect(
      (
        await caller("POST", settings + "/tinyfish/use", {
          action: "fetch",
          input: "https://127.0.0.1/",
        })
      ).statusCode,
    ).toBe(422);
    expect(calls.find((c) => c.url.includes("ima.qq.com"))?.headers.get("ima-openapi-apikey")).toBe(
      "fixture-ima",
    );
    expect(
      calls.find((c) => c.url.includes("api.search.tinyfish.ai"))?.headers.get("x-api-key"),
    ).toBe("fixture-tinyfish");
    const kdocs = calls.find((c) => (c.body as { method?: string })?.method === "tools/call");
    expect(kdocs?.headers.get("authorization")).toBe("Bearer fixture-kdocs");
    expect(kdocs?.body).toMatchObject({ params: { name: "kso_yundoc_search_yundoc" } });
    expect((await caller("GET", settings)).body).not.toContain("fixture-client");
    const { connectors } = await import("../../src/server/capability-catalog.js");
    const { brokerRuntime, freezeCapabilityConnections } =
      await import("../../src/server/capabilities.js");
    const { assertTaskAccess } = await import("../../src/server/task-access.js");
    const owner = { userId: "builder@example.test", organizationId: "org-settings" };
    const grants = connectors.map((connector) => ({
      kind: connector.kind,
      name: connector.capability,
      source: connector.source,
      version: connector.version,
    }));
    const foreign = { userId: "reviewer@example.test", organizationId: owner.organizationId };
    await expect(freezeCapabilityConnections(db, foreign, grants, null)).rejects.toThrow(
      /需要发起人/,
    );
    const revisions = await freezeCapabilityConnections(db, owner, grants, null);
    const task = await db.task.create({
      data: {
        organizationId: owner.organizationId,
        createdBy: owner.userId,
        title: "Broker wire contract",
        prompt: "Evidence from permitted sources",
        executionSnapshot: { grants },
        connectionRevisions: revisions,
      },
    });
    const events: Array<{ kind: string; value: unknown }> = [];
    const broker = await brokerRuntime(
      db,
      task,
      grants,
      async () => {
        await assertTaskAccess(db, task);
      },
      async (kind, value) => {
        events.push({ kind, value });
      },
    );
    const signal = AbortSignal.timeout(10000);
    for (const [name, args, expected] of [
      ["kdocs_search", { query: "cloud docs" }, "Cloud document"],
      ["kdocs_read", { file_id: "file-a", drive_id: "drive-a" }, "Cloud document"],
      ["ima_list", { query: "" }, "knowledge-a"],
      [
        "ima_search",
        { query: "matching article", knowledge_base_id: "knowledge-a" },
        "Verified excerpt fixture",
      ],
      ["web_search", { query: "Poros" }, "TinyFish"],
      ["web_fetch", { url: "https://www.tinyfish.ai/" }, "Extracted page text"],
    ] as const) {
      const outcome = await broker.invoke(name, args, signal);
      expect(outcome).toMatchObject({ ok: true });
      expect(JSON.stringify(outcome)).toContain(expected);
      expect(JSON.stringify(outcome)).not.toMatch(/fixture-(kdocs|ima|tinyfish|client)/);
    }
    expect(
      calls.some(
        (c) =>
          (c.body as { params?: { name?: string } })?.params?.name ===
          "kso_yundoc_extract_yundoc_content",
      ),
    ).toBe(true);
    expect(events.filter((event) => event.kind === "capability.result")).toHaveLength(6);
    const recorded = calls.length;
    expect(await broker.invoke("unknown", {}, signal)).toMatchObject({ ok: false });
    expect(await broker.invoke("web_search", { url: "unexpected argument" }, signal)).toMatchObject(
      { ok: false },
    );
    expect(calls).toHaveLength(recorded);
    await caller("DELETE", settings + "/kdocs");
    expect(
      await broker.invoke("kdocs_read", { file_id: "file-a", drive_id: "drive-a" }, signal),
    ).toMatchObject({ ok: false });
    expect(calls).toHaveLength(recorded);
  } finally {
    fetchVendor.mockRestore();
  }
});
