import { describe, expect, it } from "vitest";
import { pendingLongRunForSession, shouldResetChatScroll } from "@/panel/chat-state";

describe("chat snapshot scroll policy", () => {
  it("starts at the latest message for the first snapshot", () => {
    expect(shouldResetChatScroll(false, undefined, "session-1")).toBe(true);
  });

  it("preserves the reading position for snapshots in the same session", () => {
    expect(shouldResetChatScroll(true, "session-1", "session-1")).toBe(false);
    expect(shouldResetChatScroll(true, null, null)).toBe(false);
  });

  it("starts at the latest message after switching sessions", () => {
    expect(shouldResetChatScroll(true, "session-1", "session-2")).toBe(true);
    expect(shouldResetChatScroll(true, null, "session-1")).toBe(true);
  });

  it("detects a new temporary session when both sessions have no durable ID", () => {
    expect(shouldResetChatScroll(true, null, null, 5, 0)).toBe(true);
    expect(shouldResetChatScroll(true, null, null, 0, 0)).toBe(false);
  });

  it("does not reuse a staged long-run choice in another session", () => {
    const config = { scenarioId: "scenario-1", maxRounds: 3, sessionId: "session-1" };
    expect(pendingLongRunForSession(config, "session-1", "scenario-1")).toEqual(config);
    expect(pendingLongRunForSession(config, "session-2", "scenario-1")).toBeNull();
    expect(pendingLongRunForSession(config, "session-1", "scenario-2")).toBeNull();
    expect(pendingLongRunForSession({ ...config, sessionId: null }, "session-1", "scenario-1")).toBeNull();
  });
});
