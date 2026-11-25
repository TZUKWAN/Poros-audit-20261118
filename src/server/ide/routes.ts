import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { requirePrincipal, requireRole } from "../auth.js";
import { getDb } from "../db.js";
import { ApiError } from "../errors.js";
import { consumeLimit } from "../security.js";
import { projectKind } from "../../agent-project/contract.js";
import { createWorkspace, revisionFiles, saveRevision, workspaceAccess } from "./repository.js";
import { jobInput, submitIdeJob } from "./engine.js";
import { workspacePackage, desktopAvailable, installerFile } from "./delivery.js";
import { createReadStream } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { assembleCapability } from "../../agent-project/assembly.js";

const params = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/) });
export function idePrincipal(req: FastifyRequest, reply: FastifyReply) {
  const p = requirePrincipal(req, reply);
  if (!p || !requireRole(["BUILDER"], p, reply)) return null;
  return p;
}
export async function registerIdeRoutes(app: FastifyInstance) {
  const db = getDb();
  app.get("/api/ide/delivery", async (req, reply) => {
    if (!idePrincipal(req, reply)) return;
    return { ok: true, windows: await desktopAvailable() };
  });
  app.get("/api/ide/workspaces", async (req, reply) => {
    const p = idePrincipal(req, reply);
    if (!p) return;
    const workspaces = await db.ideWorkspace.findMany({
      where: { organizationId: p.organizationId, ownerId: p.userId },
      orderBy: { updatedAt: "desc" },
      take: 100,
      select: {
        id: true,
        name: true,
        kind: true,
        sourceDigest: true,
        latestBuildId: true,
        updatedAt: true,
      },
    });
    return { ok: true, workspaces };
  });
  app.post("/api/ide/workspaces", async (req, reply) => {
    const p = idePrincipal(req, reply);
    if (!p) return;
    await consumeLimit(`ide-new:${p.organizationId}:${p.userId}`, 20, 60000);
    const b = z
      .object({ name: z.string().trim().min(1).max(120), kind: projectKind.default("AGENT") })
      .parse(req.body);
    return reply
      .code(201)
      .send({ ok: true, workspace: await createWorkspace(db, p, b.name, b.kind) });
  });
  app.post("/api/ide/workspaces/:id/releases", async (req, reply) => {
    const p = idePrincipal(req, reply);
    if (!p) return;
    const { id } = params.parse(req.params);
    await workspaceAccess(db, p, id);
    await consumeLimit(`ide-release:${p.organizationId}:${p.userId}`, 12, 60000);
    const body = z
      .object({ buildId: z.string().max(120), includeMaterials: z.boolean().default(false) })
      .strict()
      .parse(req.body);
    const build = await db.ideBuild.findFirst({
      where: { id: body.buildId, workspaceId: id, status: "READY" },
    });
    if (!build) throw new ApiError(409, "请先完成真实构建");
    const pkg = await workspacePackage(db, p, id, build, body.includeMaterials);
    return { ok: true, package: pkg, filename: pkg.payload.appId + ".poros.json" };
  });
  app.post(
    "/api/ide/workspaces/:id/import-capability",
    { bodyLimit: 16 * 1024 * 1024 },
    async (req, reply) => {
      const p = idePrincipal(req, reply);
      if (!p) return;
      const { id } = params.parse(req.params),
        workspace = await workspaceAccess(db, p, id);
      await consumeLimit(`ide-import:${p.organizationId}:${p.userId}`, 12, 60000);
      const body = z
        .object({ expectedDigest: z.string().regex(/^[a-f0-9]{64}$/), package: z.unknown() })
        .strict()
        .parse(req.body);
      if (workspace.sourceDigest !== body.expectedDigest)
        throw new ApiError(409, "工程已变更，请刷新后重新导入");
      if (
        await db.ideJob.count({
          where: { workspaceId: id, kind: "DEVELOP", status: { in: ["QUEUED", "RUNNING"] } },
        })
      )
        throw new ApiError(409, "请先停止开发再导入能力");
      const result = assembleCapability(
        await revisionFiles(db, id, workspace.sourceDigest),
        body.package,
      );
      const saved = await saveRevision(db, p, id, body.expectedDigest, result.files);
      return {
        ok: true,
        ...saved,
        imported: result.package,
        message: "已固定能力源码与发布者摘要；新增权限尚未授权，请构建后验证组合效果",
      };
    },
  );
  app.get("/api/ide/workspaces/:id", async (req, reply) => {
    const p = idePrincipal(req, reply);
    if (!p) return;
    const { id } = params.parse(req.params),
      workspace = await workspaceAccess(db, p, id);
    const query = z
      .object({ since: z.string().max(64).optional(), full: z.string().optional() })
      .parse(req.query);
    const [files, jobs, builds] = await Promise.all([
      query.since === workspace.sourceDigest
        ? undefined
        : revisionFiles(db, id, workspace.sourceDigest),
      db.ideJob.findMany({ where: { workspaceId: id }, orderBy: { createdAt: "desc" }, take: 30 }),
      db.ideBuild.findMany({
        where: { workspaceId: id },
        orderBy: { createdAt: "desc" },
        take: 12,
        select: {
          id: true,
          sourceDigest: true,
          status: true,
          diagnostics: true,
          manifest: true,
          evidence: true,
          createdAt: true,
        },
      }),
    ]);
    if (workspace.latestBuildId && !builds.some((build) => build.id === workspace.latestBuildId)) {
      const successful = await db.ideBuild.findFirst({
        where: { id: workspace.latestBuildId, workspaceId: id, status: "READY" },
        select: {
          id: true,
          sourceDigest: true,
          status: true,
          diagnostics: true,
          manifest: true,
          evidence: true,
          createdAt: true,
        },
      });
      if (successful) builds.push(successful);
    }
    return {
      ok: true,
      workspace,
      files,
      jobs: jobs.map((job) => {
        const safeInput = { ...(job.input as Record<string, unknown>) };
        delete safeInput.bindings;
        return {
          ...job,
          input: safeInput,
          events:
            query.full === "1"
              ? job.events
              : Array.isArray(job.events)
                ? job.events.slice(-10)
                : [],
        };
      }),
      builds,
    };
  });
  app.put("/api/ide/workspaces/:id/source", async (req, reply) => {
    const p = idePrincipal(req, reply);
    if (!p) return;
    const { id } = params.parse(req.params);
    const b = z
      .object({
        expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
        files: z.record(z.string(), z.string()),
      })
      .parse(req.body);
    if (
      await db.ideJob.count({
        where: { workspaceId: id, status: { in: ["QUEUED", "RUNNING"] }, kind: "DEVELOP" },
      })
    )
      throw new ApiError(409, "请先停止正在进行的开发，再手动修改");
    return { ok: true, ...(await saveRevision(db, p, id, b.expectedDigest, b.files)) };
  });
  app.post("/api/ide/workspaces/:id/jobs", async (req, reply) => {
    const p = idePrincipal(req, reply);
    if (!p) return;
    const { id } = params.parse(req.params);
    await consumeLimit(`ide-job:${p.organizationId}:${p.userId}`, 40, 60000);
    const b = z
      .object({
        kind: z.enum([
          "DEVELOP",
          "BUILD",
          "PACKAGE",
          "RUN",
          "TEST",
          "MCP_TEST",
          "SCRIPT_TEST",
          "SKILL_TEST",
        ]),
        input: jobInput,
        expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
        buildId: z.string().max(120).optional(),
      })
      .strict()
      .parse(req.body);
    const key = z.string().min(1).max(128).parse(req.headers["idempotency-key"]);
    if (JSON.stringify(b.input).length > 512000) throw new ApiError(413, "单次运行输入过大");
    return reply.code(202).send({
      ok: true,
      job: await submitIdeJob(db, p, id, b.kind, b.input, key, b.expectedDigest, b.buildId),
    });
  });
  app.get("/api/ide/workspaces/:id/jobs/:jobId", async (req, reply) => {
    const p = idePrincipal(req, reply);
    if (!p) return;
    const { id, jobId } = params.extend({ jobId: z.string().max(120) }).parse(req.params);
    await workspaceAccess(db, p, id);
    const job = await db.ideJob.findFirst({ where: { id: jobId, workspaceId: id } });
    if (!job) throw new ApiError(404, "操作不存在");
    const input = { ...(job.input as Record<string, unknown>) };
    delete input.bindings;
    return { ok: true, job: { ...job, input } };
  });
  app.post("/api/ide/workspaces/:id/jobs/:jobId/cancel", async (req, reply) => {
    const p = idePrincipal(req, reply);
    if (!p) return;
    const { id, jobId } = params.extend({ jobId: z.string().max(120) }).parse(req.params);
    await workspaceAccess(db, p, id);
    const job = await db.ideJob.findFirst({ where: { id: jobId, workspaceId: id } });
    if (!job) throw new ApiError(404, "操作不存在");
    await db.ideJob.updateMany({
      where: { id: jobId, status: { in: ["QUEUED", "RUNNING"] } },
      data: {
        cancelRequested: true,
        ...(job.status === "QUEUED" ? { status: "CANCELLED", stage: "stopped" } : {}),
      },
    });
    return { ok: true };
  });
  app.post("/api/ide/workspaces/:id/jobs/:jobId/installer-ticket", async (req, reply) => {
    const p = idePrincipal(req, reply);
    if (!p) return;
    const { id, jobId } = params.extend({ jobId: z.string().max(120) }).parse(req.params);
    await workspaceAccess(db, p, id);
    const job = await db.ideJob.findFirst({
      where: { id: jobId, workspaceId: id, kind: "PACKAGE", status: "SUCCEEDED" },
    });
    if (!job) throw new ApiError(404, "安装构建尚未完成");
    const file = await installerFile(id, jobId, job.output),
      ticket = randomBytes(32).toString("base64url");
    await consumeLimit(`ide-installer:${p.userId}`, 10, 60000);
    await db.downloadTicket.create({
      data: {
        id: createHash("sha256").update(ticket).digest("hex"),
        fileId: "ide-installer:" + id + ":" + jobId,
        userId: p.userId,
        organizationId: p.organizationId,
        sessionId: p.sessionId!,
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    return { ok: true, url: "/api/ide/installers/" + ticket, filename: file.filename };
  });
  app.get("/api/ide/installers/:ticket", async (req, reply) => {
    const { ticket } = z
        .object({ ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
        .parse(req.params),
      id = createHash("sha256").update(ticket).digest("hex");
    const record = await db.downloadTicket.findFirst({
      where: {
        id,
        usedAt: null,
        expiresAt: { gt: new Date() },
        fileId: { startsWith: "ide-installer:" },
      },
    });
    if (!record) throw new ApiError(403, "下载链接已失效");
    const [, workspaceId, jobId] = record.fileId.split(":");
    const [member, session, workspace, job] = await Promise.all([
      db.membership.findUnique({
        where: {
          organizationId_userId: { organizationId: record.organizationId, userId: record.userId },
        },
      }),
      db.authSession.findFirst({
        where: { id: record.sessionId, revokedAt: null, expiresAt: { gt: new Date() } },
      }),
      db.ideWorkspace.findFirst({
        where: { id: workspaceId, ownerId: record.userId, organizationId: record.organizationId },
      }),
      db.ideJob.findFirst({
        where: { id: jobId, workspaceId, kind: "PACKAGE", status: "SUCCEEDED" },
      }),
    ]);
    if (
      !member ||
      member.disabledAt ||
      !["ADMIN", "BUILDER"].includes(member.role) ||
      !session ||
      !workspace ||
      !job
    )
      throw new ApiError(403, "下载权限已撤销");
    const file = await installerFile(workspaceId!, jobId!, job.output);
    const claimed = await db.downloadTicket.updateMany({
      where: { id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (!claimed.count) throw new ApiError(403, "下载链接已使用");
    return reply
      .type("application/vnd.microsoft.portable-executable")
      .header("content-disposition", 'attachment; filename="' + file.filename + '"')
      .header("content-length", file.bytes!)
      .header("cache-control", "no-store")
      .send(createReadStream(file.file));
  });
  app.get("/api/ide/workspaces/:id/builds/:buildId/preview", async (req, reply) => {
    const p = idePrincipal(req, reply);
    if (!p) return;
    const { id, buildId } = params.extend({ buildId: z.string().max(120) }).parse(req.params);
    await workspaceAccess(db, p, id);
    const build = await db.ideBuild.findFirst({
      where: { id: buildId, workspaceId: id, status: "READY" },
    });
    if (!build) throw new ApiError(404, "构建不存在");
    return {
      ok: true,
      buildId: build.id,
      sourceDigest: build.sourceDigest,
      html: build.previewHtml,
    };
  });
}
