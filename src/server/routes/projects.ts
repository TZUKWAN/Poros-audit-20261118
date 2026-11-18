import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  hashPassword,
  requirePrincipal,
  requireRole,
  visibleAgents,
  visibleProjects,
  type Principal,
} from "../auth.js";
import { getDb } from "../db.js";
import { ApiError } from "../releases.js";

const projectId = z.object({ id: z.string().min(1).max(120) });
const projectFields = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).default(""),
});
const email = z.string().email().max(254);
const role = z.enum(["ADMIN", "BUILDER", "EMPLOYEE", "REVIEWER"]);

export async function recordAudit(
  tx: Prisma.TransactionClient,
  p: Principal,
  projectId: string | null,
  action: string,
  subjectId: string,
  detail: Prisma.InputJsonValue = {},
) {
  await tx.auditEntry.create({
    data: {
      organizationId: p.organizationId,
      projectId,
      actorId: p.userId,
      action,
      subjectId,
      detail,
    },
  });
}

export async function registerProjectRoutes(app: FastifyInstance) {
  const db = getDb();
  const projectAccess = async (
    tx: Prisma.TransactionClient,
    p: Principal,
    id: string,
    access: "read" | "manage",
  ) => {
    const project = await tx.project.findFirst({
      where: { id, ...visibleProjects(p.organizationId, p.userId, p.role, access) },
      include: { members: { select: { userId: true, role: true } } },
    });
    if (!project) throw new ApiError(403, "项目不存在、已归档或未授权");
    return project;
  };
  const change = <T>(
    p: Principal,
    id: string,
    action: (tx: Prisma.TransactionClient) => Promise<T>,
  ) =>
    db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${id} AND "organizationId"=${p.organizationId} FOR UPDATE`;
      await projectAccess(tx, p, id, "manage");
      return action(tx);
    });

  app.get("/api/projects", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p) return;
    const rows = await db.project.findMany({
      where: visibleProjects(p.organizationId, p.userId, p.role),
      include: { members: { where: { userId: p.userId }, select: { role: true } } },
      orderBy: [{ archivedAt: "desc" }, { name: "asc" }],
    });
    return {
      ok: true,
      projects: rows.map(({ members, ...row }) => ({
        ...row,
        role: p.role === "ADMIN" ? "MANAGER" : members[0]?.role,
      })),
    };
  });
  app.post("/api/projects", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p || !requireRole(["ADMIN"], p, reply)) return;
    const fields = projectFields.parse(req.body);
    const project = await db.$transaction(async (tx) => {
      const row = await tx.project.create({
        data: {
          ...fields,
          organizationId: p.organizationId,
          members: { create: { userId: p.userId, role: "MANAGER" } },
        },
      });
      await recordAudit(tx, p, row.id, "project.created", row.id, fields);
      return row;
    });
    return reply.code(201).send({ ok: true, project });
  });
  app.get("/api/projects/:id", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p) return;
    const { id } = projectId.parse(req.params);
    const project = await projectAccess(db, p, id, "read");
    const viewerRole =
      p.role === "ADMIN" ? "MANAGER" : project.members.find((m) => m.userId === p.userId)?.role;
    const [members, agents, audit, availableMembers] = await Promise.all([
      db.membership.findMany({
        where: {
          organizationId: p.organizationId,
          userId: { in: project.members.map((m) => m.userId) },
        },
        select: { userId: true, role: true, disabledAt: true },
      }),
      db.agentDefinition.findMany({
        where: { organizationId: p.organizationId, projects: { some: { projectId: id } } },
        select: { id: true, name: true, status: true, currentVersion: true },
        orderBy: { name: "asc" },
      }),
      viewerRole === "MANAGER"
        ? db.auditEntry.findMany({
            where: { organizationId: p.organizationId, projectId: id },
            orderBy: { createdAt: "desc" },
            take: 100,
          })
        : [],
      viewerRole === "MANAGER" && !project.archivedAt
        ? db.membership.findMany({
            where: { organizationId: p.organizationId, disabledAt: null },
            select: { userId: true },
            orderBy: { userId: "asc" },
          })
        : [],
    ]);
    return {
      ok: true,
      project: {
        ...project,
        role: viewerRole,
        members: project.members.map((item) => {
          const member = members.find((m) => item.userId === m.userId);
          return {
            ...item,
            organizationRole: member?.role ?? null,
            available: member ? member.disabledAt === null : false,
          };
        }),
      },
      agents,
      audit,
      availableMembers,
    };
  });
  app.patch("/api/projects/:id", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p) return;
    const { id } = projectId.parse(req.params);
    const fields = projectFields
      .partial()
      .extend({ archive: z.literal(true).optional() })
      .parse(req.body);
    const project = await change(p, id, async (tx) => {
      const row = await tx.project.update({
        where: { id },
        data: {
          name: fields.name,
          description: fields.description,
          archivedAt: fields.archive ? new Date() : undefined,
        },
      });
      await recordAudit(
        tx,
        p,
        id,
        fields.archive ? "project.archived" : "project.updated",
        id,
        fields,
      );
      return row;
    });
    return { ok: true, project };
  });
  app.put("/api/projects/:id/members", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p) return;
    const { id } = projectId.parse(req.params);
    const b = z
      .object({ userId: email, role: z.enum(["MANAGER", "CONTRIBUTOR", "VIEWER"]) })
      .parse(req.body);
    const member = await change(p, id, async (tx) => {
      const account = await tx.membership.findUnique({
        where: { organizationId_userId: { organizationId: p.organizationId, userId: b.userId } },
      });
      if (!account || account.disabledAt) throw new ApiError(404, "组织内无此启用成员");
      const member = await tx.projectMember.upsert({
        where: { projectId_userId: { projectId: id, userId: b.userId } },
        create: { projectId: id, ...b },
        update: { role: b.role },
      });
      await recordAudit(tx, p, id, "project.membership.updated", b.userId, { role: b.role });
      return member;
    });
    return { ok: true, member };
  });
  app.delete("/api/projects/:id/members/:userId", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p) return;
    const { id, userId } = projectId.extend({ userId: email }).parse(req.params);
    await change(p, id, async (tx) => {
      const removed = await tx.projectMember.deleteMany({ where: { projectId: id, userId } });
      if (!removed.count) throw new ApiError(404, "项目成员不存在");
      await recordAudit(tx, p, id, "project.membership.removed", userId);
    });
    return { ok: true };
  });
  for (const method of ["PUT", "DELETE"] as const) {
    app.route({
      method,
      url: "/api/projects/:id/agents/:agentId",
      handler: async (req, reply) => {
        const p = requirePrincipal(req, reply);
        if (!p || !requireRole(["BUILDER"], p, reply)) return;
        const { id, agentId } = projectId
          .extend({ agentId: z.string().min(1).max(120) })
          .parse(req.params);
        await change(p, id, async (tx) => {
          await tx.$queryRaw`SELECT id FROM "AgentDefinition" WHERE id=${agentId} AND "organizationId"=${p.organizationId} FOR UPDATE`;
          const agent = await tx.agentDefinition.findFirst({
            where: { id: agentId, ...visibleAgents(p, "write") },
          });
          if (!agent) throw new ApiError(404, "Agent 不存在或未授权管理");
          const key = { projectId: id, agentId };
          if (method === "PUT") {
            await tx.agentProject.upsert({
              where: { agentId_projectId: key },
              create: key,
              update: {},
            });
            await tx.agentDefinition.update({
              where: { id: agentId },
              data: { projectRestricted: true },
            });
          } else {
            const removed = await tx.agentProject.deleteMany({ where: key });
            if (!removed.count) throw new ApiError(404, "项目未关联此 Agent");
          }
          await recordAudit(
            tx,
            p,
            id,
            method === "PUT" ? "project.agent.linked" : "project.agent.unlinked",
            agentId,
          );
        });
        return { ok: true };
      },
    });
  }

  app.get("/api/members", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p || !requireRole(["ADMIN"], p, reply)) return;
    return {
      ok: true,
      members: await db.membership.findMany({
        where: { organizationId: p.organizationId },
        orderBy: { userId: "asc" },
      }),
      audit: await db.auditEntry.findMany({
        where: {
          organizationId: p.organizationId,
          projectId: null,
          action: { startsWith: "member." },
        },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
    };
  });
  app.put("/api/members", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p || !requireRole(["ADMIN"], p, reply)) return;
    const b = z
      .object({
        userId: email,
        role,
        password: z.string().min(12).max(72).optional(),
        disabled: z.boolean().default(false),
      })
      .parse(req.body);
    if (Buffer.byteLength(b.password ?? "") > 72)
      throw new ApiError(400, "初始密码不得超过 72 字节");
    if (process.env.NODE_ENV === "production" && b.userId.endsWith(".test"))
      throw new ApiError(400, "生产环境禁用开发账户");
    const encoded = b.password ? hashPassword(b.password) : null;
    const member = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Organization" WHERE id=${p.organizationId} FOR UPDATE`;
      const key = { organizationId: p.organizationId, userId: b.userId };
      const old = await tx.membership.findUnique({ where: { organizationId_userId: key } });
      if (old?.role === "ADMIN" && !old.disabledAt && (b.disabled || b.role !== "ADMIN")) {
        const admins = await tx.membership.count({
          where: { organizationId: p.organizationId, role: "ADMIN", disabledAt: null },
        });
        if (admins === 1) throw new ApiError(409, "组织需保留至少一位启用的管理员");
      }
      if (!old) {
        if (encoded)
          await tx.$executeRaw`INSERT INTO user_credentials(email,password_hash) VALUES(${b.userId},${encoded}) ON CONFLICT DO NOTHING`;
        const accounts = await tx.$queryRaw<
          unknown[]
        >`SELECT email FROM user_credentials WHERE email=${b.userId}`;
        if (!accounts.length) throw new ApiError(400, "新账号需要初始密码");
      }
      const data = {
        role: b.role,
        disabledAt: b.disabled ? (old?.disabledAt ?? new Date()) : null,
      };
      const member = await tx.membership.upsert({
        where: { organizationId_userId: key },
        create: { ...key, ...data },
        update: data,
      });
      if (b.disabled)
        await tx.authSession.updateMany({
          where: { ...key, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      await recordAudit(tx, p, null, b.disabled ? "member.disabled" : "member.enabled", b.userId, {
        role: b.role,
      });
      return member;
    });
    return { ok: true, member };
  });
}
