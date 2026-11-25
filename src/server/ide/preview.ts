import type { FastifyInstance } from "fastify";
import { randomBytes, createHash } from "node:crypto";
import { z } from "zod";
import { requirePrincipal, requireRole } from "../auth.js";
import { getDb } from "../db.js";
import { ApiError } from "../errors.js";
import { consumeLimit } from "../security.js";
import { workspaceAccess } from "./repository.js";

/** A one-use frame ticket never conveys the IDE session token to generated JavaScript. */
export async function registerIdePreview(app: FastifyInstance) {
  const db = getDb();
  app.post("/api/ide/workspaces/:id/builds/:buildId/preview-ticket", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p || !requireRole(["BUILDER"], p, reply)) return;
    const { id, buildId } = z
      .object({ id: z.string().max(120), buildId: z.string().max(120) })
      .parse(req.params);
    await workspaceAccess(db, p, id);
    await consumeLimit(`ide-frame:${p.organizationId}:${p.userId}`, 40, 60000);
    if (
      !(await db.ideBuild.count({
        where: { id: buildId, workspaceId: id, status: "READY", NOT: { previewHtml: "" } },
      }))
    )
      throw new ApiError(404, "构建没有可用界面");
    const ticket = randomBytes(32).toString("base64url");
    await db.downloadTicket.create({
      data: {
        id: createHash("sha256").update(ticket).digest("hex"),
        fileId: `ide-preview:${id}:${buildId}`,
        userId: p.userId,
        organizationId: p.organizationId,
        sessionId: p.sessionId!,
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    return { ok: true, url: "/preview/" + ticket, buildId };
  });
  app.get("/preview/:ticket", async (req, reply) => {
    const { ticket } = z
      .object({ ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
      .parse(req.params);
    const id = createHash("sha256").update(ticket).digest("hex");
    const record = await db.downloadTicket.findFirst({
      where: {
        id,
        usedAt: null,
        expiresAt: { gt: new Date() },
        fileId: { startsWith: "ide-preview:" },
      },
    });
    if (!record) throw new ApiError(403, "预览链接已失效，请刷新预览");
    const [, workspaceId, buildId] = record.fileId.split(":");
    const [membership, session, workspace, build] = await Promise.all([
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
      db.ideBuild.findFirst({ where: { id: buildId, workspaceId, status: "READY" } }),
    ]);
    if (
      !membership ||
      membership.disabledAt ||
      !["ADMIN", "BUILDER"].includes(membership.role) ||
      !session ||
      !workspace ||
      !build
    )
      throw new ApiError(403, "预览权限已撤销");
    const claimed = await db.downloadTicket.updateMany({
      where: { id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (!claimed.count) throw new ApiError(403, "预览链接已经使用");
    return reply.type("text/html; charset=utf-8").send(build.previewHtml);
  });
}
