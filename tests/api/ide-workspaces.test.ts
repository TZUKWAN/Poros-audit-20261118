import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomUUID, generateKeyPairSync, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { executeIdeJob } from "../../src/server/ide/engine.js";
import { sourceDigest } from "../../src/agent-project/files.js";
import { createServer } from "node:http";
import { compileProject } from "../../src/agent-project/compiler.js";
import { parseProject, starterProject } from "../../src/agent-project/contract.js";
import { createPackage } from "../../src/agent-project/package.js";
import { stop } from "esbuild";

const name = "poros_ide_" + randomUUID().replaceAll("-", "");
let db: PrismaClient,
  control: PrismaClient,
  app: FastifyInstance,
  root = "";
const tokens: Record<string, string> = {};
beforeAll(async () => {
  const { PrismaClient } = await import("@prisma/client");
  const url = new URL(
    process.env.DATABASE_URL ||
      "postgresql://poros:change-me-strong-password@127.0.0.1:55432/poros",
  );
  url.pathname = "/postgres";
  control = new PrismaClient({ datasources: { db: { url: url.href } } });
  await control.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  url.pathname = "/" + name;
  process.env.DATABASE_URL = url.href;
  process.env.JWT_SECRET ||= randomUUID();
  process.env.POROS_RUNTIME = "gateway";
  process.env.MODEL_GATEWAY = "mock";
  process.env.LOG_LEVEL = "silent";
  root = await mkdtemp(path.join(tmpdir(), "poros-ide-workspaces-"));
  process.env.POROS_WORKSPACE_ROOT = root;
  process.env.POROS_RELEASE_ROOT = path.join(root, "publisher");
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], {
    env: process.env,
    stdio: "pipe",
  });
  const { seedForTests } = await import("../../src/server/seed.js");
  await seedForTests();
  const { getDb } = await import("../../src/server/db.js");
  db = getDb();
  const { buildApp } = await import("../../src/server/app.js");
  app = await buildApp({ worker: false });
  for (const role of ["builder", "admin", "employee", "outsider"]) {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        organizationId: role === "outsider" ? "org-b" : "org-a",
        email: role + (role === "outsider" ? "@b.test" : "@a.test"),
        password: role + "-pass-123",
      },
    });
    tokens[role] = response.json().token;
  }
}, 120000);
afterAll(async () => {
  await app?.close();
  stop();
  if (db) await (await import("../../src/server/db.js")).closeDb();
  if (control) {
    await control.$executeRawUnsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
    await control.$disconnect();
  }
  if (root) await rm(root, { recursive: true, force: true });
});
describe("IDE workspaces and source CAS", () => {
  it("persists actual three-kind engineering projects and never shares an owner's source", async () => {
    const headers = { authorization: "Bearer " + tokens.builder };
    for (const kind of ["AGENT", "SKILL", "MCP"]) {
      const created = await app.inject({
        method: "POST",
        url: "/api/ide/workspaces",
        headers,
        payload: { kind, name: "Contract " + kind },
      });
      expect(created.statusCode, created.body).toBe(201);
      const id = created.json().workspace.id,
        route = "/api/ide/workspaces/" + id;
      const detail = await app.inject({ method: "GET", url: route, headers });
      expect(detail.statusCode).toBe(200);
      const { workspace, files } = detail.json();
      expect(files["poros.json"]).toContain(kind);
      for (const role of ["admin", "outsider"])
        expect(
          (
            await app.inject({
              method: "GET",
              url: route,
              headers: { authorization: "Bearer " + tokens[role] },
            })
          ).statusCode,
        ).toBe(role === "outsider" ? 403 : 404);
      const changed = await app.inject({
        method: "PUT",
        url: route + "/source",
        headers,
        payload: {
          expectedDigest: workspace.sourceDigest,
          files: { ...files, "notes.md": "Real revision" },
        },
      });
      expect(changed.statusCode, changed.body).toBe(200);
      expect(changed.json().digest).not.toBe(workspace.sourceDigest);
      const stale = await app.inject({
        method: "PUT",
        url: route + "/source",
        headers,
        payload: { expectedDigest: workspace.sourceDigest, files },
      });
      expect(stale.statusCode).toBe(409);
      expect(
        (await app.inject({ method: "GET", url: route, headers })).json().files["notes.md"],
      ).toBe("Real revision");
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/ide/workspaces",
          headers: { authorization: "Bearer " + tokens.employee },
          payload: { name: "No authority" },
        })
      ).statusCode,
    ).toBe(403);
  });
  it("builds and runs real source, keeps a prior preview on compile failure, and distinguishes failed evaluations", async () => {
    const headers = { authorization: "Bearer " + tokens.builder };
    const created = await app.inject({
      method: "POST",
      url: "/api/ide/workspaces",
      headers,
      payload: { kind: "AGENT", name: "Actual multiply" },
    });
    const id = created.json().workspace.id,
      url = "/api/ide/workspaces/" + id;
    let detail = (await app.inject({ method: "GET", url, headers })).json();
    const files = {
      ...detail.files,
      "agent.ts":
        'import {defineAgent} from "@poros/sdk"; export default defineAgent(async(input,ctx)=>({value:Number(input)*3,read:await ctx.asset("README.md")}));',
    };
    const saved = await app.inject({
      method: "PUT",
      url: url + "/source",
      headers,
      payload: { expectedDigest: detail.workspace.sourceDigest, files },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const perform = async (kind: string, input: Record<string, unknown> = {}, buildId?: string) => {
      detail = (await app.inject({ method: "GET", url, headers })).json();
      const key = randomUUID();
      const body = { kind, input, expectedDigest: detail.workspace.sourceDigest, buildId };
      const receipt = await app.inject({
        method: "POST",
        url: url + "/jobs",
        headers: { ...headers, "idempotency-key": key },
        payload: body,
      });
      expect(receipt.statusCode, receipt.body).toBe(202);
      const repeated = await app.inject({
        method: "POST",
        url: url + "/jobs",
        headers: { ...headers, "idempotency-key": key },
        payload: body,
      });
      expect(repeated.json().job.id).toBe(receipt.json().job.id);
      const running = await db.ideJob.update({
        where: { id: receipt.json().job.id },
        data: { status: "RUNNING" },
      });
      await executeIdeJob(db, running, new AbortController().signal);
      return db.ideJob.findUniqueOrThrow({ where: { id: running.id } });
    };
    const built = await perform("BUILD");
    expect(built.status, JSON.stringify(built.output)).toBe("SUCCEEDED");
    const buildId = (built.output as { buildId: string }).buildId;
    const executed = await perform("RUN", { input: 7 }, buildId);
    expect(executed.status, JSON.stringify(executed.output)).toBe("SUCCEEDED");
    expect(executed.output).toMatchObject({
      result: { value: 21, read: files["README.md"] },
      verification: "NOT_EVALUATED",
    });
    const bad = { ...files, "agent.ts": 'const wrong: number="bad";export default()=>wrong;' };
    await app.inject({
      method: "PUT",
      url: url + "/source",
      headers,
      payload: { expectedDigest: sourceDigest(files), files: bad },
    });
    expect((await perform("BUILD")).status).toBe("FAILED");
    const after = (await app.inject({ method: "GET", url, headers })).json();
    expect(after.workspace.latestBuildId).toBe(buildId);
    expect(
      (await app.inject({ method: "GET", url: `${url}/builds/${buildId}/preview`, headers })).json()
        .sourceDigest,
    ).toBe(sourceDigest(files));
    const assertions = {
      ...files,
      "tests/cases.json": JSON.stringify([
        { name: "actual assertion", input: 7, expected: { value: 22 } },
      ]),
    };
    assertions["poros.json"] = JSON.stringify({
      ...JSON.parse(files["poros.json"]),
      tests: "tests/cases.json",
    });
    await app.inject({
      method: "PUT",
      url: url + "/source",
      headers,
      payload: { expectedDigest: after.workspace.sourceDigest, files: assertions },
    });
    const evaluated = await perform("TEST");
    expect(evaluated.status, JSON.stringify(evaluated.output)).toBe("FAILED");
    expect(evaluated.output).toMatchObject({ evaluation: { status: "FAILED" } });
  }, 120000);
  it("uses real DSH workspace tools to modify, encounter a compiler error, repair and evaluate (explicit MODEL protocol fixture)", async () => {
    const headers = { authorization: "Bearer " + tokens.builder };
    const created = await app.inject({
      method: "POST",
      url: "/api/ide/workspaces",
      headers,
      payload: { name: "Development loop" },
    });
    const id = created.json().workspace.id,
      url = "/api/ide/workspaces/" + id;
    const detail = (await app.inject({ method: "GET", url, headers })).json();
    const wrongFiles = {
      ...detail.files,
      "agent.ts": 'const wrong: number="bad";export default()=>wrong;',
      "tests/cases.json": JSON.stringify([{ name: "multiply", input: 7, expected: 21 }]),
    };
    wrongFiles["poros.json"] = JSON.stringify({
      ...JSON.parse(detail.files["poros.json"]),
      tests: "tests/cases.json",
    });
    const calls = [
      { name: "workspace_read", arguments: { path: "poros.json", offset: "0" } },
      {
        name: "workspace_patch",
        arguments: {
          expectedDigest: detail.workspace.sourceDigest,
          files: JSON.stringify({
            "agent.ts": wrongFiles["agent.ts"],
            "poros.json": wrongFiles["poros.json"],
            "tests/cases.json": wrongFiles["tests/cases.json"],
          }),
        },
      },
      { name: "workspace_build", arguments: {} },
      {
        name: "workspace_patch",
        arguments: {
          expectedDigest: sourceDigest(wrongFiles),
          files: JSON.stringify({
            "agent.ts":
              'import {defineAgent} from "@poros/sdk";export default defineAgent(input=>Number(input)*3);',
          }),
        },
      },
      { name: "workspace_build", arguments: {} },
      { name: "workspace_test", arguments: {} },
    ];
    const key = randomUUID();
    let requests = 0;
    const provider = createServer(async (req, res) => {
      if (req.headers.authorization !== "Bearer " + key) {
        res.writeHead(401).end();
        return;
      }
      let text = "";
      for await (const chunk of req) text += chunk;
      const input = JSON.parse(text) as { messages: Array<{ role: string; content?: unknown }> };
      const content = input.messages[0]?.content;
      const probe =
        input.messages.length === 1 && typeof content === "string"
          ? content.match(/^Output this verification code alone: (POROS-[0-9a-f]{8})$/)?.[1]
          : null;
      const completed = input.messages.filter((message) => message.role === "tool").length;
      const call = probe ? null : calls[completed];
      if (!probe) requests++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta: unknown, finish_reason: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({ id: "explicit-model-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      if (call) {
        send({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call-" + completed,
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
            probe || "Explicit MODEL protocol fixture: inspect actual source/build/test records.",
        });
        send({}, "stop");
      }
      res.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const baseUrl = "http://127.0.0.1:" + (provider.address() as { port: number }).port + "/v1";
    process.env.POROS_LOCAL_MODEL_BASES = baseUrl;
    try {
      expect(
        (
          await app.inject({
            method: "PUT",
            url: "/api/settings/integrations/model",
            headers,
            payload: { apiKey: key, baseUrl, model: "ide-wire-contract" },
          })
        ).statusCode,
      ).toBe(200);
      const verified = await app.inject({
        method: "POST",
        url: "/api/settings/integrations/model/test",
        headers,
      });
      expect(verified.json().passed, verified.body).toBe(true);
      const queued = await app.inject({
        method: "POST",
        url: url + "/jobs",
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          kind: "DEVELOP",
          expectedDigest: detail.workspace.sourceDigest,
          input: { prompt: "Implement multiply with a real test and fix any compiler failure." },
        },
      });
      expect(queued.statusCode, queued.body).toBe(202);
      const running = await db.ideJob.update({
        where: { id: queued.json().job.id },
        data: { status: "RUNNING" },
      });
      await executeIdeJob(db, running, AbortSignal.timeout(240000));
      const finished = await db.ideJob.findUniqueOrThrow({ where: { id: running.id } });
      expect(
        finished.status,
        JSON.stringify(finished.output) + JSON.stringify(finished.events).slice(-6000),
      ).toBe("SUCCEEDED");
      expect(finished.output).toMatchObject({ evaluation: { status: "PASSED" } });
      expect(JSON.stringify(finished.events)).toContain("not assignable");
      const final = (await app.inject({ method: "GET", url, headers })).json();
      expect(final.files["agent.ts"]).toContain("Number(input)*3");
      expect(requests).toBeGreaterThanOrEqual(7);
    } finally {
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }
  }, 270000);
  it("uses one-use preview tickets without sharing IDE credentials and revokes unused tickets with the session", async () => {
    const headers = { authorization: "Bearer " + tokens.builder };
    const created = await app.inject({
      method: "POST",
      url: "/api/ide/workspaces",
      headers,
      payload: { name: "Preview boundary" },
    });
    const id = created.json().workspace.id,
      url = "/api/ide/workspaces/" + id;
    const { buildWorkspace } = await import("../../src/server/ide/engine.js");
    const built = await buildWorkspace(db, id);
    expect(built.status).toBe("READY");
    const ticket = await app.inject({
      method: "POST",
      url: url + "/builds/" + built.id + "/preview-ticket",
      headers,
    });
    expect(ticket.statusCode, ticket.body).toBe(200);
    const frame = await app.inject({ method: "GET", url: ticket.json().url });
    expect(frame.statusCode, frame.body.slice(0, 100)).toBe(200);
    expect(frame.headers["content-security-policy"]).toContain("sandbox allow-scripts");
    expect(frame.headers["content-security-policy"]).toContain("frame-ancestors 'self'");
    expect(frame.body).not.toContain(tokens.builder);
    expect(frame.body).toContain("connect-src 'none'");
    expect((await app.inject({ method: "GET", url: ticket.json().url })).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: url + "/builds/" + built.id + "/preview-ticket",
          headers: { authorization: "Bearer " + tokens.admin },
        })
      ).statusCode,
    ).toBe(404);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "builder@a.test", password: "builder-pass-123", organizationId: "org-a" },
    });
    const transient = { authorization: "Bearer " + login.json().token };
    const revoked = await app.inject({
      method: "POST",
      url: url + "/builds/" + built.id + "/preview-ticket",
      headers: transient,
    });
    expect(revoked.statusCode).toBe(200);
    await app.inject({ method: "POST", url: "/api/auth/logout", headers: transient });
    expect((await app.inject({ method: "GET", url: revoked.json().url })).statusCode).toBe(403);
    const exported = await app.inject({
      method: "POST",
      url: url + "/releases",
      headers,
      payload: { buildId: built.id },
    });
    expect(exported.statusCode, exported.body.slice(0, 100)).toBe(200);
    expect(exported.json().package.payload.sourceDigest).toBe(built.sourceDigest);
    expect(JSON.stringify(exported.json().package)).not.toContain(tokens.builder);
  });
  it("assembles real Skill/scripts/MCP with a credentialed HTTP fixture, passes positive/boundary cases, and rejects missing consent or revoked credentials", async () => {
    const headers = { authorization: "Bearer " + tokens.builder },
      apiKey = randomUUID();
    let businessCalls = 0;
    const service = createServer((req, res) => {
      if (req.headers.authorization !== "Bearer " + apiKey) {
        res.writeHead(401).end();
        return;
      }
      res.setHeader("content-type", "application/json");
      if (req.url === "/health") {
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      businessCalls++;
      const id = req.url?.split("/").pop();
      res.end(
        JSON.stringify({
          id,
          found: id === "7",
          ...(id === "7" ? { subject: "Explicit HTTP fixture ticket" } : {}),
        }),
      );
    });
    await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
    const baseUrl = "http://127.0.0.1:" + (service.address() as { port: number }).port;
    process.env.POROS_LOCAL_API_BASES = baseUrl;
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/ide/workspaces",
        headers,
        payload: { name: "Capability composition" },
      });
      const id = created.json().workspace.id,
        url = "/api/ide/workspaces/" + id;
      const privateKey = generateKeyPairSync("ed25519")
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString();
      let detail = (await app.inject({ method: "GET", url, headers })).json();
      for (const kind of ["SKILL", "MCP"] as const) {
        const files = starterProject(kind, kind + " explicit contract fixture");
        if (kind === "SKILL") {
          files["skills/custom-skill/SKILL.md"] +=
            "\nexact-boundary: missing tickets must be NOT_FOUND.\n";
          files["skills/custom-skill/scripts/report.ts"] =
            'export default (input:unknown)=>{const v=input as {ticket:{id:string;found:boolean;subject?:string};policy:boolean};return {id:v.ticket.id,found:v.ticket.found,label:v.ticket.found?v.ticket.subject:"NOT_FOUND",policy:v.policy};};';
        } else {
          files["mcp.ts"] =
            'import {defineMcp} from "@poros/sdk";export default defineMcp({name:"fixture-helpdesk",tools:{ticket:{description:"Actual authenticated HTTP contract fixture",inputSchema:{type:"object",properties:{id:{type:"string"}},required:["id"],additionalProperties:false},async handler(args,ctx){return ctx.http("helpdesk:/tickets/"+encodeURIComponent(String(args.id)));}}}});';
          const manifest = parseProject(files);
          manifest.permissions = ["api:helpdesk"];
          files["poros.json"] = JSON.stringify(manifest);
        }
        const build = await compileProject(files);
        expect(build.status, build.diagnostics.join("\n")).toBe("READY");
        const pkg = createPackage({ appIdentity: kind, files, ...build, privateKey });
        const imported = await app.inject({
          method: "POST",
          url: url + "/import-capability",
          headers,
          payload: { expectedDigest: detail.workspace.sourceDigest, package: pkg },
        });
        expect(imported.statusCode, imported.body).toBe(200);
        detail = (await app.inject({ method: "GET", url, headers })).json();
      }
      const files = { ...detail.files },
        manifest = parseProject(files),
        server = manifest.mcp[0]!.name;
      const script = "skills/custom-skill/scripts/report.ts",
        tool = "mcp:" + server + ":ticket";
      manifest.permissions = [...new Set([...manifest.permissions, tool, "script:" + script])];
      manifest.tests = "tests/cases.json";
      files["poros.json"] = JSON.stringify(manifest);
      files["agent.ts"] =
        'import {defineAgent} from "@poros/sdk";export default defineAgent(async(input,ctx)=>{const policy=await ctx.skill("custom-skill");const result=await ctx.tool(' +
        JSON.stringify(tool) +
        ",{id:String(input)}) as {structuredContent:unknown};return ctx.script(" +
        JSON.stringify(script) +
        ',{ticket:result.structuredContent,policy:policy.includes("exact-boundary")});});';
      files["tests/cases.json"] = JSON.stringify([
        {
          name: "actual positive HTTP fixture",
          input: "7",
          expected: { id: "7", found: true, label: "Explicit HTTP fixture ticket", policy: true },
        },
        {
          name: "missing ticket boundary",
          input: "404",
          expected: { id: "404", found: false, label: "NOT_FOUND", policy: true },
        },
      ]);
      expect(
        (
          await app.inject({
            method: "PUT",
            url: url + "/source",
            headers,
            payload: { expectedDigest: detail.workspace.sourceDigest, files },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: "PUT",
            url: url + "/settings",
            headers,
            payload: { runtimeModel: "inherit", authorizedTools: manifest.permissions },
          })
        ).statusCode,
      ).toBe(200);
      const connection = url + "/connections/api/helpdesk";
      const saved = await app.inject({
        method: "PUT",
        url: connection,
        headers,
        payload: { baseUrl, token: apiKey, testPath: "/health" },
      });
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.body).not.toContain(apiKey);
      const verified = await app.inject({ method: "POST", url: connection + "/test", headers });
      expect(verified.json().passed, verified.body).toBe(true);
      const perform = async (
        kind: string,
        input: Record<string, unknown>,
        buildId?: string,
        before?: () => Promise<void>,
      ) => {
        detail = (await app.inject({ method: "GET", url, headers })).json();
        const queued = await app.inject({
          method: "POST",
          url: url + "/jobs",
          headers: { ...headers, "idempotency-key": randomUUID() },
          payload: { kind, input, buildId, expectedDigest: detail.workspace.sourceDigest },
        });
        expect(queued.statusCode, queued.body).toBe(202);
        await before?.();
        const job = await db.ideJob.update({
          where: { id: queued.json().job.id },
          data: { status: "RUNNING" },
        });
        await executeIdeJob(db, job, AbortSignal.timeout(90000));
        return db.ideJob.findUniqueOrThrow({ where: { id: job.id } });
      };
      const evaluated = await perform("TEST", { consent: manifest.permissions });
      expect(evaluated.status, JSON.stringify(evaluated.output)).toBe("SUCCEEDED");
      expect(evaluated.output).toMatchObject({
        evaluation: { status: "PASSED", cases: [{ passed: true }, { passed: true }] },
      });
      expect(businessCalls).toBe(2);
      const buildId = (evaluated.output as { buildId: string }).buildId;
      const denied = await perform("RUN", { input: "7", consent: [] }, buildId);
      expect(denied.status).toBe("FAILED");
      expect(JSON.stringify(denied.output)).toContain("需要工程声明");
      expect(businessCalls).toBe(2);
      const revoked = await perform(
        "RUN",
        { input: "7", consent: manifest.permissions },
        buildId,
        async () => {
          await app.inject({ method: "DELETE", url: connection, headers });
        },
      );
      expect(revoked.status).toBe("FAILED");
      expect(JSON.stringify(revoked.output)).toContain("已更换或已撤销");
      expect(businessCalls).toBe(2);
      expect(
        JSON.stringify([evaluated.events, evaluated.output, denied.events, revoked.events]),
      ).not.toContain(apiKey);
    } finally {
      service.closeAllConnections();
      await new Promise<void>((resolve) => service.close(() => resolve()));
    }
  }, 150000);
});

