import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance, HTTPMethods } from "fastify";
import { createGateway } from "../../src/server/model-gateway.js";
import { runTask } from "../../src/server/runner.js";

const databaseName = "poros_conversation_" + randomUUID().replaceAll("-", "");
const originalUrl = new URL(
  process.env.DATABASE_URL ||
    "postgresql://poros:change-me-strong-password@127.0.0.1:55432/poros?schema=public",
);
const controlUrl = new URL(originalUrl);
controlUrl.pathname = "/postgres";
const targetUrl = new URL(originalUrl);
targetUrl.pathname = "/" + databaseName;
let control: PrismaClient;
let db: PrismaClient;
let app: FastifyInstance;
let agentId = "";
const tokens: Record<string, string> = {};
const uploadedObjects: string[] = [];

async function request(
  method: HTTPMethods,
  url: string,
  role = "employee",
  payload?: Record<string, unknown>,
  key?: string,
) {
  return app.inject({
    method,
    url,
    headers: {
      authorization: "Bearer " + tokens[role],
      ...(key ? { "idempotency-key": key } : {}),
    },
    ...(payload === undefined ? {} : { payload }),
  });
}
async function submit(fields: Record<string, unknown> = {}, role = "employee", key = randomUUID()) {
  const response = await request(
    "POST",
    "/api/tasks",
    role,
    { agentId, prompt: "Analyze the attached business question", ...fields },
    key,
  );
  expect(response.statusCode, response.body).toBe(202);
  return response.json() as { taskId: string; conversationId: string; turn: number };
}
const gateway = () => {
  const value = createGateway("mock");
  const generate = vi.spyOn(value, "generate").mockImplementation(async () => ({
    output: "Contract fixture output " + randomUUID(),
    gateway: "mock",
    disclaimer: "Protocol fixture only",
  }));
  return { value, generate };
};

beforeAll(async () => {
  process.env.JWT_SECRET ||= "conversation-test-0123456789abcdef";
  process.env.POROS_RUNTIME = "gateway";
  process.env.MODEL_GATEWAY = "mock";
  process.env.LOG_LEVEL = "silent";
  const { PrismaClient } = await import("@prisma/client");
  control = new PrismaClient({ datasources: { db: { url: controlUrl.href } } });
  await control.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
  process.env.DATABASE_URL = targetUrl.href;
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], {
    env: process.env,
    stdio: "pipe",
  });
  const { seedForTests } = await import("../../src/server/seed.js");
  await seedForTests();
  const { buildApp } = await import("../../src/server/app.js");
  app = await buildApp({ worker: false });
  const { getDb } = await import("../../src/server/db.js");
  db = getDb();
  for (const role of ["admin", "builder", "employee", "reviewer", "outsider"]) {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        organizationId: role === "outsider" ? "org-b" : "org-a",
        email: role + (role === "outsider" ? "@b.test" : "@a.test"),
        password: role + "-pass-123",
      },
    });
    expect(response.statusCode).toBe(200);
    tokens[role] = response.json().token;
  }
  const draft = await request("POST", "/api/agents/drafts", "builder", {
    name: "Conversation contract agent",
    config: {
      persona: "Use only the authorized conversation context",
      outputKind: "markdown-document",
    },
  });
  expect(draft.statusCode, draft.body).toBe(200);
  agentId = draft.json().agent.id;
  const publication = await request("POST", `/api/agents/${agentId}/publish`, "builder");
  expect(publication.statusCode, publication.body).toBe(202);
  const approval = await request(
    "POST",
    `/api/approvals/${publication.json().approvalId}/decision`,
    "reviewer",
    { decision: "APPROVED" },
  );
  expect(approval.statusCode, approval.body).toBe(200);
}, 120000);

afterAll(async () => {
  await app?.close();
  if (db) {
    const { deleteObject } = await import("../../src/server/storage.js");
    for (const artifact of await db.artifact.findMany()) await deleteObject(artifact.storageKey);
    for (const key of uploadedObjects) await deleteObject(key);
    const { closeDb } = await import("../../src/server/db.js");
    await closeDb();
  }
  if (control) {
    await control.$executeRawUnsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await control.$disconnect();
  }
});

