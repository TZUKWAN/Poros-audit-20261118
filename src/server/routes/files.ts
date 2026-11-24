import type { FastifyInstance } from "fastify";
import type { FileObject, Prisma } from "@prisma/client";
import path from "node:path";
import { z } from "zod";
import {
  assertProjectAccess,
  requirePrincipal,
  signDownloadTicket,
  verifyDownloadTicket,
  type Principal,
} from "../auth.js";
import { getDb } from "../db.js";
import { extractFileText, TEXT_EXTENSIONS } from "../file-text.js";
import { ApiError } from "../releases.js";
import { consumeLimit } from "../security.js";
import { deleteObject, getObject, putObject, storageKeyFor } from "../storage.js";
import { recordAudit } from "./projects.js";

const idParam = z.object({ id: z.string().min(1).max(120) });
const categorySchema = z.string().trim().max(80);
const extension = (name: string) => path.extname(name).toLowerCase();
const fileView = ({ storageKey: _storageKey, ...file }: FileObject) => ({
  ...file,
  textSupported: TEXT_EXTENSIONS.has(extension(file.name)),
});

export async function requireTaskFile(
  db: Prisma.TransactionClient,
  p: Pick<Principal, "organizationId" | "userId">,
  id: string,
  projectId: string | null,
) {
  const file = await db.fileObject.findFirst({
    where: {
      id,
      organizationId: p.organizationId,
      projectId,
      deletedAt: null,
      ...(projectId === null ? { createdBy: p.userId } : {}),
    },
  });
  if (!file) throw new ApiError(403, "任务文件已删除或不在任务的授权范围内");
  if (!TEXT_EXTENSIONS.has(extension(file.name)))
    throw new ApiError(422, "所选文件格式无法提取文本");
  return file;
}

