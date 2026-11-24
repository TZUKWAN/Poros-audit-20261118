import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Prisma, JudgmentRule, Task } from "@prisma/client";
import { getDb } from "../db.js";
import {
  requirePrincipal,
  requireRole,
  requireRoleExact,
  assertProjectAccess,
  signSession,
  verifyPassword,
  visibleProjects,
  visibleAgents,
  type Principal,
} from "../auth.js";
import { createGateway, createPersonalGateway, executionGateway } from "../model-gateway.js";
import {
  findConnection,
  modelConnection,
  personalModelSource,
  readyPersonalModel,
} from "../integration-connections.js";
import { describeProviderError } from "../provider-errors.js";
import { getObject } from "../storage.js";
import { attachment, requireTaskFile } from "./files.js";
import { env } from "../env.js";
import {
  requestPublication,
  approvePublication,
  validateGrant,
  validateModelPolicy,
  editableConfig,
  parseManifest,
  digest,
  draftRevision,
  publicationRevision,
  matchesFrozenDigest,
  ApiError,
  type Manifest,
} from "../releases.js";
import { parseMechanical, ruleConflict } from "../judgment.js";
import { consumeLimit } from "../security.js";
import { TERMINAL } from "../worker.js";
import { recordAudit } from "./projects.js";
import { admitConversation } from "../conversations.js";
import {
  connectorFor,
  managedSource,
  harnessSource,
  harnessVersion,
} from "../capability-catalog.js";
import {
  assertCapabilityConnections,
  assertGrantRevision,
  freezeCapabilityConnections,
  requireManagedGrant,
} from "../capabilities.js";

const idParam = z.object({ id: z.string().min(1).max(120) });
const configSchema = z.record(z.string(), z.unknown());
const sensitiveTools = (grants: Manifest["grants"]) =>
  grants
    .filter(
      (g) =>
        Boolean(connectorFor(g)) ||
        (g.kind === "TOOL" && ["bash", "write", "edit"].includes(g.name)),
    )
    .map((g) => g.name);
