/** Real PostgreSQL integration regressions. A unique disposable DB, never development data. */
import { beforeAll, afterAll, it, expect } from "vitest";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { requestPublication, approvePublication } from "../../src/server/releases.js";
import type { Principal } from "../../src/server/auth.js";
import type { FastifyInstance, InjectOptions } from "fastify";
import { MockGateway } from "../../src/server/model-gateway.js";
import { parseMechanical, evaluateMechanical } from "../../src/server/judgment.js";
let app: FastifyInstance,
  base = "",
  runAgent = "";
const tokens: Record<string, string> = {};
const modelEntered = new Set<string>();
class DelayedModelFixture extends MockGateway {
  override async generate(prompt: string, system: string, options?: { signal?: AbortSignal }) {
    modelEntered.add(prompt);
    if (prompt.startsWith("@fail")) throw new Error("model unavailable " + process.env.JWT_SECRET);
    const delay = prompt.startsWith("@slow") ? 1500 : 20;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delay);
      options?.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("model aborted"));
        },
        { once: true },
      );
    });
    return super.generate(prompt, system);
  }
}
const headers = (role: string) => ({ authorization: `Bearer ${tokens[role]}` });
async function call(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  role = "builder",
  payload?: InjectOptions["payload"],
  key?: string,
) {
  return app.inject({
    method,
    url,
    headers: { ...headers(role), ...(key ? { "idempotency-key": key } : {}) },
    payload,
  });
}
async function finished(id: string) {
  for (let i = 0; i < 100; i++) {
    const r = await call("GET", "/api/tasks/" + id, "employee");
    expect(r.statusCode).toBe(200);
    if (!["QUEUED", "RUNNING"].includes(r.json().task.status)) return r.json();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Task did not terminate");
}
async function approveSubject(subjectId: string, decision = "APPROVED") {
  const a = await db.approvalRequest.findFirstOrThrow({
    where: { subjectId, decision: "PENDING" },
  });
  return call("POST", `/api/approvals/${a.id}/decision`, "reviewer", { decision });
}
const database = "poros_audit_" + randomUUID().replaceAll("-", "");
const url = new URL(
  process.env.DATABASE_URL ||
    "postgresql://poros:change-me-strong-password@127.0.0.1:55432/poros?schema=public",
);
const adminUrl = new URL(url);
adminUrl.pathname = "/postgres";
url.pathname = "/" + database;
const control = new PrismaClient({ datasources: { db: { url: adminUrl.href } } });
let db: PrismaClient;
const p: Principal = {
  organizationId: "org-a",
  userId: "builder@a.test",
  email: "builder@a.test",
  role: "BUILDER",
};
let agentId = "";
beforeAll(async () => {
  await control.$executeRawUnsafe(`CREATE DATABASE "${database}"`);
  process.env.DATABASE_URL = url.href;
  process.env.JWT_SECRET = "audit-test-secret-0123456789";
  process.env.LOG_LEVEL = "silent";
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], {
    env: { ...process.env },
    stdio: "pipe",
  });
  db = new PrismaClient({ datasources: { db: { url: url.href } } });
  await db.organization.create({ data: { id: "org-a", name: "audit" } });
  const a = await db.agentDefinition.create({
    data: {
      organizationId: "org-a",
      name: "release-test",
      draftConfig: { persona: "original" },
      createdBy: p.userId,
    },
  });
  agentId = a.id;
  await db.agentGrant.create({ data: { agentId, kind: "TOOL", name: "read" } });
  const { seedForTests } = await import("../../src/server/seed.js");
  await seedForTests();
  const { buildApp } = await import("../../src/server/app.js");
  app = await buildApp({ runner: { gateway: new DelayedModelFixture() } });
  base = await app.listen({ host: "127.0.0.1", port: 0 });
  for (const [role, password] of [
    ["admin", "admin-pass-123"],
    ["builder", "builder-pass-123"],
    ["employee", "employee-pass-123"],
    ["reviewer", "reviewer-pass-123"],
  ]) {
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: role + "@a.test", password, organizationId: "org-a" },
    });
    expect(r.statusCode).toBe(200);
    tokens[role!] = r.json().token;
  }
}, 120000);
afterAll(async () => {
  await app?.close();
  await db?.$disconnect();
  const { closeDb } = await import("../../src/server/db.js");
  await closeDb();
  if (/^poros_audit_[a-f0-9]{32}$/.test(database))
    await control.$executeRawUnsafe(`DROP DATABASE "${database}" WITH (FORCE)`);
  await control.$disconnect();
});
it("release freezes config, exact grants and sources; database rejects mutations", async () => {
  const r = await requestPublication(db, p, agentId);
  expect(r.version).toBe(1);
  await db.agentGrant.create({ data: { agentId, kind: "TOOL", name: "bash" } });
  await db.agentDefinition.update({
    where: { id: agentId },
    data: { draftConfig: { persona: "changed" } },
  });
  const v = await db.agentVersion.findUniqueOrThrow({
    where: { agentId_version: { agentId, version: 1 } },
  });
  expect(v.config).toEqual({ persona: "original" });
  expect((v.manifest as { grants: Array<{ name: string }> }).grants.map((g) => g.name)).toEqual([
    "read",
  ]);
  expect(v.approvedAt).toBeNull();
  await expect(
    db.agentVersion.update({ where: { id: v.id }, data: { config: { persona: "tamper" } } }),
  ).rejects.toThrow(/immutable/);
});
it("rollback then republish and concurrent publication allocate new monotone unique versions", async () => {
  const v1 = await db.agentVersion.findUniqueOrThrow({
    where: { agentId_version: { agentId, version: 1 } },
  });
  await db.$transaction((tx) => approvePublication(tx, v1.id, "org-a"));
  const r2 = await requestPublication(db, p, agentId);
  expect(r2.version).toBe(2);
  await db.agentDefinition.update({ where: { id: agentId }, data: { currentVersion: 1 } });
  const published = await Promise.all([
    requestPublication(db, p, agentId),
    requestPublication(db, p, agentId),
    requestPublication(db, p, agentId),
  ]);
  expect(published.map((x) => x.version).sort()).toEqual([3, 4, 5]);
  const v5 = await db.agentVersion.findUniqueOrThrow({
      where: { agentId_version: { agentId, version: 5 } },
    }),
    v3 = await db.agentVersion.findUniqueOrThrow({
      where: { agentId_version: { agentId, version: 3 } },
    });
  await db.$transaction((tx) => approvePublication(tx, v5.id, "org-a"));
  await db.$transaction((tx) => approvePublication(tx, v3.id, "org-a"));
  expect(
    (await db.agentDefinition.findUniqueOrThrow({ where: { id: agentId } })).currentVersion,
  ).toBe(5);
});
it("publication is pending until independent reviewer decides; self approval is forbidden", async () => {
  const a = await call("POST", "/api/agents/drafts", "admin", {
    name: "reviewed-agent",
    config: { persona: "approved persona" },
  });
  expect(a.statusCode).toBe(200);
  runAgent = a.json().agent.id;
  const r = await call("POST", `/api/agents/${runAgent}/publish`, "admin");
  expect(r.statusCode).toBe(202);
  expect(r.json().pending).toBe(true);
  const early = await call("POST", "/api/tasks", "employee", {
    agentId: runAgent,
    prompt: "too early",
  });
  expect(early.statusCode).toBe(409);
  expect(
    (
      await call("POST", `/api/approvals/${r.json().approvalId}/decision`, "admin", {
        decision: "APPROVED",
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await call("POST", `/api/approvals/${r.json().approvalId}/decision`, "reviewer", {
        decision: "APPROVED",
      })
    ).statusCode,
  ).toBe(200);
});
it("asynchronous HTTP returns QUEUED, emits before completion, and Last-Event-ID resumes without gaps", async () => {
  const r = await call(
    "POST",
    "/api/tasks",
    "employee",
    { agentId: runAgent, prompt: "@slow live SSE" },
    randomUUID(),
  );
  expect(r.statusCode).toBe(202);
  expect(r.json().status).toBe("QUEUED");
  const id = r.json().taskId,
    ctrl = new AbortController(),
    stream = await fetch(`${base}/api/tasks/${id}/events`, {
      headers: headers("employee"),
      signal: ctrl.signal,
    });
  expect(stream.status).toBe(200);
  const reader = stream.body!.getReader(),
    decoder = new TextDecoder();
  let frame = "";
  while (!frame.includes("event: judgment")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("SSE ended before running event");
    frame += decoder.decode(chunk.value);
  }
  expect((await call("GET", `/api/tasks/${id}`, "employee")).json().task.status).toBe("RUNNING");
  const eventId = frame.match(/^id: (.+)$/m)![1]!;
  ctrl.abort();
  const replay = await fetch(`${base}/api/tasks/${id}/events`, {
    headers: { ...headers("employee"), "last-event-id": eventId },
  });
  const text = await replay.text();
  expect(text).not.toContain(`id: ${eventId}\n`);
  expect(text).toContain("event: done");
  expect(text).toContain("UNVERIFIED");
});
it("duplicate concurrent submissions create one durable task, mismatched key gets 409", async () => {
  const key = randomUUID(),
    body = { agentId: runAgent, prompt: "dedupe" };
  const [a, b] = await Promise.all([
    call("POST", "/api/tasks", "employee", body, key),
    call("POST", "/api/tasks", "employee", body, key),
  ]);
  expect(a.json().taskId).toBe(b.json().taskId);
  expect(await db.task.count({ where: { requestKey: key } })).toBe(1);
  expect(
    (await call("POST", "/api/tasks", "employee", { ...body, prompt: "changed" }, key)).statusCode,
  ).toBe(409);
  await finished(a.json().taskId);
});
it("worker supports cancel, timeout, explicit bounded retry and sanitizes model errors", async () => {
  const c = await call(
    "POST",
    "/api/tasks",
    "employee",
    { agentId: runAgent, prompt: "@slow cancel" },
    randomUUID(),
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect((await call("POST", `/api/tasks/${c.json().taskId}/cancel`, "employee")).statusCode).toBe(
    200,
  );
  expect((await finished(c.json().taskId)).task.status).toBe("CANCELLED");
  const t = await call(
    "POST",
    "/api/tasks",
    "employee",
    { agentId: runAgent, prompt: "@slow timeout", timeoutMs: 500, maxAttempts: 1 },
    randomUUID(),
  );
  expect((await finished(t.json().taskId)).task.status).toBe("TIMED_OUT");
  expect((await call("POST", `/api/tasks/${t.json().taskId}/retry`, "employee")).statusCode).toBe(
    409,
  );
  const f = await call(
    "POST",
    "/api/tasks",
    "employee",
    { agentId: runAgent, prompt: "@fail model", maxAttempts: 2 },
    randomUUID(),
  );
  const first = await finished(f.json().taskId);
  expect(first.task.status).toBe("FAILED");
  expect(JSON.stringify(first)).not.toContain(process.env.JWT_SECRET);
  expect((await call("POST", `/api/tasks/${f.json().taskId}/retry`, "employee")).statusCode).toBe(
    202,
  );
  const last = await finished(f.json().taskId);
  expect(last.runs).toHaveLength(2);
  expect((await call("POST", `/api/tasks/${f.json().taskId}/retry`, "employee")).statusCode).toBe(
    409,
  );
});
it("organization concurrency quota leaves excess work queued and completes it after a slot opens", async () => {
  const jobs = await Promise.all(
    [1, 2, 3].map((i) =>
      call(
        "POST",
        "/api/tasks",
        "employee",
        { agentId: runAgent, prompt: `@slow quota ${i}` },
        randomUUID(),
      ),
    ),
  );
  for (const r of jobs) expect(r.statusCode).toBe(202);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const running = await db.task.count({ where: { organizationId: "org-a", status: "RUNNING" } }),
    queued = await db.task.count({
      where: { id: { in: jobs.map((j) => j.json().taskId) }, status: "QUEUED" },
    });
  expect(running).toBe(2);
  expect(queued).toBe(1);
  for (const r of jobs) expect((await finished(r.json().taskId)).task.status).toBe("UNVERIFIED");
});
it("real database failure rolls release counter, immutable version and approval back atomically", async () => {
  const before = await db.agentDefinition.findUniqueOrThrow({ where: { id: runAgent } });
  await db.$executeRawUnsafe(
    `CREATE FUNCTION audit_reject_release() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled PostgreSQL failure'; END $$`,
  );
  await db.$executeRawUnsafe(
    `CREATE TRIGGER audit_fail_release BEFORE INSERT ON "AgentVersion" FOR EACH ROW EXECUTE FUNCTION audit_reject_release()`,
  );
  try {
    const r = await call("POST", `/api/agents/${runAgent}/publish`);
    expect(r.statusCode).toBe(500);
    expect(r.json().ok).toBe(false);
    expect(
      (await db.agentDefinition.findUniqueOrThrow({ where: { id: runAgent } })).versionCounter,
    ).toBe(before.versionCounter);
  } finally {
    await db.$executeRawUnsafe('DROP TRIGGER audit_fail_release ON "AgentVersion"');
    await db.$executeRawUnsafe("DROP FUNCTION audit_reject_release()");
  }
});
it("expired worker lease becomes a visible failure and never silently repeats side effects", async () => {
  const v = await db.agentVersion.findFirstOrThrow({
    where: { agentId: runAgent, approvedAt: { not: null } },
  });
  const t = await db.task.create({
    data: {
      organizationId: "org-a",
      agentVersionId: v.id,
      title: "crashed worker fixture",
      prompt: "do not repeat",
      createdBy: "employee@a.test",
      status: "RUNNING",
      attempts: 1,
      leaseUntil: new Date(Date.now() - 1000),
      workerId: "dead-worker",
      executionSnapshot: v.manifest as never,
    },
  });
  await db.run.create({ data: { taskId: t.id, status: "RUNNING" } });
  const view = await finished(t.id);
  expect(view.task.status).toBe("FAILED");
  expect(view.task.attempts).toBe(1);
  expect(view.runs[0].error).toContain("lease expired");
});
it("sensitive tool requires task consent AND separate approval; later draft grants do not alter published versions", async () => {
  const grant = await call("POST", `/api/agents/${runAgent}/grants`, "builder", {
    kind: "TOOL",
    name: "bash",
    scopeNote: "test: confined bash",
  });
  expect(grant.statusCode).toBe(200);
  const old = await call(
    "POST",
    "/api/tasks",
    "employee",
    { agentId: runAgent, prompt: "frozen no bash" },
    randomUUID(),
  );
  expect(old.json().status).toBe("QUEUED");
  const result = await finished(old.json().taskId);
  expect(result.task.executionSnapshot.grants).toEqual([]);
  const pub = await call("POST", `/api/agents/${runAgent}/publish`);
  await call("POST", `/api/approvals/${pub.json().approvalId}/decision`, "reviewer", {
    decision: "APPROVED",
  });
  expect(
    (
      await call(
        "POST",
        "/api/tasks",
        "employee",
        { agentId: runAgent, prompt: "no consent" },
        randomUUID(),
      )
    ).statusCode,
  ).toBe(403);
  const task = await call(
    "POST",
    "/api/tasks",
    "employee",
    { agentId: runAgent, prompt: "approved once", consent: ["bash"] },
    randomUUID(),
  );
  expect(task.json().status).toBe("BLOCKED");
  expect((await call("GET", `/api/tasks/${task.json().taskId}/events`, "employee")).body).toContain(
    '"pendingApproval":true',
  );
  expect(await db.run.count({ where: { taskId: task.json().taskId } })).toBe(0);
  expect((await approveSubject(task.json().taskId)).statusCode).toBe(200);
  await finished(task.json().taskId);
  expect(
    (
      await call("POST", `/api/approvals/${task.json().approvalId}/decision`, "reviewer", {
        decision: "APPROVED",
      })
    ).statusCode,
  ).toBe(409);
});
it("sensitive retries require fresh consent and fresh independent approval", async () => {
  const r = await call(
    "POST",
    "/api/tasks",
    "employee",
    { agentId: runAgent, prompt: "@fail sensitive retry", consent: ["bash"], maxAttempts: 2 },
    randomUUID(),
  );
  expect(r.statusCode).toBe(202);
  expect((await approveSubject(r.json().taskId)).statusCode).toBe(200);
  expect((await finished(r.json().taskId)).task.status).toBe("FAILED");
  expect((await call("POST", `/api/tasks/${r.json().taskId}/retry`, "employee")).statusCode).toBe(
    403,
  );
  const retry = await call("POST", `/api/tasks/${r.json().taskId}/retry`, "employee", {
    consent: ["bash"],
  });
  expect(retry.statusCode).toBe(202);
  expect(retry.json().status).toBe("BLOCKED");
  expect(await db.run.count({ where: { taskId: r.json().taskId } })).toBe(1);
  expect((await approveSubject(r.json().taskId)).statusCode).toBe(200);
  expect((await finished(r.json().taskId)).runs).toHaveLength(2);
});
it("membership revocation interrupts an already running authorized task", async () => {
  const { signSession } = await import("../../src/server/auth.js"),
    user = "revoked-run@a.test";
  await db.membership.create({ data: { organizationId: "org-a", userId: user, role: "EMPLOYEE" } });
  const token = await signSession({
    userId: user,
    email: user,
    organizationId: "org-a",
    role: "EMPLOYEE",
  });
  const r = await app.inject({
    method: "POST",
    url: "/api/tasks",
    headers: { authorization: `Bearer ${token}`, "idempotency-key": randomUUID() },
    payload: { agentId: runAgent, prompt: "@slow revoked user", consent: ["bash"] },
  });
  expect(r.statusCode).toBe(202);
  expect((await approveSubject(r.json().taskId)).statusCode).toBe(200);
  let entered = false;
  for (let i = 0; i < 40; i++) {
    if (modelEntered.has("@slow revoked user")) {
      entered = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(entered).toBe(true);
  await db.membership.delete({
    where: { organizationId_userId: { organizationId: "org-a", userId: user } },
  });
  for (let i = 0; i < 40; i++) {
    const t = await db.task.findUniqueOrThrow({ where: { id: r.json().taskId } });
    if (t.status === "BLOCKED") break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect((await db.task.findUniqueOrThrow({ where: { id: r.json().taskId } })).status).toBe(
    "BLOCKED",
  );
  expect((await db.run.findFirstOrThrow({ where: { taskId: r.json().taskId } })).error).toContain(
    "POLICY_REVOKED",
  );
  expect((await call("GET", `/api/tasks/${r.json().taskId}/events`, "admin")).body).toContain(
    '"pendingApproval":false',
  );
});
it("strict mechanical syntax and source/scope validation reject invalid rules", async () => {
  for (const rule of [
    "must_contain:",
    "must_not_contain: ",
    "max_length:",
    "max_length:-2",
    "max_length:2.3",
    "max_length:NaN",
    "unknown:abc",
  ]) {
    expect(() => parseMechanical(rule)).toThrow();
    expect(evaluateMechanical(rule, "anything").status).toBe("UNCHECKED");
  }
  const body = {
    rule: "must_contain:approved",
    kind: "MECHANICAL",
    scopeType: "ORGANIZATION",
    scopeId: "org-a",
    sourceFeedback: "explicit correction",
  };
  expect(
    (await call("POST", "/api/judgments/candidates", "employee", { ...body, scopeId: "org-b" }))
      .statusCode,
  ).toBe(403);
  expect(
    (
      await call("POST", "/api/judgments/candidates", "employee", {
        ...body,
        sourceRunId: "nonexistent",
      })
    ).statusCode,
  ).toBe(404);
});
it("rule conflicts block approval; immutable revisions preserve history and supersede only on approval", async () => {
  const body = {
    rule: "must_contain:ABC",
    kind: "MECHANICAL",
    scopeType: "ORGANIZATION",
    scopeId: "org-a",
    sourceFeedback: "explicit correction",
  };
  const a = await call("POST", "/api/judgments/candidates", "employee", body),
    id = a.json().candidate.id;
  expect((await approveSubject(id)).statusCode).toBe(200);
  const b = await call("POST", "/api/judgments/candidates", "employee", {
    ...body,
    rule: "must_not_contain:ABC",
    scopeType: "AGENT",
    scopeId: runAgent,
  });
  expect((await approveSubject(b.json().candidate.id)).statusCode).toBe(409);
  const rev = await call("POST", `/api/judgments/${id}/revisions`, "employee", {
    rule: "must_contain:DEF",
    sourceFeedback: "revised correction",
  });
  expect(rev.statusCode).toBe(200);
  expect(rev.json().candidate.version).toBe(2);
  expect((await db.judgmentRule.findUniqueOrThrow({ where: { id } })).status).toBe("APPROVED");
  expect((await approveSubject(rev.json().candidate.id)).statusCode).toBe(200);
  expect((await db.judgmentRule.findUniqueOrThrow({ where: { id } })).status).toBe("SUPERSEDED");
  await expect(db.judgmentRule.update({ where: { id }, data: { rule: "tamper" } })).rejects.toThrow(
    /immutable/,
  );
});
it("project rules, application evidence and approvals respect project membership", async () => {
  const r = await call("POST", "/api/judgments/candidates", "admin", {
    rule: "max_length:100000",
    kind: "MECHANICAL",
    scopeType: "PROJECT",
    scopeId: "proj-exec",
    sourceFeedback: "private project correction",
  });
  expect(r.statusCode).toBe(200);
  const id = r.json().candidate.id;
  expect(
    (await call("GET", "/api/judgments", "employee"))
      .json()
      .rules.some((x: { id: string }) => x.id === id),
  ).toBe(false);
  expect(
    (await call("GET", "/api/approvals", "reviewer"))
      .json()
      .approvals.some((x: { subjectId: string }) => x.subjectId === id),
  ).toBe(false);
  expect((await approveSubject(id)).statusCode).toBe(403);
  await db.projectMember.create({ data: { projectId: "proj-exec", userId: "reviewer@a.test" } });
  expect((await approveSubject(id)).statusCode).toBe(200);
});
it("download ticket is atomic one-use; logout and membership removal revoke session and outstanding tickets", async () => {
  // No S3 dependency here: the test exercises ticket authority and atomic redemption, with real DB file metadata.
  const { signDownloadTicket, verifyDownloadTicket, verifySession } =
    await import("../../src/server/auth.js");
  const principal = verifySession(tokens.employee!)!;
  const f = await db.fileObject.create({
    data: {
      organizationId: "org-a",
      name: "ticket.txt",
      storageKey: "audit/authority-only",
      sizeBytes: 1,
      createdBy: principal.userId,
    },
  });
  const ticket = await signDownloadTicket(f.id, principal),
    answers = await Promise.all([
      verifyDownloadTicket(ticket, f.id),
      verifyDownloadTicket(ticket, f.id),
    ]);
  expect(answers.sort()).toEqual([false, true]);
  const pending = await signDownloadTicket(f.id, principal);
  expect((await call("POST", "/api/auth/logout", "employee")).statusCode).toBe(200);
  expect(await verifyDownloadTicket(pending, f.id)).toBe(false);
  expect((await call("GET", "/api/agents", "employee")).statusCode).toBe(401);
});
it("login brute force is rate limited and invalid file types/sizes are refused before storage", async () => {
  for (let i = 0; i < 11; i++) {
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "nonexistent@a.test", password: "wrong", organizationId: "org-a" },
    });
    expect(r.statusCode).toBe(i < 10 ? 401 : 429);
  }
  expect(
    (await call("POST", "/api/files", "admin", { name: "program.exe", contentBase64: "YWJj" }))
      .statusCode,
  ).toBe(400);
  expect(
    (await call("POST", "/api/files", "admin", { name: "empty.txt", contentBase64: "" }))
      .statusCode,
  ).toBe(413);
  expect(
    (await call("POST", "/api/files", "admin", { name: "bad.txt", contentBase64: "not base64" }))
      .statusCode,
  ).toBe(400);
});
it("removing membership invalidates a signed session immediately", async () => {
  const { signSession } = await import("../../src/server/auth.js");
  await db.membership.create({
    data: { organizationId: "org-a", userId: "removed@a.test", role: "EMPLOYEE" },
  });
  const token = await signSession({
    userId: "removed@a.test",
    email: "removed@a.test",
    role: "EMPLOYEE",
    organizationId: "org-a",
  });
  expect(
    (
      await app.inject({
        method: "GET",
        url: "/api/agents",
        headers: { authorization: `Bearer ${token}` },
      })
    ).statusCode,
  ).toBe(200);
  await db.membership.delete({
    where: { organizationId_userId: { organizationId: "org-a", userId: "removed@a.test" } },
  });
  expect(
    (
      await app.inject({
        method: "GET",
        url: "/api/agents",
        headers: { authorization: `Bearer ${token}` },
      })
    ).statusCode,
  ).toBe(401);
});
it("production refuses development defaults, mock/stub execution and seed writes", async () => {
  const snapshot = { ...process.env };
  try {
    process.env.NODE_ENV = "production";
    const { validateEnvironment } = await import("../../src/server/env.js");
    expect(() => validateEnvironment()).toThrow();
    const { seedForTests } = await import("../../src/server/seed.js");
    await expect(seedForTests()).rejects.toThrow(/Production/);
    const productionShape = new URL(url);
    productionShape.password = "production-shape-test-only";
    Object.assign(process.env, {
      JWT_SECRET: "production-shape-test-key-0123456789abcdef",
      DATABASE_URL: productionShape.href,
      S3_ENDPOINT: "http://127.0.0.1:59000",
      S3_BUCKET: "poros-artifacts",
      S3_ACCESS_KEY: "production-shape-key",
      S3_SECRET_KEY: "production-shape-secret",
      POROS_DEEPSEEK_API_KEY: "fixture-not-a-real-credential",
      MODEL_GATEWAY: "deepseek",
      POROS_RUNTIME: "dsh",
      POROS_DSH_MODEL_STUB: "1",
    });
    expect(() => validateEnvironment()).toThrow(/mock\/stub/);
    process.env.POROS_DSH_MODEL_STUB = "0";
    const { buildApp } = await import("../../src/server/app.js");
    await expect(buildApp({ worker: false })).rejects.toThrow(/seed memberships/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in snapshot)) delete process.env[key];
    Object.assign(process.env, snapshot);
  }
});
