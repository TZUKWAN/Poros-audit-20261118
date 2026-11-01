import { z } from "zod";

export const SyncEntitySchema = z.object({ id: z.string().min(1), updatedAt: z.string().datetime({ offset: true }) });
export type SyncEntity = z.infer<typeof SyncEntitySchema>;
export interface SyncPlan { create: string[]; update: string[]; conflicts: string[]; localOnly: string[]; remoteOnly: string[]; }

/** Deterministic three-way preparation for a later cloud transport. It never overwrites a newer local record silently. */
export function planSync(local: SyncEntity[], remote: SyncEntity[], base: SyncEntity[] = []): SyncPlan {
  const l = new Map(local.map((item) => [item.id, item]));
  const r = new Map(remote.map((item) => [item.id, item]));
  const b = new Map(base.map((item) => [item.id, item]));
  const create: string[] = [], update: string[] = [], conflicts: string[] = [], localOnly: string[] = [], remoteOnly: string[] = [];
  for (const [id, remoteItem] of r) {
    const localItem = l.get(id); const baseItem = b.get(id);
    if (!localItem) { create.push(id); remoteOnly.push(id); continue; }
    if (!baseItem) { if (localItem.updatedAt !== remoteItem.updatedAt) conflicts.push(id); else update.push(id); continue; }
    const localChanged = localItem.updatedAt !== baseItem.updatedAt;
    const remoteChanged = remoteItem.updatedAt !== baseItem.updatedAt;
    if (localChanged && remoteChanged && localItem.updatedAt !== remoteItem.updatedAt) conflicts.push(id);
    else if (remoteChanged) update.push(id);
    else if (!remoteChanged && localChanged) localOnly.push(id);
  }
  for (const id of l.keys()) if (!r.has(id)) localOnly.push(id);
  return { create, update, conflicts, localOnly, remoteOnly };
}

