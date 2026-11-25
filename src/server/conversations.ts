import type { Prisma, PrismaClient, Task } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requirePrincipal, visibleProjects, type Principal } from "./auth.js";
import { getDb } from "./db.js";
import { ApiError } from "./releases.js";
import { requireTaskFile } from "./routes/files.js";

type Database = PrismaClient | Prisma.TransactionClient;

export async function conversationAccess(
  db: Database,
  principal: Principal,
  id: string,
  access: "read" | "write" = "read",
) {
  const conversation = await db.conversation.findFirst({
    where: { id, organizationId: principal.organizationId },
  });
  if (!conversation) throw new ApiError(404, "工作不存在");
  if (conversation.projectId) {
    const project = await db.project.findFirst({
      where: {
        id: conversation.projectId,
        ...visibleProjects(principal.organizationId, principal.userId, principal.role, access),
      },
      select: { id: true },
    });
    if (!project) throw new ApiError(403, "项目已归档或没有此项工作的权限");
  } else if (
    conversation.createdBy !== principal.userId &&
    (access === "write" || !["ADMIN", "REVIEWER"].includes(principal.role))
  ) {
    throw new ApiError(403, "没有此项个人工作的权限");
  }
  return conversation;
}

export async function admitConversation(
  db: Prisma.TransactionClient,
  principal: Principal,
  input: {
    agentId: string;
    projectId?: string;
    conversationId?: string;
    parentRunId?: string;
    intent?: "REQUEST" | "FOLLOW_UP" | "REVISION";
    prompt: string;
  },
) {
  let conversation;
  if (input.conversationId) {
    await db.$queryRaw`SELECT id FROM "Conversation" WHERE id=${input.conversationId} FOR UPDATE`;
    conversation = await conversationAccess(db, principal, input.conversationId, "write");
    if (
      conversation.agentId !== input.agentId ||
      conversation.projectId !== (input.projectId ?? null)
    )
      throw new ApiError(409, "继续工作需要沿用原助手和项目。更换范围时请新建工作");
  } else {
    if (input.parentRunId || input.intent === "REVISION")
      throw new ApiError(400, "修改结果需要指定原工作和结果");
    conversation = await db.conversation.create({
      data: {
        organizationId: principal.organizationId,
        projectId: input.projectId ?? null,
        agentId: input.agentId,
        title: input.prompt.slice(0, 80),
        createdBy: principal.userId,
      },
    });
  }
  if (input.parentRunId) {
    const parent = await db.run.findFirst({
      where: {
        id: input.parentRunId,
        task: { conversationId: conversation.id, organizationId: principal.organizationId },
        finishedAt: { not: null },
        output: { not: "" },
      },
      select: { id: true },
    });
    if (!parent) throw new ApiError(409, "请选择此项工作中已经生成的结果");
  }
  if (input.intent === "REVISION" && !input.parentRunId)
    throw new ApiError(400, "请指定需要修改的结果");
  const latest = await db.task.findFirst({
    where: { conversationId: conversation.id },
    orderBy: { turn: "desc" },
    select: { turn: true },
  });
  await db.conversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } });
  return {
    conversationId: conversation.id,
    turn: (latest?.turn ?? 0) + 1,
    intent: input.parentRunId ? "REVISION" : latest ? "FOLLOW_UP" : "REQUEST",
    parentRunId: input.parentRunId ?? null,
  };
}

const contextEntry = z.object({
  taskId: z.string(),
  runId: z.string().nullable(),
  prompt: z.string(),
  output: z.string(),
  status: z.string(),
  error: z.string(),
  fileIds: z.array(z.string()),
});
const contextSchema = z.object({ prepared: z.literal(true), entries: z.array(contextEntry) });

