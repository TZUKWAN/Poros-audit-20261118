import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Prisma, JudgmentRule } from "@prisma/client";
import { getDb } from "../db.js";
import {
  requirePrincipal,
  requireRole,
  requireRoleExact,
  assertProjectAccess,
  signSession,
  verifyPassword,
  signDownloadTicket,
  verifyDownloadTicket,
  type Principal,
} from "../auth.js";
import { createGateway, executionGateway } from "../model-gateway.js";
import { putObject, getObject, storageKeyFor, deleteObject } from "../storage.js";
import { env } from "../env.js";
import {
  requestPublication,
  approvePublication,
  validateGrant,
  parseManifest,
  digest,
  ApiError,
  type Manifest,
} from "../releases.js";
import { parseMechanical, ruleConflict } from "../judgment.js";
import { consumeLimit } from "../security.js";
import { TERMINAL } from "../worker.js";

const idParam = z.object({ id: z.string().min(1).max(120) });
const configSchema = z.record(z.string(), z.unknown());
export const CREDENTIALS_DDL = `CREATE TABLE IF NOT EXISTS user_credentials (email TEXT PRIMARY KEY,password_hash TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now());`;
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();
  const checkProject = async (p: Principal, id: string | null | undefined) => {
    if (id && !(await assertProjectAccess(p.organizationId, id, p.userId, p.role)))
      throw new ApiError(403, "项目不存在或未授权");
  };
  const visibleTask = async (p: Principal, id: string) => {
    const t = await db.task.findFirst({ where: { id, organizationId: p.organizationId } });
    if (!t) throw new ApiError(404, "任务不存在");
    await checkProject(p, t.projectId);
    if (!t.projectId && t.createdBy !== p.userId && !["ADMIN", "REVIEWER"].includes(p.role))
      throw new ApiError(403, "私有任务未授权");
    return t;
  };
  app.post("/api/auth/login", async (req, reply) => {
    const b = z
      .object({
        email: z.string().email().max(254),
        password: z.string().min(1).max(256),
        organizationId: z.string().min(1).max(120),
      })
      .parse(req.body);
    await consumeLimit("login-ip:" + req.ip, 60, 900000);
    await consumeLimit(`login-account:${b.organizationId}:${b.email}`, 10, 900000);
    if (process.env.NODE_ENV === "production" && b.email.endsWith(".test"))
      throw new ApiError(403, "生产环境禁用开发账户");
    const m = await db.membership.findUnique({
      where: { organizationId_userId: { organizationId: b.organizationId, userId: b.email } },
    });
    const c = await db.$queryRaw<
      Array<{ password_hash: string }>
    >`SELECT password_hash FROM user_credentials WHERE email=${b.email}`;
    if (!m || !c[0] || !verifyPassword(b.password, c[0].password_hash))
      return reply.code(401).send({ ok: false, error: "认证失败" });
    return {
      ok: true,
      token: await signSession({
        userId: b.email,
        email: b.email,
        organizationId: b.organizationId,
        role: m.role,
      }),
    };
  });
  app.post("/api/auth/logout", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p) return;
    await db.authSession.updateMany({
      where: { id: p.sessionId },
      data: { revokedAt: new Date() },
    });
    return { ok: true };
  });
  app.get("/api/auth/me", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (p) return { ok: true, info: p };
  });

  app.post("/api/agents/drafts", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p || !requireRole(["BUILDER"], p, reply)) return;
    await consumeLimit("drafts:" + p.organizationId + ":" + p.userId, 20, 60000);
    const b = z
      .object({
        description: z.string().min(4).max(2000).optional(),
        name: z.string().trim().min(1).max(120).optional(),
        department: z.string().max(120).default(""),
        config: configSchema.optional(),
      })
      .parse(req.body);
    if (!b.name && !b.description) throw new ApiError(400, "需要 Agent 名称或自然语言描述");
    const draft = b.name
      ? {
          name: b.name,
          description: b.description ?? "",
          department: b.department,
          config: b.config ?? {},
        }
      : await createGateway().draftAgent(b.description!);
    let name = draft.name;
    if (!b.name) {
      const base = name;
      for (
        let i = 2;
        await db.agentDefinition.findFirst({ where: { organizationId: p.organizationId, name } });
        i++
      )
        name = `${base}-${i}`;
    }
    const agent = await db.agentDefinition.create({
      data: {
        organizationId: p.organizationId,
        name,
        description: draft.description,
        department: b.department || draft.department,
        draftConfig: draft.config as Prisma.InputJsonValue,
        createdBy: p.userId,
        nlSource: b.name ? null : b.description,
      },
    });
    return {
      ok: true,
      agent,
      diff: { before: null, after: agent.draftConfig },
      nlGenerated: !b.name,
    };
  });
  app.patch("/api/agents/:id/draft", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p || !requireRole(["BUILDER"], p, reply)) return;
    const { id } = idParam.parse(req.params);
    const b = z
      .object({
        name: z.string().trim().min(1).max(120).optional(),
        description: z.string().max(2000).optional(),
        department: z.string().max(120).optional(),
        config: configSchema.optional(),
      })
      .parse(req.body);
    return db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "AgentDefinition" WHERE id=${id} AND "organizationId"=${p.organizationId} FOR UPDATE`;
      const old = await tx.agentDefinition.findFirst({
        where: { id, organizationId: p.organizationId },
      });
      if (!old) throw new ApiError(404, "Agent 不存在");
      const agent = await tx.agentDefinition.update({
        where: { id },
        data: {
          ...b,
          config: undefined,
          draftConfig: b.config
            ? ({ ...(old.draftConfig as object), ...b.config } as Prisma.InputJsonValue)
            : undefined,
        } as Prisma.AgentDefinitionUpdateInput,
      });
      return { ok: true, agent, diff: { before: old.draftConfig, after: agent.draftConfig } };
    });
  });
  app.post("/api/agents/:id/grants", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p || !requireRole(["BUILDER"], p, reply)) return;
    const { id } = idParam.parse(req.params);
    const b = z
      .object({
        kind: z.enum(["TOOL", "SKILL", "MCP", "KNOWLEDGE", "MODEL"]),
        name: z.string().min(1).max(120),
        scopeNote: z.string().min(1).max(1000),
        version: z.literal("0.2.2-rc.1").default("0.2.2-rc.1"),
        source: z.literal("@deepseek-ai/dsh").default("@deepseek-ai/dsh"),
      })
      .parse(req.body);
    validateGrant(b);
    const grant = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "AgentDefinition" WHERE id=${id} AND "organizationId"=${p.organizationId} FOR UPDATE`;
      if (
        !(await tx.agentDefinition.findFirst({ where: { id, organizationId: p.organizationId } }))
      )
        throw new ApiError(404, "Agent 不存在");
      return tx.agentGrant.upsert({
        where: { agentId_kind_name: { agentId: id, kind: b.kind, name: b.name } },
        create: { agentId: id, ...b },
        update: b,
      });
    });
    return { ok: true, grant };
  });
  app.delete("/api/agents/:id/grants/:grantId", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p || !requireRole(["BUILDER"], p, reply)) return;
    const b = z.object({ id: z.string(), grantId: z.string() }).parse(req.params);
    const result = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "AgentDefinition" WHERE id=${b.id} AND "organizationId"=${p.organizationId} FOR UPDATE`;
      return tx.agentGrant.deleteMany({
        where: { id: b.grantId, agentId: b.id, agent: { organizationId: p.organizationId } },
      });
    });
    if (!result.count) throw new ApiError(404, "授权不存在");
    return { ok: true };
  });
  app.post("/api/agents/:id/publish", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p || !requireRole(["BUILDER"], p, reply)) return;
    const { id } = idParam.parse(req.params);
    return reply.code(202).send({ ok: true, ...(await requestPublication(db, p, id)) });
  });
  app.post("/api/agents/:id/rollback", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p || !requireRole(["BUILDER"], p, reply)) return;
    const { id } = idParam.parse(req.params),
      b = z.object({ version: z.number().int().positive() }).parse(req.body);
    const v = await db.agentVersion.findFirst({
      where: {
        agentId: id,
        version: b.version,
        approvedAt: { not: null },
        agent: { organizationId: p.organizationId },
      },
    });
    if (!v) throw new ApiError(404, "没有已审批目标版本");
    await db.agentDefinition.update({
      where: { id },
      data: { currentVersion: v.version, status: "PUBLISHED" },
    });
    return { ok: true, currentVersion: v.version };
  });
  app.get("/api/agents", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p) return;
    const agents = await db.agentDefinition.findMany({
      where: { organizationId: p.organizationId },
      include: { versions: { orderBy: { version: "desc" } }, grants: true },
    });
    return {
      ok: true,
      agents: agents.map((a) => ({
        ...a,
        releaseReady:
          a.status === "PUBLISHED" &&
          a.versions.some((v) => v.version === a.currentVersion && v.approvedAt !== null),
      })),
    };
  });

  const enqueue = async (
    p: Principal,
    b: {
      agentId: string;
      prompt: string;
      projectId?: string;
      consent: string[];
      timeoutMs: number;
      maxAttempts: number;
    },
    requestKey: string,
    draft = false,
  ) => {
    const a = await db.agentDefinition.findFirst({
      where: { id: b.agentId, organizationId: p.organizationId },
      include: { grants: true },
    });
    if (!a) throw new ApiError(404, "Agent 不存在");
    await checkProject(p, b.projectId);
    const v = draft
      ? null
      : await db.agentVersion.findFirst({
          where: { agentId: a.id, version: a.currentVersion, approvedAt: { not: null } },
        });
    if (!draft && (!v || a.status !== "PUBLISHED"))
      throw new ApiError(409, "只能运行已独立审批的发布版本");
    const manifest: Manifest = draft
      ? {
          agentId: a.id,
          name: a.name,
          department: a.department,
          config: a.draftConfig as Record<string, unknown>,
          grants: a.grants.map((g) => ({
            kind: g.kind,
            name: g.name,
            version: g.version,
            source: g.source,
          })),
          harness: "@deepseek-ai/dsh@0.2.2-rc.1",
        }
      : parseManifest(v!.manifest);
    manifest.grants.forEach(validateGrant);
    const sensitive = manifest.grants
      .filter(
        (g) =>
          g.kind === "TOOL" &&
          ["bash", "write", "edit", "web.fetch", "web.search"].includes(g.name),
      )
      .map((g) => g.name);
    if (sensitive.some((name) => !b.consent.includes(name)))
      throw new ApiError(403, "本次任务需要明确同意敏感能力：" + sensitive.join(", "));
    const hash = digest({ b, versionId: v?.id ?? null, manifest });
    return db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(709141821)::text`;
      const prior = await tx.task.findUnique({
        where: {
          organizationId_createdBy_requestKey: {
            organizationId: p.organizationId,
            createdBy: p.userId,
            requestKey,
          },
        },
      });
      if (prior) {
        if (prior.requestHash !== hash) throw new ApiError(409, "幂等键对应不同请求");
        return { taskId: prior.id, status: prior.status, duplicate: true };
      }
      if (
        (await tx.task.count({
          where: { organizationId: p.organizationId, status: { in: ["QUEUED", "RUNNING"] } },
        })) >= 100
      )
        throw new ApiError(429, "组织任务队列已满");
      const task = await tx.task.create({
        data: {
          organizationId: p.organizationId,
          projectId: b.projectId ?? null,
          agentVersionId: v?.id ?? null,
          executionSnapshot: manifest as unknown as Prisma.InputJsonValue,
          title: (draft ? "【草稿测试】" : "") + b.prompt.slice(0, 80),
          prompt: b.prompt,
          createdBy: p.userId,
          requestKey,
          requestHash: hash,
          timeoutMs: b.timeoutMs,
          maxAttempts: b.maxAttempts,
          status: sensitive.length ? "BLOCKED" : "QUEUED",
        },
      });
      const approval = sensitive.length
        ? await tx.approvalRequest.create({
            data: {
              organizationId: p.organizationId,
              kind: "DANGEROUS_OPERATION",
              subjectId: task.id,
              requestedBy: p.userId,
              payload: {
                agentVersionId: v?.id ?? null,
                manifestHash: digest(manifest),
                tools: sensitive,
                consentedBy: p.userId,
                taskId: task.id,
              },
            },
          })
        : null;
      return {
        taskId: task.id,
        status: task.status,
        approvalId: approval?.id ?? null,
        duplicate: false,
      };
    });
  };
  const taskBody = z.object({
    agentId: z.string(),
    prompt: z.string().trim().min(1).max(20000),
    projectId: z.string().optional(),
    consent: z.array(z.string()).max(20).default([]),
    timeoutMs: z.number().int().min(500).max(300000).default(180000),
    maxAttempts: z.number().int().min(1).max(3).default(3),
  });
  app.post("/api/tasks", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p) return;
    await consumeLimit("tasks:" + p.organizationId + ":" + p.userId, 60, 60000);
    const b = taskBody.parse(req.body),
      key = z
        .string()
        .min(1)
        .max(128)
        .parse(req.headers["idempotency-key"] ?? digest(b));
    return reply
      .code(202)
      .send({ ok: true, ...(await enqueue(p, b, key)), runtime: env.porosRuntime() });
  });
  app.post("/api/agents/:id/test-runs", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p || !requireRole(["BUILDER"], p, reply)) return;
    const { id } = idParam.parse(req.params),
      b = taskBody.parse({ ...(req.body as object), agentId: id });
    return reply.code(202).send({
      ok: true,
      ...(await enqueue(p, b, String(req.headers["idempotency-key"] ?? randomUUID()), true)),
      runtime: env.porosRuntime(),
    });
  });
  app.get("/api/tasks/:id", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p) return;
    const { id } = idParam.parse(req.params),
      task = await visibleTask(p, id);
    return {
      ok: true,
      task,
      runs: await db.run.findMany({ where: { taskId: id }, orderBy: { startedAt: "desc" } }),
    };
  });
  app.post("/api/tasks/:id/cancel", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p) return;
    const { id } = idParam.parse(req.params),
      t = await visibleTask(p, id);
    if (!["QUEUED", "RUNNING", "BLOCKED"].includes(t.status)) throw new ApiError(409, "任务已结束");
    await db.task.update({
      where: { id },
      data: { cancelRequested: true, ...(t.status !== "RUNNING" ? { status: "CANCELLED" } : {}) },
    });
    return { ok: true };
  });
  app.post("/api/tasks/:id/retry", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p) return;
    const { id } = idParam.parse(req.params),
      t = await visibleTask(p, id);
    if (t.createdBy !== p.userId) throw new ApiError(403, "只有任务发起人可以授权重试");
    const body = z.object({ consent: z.array(z.string()).default([]) }).parse(req.body ?? {});
    const result = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Task" WHERE id=${id} FOR UPDATE`;
      const current = await tx.task.findUniqueOrThrow({ where: { id } });
      if (
        !["FAILED", "TIMED_OUT"].includes(current.status) ||
        current.attempts >= current.maxAttempts
      )
        throw new ApiError(409, "任务不可重试或已达尝试上限");
      const manifest = parseManifest(current.executionSnapshot),
        tools = manifest.grants
          .filter(
            (g) =>
              g.kind === "TOOL" &&
              ["bash", "write", "edit", "web.fetch", "web.search"].includes(g.name),
          )
          .map((g) => g.name);
      if (tools.some((name) => !body.consent.includes(name)))
        throw new ApiError(403, "重试需要重新同意敏感能力");
      const status = tools.length ? ("BLOCKED" as const) : ("QUEUED" as const);
      await tx.task.update({
        where: { id },
        data: { status, cancelRequested: false, availableAt: new Date(Date.now() + 250) },
      });
      const approval = tools.length
        ? await tx.approvalRequest.create({
            data: {
              organizationId: p.organizationId,
              kind: "DANGEROUS_OPERATION",
              subjectId: id,
              requestedBy: p.userId,
              payload: {
                manifestHash: digest(manifest),
                taskId: id,
                tools,
                consentedBy: p.userId,
                attempt: current.attempts + 1,
              },
            },
          })
        : null;
      return { status, approvalId: approval?.id ?? null };
    });
    return reply.code(202).send({ ok: true, taskId: id, ...result });
  });
  app.get("/api/tasks/:id/events", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p) return;
    const { id } = idParam.parse(req.params);
    await visibleTask(p, id);
    let cursor = z
        .string()
        .max(200)
        .parse(req.headers["last-event-id"] ?? (req.query as { after?: string }).after ?? ""),
      closed = false;
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    reply.raw.flushHeaders();
    req.raw.on("close", () => {
      closed = true;
    });
    let idle = 0;
    try {
      while (!closed) {
        // Re-check session and membership during long streams, not just at connection time.
        const session = await db.authSession.findFirst({
          where: { id: p.sessionId, revokedAt: null, expiresAt: { gt: new Date() } },
        });
        const member = await db.membership.findUnique({
          where: { organizationId_userId: { organizationId: p.organizationId, userId: p.userId } },
        });
        if (!session || !member) break;
        const t = await visibleTask({ ...p, role: member.role }, id),
          runs = await db.run.findMany({ where: { taskId: id }, orderBy: { startedAt: "asc" } });
        const all = await db.runEvent.findMany({
          where: { runId: { in: runs.map((r) => r.id) } },
          orderBy: [{ createdAt: "asc" }, { seq: "asc" }],
        });
        let start = cursor ? all.findIndex((e) => `${e.runId}:${e.seq}` === cursor) + 1 : 0;
        if (cursor && start === 0) {
          reply.raw.write("event: reset\ndata: {}\n\n");
          start = 0;
        }
        for (const e of all.slice(start)) {
          if (closed || reply.raw.destroyed) break;
          cursor = `${e.runId}:${e.seq}`;
          if (
            !reply.raw.write(
              `id: ${cursor}\nevent: ${e.kind}\ndata: ${JSON.stringify({ seq: e.seq, runId: e.runId, payload: e.payload })}\n\n`,
            )
          ) {
            await new Promise<void>((resolve) => {
              const resume = () => {
                reply.raw.off("drain", resume);
                reply.raw.off("close", resume);
                resolve();
              };
              reply.raw.once("drain", resume);
              reply.raw.once("close", resume);
            });
          }
        }
        if (closed || reply.raw.destroyed) break;
        if (TERMINAL.has(t.status) && !runs.some((r) => r.status === "RUNNING")) {
          const pendingApproval =
            t.status === "BLOCKED" &&
            (await db.approvalRequest.count({
              where: {
                organizationId: p.organizationId,
                subjectId: id,
                kind: "DANGEROUS_OPERATION",
                decision: "PENDING",
              },
            })) > 0;
          reply.raw.write(
            `event: done\ndata: ${JSON.stringify({ status: t.status, pendingApproval })}\n\n`,
          );
          break;
        }
        if (++idle % 20 === 0) reply.raw.write(": heartbeat\n\n");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } catch {
      if (!closed) reply.raw.write('event: error\ndata: {"error":"事件流中断，请重新连接"}\n\n');
    } finally {
      reply.raw.end();
    }
  });

  app.get("/api/approvals", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p || !requireRoleExact(["REVIEWER", "ADMIN"], p, reply)) return;
    const all = await db.approvalRequest.findMany({
      where: { organizationId: p.organizationId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    const approvals = [];
    for (const a of all) {
      let projectId: string | null = null;
      if (a.kind === "JUDGMENT_RULE") {
        const r = await db.judgmentRule.findFirst({
          where: { id: a.subjectId, organizationId: p.organizationId },
        });
        if (!r) continue;
        if (r.scopeType === "PROJECT") projectId = r.scopeId;
      }
      if (a.kind === "DANGEROUS_OPERATION") {
        const task = await db.task.findFirst({
          where: { id: a.subjectId, organizationId: p.organizationId },
        });
        if (!task) continue;
        projectId = task.projectId;
      }
      if (projectId && !(await assertProjectAccess(p.organizationId, projectId, p.userId, p.role)))
        continue;
      approvals.push(a);
    }
    return { ok: true, approvals };
  });
  const scopesOverlap = async (a: JudgmentRule, b: JudgmentRule) => {
    if (a.scopeType === b.scopeType) return a.scopeId === b.scopeId;
    for (const [dept, agent] of [
      [a, b],
      [b, a],
    ])
      if (dept!.scopeType === "DEPARTMENT" && agent!.scopeType === "AGENT") {
        const row = await db.agentDefinition.findFirst({
          where: { id: agent!.scopeId, organizationId: a.organizationId },
        });
        return row?.department === dept!.scopeId;
      }
    return true;
  };
  app.post("/api/approvals/:id/decision", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p || !requireRoleExact(["REVIEWER", "ADMIN"], p, reply)) return;
    const { id } = idParam.parse(req.params),
      b = z.object({ decision: z.enum(["APPROVED", "REJECTED"]) }).parse(req.body);
    const approval = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${p.organizationId}))::text`;
      const a = await tx.approvalRequest.findFirst({
        where: { id, organizationId: p.organizationId, decision: "PENDING" },
      });
      if (!a) throw new ApiError(409, "审批不存在或已决定");
      if (a.requestedBy === p.userId) throw new ApiError(403, "禁止自审批");
      if (b.decision === "APPROVED") {
        if (a.kind === "AGENT_PUBLISH") await approvePublication(tx, a.subjectId, p.organizationId);
        if (a.kind === "DANGEROUS_OPERATION") {
          const task = await tx.task.findFirst({
            where: {
              id: a.subjectId,
              organizationId: p.organizationId,
              status: "BLOCKED",
              cancelRequested: false,
            },
          });
          if (!task) throw new ApiError(409, "任务不再等待授权");
          await checkProject(p, task.projectId);
          if (
            (a.payload as { manifestHash?: string }).manifestHash !== digest(task.executionSnapshot)
          )
            throw new ApiError(409, "任务授权快照不一致");
          await tx.task.update({ where: { id: task.id }, data: { status: "QUEUED" } });
        }
        if (a.kind === "JUDGMENT_RULE") {
          const rule = await tx.judgmentRule.findFirst({
            where: { id: a.subjectId, organizationId: p.organizationId, status: "CANDIDATE" },
          });
          if (!rule) throw new ApiError(409, "规则不再等待审批");
          if (rule.scopeType === "PROJECT") await checkProject(p, rule.scopeId);
          if (rule.kind === "MECHANICAL") parseMechanical(rule.rule);
          const active = await tx.judgmentRule.findMany({
            where: {
              organizationId: p.organizationId,
              status: "APPROVED",
              familyId: { not: rule.familyId },
            },
          });
          for (const other of active)
            if (
              rule.kind === "MECHANICAL" &&
              other.kind === "MECHANICAL" &&
              ruleConflict(rule.rule, other.rule) &&
              (await scopesOverlap(rule, other))
            )
              throw new ApiError(409, `规则与已生效规则 ${other.id} 冲突`);
          await tx.judgmentRule.updateMany({
            where: { familyId: rule.familyId, status: "APPROVED" },
            data: { status: "SUPERSEDED" },
          });
          await tx.judgmentRule.update({
            where: { id: rule.id },
            data: { status: "APPROVED", approvedBy: p.userId },
          });
        }
      } else if (a.kind === "DANGEROUS_OPERATION")
        await tx.task.updateMany({
          where: { id: a.subjectId, status: "BLOCKED" },
          data: { status: "CANCELLED", cancelRequested: true },
        });
      return tx.approvalRequest.update({
        where: { id },
        data: { decision: b.decision, decidedBy: p.userId, decidedAt: new Date() },
      });
    });
    return { ok: true, approval };
  });
  const ruleBody = z.object({
    rule: z.string().trim().min(3).max(4000),
    kind: z.enum(["MECHANICAL", "SEMANTIC"]).default("MECHANICAL"),
    scopeType: z.enum(["ORGANIZATION", "DEPARTMENT", "PROJECT", "AGENT"]),
    scopeId: z.string().min(1).max(120),
    sourceFeedback: z.string().trim().min(1).max(4000),
    sourceRunId: z.string().max(120).default(""),
  });
  const candidate = async (p: Principal, b: z.infer<typeof ruleBody>, previous?: JudgmentRule) => {
    if (b.kind === "MECHANICAL") parseMechanical(b.rule);
    if (b.scopeType === "ORGANIZATION" && b.scopeId !== p.organizationId)
      throw new ApiError(403, "组织作用域不存在");
    if (b.scopeType === "PROJECT") await checkProject(p, b.scopeId);
    if (
      b.scopeType === "AGENT" &&
      !(await db.agentDefinition.findFirst({
        where: { id: b.scopeId, organizationId: p.organizationId },
      }))
    )
      throw new ApiError(404, "Agent 作用域不存在");
    if (
      b.scopeType === "DEPARTMENT" &&
      !(await db.agentDefinition.findFirst({
        where: { department: b.scopeId, organizationId: p.organizationId },
      }))
    )
      throw new ApiError(404, "部门作用域不存在");
    if (b.sourceRunId) {
      const r = await db.run.findFirst({
        where: { id: b.sourceRunId, task: { organizationId: p.organizationId } },
      });
      if (!r) throw new ApiError(404, "来源运行不存在");
      await visibleTask(p, r.taskId);
    }
    return db.$transaction(async (tx) => {
      if (previous)
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${previous.familyId}))::text`;
      const latest = previous
        ? await tx.judgmentRule.aggregate({
            where: { familyId: previous.familyId },
            _max: { version: true },
          })
        : null;
      const c = await tx.judgmentRule.create({
        data: {
          ...b,
          organizationId: p.organizationId,
          ...(previous
            ? {
                familyId: previous.familyId,
                previousId: previous.id,
                version: (latest?._max.version ?? 0) + 1,
              }
            : {}),
        },
      });
      await tx.approvalRequest.create({
        data: {
          organizationId: p.organizationId,
          kind: "JUDGMENT_RULE",
          subjectId: c.id,
          requestedBy: p.userId,
          payload: {
            ruleId: c.id,
            version: c.version,
            sourceRunId: c.sourceRunId,
            rule: c.rule,
            kind: c.kind,
            scopeType: c.scopeType,
            scopeId: c.scopeId,
            sourceFeedback: c.sourceFeedback,
          },
        },
      });
      return c;
    });
  };
  app.post("/api/judgments/candidates", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p) return;
    return { ok: true, candidate: await candidate(p, ruleBody.parse(req.body)) };
  });
  app.post("/api/judgments/:id/revisions", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p) return;
    const { id } = idParam.parse(req.params),
      old = await db.judgmentRule.findFirst({ where: { id, organizationId: p.organizationId } });
    if (!old) throw new ApiError(404, "规则不存在");
    const b = ruleBody.parse({ ...old, ...(req.body as object) });
    if (b.scopeId !== old.scopeId || b.scopeType !== old.scopeType || b.kind !== old.kind)
      throw new ApiError(400, "修订不得改变规则家族作用域或类型");
    return { ok: true, candidate: await candidate(p, b, old) };
  });
  app.post("/api/judgments/:id/disable", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p || !requireRoleExact(["REVIEWER", "ADMIN"], p, reply)) return;
    const { id } = idParam.parse(req.params);
    const existing = await db.judgmentRule.findFirst({
      where: { id, organizationId: p.organizationId },
    });
    if (!existing) throw new ApiError(404, "规则不存在");
    if (existing.scopeType === "PROJECT") await checkProject(p, existing.scopeId);
    const r = await db.judgmentRule.updateMany({
      where: { id, organizationId: p.organizationId },
      data: { status: "DISABLED", disabledBy: p.userId, disabledAt: new Date() },
    });
    if (!r.count) throw new ApiError(404, "规则不存在");
    return { ok: true, status: "DISABLED" };
  });
  app.get("/api/judgments", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p) return;
    const projects = await db.project.findMany({
      where: {
        organizationId: p.organizationId,
        ...(p.role === "ADMIN" ? {} : { members: { some: { userId: p.userId } } }),
      },
      select: { id: true },
    });
    return {
      ok: true,
      rules: await db.judgmentRule.findMany({
        where: {
          organizationId: p.organizationId,
          OR: [
            { scopeType: { not: "PROJECT" } },
            { scopeType: "PROJECT", scopeId: { in: projects.map((x) => x.id) } },
          ],
        },
        include: {
          applications: {
            where: {
              run: {
                task: {
                  organizationId: p.organizationId,
                  ...(p.role === "ADMIN"
                    ? {}
                    : {
                        OR: [
                          { projectId: { in: projects.map((x) => x.id) } },
                          {
                            projectId: null,
                            ...(p.role === "REVIEWER" ? {} : { createdBy: p.userId }),
                          },
                        ],
                      }),
                },
              },
            },
            orderBy: { injectedAt: "desc" },
            take: 5,
          },
        },
        orderBy: { createdAt: "desc" },
      }),
    };
  });

  app.post("/api/files", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p) return;
    await consumeLimit("upload:" + p.organizationId + ":" + p.userId, 20, 60000);
    const b = z
      .object({
        name: z
          .string()
          .min(1)
          .max(180)
          .regex(/^[^/\\\x00-\x1f]+\.(?:txt|md|csv|json|pdf|png|jpe?g|docx|pptx|xlsx)$/i),
        contentBase64: z.string().max(7 * 1024 * 1024),
        projectId: z.string().optional(),
        sourceUrl: z.string().max(2000).default(""),
      })
      .parse(req.body);
    await checkProject(p, b.projectId);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b.contentBase64))
      throw new ApiError(400, "非法 base64");
    const buf = Buffer.from(b.contentBase64, "base64");
    if (!buf.length || buf.length > 5 * 1024 * 1024)
      throw new ApiError(413, "文件必须为 1 字节至 5 MiB");
    const key = storageKeyFor(p.organizationId, b.name);
    await putObject(key, buf);
    try {
      const file = await db.fileObject.create({
        data: {
          organizationId: p.organizationId,
          projectId: b.projectId ?? null,
          name: b.name,
          storageKey: key,
          sizeBytes: buf.length,
          sourceUrl: b.sourceUrl,
          createdBy: p.userId,
        },
      });
      return { ok: true, file };
    } catch (error) {
      await deleteObject(key);
      throw error;
    }
  });
  app.post("/api/files/:id/download-ticket", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p) return;
    await consumeLimit("download-ticket:" + p.organizationId + ":" + p.userId, 60, 60000);
    const { id } = idParam.parse(req.params),
      f = await db.fileObject.findFirst({ where: { id, organizationId: p.organizationId } });
    if (!f) throw new ApiError(404, "文件不存在");
    await checkProject(p, f.projectId);
    if (!f.projectId && f.createdBy !== p.userId && p.role !== "ADMIN")
      throw new ApiError(403, "私有文件未授权");
    return { ok: true, ticket: await signDownloadTicket(id, p), expiresInSeconds: 60 };
  });
  app.get("/api/files/:id/download", async (req, reply) => {
    const { id } = idParam.parse(req.params),
      ticket = (req.query as { dl?: string }).dl;
    if (!ticket || !(await verifyDownloadTicket(ticket, id)))
      throw new ApiError(401, "下载票据无效、过期、已使用或权限已撤销");
    const f = await db.fileObject.findUniqueOrThrow({ where: { id } });
    reply
      .header("content-disposition", `attachment; filename="${encodeURIComponent(f.name)}"`)
      .header("x-content-type-options", "nosniff")
      .header("cache-control", "no-store");
    return reply.send(await getObject(f.storageKey));
  });
  app.get("/api/integrations/status", async (req, reply) => {
    if (!requirePrincipal(req, reply)) return;
    return {
      ok: true,
      runtime: env.porosRuntime(),
      modelGateway: env.modelGateway(),
      executionGateway: executionGateway().name,
      dshModel: env.dshModelStub()
        ? "测试桩模型（真实 DSH 工具）"
        : env.deepseekApiKey()
          ? "已配置（实际运行后验证）"
          : "未配置",
      semanticJudge:
        executionGateway().name === "deepseek" &&
        Boolean(env.deepseekApiKey()) &&
        !env.dshModelStub()
          ? "已配置：使用同一准入模型，逐次留痕"
          : "UNCHECKED（未配置真实 Judge）",
      modelDisclaimer: env.modelGateway() === "mock" ? "未配置真实模型服务" : "",
      kdocs: "未配置/未验证真实服务",
      ima: "未配置/未验证真实服务",
      tinyfish: "未配置/未验证真实服务",
    };
  });
}