describe("Conversation admission and real persistence", () => {
  it("creates an addressable work, and an idempotent replay retains the original work and turn", async () => {
    const key = randomUUID();
    const first = await submit({}, "employee", key);
    const replay = await submit({}, "employee", key);
    expect(replay).toMatchObject({
      taskId: first.taskId,
      conversationId: first.conversationId,
      turn: first.turn,
      approvalId: null,
      duplicate: true,
    });
    expect(first.turn).toBe(1);
    expect(
      (
        await request("PATCH", `/api/agents/${agentId}/draft`, "builder", {
          config: { persona: "A later approved persona" },
        })
      ).statusCode,
    ).toBe(200);
    const newer = await request("POST", `/api/agents/${agentId}/publish`, "builder");
    expect(
      (
        await request("POST", `/api/approvals/${newer.json().approvalId}/decision`, "reviewer", {
          decision: "APPROVED",
        })
      ).statusCode,
    ).toBe(200);
    expect(await submit({}, "employee", key)).toMatchObject({
      taskId: first.taskId,
      conversationId: first.conversationId,
      turn: 1,
      duplicate: true,
    });
    expect(await db.task.count({ where: { conversationId: first.conversationId } })).toBe(1);
    const view = await request("GET", "/api/conversations/" + first.conversationId);
    expect(view.statusCode).toBe(200);
    expect(view.json().tasks[0].prompt).toContain("business question");
    const listing = await request("GET", "/api/conversations");
    expect(
      listing.json().conversations.some((row: { id: string }) => row.id === first.conversationId),
    ).toBe(true);
  });
  it("serializes concurrent messages into unique ordered turns", async () => {
    const first = await submit();
    const messages = await Promise.all([
      submit({ conversationId: first.conversationId, prompt: "Add the first detail" }),
      submit({ conversationId: first.conversationId, prompt: "Add the second detail" }),
    ]);
    expect(messages.map((row) => row.turn).sort()).toEqual([2, 3]);
    expect(await db.task.count({ where: { conversationId: first.conversationId } })).toBe(3);
  });
  it("denies cross-organization reads and private-work continuations by other members", async () => {
    const first = await submit();
    expect(
      (await request("GET", "/api/conversations/" + first.conversationId, "outsider")).statusCode,
    ).toBe(404);
    expect(
      (await request("GET", "/api/conversations/" + first.conversationId, "builder")).statusCode,
    ).toBe(403);
    const rejected = await request("POST", "/api/tasks", "builder", {
      agentId,
      conversationId: first.conversationId,
      prompt: "Unauthorized continuation",
    });
    expect(rejected.statusCode).toBe(403);
  });
  it("keeps project visibility and execution permission separate", async () => {
    const first = await submit({ projectId: "proj-market" });
    expect(
      (await request("GET", "/api/conversations/" + first.conversationId, "builder")).statusCode,
    ).toBe(200);
    await db.projectMember.update({
      where: { projectId_userId: { projectId: "proj-market", userId: "builder@a.test" } },
      data: { role: "VIEWER" },
    });
    const rejected = await request("POST", "/api/tasks", "builder", {
      agentId,
      projectId: "proj-market",
      conversationId: first.conversationId,
      prompt: "Read-only member tries to execute",
    });
    expect(rejected.statusCode).toBe(403);
  });
  it("rejects a project change without creating a partial follow-up", async () => {
    const first = await submit();
    const rejected = await request("POST", "/api/tasks", "employee", {
      agentId,
      projectId: "proj-market",
      conversationId: first.conversationId,
      prompt: "Change scope",
    });
    expect(rejected.statusCode).toBe(409);
    expect(await db.task.count({ where: { conversationId: first.conversationId } })).toBe(1);
  });
  it("exposes only the member's own approval applications without granting reviewer powers", async () => {
    const listing = await request("GET", "/api/approvals/mine", "builder");
    expect(listing.statusCode).toBe(200);
    expect(listing.json().approvals.length).toBeGreaterThan(0);
    expect(
      listing
        .json()
        .approvals.every((row: { requestedBy: string }) => row.requestedBy === "builder@a.test"),
    ).toBe(true);
    expect((await request("GET", "/api/approvals", "builder")).statusCode).toBe(403);
    expect((await request("GET", "/api/approvals/mine", "outsider")).json().approvals).toEqual([]);
  });
  it("distinguishes a pending approval from a rejected terminal request", async () => {
    const draft = await request("POST", "/api/agents/drafts", "builder", {
      name: "Approval state contract",
    });
    const id = draft.json().agent.id as string;
    expect(
      (
        await request("POST", `/api/agents/${id}/grants`, "builder", {
          kind: "TOOL",
          name: "bash",
          scopeNote: "Approval contract fixture only",
        })
      ).statusCode,
    ).toBe(200);
    const publication = await request("POST", `/api/agents/${id}/publish`, "builder");
    expect(
      (
        await request(
          "POST",
          `/api/approvals/${publication.json().approvalId}/decision`,
          "reviewer",
          { decision: "APPROVED" },
        )
      ).statusCode,
    ).toBe(200);
    const first = await submit({ agentId: id, consent: ["bash"] });
    const before = await request("GET", `/api/conversations/${first.conversationId}`);
    expect(before.json().tasks[0].pendingApproval).toBe(true);
    const mine = await request("GET", `/api/approvals/mine?taskId=${first.taskId}`);
    expect(mine.json().approvals).toHaveLength(1);
    expect(
      (
        await request(
          "POST",
          `/api/approvals/${mine.json().approvals[0].id}/decision`,
          "reviewer",
          { decision: "REJECTED" },
        )
      ).statusCode,
    ).toBe(200);
    const after = await request("GET", `/api/conversations/${first.conversationId}`);
    expect(after.json().tasks[0]).toMatchObject({ status: "CANCELLED", pendingApproval: false });
  });
  it("rejects stale draft saves and publication previews while retaining the saved version", async () => {
    const created = await request("POST", "/api/agents/drafts", "builder", {
      name: "Concurrent draft review",
      config: { persona: "Original saved persona" },
    });
    const id = created.json().agent.id as string;
    const listing = await request("GET", "/api/agents", "builder");
    const initial = listing.json().agents.find((row: { id: string }) => row.id === id);
    const saved = await request("PATCH", `/api/agents/${id}/draft`, "builder", {
      config: { persona: "First editor's saved persona" },
      expectedRevision: initial.draftRevision,
    });
    expect(saved.statusCode).toBe(200);
    const stale = await request("PATCH", `/api/agents/${id}/draft`, "builder", {
      config: { persona: "Stale editor overwrites" },
      expectedRevision: initial.draftRevision,
    });
    expect(stale.statusCode).toBe(409);
    expect(
      (await db.agentDefinition.findUniqueOrThrow({ where: { id } })).draftConfig,
    ).toMatchObject({ persona: "First editor's saved persona" });
    const release = await request("POST", `/api/agents/${id}/publish`, "builder", {
      expectedRevision: initial.publicationRevision,
    });
    expect(release.statusCode).toBe(409);
    expect(await db.agentVersion.count({ where: { agentId: id } })).toBe(0);
  });
  it("keeps directly linked file metadata under the same live access checks as preview", async () => {
    const file = await db.fileObject.create({
      data: {
        organizationId: "org-a",
        name: "metadata-authorization.txt",
        storageKey: "metadata-only-access-case",
        sizeBytes: 1,
        createdBy: "employee@a.test",
      },
    });
    const readable = await request("GET", `/api/files/${file.id}`);
    expect(readable.statusCode).toBe(200);
    expect(readable.json().file.name).toBe(file.name);
    expect(readable.json().file.storageKey).toBeUndefined();
    expect((await request("GET", `/api/files/${file.id}`, "builder")).statusCode).toBe(403);
    expect((await request("GET", `/api/files/${file.id}`, "outsider")).statusCode).toBe(404);
    await db.fileObject.update({ where: { id: file.id }, data: { deletedAt: new Date() } });
    expect((await request("GET", `/api/files/${file.id}`)).statusCode).toBe(404);
  });
});

