import type { Prisma, PrismaClient } from "@prisma/client";
import {
  ProjectStore,
  sourceDigest,
  validateFiles,
  type ProjectFiles,
} from "../../agent-project/files.js";
import { starterProject, type ProjectKind } from "../../agent-project/contract.js";
import type { Principal } from "../auth.js";
import { ApiError } from "../errors.js";

export const json = (value: unknown) => value as Prisma.InputJsonValue;
export async function workspaceAccess(db: PrismaClient, p: Principal, id: string) {
  const workspace = await db.ideWorkspace.findFirst({
    where: { id, organizationId: p.organizationId, ownerId: p.userId },
  });
  if (!workspace) throw new ApiError(404, "工程不存在或无权访问");
  return workspace;
}
export async function createWorkspace(
  db: PrismaClient,
  p: Principal,
  name: string,
  kind: ProjectKind,
) {
  const files = starterProject(kind, name),
    digest = sourceDigest(files);
  const workspace = await db.ideWorkspace.create({
    data: {
      organizationId: p.organizationId,
      ownerId: p.userId,
      name,
      kind,
      revisions: { create: { digest, files: json(files) } },
      sourceDigest: digest,
    },
  });
  await new ProjectStore().save(workspace.id, files);
  return workspace;
}
export async function revisionFiles(db: PrismaClient, workspaceId: string, digest: string) {
  const revision = await db.ideRevision.findUnique({
    where: { workspaceId_digest: { workspaceId, digest } },
  });
  if (!revision) throw new ApiError(404, "源码版本不存在");
  const archive = validateFiles(revision.files);
  // Immutable DB snapshot is a recovery copy. Runtime reads and verifies real files.
  const store = new ProjectStore();
  await store.save(workspaceId, archive);
  return store.read(workspaceId, digest, Object.keys(archive));
}
export async function saveRevision(
  db: PrismaClient,
  p: Principal,
  id: string,
  expected: string,
  raw: ProjectFiles,
) {
  await workspaceAccess(db, p, id);
  const files = validateFiles(raw),
    digest = sourceDigest(files);
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "IdeWorkspace" WHERE id=${id} FOR UPDATE`;
      if (
        !(await tx.ideWorkspace.count({
          where: {
            id,
            organizationId: p.organizationId,
            ownerId: p.userId,
            sourceDigest: expected,
          },
        }))
      )
        throw new ApiError(409, "工程已被修改，请先读取最新版本");
      await new ProjectStore().save(id, files);
      const changed = await tx.ideWorkspace.updateMany({
        where: { id, organizationId: p.organizationId, ownerId: p.userId, sourceDigest: expected },
        data: { sourceDigest: digest },
      });
      if (!changed.count) throw new ApiError(409, "工程已被修改，请先读取最新版本");
      await tx.ideRevision.upsert({
        where: { workspaceId_digest: { workspaceId: id, digest } },
        create: { workspaceId: id, digest, files: json(files) },
        update: {},
      });
      return { digest, files };
    },
    { timeout: 30000 },
  );
}
