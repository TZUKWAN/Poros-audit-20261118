/**
 * A snapshot is emitted for many ordinary state changes (run progress,
 * project updates, settings, and modal actions). Those updates must preserve
 * the user's current position in the conversation. Only the first snapshot
 * and a switch to another conversation should place the reading column at the
 * latest message.
 */
export function shouldResetChatScroll(
  hasPreviousSnapshot: boolean,
  previousSessionId: string | null | undefined,
  nextSessionId: string | null | undefined,
  previousMessageCount = 0,
  nextMessageCount = 0,
): boolean {
  // Temporary sessions intentionally have no durable ID. A new temporary
  // conversation therefore appears as null -> null; the chat length falling
  // back to zero is the reliable navigation signal in that case.
  return !hasPreviousSnapshot || previousSessionId !== nextSessionId || nextMessageCount < previousMessageCount;
}

export interface PendingLongRunConfig {
  scenarioId: string;
  maxRounds: number;
  sessionId: string | null;
  projectId?: string | null;
}

/** A long-run choice is valid only for the conversation that created it. */
export function pendingLongRunForSession(
  config: PendingLongRunConfig | null,
  sessionId: string | null | undefined,
  scenarioId: string | null | undefined,
): PendingLongRunConfig | null {
  if (!config || !sessionId || !scenarioId) return null;
  return config.sessionId === sessionId && config.scenarioId === scenarioId ? config : null;
}