export function attachment(name: string) {
  return (
    "attachment; filename*=UTF-8''" +
    encodeURIComponent(name).replace(
      /['()*]/g,
      (part) => "%" + part.charCodeAt(0).toString(16).toUpperCase(),
    )
  );
}

export async function registerFileRoutes(app: FastifyInstance) {
  const db = getDb();
  const checkProject = async (
    p: Principal,
    id: string | null | undefined,
    mode: "read" | "write" = "read",
  ) => {
    if (id && !(await assertProjectAccess(p.organizationId, id, p.userId, p.role, mode)))
      throw new ApiError(403, "项目不存在、已归档或当前权限不足");
  };
  const getFile = async (p: Principal, id: string) => {
    const file = await db.fileObject.findFirst({
      where: { id, organizationId: p.organizationId, deletedAt: null },
    });
    if (!file) throw new ApiError(404, "文件不存在");
    await checkProject(p, file.projectId);
    if (!file.projectId && file.createdBy !== p.userId && p.role !== "ADMIN")
      throw new ApiError(403, "私有文件未授权");
    return file;
  };
  const checkEdit = async (p: Principal, file: FileObject) => {
    await checkProject(p, file.projectId, "write");
    if (file.createdBy === p.userId || p.role === "ADMIN") return;
    if (
      !file.projectId ||
      !(await assertProjectAccess(p.organizationId, file.projectId, p.userId, p.role, "manage"))
    )
      throw new ApiError(403, "仅上传者或项目管理员可修改文件");
  };

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
        category: categorySchema.default(""),
        sourceUrl: z.union([z.literal(""), z.url({ protocol: /^https?$/ }).max(2000)]).default(""),
      })
      .parse(req.body);
    await checkProject(p, b.projectId, "write");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b.contentBase64))
      throw new ApiError(400, "非法 base64");
    const buf = Buffer.from(b.contentBase64, "base64");
    if (!buf.length || buf.length > 5 * 1024 * 1024)
      throw new ApiError(413, "文件必须为 1 字节至 5 MiB");
    const storageKey = storageKeyFor(p.organizationId, b.name);
    await putObject(storageKey, buf);
    try {
      const file = await db.$transaction(async (tx) => {
        const row = await tx.fileObject.create({
          data: {
            organizationId: p.organizationId,
            projectId: b.projectId ?? null,
            name: b.name,
            storageKey,
            sizeBytes: buf.length,
            sourceUrl: b.sourceUrl,
            category: b.category,
            createdBy: p.userId,
          },
        });
        await recordAudit(tx, p, row.projectId, "file.uploaded", row.id, {
          name: row.name,
          sizeBytes: row.sizeBytes,
        });
        return row;
      });
      return {
        ok: true,
        file: { ...file, textSupported: TEXT_EXTENSIONS.has(extension(file.name)) },
      };
    } catch (error) {
      await deleteObject(storageKey);
      throw error;
    }
  });
  app.get("/api/files", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p) return;
    const b = z
      .object({
        projectId: z.string().min(1).max(120).optional(),
        q: z.string().trim().max(180).optional(),
        category: categorySchema.optional(),
        page: z.coerce.number().int().min(1).max(10000).default(1),
      })
      .parse(req.query);
    await checkProject(p, b.projectId);
    const rows = await db.fileObject.findMany({
      where: {
        organizationId: p.organizationId,
        deletedAt: null,
        projectId: b.projectId ?? null,
        ...(b.projectId ? {} : { createdBy: p.userId }),
        ...(b.q ? { name: { contains: b.q, mode: "insensitive" } } : {}),
        category: b.category,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (b.page - 1) * 25,
      take: 26,
      include: { _count: { select: { uses: true } } },
    });
    return {
      ok: true,
      files: rows.slice(0, 25).map((row) => ({ ...fileView(row), useCount: row._count.uses })),
      hasMore: rows.length > 25,
    };
  });
  app.get("/api/files/:id", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p) return;
    const file = await getFile(p, idParam.parse(req.params).id);
    return { ok: true, file: fileView(file) };
  });
  app.get("/api/files/:id/preview", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p) return;
    const { id } = idParam.parse(req.params);
    const file = await getFile(p, id);
    await consumeLimit("preview:" + p.organizationId + ":" + p.userId, 24, 60000);
    const bytes = await getObject(file.storageKey);
    try {
      return { ok: true, preview: await extractFileText(file.name, bytes) };
    } catch (error) {
      throw new ApiError(422, error instanceof Error ? error.message : "无法提取文件文本");
    }
  });
  app.get("/api/files/:id/usage", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p) return;
    const file = await getFile(p, idParam.parse(req.params).id);
    const uses = await db.fileUse.findMany({
      where: {
        fileId: file.id,
        run: {
          task: {
            organizationId: p.organizationId,
            projectId: file.projectId,
            ...(file.projectId ? {} : { createdBy: p.userId }),
          },
        },
      },
      include: { run: { select: { taskId: true, status: true } } },
      orderBy: { createdAt: "desc" },
      take: 30,
    });
    return { ok: true, uses };
  });
  for (const method of ["PATCH", "DELETE"] as const) {
    app.route({
      method,
      url: "/api/files/:id",
      handler: async (req, reply) => {
        const p = requirePrincipal(req, reply);
        if (!p) return;
        const file = await getFile(p, idParam.parse(req.params).id);
        await checkEdit(p, file);
        const data =
          method === "DELETE"
            ? { deletedAt: new Date() }
            : z.object({ category: categorySchema }).parse(req.body);
        await db.$transaction(async (tx) => {
          const saved = await tx.fileObject.updateMany({
            where: { id: file.id, deletedAt: null },
            data,
          });
          if (!saved.count) throw new ApiError(409, "文件已删除");
          await recordAudit(
            tx,
            p,
            file.projectId,
            method === "DELETE" ? "file.removed" : "file.categorized",
            file.id,
            { name: file.name },
          );
        });
        return { ok: true };
      },
    });
  }
  app.post("/api/files/:id/download-ticket", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p) return;
    await consumeLimit("download-ticket:" + p.organizationId + ":" + p.userId, 60, 60000);
    const file = await getFile(p, idParam.parse(req.params).id);
    return { ok: true, ticket: await signDownloadTicket(file.id, p), expiresInSeconds: 60 };
  });
  app.get("/api/files/:id/download", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { dl } = z.object({ dl: z.string().optional() }).parse(req.query);
    if (!dl || !(await verifyDownloadTicket(dl, id)))
      throw new ApiError(401, "下载票据无效、过期、已使用或权限已撤销");
    const file = await db.fileObject.findFirst({ where: { id, deletedAt: null } });
    if (!file) throw new ApiError(404, "文件不存在");
    reply.header("content-disposition", attachment(file.name)).header("cache-control", "no-store");
    return reply.send(await getObject(file.storageKey));
  });
}
