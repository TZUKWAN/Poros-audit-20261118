/** PostgreSQL durable queue. Atomic claims, leases and advisory lock enforce shared quotas. */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { runTask, type RunnerDeps } from "./runner.js";
import { cleanupOrphanedRuntime } from "./dsh-runtime.js";
import { findConnection } from "./integration-connections.js";
export const TERMINAL = new Set([
  "SUCCEEDED",
  "FAILED",
  "BLOCKED",
  "UNVERIFIED",
  "SUCCEEDED_WITH_VIOLATIONS",
  "CANCELLED",
  "TIMED_OUT",
]);
export function startWorker(db: PrismaClient, overrides: Partial<RunnerDeps> = {}) {
  const id = randomUUID(),
    active = new Map<string, { ctrl: AbortController; promise: Promise<unknown> }>();
  let polling = false,
    stopped = false;
  let lastMaintenance = 0;
  let maintenance: Promise<void> = Promise.resolve();
  const tick = async () => {
    if (stopped || polling) return;
    polling = true;
    try {
      if (Date.now() - lastMaintenance > 60000) {
        lastMaintenance = Date.now();
        await db.rateLimitBucket.deleteMany({
          where: { resetAt: { lt: new Date(Date.now() - 86400000) } },
        });
        maintenance = cleanupOrphanedRuntime(db).catch(() =>
          console.error("Runtime cleanup unavailable; owned resources will be retried"),
        );
      }
      // A crashed worker cannot silently retry side effects. Mark expired attempts failed; retry requires user action.
      const stale = await db.task.findMany({
        where: { status: "RUNNING", leaseUntil: { lt: new Date() } },
      });
      for (const task of stale)
        await db.$transaction(async (tx) => {
          const claimed = await tx.task.updateMany({
            where: { id: task.id, status: "RUNNING", leaseUntil: { lt: new Date() } },
            data: { status: "FAILED", workerId: null, leaseUntil: null },
          });
          if (claimed.count)
            await tx.run.updateMany({
              where: { taskId: task.id, status: "RUNNING" },
              data: {
                status: "FAILED",
                error: "Worker lease expired; explicit retry required",
                finishedAt: new Date(),
              },
            });
        });
      for (const [taskId, job] of active) {
        const task = await db.task.findUnique({ where: { id: taskId } });
        if (!task || task.cancelRequested) job.ctrl.abort();
        else {
          const member = await db.membership.findUnique({
            where: {
              organizationId_userId: {
                organizationId: task.organizationId,
                userId: task.createdBy,
              },
            },
          });
          const projectAllowed =
            !task.projectId ||
            member?.role === "ADMIN" ||
            (await db.projectMember.findUnique({
              where: { projectId_userId: { projectId: task.projectId, userId: task.createdBy } },
            }));
          if (!member || !projectAllowed)
            job.ctrl.abort(
              new Error("POLICY_REVOKED: task membership or project permission removed"),
            );
          else if (task.modelConnectionRevision) {
            const model = await findConnection(
              db,
              { organizationId: task.organizationId, userId: task.createdBy },
              "model",
            );
            if (
              !model ||
              model.revision !== task.modelConnectionRevision ||
              model.testCode !== "OK"
            )
              job.ctrl.abort(new Error("POLICY_REVOKED: personal model no longer authorized"));
          }
        }
      }
      const job = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(709141821)::text`;
        const running = await tx.task.findMany({
          where: { status: "RUNNING" },
          select: { organizationId: true },
        });
        if (running.length >= Number(process.env.POROS_MAX_CONCURRENCY || 4)) return null;
        const candidates = await tx.task.findMany({
          where: { status: "QUEUED", availableAt: { lte: new Date() }, cancelRequested: false },
          orderBy: { createdAt: "asc" },
          take: 100,
        });
        const task = candidates.find(
          (t) =>
            running.filter((r) => r.organizationId === t.organizationId).length <
            Number(process.env.POROS_ORG_CONCURRENCY || 2),
        );
        if (!task) return null;
        const updated = await tx.task.updateMany({
          where: { id: task.id, status: "QUEUED" },
          data: {
            status: "RUNNING",
            workerId: id,
            leaseUntil: new Date(Date.now() + task.timeoutMs + 30000),
            attempts: { increment: 1 },
          },
        });
        if (!updated.count) return null;
        const run = await tx.run.create({ data: { taskId: task.id, status: "RUNNING" } });
        return { task, run };
      });
      if (job) {
        const ctrl = new AbortController(),
          timer = setTimeout(() => ctrl.abort(), job.task.timeoutMs);
        const promise = runTask(
          { db, ...overrides, signal: ctrl.signal, runId: job.run.id },
          job.task.id,
        )
          .catch((error) => {
            console.error(
              "worker execution failed",
              error instanceof Error ? error.name : "unknown",
            );
          })
          .finally(() => {
            clearTimeout(timer);
            active.delete(job.task.id);
          });
        active.set(job.task.id, { ctrl, promise });
      }
    } finally {
      polling = false;
    }
  };
  const interval = setInterval(() => {
    void tick().catch(() => {
      /* DB outage leaves durable jobs/leases; next poll retries the DB connection. */
    });
  }, 150);
  interval.unref();
  return {
    tick,
    async stop() {
      stopped = true;
      clearInterval(interval);
      while (polling) await new Promise((resolve) => setTimeout(resolve, 10));
      for (const j of active.values()) j.ctrl.abort(new Error("WORKER_SHUTDOWN"));
      await Promise.all([...active.values()].map((j) => j.promise));
      await maintenance;
    },
  };
}