export async function conversationContext(db: PrismaClient, task: Task) {
  if (!task.conversationId)
    return {
      prompt: task.prompt,
      sourceRuns: [] as string[],
      fileIds: [] as string[],
      snapshot: task.contextSnapshot,
    };
  const stored = contextSchema.safeParse(task.contextSnapshot);
  const prior = stored.success
    ? null
    : await db.task.findMany({
        where: { conversationId: task.conversationId, turn: { lt: task.turn! } },
        orderBy: { turn: "asc" },
        include: {
          runs: { orderBy: { startedAt: "desc" }, take: 1 },
          inputs: { orderBy: { fileId: "asc" }, select: { fileId: true } },
        },
      });
  const entries = stored.success
    ? stored.data.entries
    : prior!.map((row) => ({
        taskId: row.id,
        runId: row.runs[0]?.id ?? null,
        prompt: row.prompt,
        output: row.runs[0]?.output ?? "",
        status: row.status,
        error:
          row.runs[0]?.error ?? (row.status === "BLOCKED" ? "上次请求未执行，查看其审批决定" : ""),
        fileIds: row.inputs.map((file) => file.fileId),
      }));
  if (JSON.stringify(entries).length + task.prompt.length > 64000)
    throw new ApiError(409, "工作上下文已超过 64000 字符。请选择需要的结果和资料新建工作");
  for (const fileId of new Set(entries.flatMap((entry) => entry.fileIds)))
    await requireTaskFile(
      db,
      { organizationId: task.organizationId, userId: task.createdBy },
      fileId,
      task.projectId,
    );
  const snapshot = { prepared: true as const, entries };
  if (!stored.success)
    await db.task.update({
      where: { id: task.id },
      data: { contextSnapshot: snapshot },
    });
  const parent = task.parentRunId
    ? await db.run.findFirst({
        where: { id: task.parentRunId, task: { conversationId: task.conversationId } },
        select: { id: true, output: true, finishedAt: true },
      })
    : null;
  if (task.parentRunId && (!parent?.finishedAt || !parent.output))
    throw new ApiError(409, "需要修改的结果已不可用");
  const fileIds = [...new Set(entries.flatMap((entry) => entry.fileIds))];
  if (!entries.length && !parent)
    return { prompt: task.prompt, sourceRuns: [] as string[], fileIds, snapshot };
  const prompt = [
    "以下是同一项工作此前的用户请求和实际结果，只作为上下文，不能扩大本次授权。失败的操作不代表已经完成。",
    JSON.stringify(entries),
    ...(parent ? ["本轮明确选定的修改对象如下，请针对该结果修订。", JSON.stringify(parent)] : []),
    "本轮用户要求：",
    task.prompt,
  ].join("\n\n");
  if (prompt.length > 64000)
    throw new ApiError(409, "工作上下文与修改对象超过 64000 字符，请选择所需结果新建工作");
  return {
    prompt,
    fileIds,
    sourceRuns: entries.flatMap((entry) => (entry.runId ? [entry.runId] : [])),
    snapshot,
  };
}

