import { z } from "zod";

export const PanelEventSchema = z.object({
  eventId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  sessionId: z.string().nullable().default(null),
  runId: z.string().nullable().default(null),
  requestId: z.string().nullable().default(null),
  terminal: z.boolean().default(false),
  kind: z.string().min(1),
  payload: z.unknown(),
  emittedAt: z.string().datetime({ offset: true }),
});
export type PanelEvent = z.infer<typeof PanelEventSchema>;

export function eventId(prefix = "evt"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

