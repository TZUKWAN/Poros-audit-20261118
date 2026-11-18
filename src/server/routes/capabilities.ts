import type { FastifyInstance } from "fastify";
import { z } from "zod";
import path from "node:path";
import { assertProjectAccess, requirePrincipal, requireRole, visibleProjects } from "../auth.js";
import {
  connectors,
  harnessSource,
  harnessVersion,
  managedSource,
  nativeTools,
} from "../capability-catalog.js";
import { getDb } from "../db.js";
import { env } from "../env.js";
import { ApiError } from "../errors.js";
import { TEXT_EXTENSIONS } from "../file-text.js";
import { recordAudit } from "./projects.js";

const title = z.string().trim().min(1).max(240);
const input = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("SKILL"),
    name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,51}$/),
    description: title,
    instruction: z.string().trim().min(1).max(8000),
    projectId: z.string().max(120).optional(),
  }),
  z.object({
    kind: z.literal("KNOWLEDGE"),
    name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,51}$/),
    description: title,
    fileId: z.string().min(1).max(120),
    projectId: z.string().min(1).max(120),
  }),
]);

export async function registerCapabilityRoutes(app: FastifyInstance) {
  const db = getDb();
  app.get("/api/capabilities", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p) return;
    const projects = await db.project.findMany({
      where: visibleProjects(p.organizationId, p.userId, p.role),
      select: { id: true },
    });
    const stored = await db.capabilityDefinition.findMany({
      where: {
        organizationId: p.organizationId,
        OR: [{ projectId: null }, { projectId: { in: projects.map((v) => v.id) } }],
      },
      select: {
        id: true,
        kind: true,
        name: true,
        version: true,
        description: true,
        projectId: true,
        disabledAt: true,
        disabledBy: true,
        createdBy: true,
        createdAt: true,
      },
      orderBy: [{ name: "asc" }, { version: "desc" }],
    });
    return {
      ok: true,
      runtime: env.porosRuntime(),
      capabilities: [
        ...nativeTools.map((name) => ({
          kind: "TOOL",
          name,
          runtimeName: name,
          source: harnessSource,
          version: harnessVersion,
          description: "DSH 容器工具",
        })),
        {
          kind: "MODEL",
          name: "deepseek-chat",
          source: harnessSource,
          version: harnessVersion,
          description: "组织准入模型",
          configured: Boolean(env.deepseekApiKey()),
        },
        ...connectors.map((c) => ({
          kind: c.kind,
          name: c.capability,
          runtimeName: c.name,
          source: c.source,
          version: c.version,
          description: c.description,
          provider: c.provider,
        })),
        ...stored.map((c) => ({
          ...c,
          version: String(c.version),
          source: managedSource + c.id,
          scope: c.projectId ? "PROJECT" : "ORGANIZATION",
        })),
      ],
    };
  });
  app.post("/api/capabilities", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p || !requireRole(["ADMIN"], p, reply)) return;
    const b = input.parse(req.body);
    if (
      b.projectId &&
      !(await assertProjectAccess(p.organizationId, b.projectId, p.userId, p.role, "manage"))
    )
      throw new ApiError(403, "项目不存在或已归档");
    const capability = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Organization" WHERE id=${p.organizationId} FOR UPDATE`;
      if (b.kind === "KNOWLEDGE") {
        const file = await tx.fileObject.findFirst({
          where: {
            id: b.fileId,
            organizationId: p.organizationId,
            projectId: b.projectId,
            deletedAt: null,
          },
          select: { name: true },
        });
        if (!file || !TEXT_EXTENSIONS.has(path.extname(file.name).toLowerCase()))
          throw new ApiError(400, "选择本项目中支持文本提取的文件");
      }
      const group = { organizationId: p.organizationId, kind: b.kind, name: b.name };
      const latest = await tx.capabilityDefinition.aggregate({
        where: group,
        _max: { version: true },
      });
      const definition = await tx.capabilityDefinition.create({
        data: {
          ...b,
          organizationId: p.organizationId,
          createdBy: p.userId,
          version: (latest._max.version ?? 0) + 1,
        },
      });
      await recordAudit(tx, p, b.projectId ?? null, "capability.registered", definition.id, {
        name: b.name,
        kind: b.kind,
        version: definition.version,
      });
      return definition;
    });
    return reply.code(201).send({ ok: true, capability });
  });
  app.delete("/api/capabilities/:id", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p || !requireRole(["ADMIN"], p, reply)) return;
    const { id } = z.object({ id: z.string().min(1).max(120) }).parse(req.params);
    await db.$transaction(async (tx) => {
      const capability = await tx.capabilityDefinition.findFirst({
        where: { id, organizationId: p.organizationId, disabledAt: null },
      });
      if (!capability) throw new ApiError(404, "能力不存在或已停用");
      const saved = await tx.capabilityDefinition.updateMany({
        where: { id, disabledAt: null },
        data: { disabledAt: new Date(), disabledBy: p.userId },
      });
      if (!saved.count) throw new ApiError(409, "能力已经停用");
      await recordAudit(tx, p, capability.projectId, "capability.disabled", id, {
        name: capability.name,
        version: capability.version,
      });
    });
    return { ok: true };
  });
}
