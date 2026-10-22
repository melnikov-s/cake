import { expect, it } from "vitest";
import { currentSessionOutcome } from "../../../src/contracts/project-sessions/session-reporting";
import { launchedSessionStatus } from "../../../src/renderer/lib/cake-chat-launches";
import { settledSessionActivity } from "../../../src/renderer/lib/session-activity";
import { TURN_STOPPED_NOTICE_TITLE } from "../../../src/contracts/conversations/turn-stop";

it.each(["failed", "stopped", "interrupted"] as const)(
  "a newer successful turn supersedes a retained %s launch report, even if delivered late",
  (status) => {
    const session = {
      sessionId: "session",
      title: "Task",
      projectName: "Project",
      modifiedAt: "2026-01-01",
      resolved: false,
      running: false,
      latestTurnOutcome: "complete" as const,
      cakeChatLaunch: {
        requesterSessionId: "chat",
        lastReport: { status, summary: "Historical problem", reportedAt: "2026-01-02" },
      },
    };
    expect(currentSessionOutcome("complete", status)).toBe("completed");
    expect(launchedSessionStatus(session, undefined)).toBe("done");
    expect(launchedSessionStatus({ ...session, running: true }, undefined)).toBe("running");
    expect(launchedSessionStatus(session, "waiting")).toBe("needs-you");
    expect(launchedSessionStatus({ ...session, latestTurnOutcome: "failed" }, "error")).toBe(
      "failed",
    );
  },
);

it("retains explicit task blockers independently of successful model generation", () => {
  expect(currentSessionOutcome("complete", "blocked")).toBe("blocked");
  expect(currentSessionOutcome(undefined, "failed")).toBe("failed");
  expect(currentSessionOutcome("failed", "completed")).toBe("failed");
});

it.each([
  { kind: "text", role: "assistant", status: "error" },
  { kind: "notice", tone: "error", title: "Model request failed" },
  { kind: "notice", tone: "info", title: TURN_STOPPED_NOTICE_TITLE },
])(
  "a successful hidden continuation supersedes $kind failure/stop without deleting it",
  (failure) => {
    const parts = [
      { kind: "text", role: "user", status: "complete" },
      failure,
      { kind: "text", role: "assistant", status: "complete" },
    ];
    expect(settledSessionActivity(undefined, parts)).toBe("unread");
    expect(settledSessionActivity("complete", parts)).toBe("unread");
    // No assistant text is required for an authoritative successful settlement.
    expect(settledSessionActivity("complete", parts.slice(0, -1))).toBe("unread");
    expect(
      settledSessionActivity(undefined, [
        ...parts,
        { kind: "text", role: "assistant", status: "error" },
      ]),
    ).toBe("error");
    expect(parts[1]).toBe(failure);
  },
);
