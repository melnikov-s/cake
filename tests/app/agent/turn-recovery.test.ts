import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  TURN_RETRY_BASE_DELAY_MS,
  TURN_RETRY_MAX_DELAY_MS,
  classifyTurnFailure,
  formatRetryDelay,
  isAbortedAssistantTurn,
  isEmptyAssistantTurn,
  shouldAutoResumeInterruptedTurn,
  turnRetryDelayMs,
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
  // SAFETY: base plus partial overrides form a complete test AssistantMessage.
  return { ...base, ...overrides } as AssistantMessage;
}

describe("isEmptyAssistantTurn", () => {
  it("matches the silent-failure signature: stop with no content at all", () => {
    expect(isEmptyAssistantTurn(assistantMessage())).toBe(true);
  });

  it("matches whitespace-only text and thinking content", () => {
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

  it("never matches a normal final answer with text", () => {
    expect(
      isEmptyAssistantTurn(assistantMessage({ content: [{ type: "text", text: "Done." }] })),
    ).toBe(false);
  });

  it("never matches a normal answer with visible reasoning plus text", () => {
    expect(
      isEmptyAssistantTurn(
        assistantMessage({
          content: [
            { type: "thinking", thinking: "Let me check the styles first." },
            { type: "text", text: "Fixed the font color." },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("never matches a tool-use turn", () => {
    expect(isEmptyAssistantTurn(assistantMessage({ stopReason: "toolUse" }))).toBe(false);
    expect(
      isEmptyAssistantTurn(
        assistantMessage({
          content: [
            {
              type: "toolCall",
              id: "t1",
              name: "read",
              arguments: {},
            },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("never matches errors, aborts, length cutoffs, pending or deferred stops", () => {
    for (const stopReason of ["error", "aborted", "length", "pending", "deferred"] as const) {
      expect(isEmptyAssistantTurn(assistantMessage({ stopReason }))).toBe(false);
    }
  });

  it("never matches a message carrying an errorMessage even with stop reason stop", () => {
    expect(isEmptyAssistantTurn(assistantMessage({ errorMessage: "boom" }))).toBe(false);
  });

  it("never matches user or tool-result messages or a missing message", () => {
    expect(isEmptyAssistantTurn(undefined)).toBe(false);
    // SAFETY: deliberately malformed input to prove the predicate rejects it.
    expect(isEmptyAssistantTurn({ role: "user" } as never)).toBe(false);
  });
});

describe("isAbortedAssistantTurn", () => {
  it("matches an aborted turn with partial content and no tool call", () => {
    expect(
      isAbortedAssistantTurn(
        assistantMessage({
          stopReason: "aborted",
          errorMessage: "Request was aborted",
          content: [
            { type: "thinking", thinking: "The file uses tabs..." },
            { type: "text", text: "Minor whitespace mismatch. Retrying:" },
          ],
        }),
      ),
    ).toBe(true);
  });

  it("matches a fully empty aborted turn", () => {
    expect(
      isAbortedAssistantTurn(assistantMessage({ stopReason: "aborted", errorMessage: "aborted" })),
    ).toBe(true);
  });

  it("never matches other stop reasons or non-assistant messages", () => {
    expect(isAbortedAssistantTurn(undefined)).toBe(false);
    expect(isAbortedAssistantTurn(assistantMessage())).toBe(false);
    expect(
      isAbortedAssistantTurn(assistantMessage({ stopReason: "error", errorMessage: "boom" })),
    ).toBe(false);
  });

  it("never matches an aborted turn carrying a tool call", () => {
    expect(
      isAbortedAssistantTurn(
        assistantMessage({
          stopReason: "aborted",
          errorMessage: "Request was aborted",
          content: [{ type: "toolCall", id: "t1", name: "edit", arguments: {} }],
        }),
      ),
    ).toBe(false);
  });
});

describe("classifyTurnFailure", () => {
  const substantive = assistantMessage({ content: [{ type: "text", text: "All done." }] });

  it("classifies an empty response", () => {
    expect(classifyTurnFailure(assistantMessage())).toEqual({
      kind: "empty",
      detail: expect.stringContaining("no content"),
    });
  });

  it("classifies a spontaneous stream abort and respects user-initiated ones", () => {
    const aborted = assistantMessage({
      stopReason: "aborted",
      errorMessage: "Request aborted",
      content: [{ type: "text", text: "Partial answer" }],
    });
    expect(classifyTurnFailure(aborted)).toEqual({ kind: "aborted", detail: "Request aborted" });
    expect(classifyTurnFailure(aborted, true)).toBeUndefined();
  });

  it("never classifies an aborted turn that carries unexecuted tool calls", () => {
    expect(
      classifyTurnFailure(
        assistantMessage({
          stopReason: "aborted",
          errorMessage: "Request aborted",
          content: [{ type: "toolCall", id: "t1", name: "edit", arguments: {} }],
        }),
      ),
    ).toBeUndefined();
  });

  it("classifies transient provider errors", () => {
    const failed = assistantMessage({
      stopReason: "error",
      errorMessage: "JSON error injected into SSE stream",
    });
    expect(classifyTurnFailure(failed)).toEqual({
      kind: "error",
      detail: "JSON error injected into SSE stream",
    });
    expect(classifyTurnFailure(assistantMessage({ stopReason: "error" }))).toEqual({
      kind: "error",
      detail: "The provider request failed.",
    });
  });

  it("refuses to classify permanent provider errors backoff cannot fix", () => {
    for (const errorMessage of [
      "Invalid API key provided",
      "Authentication failed for provider",
      "401 Unauthorized",
      "403 Forbidden",
      "Invalid request: malformed body",
      "Model not found: stealth/ox-alpha",
      "Prompt exceeds context length",
      "Monthly usage limit reached for this subscription",
      "GoUsageLimitError: you have reached your plan limit",
      "insufficient_quota: You exceeded your current quota",
      "Out of budget for this billing period",
      "Please enable available balance usage to continue",
      "Insufficient credits: purchase more to continue",
      "Your credit balance is too low to access the API",
    ]) {
      expect(
        classifyTurnFailure(assistantMessage({ stopReason: "error", errorMessage })),
      ).toBeUndefined();
    }
  });

  it("keeps rate limits and server errors retryable", () => {
    for (const errorMessage of [
      "429 Too Many Requests",
      "Rate limit exceeded, please slow down",
      "500 Internal Server Error",
      "Connection reset while streaming",
    ]) {
      expect(
        classifyTurnFailure(assistantMessage({ stopReason: "error", errorMessage }))?.kind,
      ).toBe("error");
    }
  });

  it("returns undefined for healthy shapes", () => {
    expect(classifyTurnFailure(undefined)).toBeUndefined();
    expect(classifyTurnFailure(substantive)).toBeUndefined();
    expect(
      classifyTurnFailure(assistantMessage({ stopReason: "toolUse", content: [] })),
    ).toBeUndefined();
    expect(
      classifyTurnFailure(assistantMessage({ stopReason: "length", content: [] })),
    ).toBeUndefined();
  });
});

describe("turnRetryDelayMs", () => {
  it("doubles from the base delay with each attempt", () => {
    expect(TURN_RETRY_BASE_DELAY_MS).toBe(2_000);
    expect(turnRetryDelayMs(1)).toBe(2_000);
    expect(turnRetryDelayMs(2)).toBe(4_000);
    expect(turnRetryDelayMs(3)).toBe(8_000);
    expect(turnRetryDelayMs(10)).toBe(2_000 * 2 ** 9);
  });

  it("saturates at the one-hour cap and stays there", () => {
    expect(TURN_RETRY_MAX_DELAY_MS).toBe(60 * 60 * 1_000);
    expect(turnRetryDelayMs(50)).toBe(TURN_RETRY_MAX_DELAY_MS);
    expect(turnRetryDelayMs(500)).toBe(TURN_RETRY_MAX_DELAY_MS);
  });

  it("tolerates nonsensical attempt numbers", () => {
    expect(turnRetryDelayMs(0)).toBe(TURN_RETRY_BASE_DELAY_MS);
    expect(turnRetryDelayMs(-5)).toBe(TURN_RETRY_BASE_DELAY_MS);
    expect(turnRetryDelayMs(1.9)).toBe(TURN_RETRY_BASE_DELAY_MS);
  });
});

describe("formatRetryDelay", () => {
  it("formats seconds under a minute", () => {
    expect(formatRetryDelay(0)).toBe("0s");
    expect(formatRetryDelay(5_000)).toBe("5s");
    expect(formatRetryDelay(59_000)).toBe("59s");
  });

  it("formats minutes and seconds", () => {
    expect(formatRetryDelay(90_000)).toBe("1m 30s");
    expect(formatRetryDelay(120_000)).toBe("2m");
  });

  it("formats hours and minutes", () => {
    expect(formatRetryDelay(60 * 60 * 1_000)).toBe("1h");
    expect(formatRetryDelay(60 * 65 * 1_000)).toBe("1h 5m");
  });
});

describe("shouldAutoResumeInterruptedTurn", () => {
  it("resumes when the conversation ends in tool results the model never answered", () => {
    const messages = [
      { role: "user" },
      { role: "assistant", stopReason: "toolUse" },
      { role: "toolResult" },
    ];
    expect(shouldAutoResumeInterruptedTurn(messages)).toBe(true);
  });

  it("never resumes a completed conversation ending in an assistant message", () => {
    expect(
      shouldAutoResumeInterruptedTurn([
        { role: "user" },
        { role: "assistant", stopReason: "stop" },
      ]),
    ).toBe(false);
  });

  it("never resumes when the tail is a user message (prompt never answered is ambiguous)", () => {
    expect(shouldAutoResumeInterruptedTurn([{ role: "user" }])).toBe(false);
  });

  it("never resumes after an intentional abort, even with dangling tool results", () => {
    const messages = [
      { role: "user" },
      { role: "assistant", stopReason: "toolUse" },
      { role: "toolResult" },
      { role: "assistant", stopReason: "aborted" },
      { role: "assistant", stopReason: "aborted" },
    ];
    expect(shouldAutoResumeInterruptedTurn(messages)).toBe(false);
  });

  it("handles empty conversations", () => {
    expect(shouldAutoResumeInterruptedTurn([])).toBe(false);
  });
});
