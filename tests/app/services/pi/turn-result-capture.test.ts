import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createTurnResultCapture } from "../../../../src/services/pi/runtime/turn-result-capture";
import {
  implicitTurnResultFor,
  substantiveTurnResult,
  type PiTurnResult,
} from "../../../../src/contracts/pi/turn-result-data";
import { encodeCrossSessionMessage } from "../../../../src/contracts/conversations/cross-session-message";
import { addPresentationModeReminder } from "../../../../src/contracts/conversations/presentation-mode-reminders";

const assistant = (
  text: string,
  stopReason: "stop" | "toolUse" | "error" | "aborted" = "stop",
): AgentSessionEvent => ({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason,
    timestamp: 0,
    api: "openai-responses",
    provider: "openai",
    model: "fixture",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    ...(stopReason === "error" ? { errorMessage: "Provider failed" } : null),
  },
});
const user: AgentSessionEvent = {
  type: "message_end",
  message: { role: "user", content: "Task", timestamp: 0 },
};

const parent = "474e9d62-e606-4d77-ac57-07bc53830481";
const sibling = "bf90dcd3-83d1-4857-ba3b-9c6344d3d802";
const grandchild = "5c47caf0-9bb6-487e-89e0-60c6dad7d164";
let sequence = 0;
const fromSession = (
  sessionId: string,
  extra: { replyToMessageId?: string; generatedNotice?: boolean } = {},
): AgentSessionEvent => ({
  type: "message_end",
  message: {
    role: "user",
    content: encodeCrossSessionMessage("Coordination", {
      version: 1,
      messageId: `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
      threadId: "00000000-0000-4000-8000-100000000000",
      sequence: 1,
      expectsResponse: true,
      ...extra,
      sender: { sessionId, title: "Session", kind: "project-session" },
    }),
    timestamp: 0,
  },
});
const finalAnswer = "A substantive final answer with findings and verification.";
const settledResult = (events: readonly AgentSessionEvent[]) => {
  const results: PiTurnResult[] = [];
  const capture = createTurnResultCapture(
    () => ["delegated"],
    (_id, result) => results.push(result),
  );
  for (const event of events) capture(event);
  capture(assistant(finalAnswer));
  capture({ type: "agent_settled" });
  return results[0];
};

describe("Pi run final-answer addressee", () => {
  it("captures the exact application-owned final entry for link/artifact-only results", () => {
    const results: PiTurnResult[] = [];
    const capture = createTurnResultCapture(
      () => ["request"],
      (_id, result) => results.push(result),
      () => "pi-final-entry",
    );
    capture(fromSession(parent));
    capture(assistant("[Drawing](cake://artifact/drawing)"));
    capture({ type: "agent_settled" });
    expect(results[0]).toMatchObject({ entryId: "pi-final-entry", respondsToSessionId: parent });
    expect(implicitTurnResultFor(results[0], parent)).toBe("[Drawing](cake://artifact/drawing)");
  });

  it("attributes a delegated run's answer to its requester", () => {
    const result = settledResult([fromSession(parent), assistant("Working", "toolUse")]);
    expect(result?.respondsToSessionId).toBe(parent);
    expect(implicitTurnResultFor(result, parent)).toBe(finalAnswer);
  });

  it("never attributes an answer to the local user's later input to the requester", () => {
    // Reproduces the reported child: the user typed into a busy delegated child and Pi
    // consumed that follow-up into the same run, so its final answer addressed the user.
    const result = settledResult([fromSession(parent), assistant("Reported", "stop"), user]);
    expect(result?.respondsToSessionId).toBeUndefined();
    expect(implicitTurnResultFor(result, parent)).toBeUndefined();
    const reminded = (content: string): AgentSessionEvent => ({
      type: "message_end",
      message: {
        role: "user",
        content: addPresentationModeReminder(content, "normal", "browser"),
        timestamp: 0,
      },
    });
    expect(
      implicitTurnResultFor(settledResult([fromSession(parent), reminded("STOP")]), parent),
    ).toBeUndefined();
    const parentRequest = fromSession(parent);
    const parentContent =
      parentRequest.type === "message_end" && parentRequest.message.role === "user"
        ? String(parentRequest.message.content)
        : "";
    expect(settledResult([reminded(parentContent)])?.respondsToSessionId).toBe(parent);
  });

  it("follows the latest new request but not replies or generated notices", () => {
    expect(
      settledResult([fromSession(parent), user, fromSession(parent)])?.respondsToSessionId,
    ).toBe(parent);
    const answeredSibling = settledResult([fromSession(parent), fromSession(sibling)]);
    expect(implicitTurnResultFor(answeredSibling, parent)).toBeUndefined();
    expect(implicitTurnResultFor(answeredSibling, sibling)).toBe(finalAnswer);
    const nested = settledResult([
      fromSession(parent),
      fromSession(grandchild, { replyToMessageId: "00000000-0000-4000-8000-200000000000" }),
      fromSession(grandchild, { generatedNotice: true }),
    ]);
    expect(implicitTurnResultFor(nested, parent)).toBe(finalAnswer);
    expect(
      settledResult([user, fromSession(grandchild, { generatedNotice: true })])
        ?.respondsToSessionId,
    ).toBeUndefined();
  });

  it("starts every run unattributed", () => {
    const results: PiTurnResult[] = [];
    const capture = createTurnResultCapture(
      () => ["turn"],
      (_id, result) => results.push(result),
    );
    capture(fromSession(parent));
    capture(assistant(finalAnswer));
    capture({ type: "agent_settled" });
    capture(fromSession(grandchild, { generatedNotice: true }));
    capture(assistant(finalAnswer));
    capture({ type: "agent_settled" });
    expect(results.map((result) => result.respondsToSessionId)).toEqual([parent, undefined]);
  });
});

describe("Pi run result evidence", () => {
  it("uses the final assistant message only and correlates every consumed input", () => {
    const results: Array<[string, PiTurnResult]> = [];
    const capture = createTurnResultCapture(
      () => ["initial", "steering"],
      (id, result) => results.push([id, result]),
    );
    capture(user);
    capture(assistant("Still working", "toolUse"));
    capture(assistant("Implemented the change; the focused regression suite passed."));
    expect(results).toEqual([]);
    capture({ type: "agent_settled" });
    expect(results.map(([id]) => id)).toEqual(["initial", "steering"]);
    expect(results[0]?.[1].text).toContain("regression suite passed");
    capture({ type: "agent_settled" });
    expect(results).toHaveLength(2);
  });

  it("does not report a historical assistant tail for an empty new run", () => {
    const results: PiTurnResult[] = [];
    const capture = createTurnResultCapture(
      () => ["turn"],
      (_id, result) => results.push(result),
    );
    capture(assistant("Earlier work completed successfully."));
    capture(user);
    capture({ type: "agent_settled" });
    expect(results).toEqual([]);
  });

  it.each(["toolUse", "error", "aborted"] as const)(
    "retains %s evidence without treating it as a successful final result",
    (stopReason) => {
      const results: PiTurnResult[] = [];
      const capture = createTurnResultCapture(
        () => ["turn"],
        (_id, result) => results.push(result),
      );
      capture(user);
      capture(
        assistant("A long partial result is not proof of successful completion.", stopReason),
      );
      capture({ type: "agent_settled" });
      expect(results[0]?.stopReason).toBe(stopReason);
      expect(substantiveTurnResult(results[0])).toBeUndefined();
      if (stopReason === "error") expect(results[0]?.errorMessage).toBe("Provider failed");
    },
  );

  it.each(["", "Done.", "Acknowledged.", "Thank you."])(
    "rejects empty or acknowledgment-only output %j",
    (text) => {
      expect(substantiveTurnResult({ stopReason: "stop", text })).toBeUndefined();
    },
  );
});