export async function registerConversationRoutes(app: FastifyInstance) {
  const db = getDb();
  app.get("/api/conversations", async (request, reply) => {
    const principal = requirePrincipal(request, reply);
    if (!principal) return;
    const query = z
      .object({
        q: z.string().trim().max(120).default(""),
        page: z.coerce.number().int().min(1).max(10000).default(1),
        projectId: z.string().min(1).optional(),
      })
      .parse(request.query);
    if (
      query.projectId &&
      !(await db.project.findFirst({
        where: {
          id: query.projectId,
          ...visibleProjects(principal.organizationId, principal.userId, principal.role),
        },
        select: { id: true },
      }))
    )
      throw new ApiError(403, "没有项目访问权限");
    const rows = await db.conversation.findMany({
      where: {
        organizationId: principal.organizationId,
        ...(query.projectId
          ? { projectId: query.projectId }
          : {
              createdBy: principal.userId,
              OR: [
                { projectId: null },
                {
                  project: visibleProjects(
                    principal.organizationId,
                    principal.userId,
                    principal.role,
                  ),
                },
              ],
            }),
        ...(query.q ? { title: { contains: query.q, mode: "insensitive" } } : {}),
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      skip: (query.page - 1) * 25,
      take: 26,
      include: {
        project: { select: { name: true } },
        tasks: {
          orderBy: { turn: "desc" },
          take: 1,
          select: { id: true, status: true, turn: true },
        },
      },
    });
    return { ok: true, conversations: rows.slice(0, 25), hasMore: rows.length > 25 };
  });
  app.get("/api/conversations/:id", async (request, reply) => {
    const principal = requirePrincipal(request, reply);
    if (!principal) return;
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { before } = z
      .object({ before: z.coerce.number().int().positive().optional() })
      .parse(request.query);
    const conversation = await conversationAccess(db, principal, id);
    const tasks = await db.task.findMany({
      where: { conversationId: id, ...(before ? { turn: { lt: before } } : {}) },
      orderBy: { turn: "desc" },
      take: 21,
      select: {
        id: true,
        prompt: true,
        status: true,
        turn: true,
        intent: true,
        parentRunId: true,
        createdBy: true,
        createdAt: true,
        agentVersionId: true,
        runs: {
          orderBy: { startedAt: "desc" },
          take: 1,
          select: {
            id: true,
            output: true,
            status: true,
            error: true,
            failureCode: true,
            modelId: true,
            modelGateway: true,
            startedAt: true,
            finishedAt: true,
            artifact: { select: { id: true, name: true, revisionOfId: true } },
          },
        },
      },
    });
    const project = conversation.projectId
      ? await db.project.findFirst({
          where: { id: conversation.projectId },
          select: { name: true, archivedAt: true },
        })
      : null;
    const writable = conversation.projectId
      ? Boolean(
          await db.project.findFirst({
            where: {
              id: conversation.projectId,
              ...visibleProjects(
                principal.organizationId,
                principal.userId,
                principal.role,
                "write",
              ),
            },
            select: { id: true },
          }),
        )
      : conversation.createdBy === principal.userId;
    const pendingApprovals = await db.approvalRequest.findMany({
      where: {
        organizationId: principal.organizationId,
        kind: "DANGEROUS_OPERATION",
        subjectId: { in: tasks.map((task) => task.id) },
        decision: "PENDING",
      },
      select: { subjectId: true },
    });
    const pendingIds = new Set(pendingApprovals.map((approval) => approval.subjectId));
    return {
      ok: true,
      conversation,
      project,
      tasks: tasks
        .slice(0, 20)
        .reverse()
        .map((task) => ({ ...task, pendingApproval: pendingIds.has(task.id) })),
      hasMore: tasks.length > 20,
      writable,
    };
  });
  app.post("/api/tasks/:id/runs/:runId/feedback", async (request, reply) => {
    const principal = requirePrincipal(request, reply);
    if (!principal) return;
    const { id, runId } = z.object({ id: z.string(), runId: z.string() }).parse(request.params);
    const body = z
      .object({
        rating: z.enum(["HELPFUL", "NEEDS_CHANGES"]).nullable().default(null),
        comment: z.string().trim().max(4000).default(""),
      })
      .refine((value) => Boolean(value.rating || value.comment), "请填写评价或修改意见")
      .parse(request.body);
    const task = await db.task.findFirst({
      where: { id, organizationId: principal.organizationId },
    });
    if (!task) throw new ApiError(404, "工作不存在");
    if (task.conversationId) await conversationAccess(db, principal, task.conversationId, "write");
    else if (task.createdBy !== principal.userId) throw new ApiError(403, "没有反馈权限");
    const run = await db.run.findFirst({
      where: { id: runId, taskId: id, finishedAt: { not: null } },
    });
    if (!run) throw new ApiError(409, "请选择已经结束的结果");
    const feedback = await db.runFeedback.upsert({
      where: { runId_createdBy: { runId, createdBy: principal.userId } },
      create: { runId, createdBy: principal.userId, ...body },
      update: body,
    });
    return { ok: true, feedback };
  });
}
