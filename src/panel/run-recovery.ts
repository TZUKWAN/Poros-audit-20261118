export interface RestartRunState {
  /** Durable RunProduct id. Recovery must key on this, never only on text. */
  id?: string;
  mode: "build" | "work";
  status: string;
  requirement: string;
  startedAt: string;
}

export interface ResumableBuildContext {
  id: string;
  requirement: string;
  projectId: string | null;
}

/**
 * Match persisted construction checkpoints to durable run rows. Prefer the
 * explicit BuildContext id written in `run.details.buildId`; for legacy rows,
 * only a unique requirement/project match is safe. Returning no id on an
 * ambiguous match makes restart cancellation conservative and prevents a
 * checkpoint from being attached to another conversation.
 */
export function matchResumableBuildRunIds(contexts: ReadonlyArray<ResumableBuildContext>, runs: ReadonlyArray<RestartRunState & { details?: Record<string, unknown> | null; projectId?: string | null; sessionId?: string | null }>, sessionId?: string | null): Set<string> {
  const activeBuilds = runs.filter((run) => run.mode === "build" && ["queued", "running", "paused", "waiting-approval", "waiting-user"].includes(run.status) && (sessionId === undefined || (run.sessionId ?? null) === sessionId));
  const ids = new Set<string>();
  for (const context of contexts) {
    const exact = activeBuilds.filter((run) => run.details?.buildId === context.id);
    const linked = exact.length > 0 ? exact : activeBuilds.filter((run) => run.requirement === context.requirement && (run.projectId ?? null) === context.projectId);
    if (linked.length === 1 && linked[0]?.id) ids.add(linked[0].id);
  }
  return ids;
}

/** Select a checkpoint owned by the hydrated conversation only. */
export function selectResumableBuildContext<T extends ResumableBuildContext & { updatedAt?: string }>(contexts: ReadonlyArray<T>, runs: ReadonlyArray<RestartRunState & { details?: Record<string, unknown> | null; projectId?: string | null; sessionId?: string | null }>, sessionId: string | null): T | undefined {
  const activeBuilds = runs.filter((run) => run.mode === "build" && ["queued", "running", "paused", "waiting-approval", "waiting-user"].includes(run.status) && (run.sessionId ?? null) === sessionId);
  const owned = contexts.filter((context) => {
    const exact = activeBuilds.filter((run) => run.details?.buildId === context.id);
    const linked = exact.length > 0 ? exact : activeBuilds.filter((run) => run.requirement === context.requirement && (run.projectId ?? null) === context.projectId);
    return linked.length === 1;
  });
  return owned.sort((a, b) => Date.parse(a.updatedAt ?? "") - Date.parse(b.updatedAt ?? "")).at(-1);
}

/**
 * Work runs do not persist a worker checkpoint, so running/paused work cannot
 * be resumed after a process restart. Construction builds with a pending gate
 * or a model clarification are resumable records. The set contains durable run ids. Older
 * callers that do not provide an id cannot be treated as resumable because
 * two sessions may legitimately use the same requirement text.
 */
export function shouldCancelAfterRestart(run: RestartRunState, resumableBuildRunIds: ReadonlySet<string>): boolean {
  if (run.status !== "running" && run.status !== "paused" && run.status !== "waiting-user") return false;
  if (run.mode === "build" && run.id && resumableBuildRunIds.has(run.id)) return false;
  return true;
}

export function restartCancellationPatch(run: RestartRunState, nowMs = Date.now()): { status: "cancelled"; finishedAt: string; durationMs: number; error: string } {
  const finishedAt = new Date(nowMs).toISOString();
  const startedMs = Date.parse(run.startedAt);
  return {
    status: "cancelled",
    finishedAt,
    durationMs: Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs) : 0,
    error: "面板进程重启，运行没有可恢复的执行检查点。",
  };
}