describe("Conversation execution using an explicitly injected model protocol fixture", () => {
  it("blocks oversized history before another model call and preserves the earlier output", async () => {
    const first = await submit();
    const model = gateway();
    model.generate.mockResolvedValue({
      output: "OVERSIZED-FIXTURE ".repeat(4000),
      gateway: "mock",
      disclaimer: "Protocol fixture only",
    });
    const original = await runTask({ db, gateway: model.value, runtime: "gateway" }, first.taskId);
    const follow = await submit({
      conversationId: first.conversationId,
      prompt: "Continue an oversized work",
    });
    const result = await runTask({ db, gateway: model.value, runtime: "gateway" }, follow.taskId);
    expect(result.status).toBe("BLOCKED");
    expect(model.generate).toHaveBeenCalledTimes(1);
    expect((await db.run.findUniqueOrThrow({ where: { id: result.runId } })).error).toContain(
      "64000",
    );
    expect((await db.run.findUniqueOrThrow({ where: { id: original.runId } })).output).toBe(
      "OVERSIZED-FIXTURE ".repeat(4000),
    );
  });
  it("rereads earlier authorized files even when the preceding answer did not repeat their text", async () => {
    const marker = "SOURCE-NOT-REPEATED-" + randomUUID();
    const upload = await request("POST", "/api/files", "employee", {
      name: "conversation-source.txt",
      contentBase64: Buffer.from(marker).toString("base64"),
    });
    expect(upload.statusCode, upload.body).toBe(200);
    const file = await db.fileObject.findUniqueOrThrow({ where: { id: upload.json().file.id } });
    uploadedObjects.push(file.storageKey);
    const first = await submit({ fileIds: [file.id] });
    const model = gateway();
    model.generate.mockResolvedValue({
      output: "Fixture deliberately omits source details",
      gateway: "mock",
      disclaimer: "Protocol fixture only",
    });
    await runTask({ db, gateway: model.value, runtime: "gateway" }, first.taskId);
    const follow = await submit({
      conversationId: first.conversationId,
      prompt: "Check the original source again",
    });
    const run = await runTask({ db, gateway: model.value, runtime: "gateway" }, follow.taskId);
    expect(model.generate.mock.calls[1]![0]).toContain(marker);
    expect(model.generate.mock.calls[1]![0]).toContain("Fixture deliberately omits source details");
    expect(await db.fileUse.count({ where: { runId: run.runId, fileId: file.id } })).toBe(1);
  });
  it("passes the preceding actual output to the next generation and links stored artifact revisions", async () => {
    const first = await submit({ prompt: "Create the initial report" });
    const model = gateway();
    const originalRun = await runTask(
      { db, gateway: model.value, runtime: "gateway" },
      first.taskId,
    );
    const original = await db.run.findUniqueOrThrow({
      where: { id: originalRun.runId },
      include: { artifact: true },
    });
    expect(original.status).toBe("UNVERIFIED");
    expect(original.artifact).not.toBeNull();
    const follow = await submit({
      conversationId: first.conversationId,
      intent: "REVISION",
      parentRunId: original.id,
      prompt: "Shorten the second paragraph",
    });
    const revisedRun = await runTask(
      { db, gateway: model.value, runtime: "gateway" },
      follow.taskId,
    );
    const actualPrompt = model.generate.mock.calls[1]![0];
    expect(actualPrompt).toContain(original.output);
    expect(actualPrompt).toContain("Shorten the second paragraph");
    const revised = await db.run.findUniqueOrThrow({
      where: { id: revisedRun.runId },
      include: { artifact: true },
    });
    expect(revised.artifact?.revisionOfId).toBe(original.artifact!.id);
    expect((await db.run.findUniqueOrThrow({ where: { id: original.id } })).output).toBe(
      original.output,
    );
    const task = await db.task.findUniqueOrThrow({ where: { id: follow.taskId } });
    expect(task.intent).toBe("REVISION");
    expect(task.attempts).toBe(1);
    const inferred = await submit({
      conversationId: first.conversationId,
      parentRunId: original.id,
      prompt: "Revise the selected result using the parent reference",
    });
    expect((await db.task.findUniqueOrThrow({ where: { id: inferred.taskId } })).intent).toBe(
      "REVISION",
    );
  });
  it("keeps feedback on unverified output separate from quality and long-term rules", async () => {
    const first = await submit();
    const model = gateway();
    const run = await runTask({ db, gateway: model.value, runtime: "gateway" }, first.taskId);
    const response = await request(
      "POST",
      `/api/tasks/${first.taskId}/runs/${run.runId}/feedback`,
      "employee",
      { rating: "NEEDS_CHANGES", comment: "Revise this report only" },
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(await db.runFeedback.count({ where: { runId: run.runId } })).toBe(1);
    expect((await db.run.findUniqueOrThrow({ where: { id: run.runId } })).status).toBe(
      "UNVERIFIED",
    );
    expect(await db.judgmentRule.count()).toBe(0);
    expect(
      (await request("POST", `/api/tasks/${first.taskId}/accept`, "employee", { runId: run.runId }))
        .statusCode,
    ).toBe(409);
  });
  it("rejects a revision reference belonging to a different work", async () => {
    const first = await submit();
    const run = await runTask({ db, gateway: gateway().value, runtime: "gateway" }, first.taskId);
    const second = await submit();
    const response = await request("POST", "/api/tasks", "employee", {
      agentId,
      conversationId: second.conversationId,
      intent: "REVISION",
      parentRunId: run.runId,
      prompt: "Modify an unrelated work",
    });
    expect(response.statusCode).toBe(409);
  });
  it("rechecks access to historical source files before using conversation context", async () => {
    const first = await submit();
    await runTask({ db, gateway: gateway().value, runtime: "gateway" }, first.taskId);
    const file = await db.fileObject.create({
      data: {
        organizationId: "org-a",
        name: "revoked-history.txt",
        storageKey: "metadata-only-revocation-case",
        sizeBytes: 1,
        createdBy: "employee@a.test",
        deletedAt: new Date(),
      },
    });
    await db.taskInput.create({ data: { taskId: first.taskId, fileId: file.id } });
    const follow = await submit({
      conversationId: first.conversationId,
      prompt: "Continue after source access was revoked",
    });
    const model = gateway();
    const run = await runTask({ db, gateway: model.value, runtime: "gateway" }, follow.taskId);
    expect(run.status).toBe("BLOCKED");
    expect(model.generate).not.toHaveBeenCalled();
  });
  it("waits for the preceding turn before a queued follow-up can execute", async () => {
    await db.task.updateMany({ where: { status: "QUEUED" }, data: { status: "CANCELLED" } });
    const first = await submit({ prompt: "The initial serial request" });
    const follow = await submit({
      conversationId: first.conversationId,
      prompt: "The next serial request",
    });
    let releaseInitial = () => {};
    const initialWait = new Promise<void>((resolve) => {
      releaseInitial = resolve;
    });
    const model = gateway();
    model.generate.mockImplementation(async (prompt) => {
      if (prompt === "The initial serial request") await initialWait;
      return {
        output: "SERIAL-PREVIOUS-OUTPUT",
        gateway: "mock",
        disclaimer: "Protocol fixture only",
      };
    });
    const { startWorker } = await import("../../src/server/worker.js");
    const worker = startWorker(db, { gateway: model.value, runtime: "gateway" });
    try {
      await worker.tick();
      await vi.waitFor(() => expect(model.generate).toHaveBeenCalledTimes(1));
      await worker.tick();
      expect((await db.task.findUniqueOrThrow({ where: { id: follow.taskId } })).status).toBe(
        "QUEUED",
      );
      expect(model.generate).toHaveBeenCalledTimes(1);
      releaseInitial();
      await vi.waitFor(
        async () => {
          expect((await db.task.findUniqueOrThrow({ where: { id: follow.taskId } })).status).toBe(
            "UNVERIFIED",
          );
        },
        { timeout: 5000 },
      );
      expect(model.generate).toHaveBeenCalledTimes(2);
      expect(model.generate.mock.calls[1]![0]).toContain("SERIAL-PREVIOUS-OUTPUT");
    } finally {
      releaseInitial();
      await worker.stop();
    }
  });
});
