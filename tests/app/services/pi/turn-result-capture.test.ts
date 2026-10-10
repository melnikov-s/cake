import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createTurnResultCapture } from "../../../../src/services/pi/runtime/turn-result-capture";
import {
  substantiveTurnResult,
  type PiTurnResult,
} from "../../../../src/contracts/pi/turn-result-data";

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
