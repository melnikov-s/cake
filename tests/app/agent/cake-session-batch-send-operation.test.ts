import { describe, expect, it, vi } from "vitest";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";
import { createSessionSendBatchOperation } from "../../../src/domain/conversations/cake-session-batch-send-operation";
import type { JsonObject, JsonValue } from "../../../src/contracts/serialization/json-contract";

const context = { signal: new AbortController().signal, toolCallId: "batch", runtime: {} };
const receipt = (sessionId: string) => ({
  ok: true,
  command: "sessions.send",
  messageId: `message-${sessionId}`,
  threadId: `thread-${sessionId}`,
  delivery: "prompt",
  status: "accepted",
  targetTitle: sessionId,
  recipientContext: { usedTokens: 100, windowTokens: 1000 },
});
const registry = (send: (input: JsonObject, signal: AbortSignal) => Promise<JsonValue>) =>
  new CakeOperationRegistry([createSessionSendBatchOperation(send)]);
const invoke = (operations: CakeOperationRegistry, input: unknown) =>
  operations.invoke({ command: "sessions.send-batch", input }, context);

describe("sessions.send-batch operation", () => {
  it("sends sequentially to every recipient with shared defaults and compact results", async () => {
    let active = 0;
    const send = vi.fn(async (input: JsonObject) => {
      expect(active++).toBe(0);
      await Promise.resolve();
      active--;
      return receipt(String(input.sessionId));
    });
    const result = await invoke(registry(send), {
      sessionIds: ["a", "b"],
      text: "  Shared message  ",
      maxMessages: 5,
    });
    // Omitted response fields pass through so the single-send authority applies the
    // sender's own default (false for Project Sessions, a digest report for Cake Chat).
    expect(send.mock.calls.map(([input]) => input)).toEqual([
      { sessionId: "a", text: "Shared message", maxMessages: 5 },
      { sessionId: "b", text: "Shared message", maxMessages: 5 },
    ]);
    expect(result.structuredContent).toEqual({
      command: "sessions.send-batch",
      result: {
        ok: true,
        command: "sessions.send-batch",
        status: "complete",
        expectsResponse: false,
        outcomes: ["a", "b"].map((sessionId) => ({
          sessionId,
          ok: true,
          messageId: `message-${sessionId}`,
          threadId: `thread-${sessionId}`,
          delivery: "prompt",
          status: "accepted",
        })),
      },
    });
    expect(result.text).not.toContain("Shared message");
    expect(result.text).not.toContain("recipientContext");
  });

  it.each([
    { sessionIds: [], text: "message" },
    { sessionIds: ["a", "a"], text: "message" },
    { sessionIds: ["a", ""], text: "message" },
    { sessionIds: ["a", 42], text: "message" },
    { sessionIds: Array.from({ length: 101 }, (_, i) => String(i)), text: "message" },
    { sessionIds: ["a"], text: " " },
    { sessionIds: ["a"], text: "message", threadId: "existing-thread" },
  ])("rejects invalid arguments before sending: %j", async (input) => {
    const send = vi.fn(async () => receipt("a"));
    await expect(invoke(registry(send), input)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it("retains successes and all rejected/thrown/malformed failures, and continues", async () => {
    const send = vi.fn(async (input: JsonObject): Promise<JsonValue> => {
      if (input.sessionId === "missing") return { ok: false, error: "Session not found" };
      if (input.sessionId === "broken") throw new Error("Delivery unavailable");
      if (input.sessionId === "malformed") return { ok: true };
      return receipt(String(input.sessionId));
    });
    const result = await invoke(registry(send), {
      sessionIds: ["a", "missing", "broken", "malformed", "b"],
      text: "message",
      delivery: "steer",
      expectsResponse: false,
    });
    expect(result.structuredContent).toMatchObject({
      result: {
        ok: true,
        status: "partial",
        expectsResponse: false,
        outcomes: [
          { sessionId: "a", ok: true },
          { sessionId: "missing", ok: false, status: "failed", error: "Session not found" },
          { sessionId: "broken", ok: false, status: "failed", error: "Delivery unavailable" },
          {
            sessionId: "malformed",
            ok: false,
            status: "failed",
            error: expect.stringContaining("delivery may have occurred"),
          },
          { sessionId: "b", ok: true },
        ],
      },
    });
    expect(send).toHaveBeenCalledTimes(5);
    for (const [input] of send.mock.calls)
      expect(input).toMatchObject({ text: "message", delivery: "steer", expectsResponse: false });
  });

  it("reports every failure when no recipient succeeds", async () => {
    const send = vi.fn(async () => ({ ok: false, error: "Session not found" }));
    const result = await invoke(registry(send), { sessionIds: ["a", "b"], text: "message" });
    expect(result.structuredContent).toMatchObject({
      result: {
        ok: true,
        status: "failed",
        outcomes: [
          { sessionId: "a", ok: false },
          { sessionId: "b", ok: false },
        ],
      },
    });
  });

  it("stops on cancellation without discarding prior or remaining outcomes", async () => {
    const controller = new AbortController();
    const send = vi.fn(async () => {
      controller.abort();
      return receipt("a");
    });
    const result = await registry(send).invoke(
      { command: "sessions.send-batch", input: { sessionIds: ["a", "b", "c"], text: "message" } },
      { ...context, signal: controller.signal },
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.structuredContent).toMatchObject({
      result: {
        status: "partial",
        outcomes: [
          { sessionId: "a", ok: true },
          { sessionId: "b", ok: false, status: "not-sent" },
          { sessionId: "c", ok: false, status: "not-sent" },
        ],
      },
    });
  });

  it("preserves every outcome in model-facing text beyond the ordinary result limit", async () => {
    const ids = Array.from({ length: 100 }, (_, index) => `${index}-${"s".repeat(250)}`);
    const result = await invoke(
      registry(async () => ({ ok: false, error: "e".repeat(2_000) })),
      {
        sessionIds: ids,
        text: "Shared message",
      },
    );
    expect(result.text.length).toBeGreaterThan(24_000);
    expect(result.text).not.toContain("truncated");
    const parsed = JSON.parse(result.text);
    expect(parsed.outcomes.map((outcome: { sessionId: string }) => outcome.sessionId)).toEqual(ids);
    expect(
      parsed.outcomes.every((outcome: { error: string }) => outcome.error.length === 1_024),
    ).toBe(true);
  });

  it("does not echo shared text embedded in delivery errors", async () => {
    const result = await invoke(
      registry(async () => {
        throw new Error("Cannot send Shared message");
      }),
      { sessionIds: ["a"], text: "Shared message" },
    );
    expect(result.text).not.toContain("Shared message");
    expect(result.text).toContain("[shared message]");
  });

  it("publishes exact separate-operation help and partial-failure guidance", async () => {
    const operations = registry(async () => receipt("a"));
    const help = await operations.invoke({ command: "sessions.send-batch.help" }, context);
    expect(help.text).toContain('"sessionIds"');
    expect(help.text).toContain('"uniqueItems":true');
    expect(help.text).toContain("Not atomic");
    expect(help.text).toContain("inspect every outcome");
  });
});
