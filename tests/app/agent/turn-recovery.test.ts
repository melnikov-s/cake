import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  classifyTurnFailure,
  isAbortedAssistantTurn,
  isEmptyAssistantTurn,
  shouldAutoResumeInterruptedTurn,
  turnRecoveryPrompt,
} from "../../../src/agent/turn-recovery";

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  const base = {
    role: "assistant" as const,
    content: [],
    api: "openai-completions",
    provider: "openrouter",
    model: "stealth/ox-alpha",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
  return { ...base, ...overrides } as AssistantMessage;
}

describe("isEmptyAssistantTurn", () => {
  it("matches a successful response with no useful content", () => {
    expect(isEmptyAssistantTurn(assistantMessage())).toBe(true);
    expect(
      isEmptyAssistantTurn(
        assistantMessage({
          content: [
            { type: "thinking", thinking: "  \n\t" },
            { type: "text", text: "   " },
          ],
        }),
      ),
    ).toBe(true);
  });

  it("rejects substantive, tool-use, error, and aborted responses", () => {
    expect(
      isEmptyAssistantTurn(assistantMessage({ content: [{ type: "text", text: "Done." }] })),
    ).toBe(false);
    expect(
      isEmptyAssistantTurn(
        assistantMessage({
          content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }],
        }),
      ),
    ).toBe(false);
    expect(isEmptyAssistantTurn(assistantMessage({ stopReason: "error" }))).toBe(false);
    expect(isEmptyAssistantTurn(assistantMessage({ stopReason: "aborted" }))).toBe(false);
  });
});

describe("isAbortedAssistantTurn", () => {
  it("matches an interrupted response without tool calls", () => {
    expect(
      isAbortedAssistantTurn(
        assistantMessage({
          stopReason: "aborted",
          errorMessage: "Request aborted",
          content: [{ type: "text", text: "Partial answer" }],
        }),
      ),
    ).toBe(true);
  });

  it("rejects an aborted response containing an unexecuted tool call", () => {
    expect(
      isAbortedAssistantTurn(
        assistantMessage({
          stopReason: "aborted",
          content: [{ type: "toolCall", id: "t1", name: "edit", arguments: {} }],
        }),
      ),
    ).toBe(false);
  });
});

describe("classifyTurnFailure", () => {
  it("classifies only empty and spontaneous aborted responses", () => {
    expect(classifyTurnFailure(assistantMessage())?.kind).toBe("empty");
    const aborted = assistantMessage({
      stopReason: "aborted",
      errorMessage: "Request aborted",
      content: [{ type: "text", text: "Partial answer" }],
    });
    expect(classifyTurnFailure(aborted)).toEqual({ kind: "aborted", detail: "Request aborted" });
    expect(classifyTurnFailure(aborted, true)).toBeUndefined();
  });

  it("leaves all provider errors to Pi's retry policy", () => {
    for (const errorMessage of [
      "429 Too Many Requests",
      "500 Internal Server Error",
      "Invalid API key provided",
      "Unknown provider failure",
    ]) {
      expect(
        classifyTurnFailure(assistantMessage({ stopReason: "error", errorMessage })),
      ).toBeUndefined();
    }
  });

  it("provides hidden continuation context without impersonating the user", () => {
    expect(turnRecoveryPrompt("empty")).toContain("previous response");
    expect(turnRecoveryPrompt("aborted")).toContain("cut off");
  });
});

describe("shouldAutoResumeInterruptedTurn", () => {
  it("resumes when the conversation ends in unanswered tool results", () => {
    expect(
      shouldAutoResumeInterruptedTurn([
        { role: "user" },
        { role: "assistant", stopReason: "toolUse" },
        { role: "toolResult" },
      ]),
    ).toBe(true);
  });

  it("rejects completed, ambiguous, and intentionally aborted tails", () => {
    expect(
      shouldAutoResumeInterruptedTurn([
        { role: "user" },
        { role: "assistant", stopReason: "stop" },
      ]),
    ).toBe(false);
    expect(shouldAutoResumeInterruptedTurn([{ role: "user" }])).toBe(false);
    expect(
      shouldAutoResumeInterruptedTurn([
        { role: "assistant", stopReason: "aborted" },
        { role: "toolResult" },
      ]),
    ).toBe(false);
  });
});