export const CREDENTIALS_DDL = `CREATE TABLE IF NOT EXISTS user_credentials (email TEXT PRIMARY KEY,password_hash TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now());`;
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();
  const checkProject = async (
    p: Principal,
    id: string | null | undefined,
    mode: "read" | "write" = "read",
  ) => {
    if (id && !(await assertProjectAccess(p.organizationId, id, p.userId, p.role, mode)))
      throw new ApiError(403, "项目不存在、已归档或权限不足");
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
    if (!m || m.disabledAt || !c[0] || !verifyPassword(b.password, c[0].password_hash))
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
        generationMode: z.enum(["live", "template"]).optional(),
      })
      .parse(req.body);
    if (!b.name && !b.description) throw new ApiError(400, "需要 Agent 名称或自然语言描述");
    if (b.generationMode === "template" && process.env.NODE_ENV === "production")
      throw new ApiError(403, "生产模式禁用模拟草稿");
    const model =
      b.name || b.generationMode === "template"
        ? null
        : await readyPersonalModel(db, p).catch((error: unknown) => {
            throw new ApiError(409, describeProviderError(error).message);
          });
    if (!b.name && !model && env.personalModelOnly())
      throw new ApiError(409, "请先在设置中保存并测试个人模型");
    if (!b.name && b.generationMode === "live" && !model && env.modelGateway() !== "deepseek")
      throw new ApiError(409, "请先在设置中验证模型生成连接");
    const gateway = b.name
      ? null
      : model
        ? createPersonalGateway(model.model)
        : createGateway(b.generationMode === "template" ? "mock" : undefined);
    const draft = b.name
      ? {
          name: b.name,
          description: b.description ?? "",
          department: b.department,
          config: b.config ?? {},
        }
      : await gateway!.draftAgent(b.description!).catch((error: unknown) => {
          throw new ApiError(422, describeProviderError(error).message);
        });
    const origin = gateway === null ? "MANUAL" : gateway.name === "mock" ? "TEMPLATE" : "MODEL";
    const generationModel = origin === "MODEL" ? (model?.model.model ?? "deepseek-chat") : null;
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
        draftConfig: editableConfig(draft.config) as Prisma.InputJsonValue,
        createdBy: p.userId,
        nlSource: b.name ? null : b.description,
        draftOrigin: origin,
        generationModel,
      },
    });
    return {
      ok: true,
      agent,
      diff: { before: null, after: agent.draftConfig },
      nlGenerated: origin === "MODEL",
      generation: { origin, model: generationModel },
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
        replaceConfig: z.boolean().default(false),
        expectedRevision: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .parse(req.body);
    return db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "AgentDefinition" WHERE id=${id} AND "organizationId"=${p.organizationId} FOR UPDATE`;
      const old = await tx.agentDefinition.findFirst({
        where: { id, ...visibleAgents(p, "write") },
      });
      if (!old) throw new ApiError(404, "Agent 不存在");
      if (b.expectedRevision && draftRevision(old) !== b.expectedRevision)
        throw new ApiError(409, "草稿已被其他编辑更新。您的输入已保留，请对比当前版本后决定");
      const nextConfig = b.config
        ? editableConfig(
            b.replaceConfig ? b.config : { ...(old.draftConfig as object), ...b.config },
          )
        : undefined;
      const agent = await tx.agentDefinition.update({
        where: { id },
        data: {
          name: b.name,
          description: b.description,
          department: b.department,
          draftConfig: nextConfig as Prisma.InputJsonValue | undefined,
        },
      });
      const editable = ({ name, description, department, draftConfig }: typeof old) => ({
        name,
        description,
        department,
        config: draftConfig,
      });
      return {
        ok: true,
        agent: { ...agent, draftRevision: draftRevision(agent) },
        diff: {
          before: old.draftConfig,
          after: agent.draftConfig,
          fields: { before: editable(old), after: editable(agent) },
        },
      };
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
        version: z.string().min(1).max(120).default(harnessVersion),
        source: z.string().max(350).default(harnessSource),
      })
      .parse(req.body);
    validateGrant(b);
    if (b.source.startsWith(managedSource)) {
      const capability = await requireManagedGrant(db, p.organizationId, b);
      await checkProject(p, capability?.projectId);
    } else if (b.source !== harnessSource && !connectorFor(b)) {
      if (b.kind !== "MODEL" || !b.source.startsWith(personalModelSource))
        throw new ApiError(400, "能力来源不合法");
      const row = await findConnection(db, p, "model");
      const binding = row ? modelConnection(row) : null;
      if (
        !binding ||
        b.name !== binding.model ||
        b.source !== personalModelSource + binding.baseUrl
      )
        throw new ApiError(409, "请先在设置中保存相同端点和模型名");
    }
    const grant = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "AgentDefinition" WHERE id=${id} AND "organizationId"=${p.organizationId} FOR UPDATE`;
      if (!(await tx.agentDefinition.findFirst({ where: { id, ...visibleAgents(p, "write") } })))
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
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "AgentDefinition" WHERE id=${b.id} AND "organizationId"=${p.organizationId} FOR UPDATE`;
      const grant = await tx.agentGrant.findFirst({
        where: { id: b.grantId, agentId: b.id, agent: visibleAgents(p, "write") },
        include: { agent: { select: { versionCounter: true } } },
      });
      if (!grant) throw new ApiError(404, "授权不存在");
      await tx.agentGrant.delete({ where: { id: grant.id } });
      await tx.agentGrantRevocation.create({
        data: {
          agentId: b.id,
          kind: grant.kind,
          name: grant.name,
          source: grant.source,
          throughVersion: grant.agent.versionCounter,
        },
      });
      await recordAudit(tx, p, null, "agent.grant.revoked", b.id, {
        name: grant.name,
        version: grant.version,
      });
    });
    return { ok: true };
  });
  app.post("/api/agents/:id/publish", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p || !requireRole(["BUILDER"], p, reply)) return;
    const { id } = idParam.parse(req.params);
    const { expectedRevision } = z
      .object({
        expectedRevision: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .parse(req.body ?? {});
    return reply
      .code(202)
      .send({ ok: true, ...(await requestPublication(db, p, id, expectedRevision)) });
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
        agent: visibleAgents(p, "write"),
      },
    });
    if (!v) throw new ApiError(404, "没有已审批目标版本");
    await db.$transaction(async (tx) => {
      const changed = await tx.agentDefinition.updateMany({
        where: { id, ...visibleAgents(p, "write") },
        data: { currentVersion: v.version, status: "PUBLISHED" },
      });
      if (!changed.count) throw new ApiError(404, "Agent 不存在或未授权");
      await recordAudit(tx, p, null, "agent.rolled_back", id, { version: v.version });
    });
    return { ok: true, currentVersion: v.version };
  });
  app.get("/api/agents", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p) return;
    const canBuild = p.role === "BUILDER" || p.role === "ADMIN";
    const agents = await db.agentDefinition.findMany({
      where: { ...visibleAgents(p), ...(canBuild ? {} : { status: "PUBLISHED" }) },
      include: {
        versions: { orderBy: { version: "desc" } },
        grants: true,
        projects: {
          where: { project: visibleProjects(p.organizationId, p.userId, p.role) },
          select: { projectId: true },
        },
      },
    });
    return {
      ok: true,
      agents: agents.map((a) => ({
        ...a,
        ...(canBuild
          ? { draftRevision: draftRevision(a), publicationRevision: publicationRevision(a) }
          : {}),
        ...(canBuild
          ? {}
          : {
              draftConfig: {},
              grants: [],
              nlSource: null,
              versions: a.versions.filter((v) => v.version === a.currentVersion && v.approvedAt),
            }),
        releaseReady:
          a.status === "PUBLISHED" &&
          a.versions.some((v) => v.version === a.currentVersion && v.approvedAt !== null),
      })),
    };
  });

  const duplicateReceipt = async (client: Prisma.TransactionClient, prior: Task) => {
    const approval = await client.approvalRequest.findFirst({
      where: {
        organizationId: prior.organizationId,
        subjectId: prior.id,
        kind: "DANGEROUS_OPERATION",
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    return {
      taskId: prior.id,
      conversationId: prior.conversationId,
      turn: prior.turn,
      status: prior.status,
      approvalId: approval?.id ?? null,
      duplicate: true,
    };
  };
  const enqueue = async (
    p: Principal,
    b: {
      agentId: string;
      prompt: string;
      conversationId?: string;
      parentRunId?: string;
      intent?: "REQUEST" | "FOLLOW_UP" | "REVISION";
      projectId?: string;
      fileIds: string[];
      consent: string[];
      timeoutMs: number;
      maxAttempts: number;
    },
    requestKey: string,
    draft = false,
  ) => {
    await checkProject(p, b.projectId, "write");
    const hash = digest({ b, draft });
    const submitted = await db.task.findUnique({
      where: {
        organizationId_createdBy_requestKey: {
          organizationId: p.organizationId,
          createdBy: p.userId,
          requestKey,
        },
      },
    });
    // A lost receipt must still resolve to the frozen request after a new release or connection change.
    if (submitted?.requestHash === hash) return duplicateReceipt(db, submitted);
    const a = await db.agentDefinition.findFirst({
      where: { id: b.agentId, ...visibleAgents(p, draft ? "write" : "read") },
      include: { grants: true, projects: { select: { projectId: true } } },
    });
    if (!a) throw new ApiError(404, "Agent 不存在");
    if (a.projectRestricted && !a.projects.some((link) => link.projectId === b.projectId))
      throw new ApiError(403, "请选择关联此 Agent 且有执行权限的项目");
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
            scopeNote: g.scopeNote,
          })),
          harness: "@deepseek-ai/dsh@0.2.2-rc.1",
        }
      : parseManifest(v!.manifest);
    manifest.grants.forEach(validateGrant);
    const sensitive = sensitiveTools(manifest.grants);
    const modelGrant = validateModelPolicy(manifest);
    if (env.dshModelStub() && env.porosRuntime() === "dsh" && modelGrant)
      throw new ApiError(409, "模拟环境禁止用 DSH 测试模型替代个人模型，请切换真实运行环境");
    if (sensitive.some((name) => !b.consent.includes(name)))
      throw new ApiError(403, "本次任务需要明确同意敏感能力：" + sensitive.join(", "));
    const legacyHash = digest({ b, versionId: v?.id ?? null, manifest });
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
        if (prior.requestHash !== hash && prior.requestHash !== legacyHash)
          throw new ApiError(409, "幂等键对应不同请求");
        return duplicateReceipt(tx, prior);
      }
      let modelConnectionRevision: string | undefined;
      await assertGrantRevision(tx, a.id, manifest.grants, v?.version ?? null, new Date());
      if (
        env.porosRuntime() !== "dsh" &&
        manifest.grants.some((g) => connectorFor(g) || g.source?.startsWith(managedSource))
      )
        throw new ApiError(409, "连接器、Skill 和知识能力需要 DSH 执行环境");
      const connectionRevisions = await freezeCapabilityConnections(
        tx,
        p,
        manifest.grants,
        b.projectId ?? null,
      );
      if (modelGrant) {
        const binding = await readyPersonalModel(db, p, modelGrant).catch((error: unknown) => {
          throw new ApiError(409, describeProviderError(error).message);
        });
        if (!binding) throw new ApiError(409, "请在设置中配置并验证此 Agent 授权的个人模型");
        modelConnectionRevision = binding.revision;
      } else if (env.personalModelOnly()) {
        throw new ApiError(409, "此 Agent 版本尚未审批个人模型端点和模型名");
      }
      for (const fileId of b.fileIds) await requireTaskFile(tx, p, fileId, b.projectId ?? null);
      if (
        (await tx.task.count({
          where: { organizationId: p.organizationId, status: { in: ["QUEUED", "RUNNING"] } },
        })) >= 100
      )
        throw new ApiError(429, "组织任务队列已满");
      const task = await tx.task.create({
        data: {
          ...(await admitConversation(tx, p, b)),
          organizationId: p.organizationId,
          projectId: b.projectId ?? null,
          agentVersionId: v?.id ?? null,
          executionSnapshot: manifest as unknown as Prisma.InputJsonValue,
          modelConnectionRevision,
          connectionRevisions,
          inputs: { createMany: { data: b.fileIds.map((fileId) => ({ fileId })) } },
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
      if (task.projectId)
        await recordAudit(tx, p, task.projectId, "task.submitted", task.id, {
          agentId: a.id,
          version: v?.version ?? null,
          draft,
        });
      return {
        taskId: task.id,
        conversationId: task.conversationId,
        turn: task.turn,
        status: task.status,
        approvalId: approval?.id ?? null,
        duplicate: false,
      };
    });
  };
  const taskBody = z.object({
    agentId: z.string(),
    conversationId: z.string().min(1).max(120).optional(),
    parentRunId: z.string().min(1).max(120).optional(),
    intent: z.enum(["REQUEST", "FOLLOW_UP", "REVISION"]).optional(),
    prompt: z.string().trim().min(1).max(20000),
    projectId: z.string().optional(),
    fileIds: z
      .array(z.string().min(1).max(120))
      .max(3)
      .default([])
      .transform((ids) => [...new Set(ids)]),
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
  app.get("/api/tasks", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p) return;
    const { projectId, q, page } = z
      .object({
        projectId: z.string().min(1).max(120).optional(),
        q: z.string().trim().max(120).optional(),
        page: z.coerce.number().int().min(1).max(10000).default(1),
      })
      .parse(req.query);
    await checkProject(p, projectId);
    const where: Prisma.TaskWhereInput = {
      organizationId: p.organizationId,
      ...(projectId
        ? { projectId }
        : {
            createdBy: p.userId,
            ...(p.role === "ADMIN"
              ? {}
              : {
                  OR: [
                    { projectId: null },
                    {
                      project: visibleProjects(p.organizationId, p.userId, p.role),
                    },
                  ],
                }),
          }),
      ...(q ? { title: { contains: q, mode: "insensitive" } } : {}),
    };
    const tasks = await db.task.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * 25,
      take: 26,
      select: {
        id: true,
        title: true,
        status: true,
        createdAt: true,
        attempts: true,
        maxAttempts: true,
        createdBy: true,
        projectId: true,
        executionSnapshot: true,
      },
    });
    return {
      ok: true,
      hasMore: tasks.length > 25,
      tasks: tasks.slice(0, 25).map(({ executionSnapshot, ...task }) => ({
        ...task,
        sensitive: Array.isArray((executionSnapshot as Partial<Manifest>)?.grants)
          ? sensitiveTools((executionSnapshot as unknown as Manifest).grants)
          : [],
      })),
    };
  });
  app.get("/api/tasks/:id", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p) return;
    const { id } = idParam.parse(req.params),
      task = await visibleTask(p, id);
    const [runs, project, approval, inputs] = await Promise.all([
      db.run.findMany({
        where: { taskId: id },
        orderBy: { startedAt: "desc" },
        include: {
          artifact: { select: { id: true, name: true, sizeBytes: true, revisionOfId: true } },
          feedback: { orderBy: { updatedAt: "desc" } },
          fileUses: {
            include: {
              file: { select: { id: true, name: true, sourceUrl: true, deletedAt: true } },
            },
          },
          applications: {
            include: { rule: { select: { id: true, kind: true, rule: true, version: true } } },
          },
        },
      }),
      task.projectId
        ? db.project.findUnique({
            where: { id: task.projectId },
            select: { name: true, archivedAt: true },
          })
        : null,
      db.approvalRequest.findFirst({
        where: { organizationId: p.organizationId, subjectId: id, kind: "DANGEROUS_OPERATION" },
        orderBy: { createdAt: "desc" },
        select: { decision: true, decidedBy: true },
      }),
      db.taskInput.findMany({
        where: { taskId: id },
        select: { file: { select: { id: true, name: true, sourceUrl: true } } },
      }),
    ]);
    const version = task.agentVersionId
      ? await db.agentVersion.findUnique({
          where: { id: task.agentVersionId },
          select: { version: true },
        })
      : null;
    const current = task.createdBy === p.userId;
    const canWrite =
      !task.projectId ||
      (await assertProjectAccess(p.organizationId, task.projectId, p.userId, p.role, "write"));
    return {
      ok: true,
      task,
      runs,
      project,
      approval,
      inputs,
      version: version?.version ?? null,
      permissions: {
        cancel: canWrite && (current || p.role === "ADMIN"),
        retry: canWrite && current,
        accept: canWrite && current,
        feedback: canWrite && (Boolean(task.projectId) || current),
      },
    };
  });
  app.get("/api/tasks/:id/runs/:runId/artifact", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p) return;
    const { id, runId } = idParam.extend({ runId: z.string().min(1).max(120) }).parse(req.params);
    await visibleTask(p, id);
    const item = await db.artifact.findFirst({
      where: { runId, taskId: id, organizationId: p.organizationId },
    });
    if (!item) throw new ApiError(404, "产物不存在");
    reply.header("content-disposition", attachment(item.name));
    return reply.send(await getObject(item.storageKey));
  });
  app.post("/api/tasks/:id/accept", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p) return;
    const { id } = idParam.parse(req.params);
    const { runId } = z.object({ runId: z.string().min(1).max(120) }).parse(req.body);
    const task = await visibleTask(p, id);
    await checkProject(p, task.projectId, "write");
    if (task.createdBy !== p.userId) throw new ApiError(403, "只有发起人可以采纳");
    const run = await db.run.findFirst({ where: { id: runId, taskId: id, status: "SUCCEEDED" } });
    if (!run) throw new ApiError(409, "仅能采纳已通过验收的运行");
    const accepted = await db.$transaction(async (tx) => {
      const row = await tx.task.updateMany({
        where: { id, status: "SUCCEEDED", acceptedRunId: null },
        data: { acceptedRunId: runId, acceptedBy: p.userId, acceptedAt: new Date() },
      });
      if (!row.count) throw new ApiError(409, "已有采纳记录或任务状态已变化");
      await recordAudit(tx, p, task.projectId, "task.accepted", id, { runId });
      return tx.task.findUniqueOrThrow({
        where: { id },
        select: { acceptedRunId: true, acceptedAt: true },
      });
    });
    return { ok: true, ...accepted };
  });
  app.post("/api/tasks/:id/cancel", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p) return;
    const { id } = idParam.parse(req.params),
      t = await visibleTask(p, id);
    await checkProject(p, t.projectId, "write");
    if (t.createdBy !== p.userId && p.role !== "ADMIN")
      throw new ApiError(403, "仅任务发起人或管理员可以取消");
    if (!["QUEUED", "RUNNING", "BLOCKED"].includes(t.status)) throw new ApiError(409, "任务已结束");
    await db.$transaction(async (tx) => {
      const cancelled = await tx.task.updateMany({
        where: { id, status: t.status, cancelRequested: false },
        data: { cancelRequested: true, ...(t.status !== "RUNNING" ? { status: "CANCELLED" } : {}) },
      });
      if (!cancelled.count) throw new ApiError(409, "任务状态已变化，请刷新");
      await tx.approvalRequest.updateMany({
        where: {
          organizationId: p.organizationId,
          subjectId: id,
          kind: "DANGEROUS_OPERATION",
          decision: "PENDING",
        },
        data: { decision: "WITHDRAWN", decidedBy: p.userId, decidedAt: new Date() },
      });
      await recordAudit(tx, p, t.projectId, "task.cancelled", id);
    });
    return { ok: true };
  });
  app.post("/api/tasks/:id/retry", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p) return;
    const { id } = idParam.parse(req.params),
      t = await visibleTask(p, id);
    await checkProject(p, t.projectId, "write");
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
        tools = sensitiveTools(manifest.grants),
        selected = validateModelPolicy(manifest);
      const inputs = await tx.taskInput.findMany({ where: { taskId: id } });
      for (const item of inputs) await requireTaskFile(tx, p, item.fileId, t.projectId);
      await assertCapabilityConnections(tx, current);
      if (selected) {
        const binding = await readyPersonalModel(db, p, {
          ...selected,
          revision: current.modelConnectionRevision || "",
        }).catch((error: unknown) => {
          throw new ApiError(409, describeProviderError(error).message);
        });
        if (!binding) throw new ApiError(409, "个人模型已断开，请重新提交任务");
      }
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
    reply.raw.once("close", () => {
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
        if (!session || !member || member.disabledAt) {
          reply.raw.write("event: access-revoked\ndata: {}\n\n");
          break;
        }
        const t = await visibleTask({ ...p, role: member.role }, id),
          runs = await db.run.findMany({
            where: { taskId: id },
            orderBy: [{ startedAt: "asc" }, { id: "asc" }],
            select: { id: true, status: true },
          });
        let [runCursor, seqCursor] = cursor.split(":");
        let runStart = runs.findIndex((run) => run.id === runCursor);
        if (cursor && (runStart < 0 || !/^[1-9][0-9]{0,8}$/.test(seqCursor ?? ""))) {
          reply.raw.write("event: reset\ndata: {}\n\n");
          cursor = "";
          runStart = 0;
          runCursor = seqCursor = "";
        }
        const afterRunIds = runs
          .slice(Math.max(0, runStart + (cursor ? 1 : 0)))
          .map((run) => run.id);
        const batch = await db.runEvent.findMany({
          where: {
            OR: [
              { runId: { in: afterRunIds } },
              ...(cursor && runCursor
                ? [{ runId: runCursor, seq: { gt: Number(seqCursor) } }]
                : []),
            ],
          },
          orderBy: [{ createdAt: "asc" }, { runId: "asc" }, { seq: "asc" }],
          take: 200,
        });
        for (const e of batch) {
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
        if (batch.length === 200) continue;
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
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } catch (error) {
      if (!closed)
        reply.raw.write(
          error instanceof ApiError
            ? "event: access-revoked\ndata: {}\n\n"
            : 'event: error\ndata: {"error":"事件流中断，请重新连接"}\n\n',
        );
    } finally {
      reply.raw.end();
    }
  });

  const listApprovals = async (p: Principal, mine = false, taskId?: string) => {
    const all = await db.approvalRequest.findMany({
      where: {
        organizationId: p.organizationId,
        ...(mine ? { requestedBy: p.userId } : {}),
        ...(taskId ? { kind: "DANGEROUS_OPERATION", subjectId: taskId } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    const approvals = [];
    for (const a of all) {
      let projectId: string | null = null;
      if (
        a.kind === "AGENT_PUBLISH" &&
        !(await db.agentVersion.findFirst({
          where: { id: a.subjectId, agent: visibleAgents(p) },
          select: { id: true },
        }))
      )
        continue;
      if (a.kind === "JUDGMENT_RULE") {
        const r = await db.judgmentRule.findFirst({
          where: { id: a.subjectId, organizationId: p.organizationId },
        });
        if (!r) continue;
        if (r.scopeType === "PROJECT") projectId = r.scopeId;
        if (
          r.scopeType === "AGENT" &&
          !(await db.agentDefinition.findFirst({
            where: { id: r.scopeId, ...visibleAgents(p) },
            select: { id: true },
          }))
        )
          continue;
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
  };
  app.get("/api/approvals/mine", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p) return;
    const { taskId } = z.object({ taskId: z.string().min(1).max(120).optional() }).parse(req.query);
    return listApprovals(p, true, taskId);
  });
  app.get("/api/approvals", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p || !requireRoleExact(["REVIEWER", "ADMIN"], p, reply)) return;
    const { taskId } = z.object({ taskId: z.string().min(1).max(120).optional() }).parse(req.query);
    return listApprovals(p, false, taskId);
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
      if (
        a.kind === "AGENT_PUBLISH" &&
        !(await tx.agentVersion.findFirst({
          where: { id: a.subjectId, agent: visibleAgents(p) },
          select: { id: true },
        }))
      )
        throw new ApiError(403, "没有关联项目的审阅权限");
      if (a.kind === "DANGEROUS_OPERATION") {
        const task = await tx.task.findFirst({
          where: { id: a.subjectId, organizationId: p.organizationId },
          select: { projectId: true },
        });
        if (!task) throw new ApiError(404, "审批任务不存在");
        await checkProject(p, task.projectId);
      }
      if (a.kind === "JUDGMENT_RULE") {
        const rule = await tx.judgmentRule.findFirst({
          where: { id: a.subjectId, organizationId: p.organizationId },
        });
        if (!rule) throw new ApiError(404, "审批规则不存在");
        if (rule.scopeType === "PROJECT") await checkProject(p, rule.scopeId);
        if (
          rule.scopeType === "AGENT" &&
          !(await tx.agentDefinition.findFirst({
            where: { id: rule.scopeId, ...visibleAgents(p) },
            select: { id: true },
          }))
        )
          throw new ApiError(403, "没有此 Agent 的审阅权限");
      }
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
            !matchesFrozenDigest(
              task.executionSnapshot,
              (a.payload as { manifestHash?: string }).manifestHash,
            )
          )
            throw new ApiError(409, "任务授权快照不一致");
          const admitted = await tx.task.updateMany({
            where: { id: task.id, status: "BLOCKED", cancelRequested: false },
            data: { status: "QUEUED" },
          });
          if (!admitted.count) throw new ApiError(409, "任务不再等待授权");
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
          if (
            await tx.judgmentRule.findFirst({
              where: { familyId: rule.familyId, version: { gt: rule.version }, status: "APPROVED" },
              select: { id: true },
            })
          )
            throw new ApiError(409, "已有更新修订生效");
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
      } else if (a.kind === "DANGEROUS_OPERATION") {
        const rejected = await tx.task.updateMany({
          where: { id: a.subjectId, status: "BLOCKED", cancelRequested: false },
          data: { status: "CANCELLED", cancelRequested: true },
        });
        if (!rejected.count) throw new ApiError(409, "任务不再等待授权");
      }
      return tx.approvalRequest.update({
        where: { id, decision: "PENDING" },
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
        where: { id: b.scopeId, ...visibleAgents(p) },
      }))
    )
      throw new ApiError(404, "Agent 作用域不存在");
    if (
      b.scopeType === "DEPARTMENT" &&
      !(await db.agentDefinition.findFirst({
        where: { department: b.scopeId, ...visibleAgents(p) },
      }))
    )
      throw new ApiError(404, "部门作用域不存在");
    let evidence: Prisma.InputJsonObject = {};
    if (b.sourceRunId) {
      const r = await db.run.findFirst({
        where: { id: b.sourceRunId, task: { organizationId: p.organizationId } },
        include: {
          task: {
            select: {
              agentVersionId: true,
              agentVersion: { select: { version: true } },
              executionSnapshot: true,
            },
          },
        },
      });
      if (!r) throw new ApiError(404, "来源运行不存在");
      const task = await visibleTask(p, r.taskId);
      if (!r.finishedAt) throw new ApiError(409, "运行结束后才可以关联纠正");
      evidence = {
        taskId: r.taskId,
        runId: r.id,
        projectId: task.projectId,
        agentId: (r.task.executionSnapshot as { agentId?: string })?.agentId ?? null,
        agentVersionId: r.task.agentVersionId,
        agentVersion: r.task.agentVersion?.version ?? null,
        originalOutput: r.output,
        outputDigest: digest(r.output),
      };
    }
    const impacts = await db.agentDefinition.findMany({
      where: {
        ...visibleAgents(p),
        ...(b.scopeType === "AGENT" ? { id: b.scopeId } : {}),
        ...(b.scopeType === "DEPARTMENT" ? { department: b.scopeId } : {}),
        ...(b.scopeType === "PROJECT"
          ? { OR: [{ projectRestricted: false }, { projects: { some: { projectId: b.scopeId } } }] }
          : {}),
      },
      select: { id: true, name: true },
      take: 100,
    });
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
          sourceEvidence: evidence,
          ...(previous
            ? {
                familyId: previous.familyId,
                previousId: previous.id,
                version: (latest?._max.version ?? 0) + 1,
              }
            : {}),
        },
      });
      const conflicts: string[] = [];
      if (c.kind === "MECHANICAL") {
        const active = await tx.judgmentRule.findMany({
          where: {
            organizationId: p.organizationId,
            status: "APPROVED",
            kind: "MECHANICAL",
            familyId: { not: c.familyId },
          },
        });
        for (const other of active)
          if (ruleConflict(c.rule, other.rule) && (await scopesOverlap(c, other)))
            conflicts.push(other.id);
      }
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
            impactedAgents: impacts,
            conflicts,
          },
        },
      });
      return { ...c, conflicts, impactedAgents: impacts };
    });
  };
  app.post("/api/judgments/candidates", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p) return;
    return { ok: true, candidate: await candidate(p, ruleBody.parse(req.body)) };
  });
  app.post("/api/tasks/:id/runs/:runId/corrections", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p) return;
    const { id, runId } = idParam.extend({ runId: z.string().min(1).max(120) }).parse(req.params);
    const task = await visibleTask(p, id);
    await checkProject(p, task.projectId, "write");
    const run = await db.run.findFirst({
      where: { id: runId, taskId: id, finishedAt: { not: null } },
      select: { id: true, output: true },
    });
    if (!run || !run.output) throw new ApiError(409, "选择一条已有产出的运行");
    const b = ruleBody
      .omit({ scopeType: true, scopeId: true, sourceRunId: true })
      .extend({
        scopeType: z.enum(["AGENT", "PROJECT"]).default("AGENT"),
      })
      .parse(req.body);
    const scopeId =
      b.scopeType === "PROJECT"
        ? task.projectId
        : (task.executionSnapshot as { agentId?: string })?.agentId;
    if (!scopeId) throw new ApiError(400, "这次运行没有所选规则作用域");
    return { ok: true, candidate: await candidate(p, { ...b, scopeId, sourceRunId: runId }) };
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
    if (
      existing.scopeType === "AGENT" &&
      !(await db.agentDefinition.findFirst({
        where: { id: existing.scopeId, ...visibleAgents(p) },
        select: { id: true },
      }))
    )
      throw new ApiError(403, "没有此 Agent 的审阅权限");
    const r = await db.$transaction(async (tx) => {
      const r = await tx.judgmentRule.updateMany({
        where: { id, organizationId: p.organizationId, status: "APPROVED" },
        data: { status: "DISABLED", disabledBy: p.userId, disabledAt: new Date() },
      });
      if (r.count)
        await recordAudit(
          tx,
          p,
          existing.scopeType === "PROJECT" ? existing.scopeId : null,
          "judgment.disabled",
          id,
          { version: existing.version },
        );
      return r;
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
    const agents = await db.agentDefinition.findMany({
      where: visibleAgents(p),
      select: { id: true, department: true },
    });
    return {
      ok: true,
      rules: (
        await db.judgmentRule.findMany({
          where: {
            organizationId: p.organizationId,
            OR: [
              { scopeType: "ORGANIZATION" },
              {
                scopeType: "DEPARTMENT",
                scopeId: { in: [...new Set(agents.map((agent) => agent.department))] },
              },
              { scopeType: "AGENT", scopeId: { in: agents.map((agent) => agent.id) } },
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
        })
      ).map(({ sourceEvidence, ...rule }) => ({
        ...rule,
        sourceEvidence: {
          outputDigest: (sourceEvidence as { outputDigest?: string })?.outputDigest ?? null,
        },
      })),
    };
  });

  app.get("/api/integrations/status", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p) return;
    const connections = await db.integrationConnection.findMany({
      where: { organizationId: p.organizationId, userId: p.userId },
      select: { provider: true, testCode: true },
    });
    const state = (provider: string) => {
      const row = connections.find((item) => item.provider === provider);
      return row?.testCode === "OK" ? "已验证" : row ? "已保存，尚未验证成功" : "未配置";
    };
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
      kdocs: state("kdocs"),
      ima: state("ima"),
      tinyfish: state("tinyfish"),
    };
  });
}