const windowsDelivery =
  process.platform === "win32" && process.env.POROS_WINDOWS_DELIVERY_ACCEPTANCE === "1"
    ? it
    : it.skip;
windowsDelivery(
  "creates a real Windows installer through an IDE job and streams a private revocable one-use download",
  async () => {
    const headers = { authorization: "Bearer " + tokens.builder };
    const created = (
        await app.inject({
          method: "POST",
          url: "/api/ide/workspaces",
          headers,
          payload: { kind: "AGENT", name: "IDE 安装构建验收" },
        })
      ).json(),
      id = created.workspace.id,
      base = "/api/ide/workspaces/" + id;
    let detail = (await app.inject({ url: base, headers })).json();
    const files = {
      ...detail.files,
      "agent.ts":
        'import{defineAgent}from"@poros/sdk";export default defineAgent(input=>Number(input)*3);',
    };
    expect(
      (
        await app.inject({
          method: "PUT",
          url: base + "/source",
          headers,
          payload: { expectedDigest: detail.workspace.sourceDigest, files },
        })
      ).statusCode,
    ).toBe(200);
    const perform = async (kind: string, buildId?: string) => {
      detail = (await app.inject({ url: base, headers })).json();
      const response = await app.inject({
        method: "POST",
        url: base + "/jobs",
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: { kind, input: {}, expectedDigest: detail.workspace.sourceDigest, buildId },
      });
      expect(response.statusCode, response.body).toBe(202);
      const job = await db.ideJob.update({
        where: { id: response.json().job.id },
        data: { status: "RUNNING" },
      });
      await executeIdeJob(db, job, new AbortController().signal);
      return db.ideJob.findUniqueOrThrow({ where: { id: job.id } });
    };
    const built = await perform("BUILD");
    expect(built.status, JSON.stringify(built.output)).toBe("SUCCEEDED");
    const buildId = (built.output as { buildId: string }).buildId;
    const packed = await perform("PACKAGE", buildId);
    expect(packed.status, JSON.stringify(packed.output)).toBe("SUCCEEDED");
    const output = packed.output as {
      installer: { bytes: number; sha256: string; windowsSignatureStatus: string };
    };
    expect(output.installer.bytes).toBeGreaterThan(100000000);
    expect(output.installer.windowsSignatureStatus).toBeTruthy();
    const ticketRoute = base + "/jobs/" + packed.id + "/installer-ticket";
    expect(
      (
        await app.inject({
          method: "POST",
          url: ticketRoute,
          headers: { authorization: "Bearer " + tokens.outsider },
        })
      ).statusCode,
    ).toBe(403);
    const ticket = (await app.inject({ method: "POST", url: ticketRoute, headers })).json();
    expect(ticket.url).not.toContain(tokens.builder);
    const address = await app.listen({ host: "127.0.0.1", port: 0 }),
      response = await fetch(address + ticket.url);
    expect(response.status).toBe(200);
    expect(Number(response.headers.get("content-length"))).toBe(output.installer.bytes);
    const hash = createHash("sha256");
    let bytes = 0;
    const reader = response.body!.getReader();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      hash.update(chunk.value);
      bytes += chunk.value.length;
    }
    expect(bytes).toBe(output.installer.bytes);
    expect(hash.digest("hex")).toBe(output.installer.sha256);
    expect((await fetch(address + ticket.url)).status).toBe(403);
    const revoked = (await app.inject({ method: "POST", url: ticketRoute, headers })).json();
    const ticketId = createHash("sha256").update(revoked.url.split("/").at(-1)).digest("hex"),
      record = await db.downloadTicket.findUniqueOrThrow({ where: { id: ticketId } });
    await db.authSession.update({
      where: { id: record.sessionId },
      data: { revokedAt: new Date() },
    });
    expect((await fetch(address + revoked.url)).status).toBe(403);
  },
  300000,
);
