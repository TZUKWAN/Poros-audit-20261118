import type { Prisma, Task } from "@prisma/client";
import { visibleProjects } from "./auth.js";
import { ApiError } from "./releases.js";
import {
  assertCapabilityConnections,
  assertGrantRevision,
  requireManagedGrant,
} from "./capabilities.js";
import type { DshGrant } from "./dsh-runtime.js";
import { findConnection } from "./integration-connections.js";

type TaskIdentity = Pick<
  Task,
  | "id"
  | "organizationId"
  | "createdBy"
  | "createdAt"
  | "projectId"
  | "agentVersionId"
  | "executionSnapshot"
  | "connectionRevisions"
  | "modelConnectionRevision"
>;

export async function assertTaskAccess(db: Prisma.TransactionClient, task: TaskIdentity) {
  const member = await db.membership.findUnique({
    where: {
      organizationId_userId: { organizationId: task.organizationId, userId: task.createdBy },
    },
  });
  if (!member || member.disabledAt) throw new ApiError(403, "任务发起人已无组织权限");
  if (
    task.projectId &&
    !(await db.project.findFirst({
      where: {
        id: task.projectId,
        ...visibleProjects(task.organizationId, task.createdBy, member.role, "write"),
      },
      select: { id: true },
    }))
  )
    throw new ApiError(403, "项目已归档或任务发起人已无项目执行权限");
  const agentId = (task.executionSnapshot as { agentId?: unknown } | null)?.agentId;
  if (
    typeof agentId === "string" &&
    !(await db.agentDefinition.findFirst({
      where: {
        id: agentId,
        organizationId: task.organizationId,
        status: { not: "DISABLED" },
        OR: [
          { projectRestricted: false },
          ...(task.projectId ? [{ projects: { some: { projectId: task.projectId } } }] : []),
        ],
      },
      select: { id: true },
    }))
  )
    throw new ApiError(403, "Agent 已禁用或项目授权已撤销");
  if (
    await db.taskInput.findFirst({ where: { taskId: task.id, file: { deletedAt: { not: null } } } })
  )
    throw new ApiError(403, "任务输入文件已删除");
  const grants = (task.executionSnapshot as { grants?: DshGrant[] } | null)?.grants;
  if (typeof agentId === "string" && Array.isArray(grants)) {
    const version = task.agentVersionId
      ? await db.agentVersion.findUnique({
          where: { id: task.agentVersionId },
          select: { version: true },
        })
      : null;
    await assertGrantRevision(db, agentId, grants, version?.version ?? null, task.createdAt);
    for (const grant of grants)
      await requireManagedGrant(db, task.organizationId, grant, task.projectId);
  }
  await assertCapabilityConnections(db, task);
  if (task.modelConnectionRevision) {
    const model = await findConnection(
      db,
      { organizationId: task.organizationId, userId: task.createdBy },
      "model",
    );
    if (!model || model.revision !== task.modelConnectionRevision || model.testCode !== "OK")
      throw new ApiError(403, "个人模型已断开、变化或验证失败，请重新发起任务");
  }
  return member;
}
