import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  EMPTY_TURN_MAX_CONTINUATIONS,
  decideEmptyTurnResponse,
  isEmptyAssistantTurn,
  shouldAutoResumeInterruptedTurn,
} from "../../../src/agent/empty-turn";

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
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
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  } as AssistantMessage;
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
    expect(
      isEmptyAssistantTurn({ role: "user", content: [], timestamp: Date.now() } as never),
    ).toBe(false);
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

describe("decideEmptyTurnResponse", () => {
  const substantive = assistantMessage({ content: [{ type: "text", text: "All done." }] });

  it("resets on any substantive final message", () => {
    expect(decideEmptyTurnResponse(substantive, 3)).toEqual({ action: "reset" });
  });

  it("continues with an incrementing attempt on an empty turn", () => {
    expect(decideEmptyTurnResponse(assistantMessage(), 0)).toEqual({
      action: "continue",
      attempt: 1,
    });
    expect(decideEmptyTurnResponse(assistantMessage(), 4)).toEqual({
      action: "continue",
      attempt: 5,
    });
  });

  it("gives up after EMPTY_TURN_MAX_CONTINUATIONS consecutive empty turns", () => {
    expect(decideEmptyTurnResponse(assistantMessage(), EMPTY_TURN_MAX_CONTINUATIONS)).toEqual({
      action: "give-up",
      attempts: EMPTY_TURN_MAX_CONTINUATIONS,
    });
    expect(decideEmptyTurnResponse(assistantMessage(), EMPTY_TURN_MAX_CONTINUATIONS + 2)).toEqual({
      action: "give-up",
      attempts: EMPTY_TURN_MAX_CONTINUATIONS + 2,
    });
  });

  it("resets after give-up once a real response arrives", () => {
    expect(decideEmptyTurnResponse(substantive, EMPTY_TURN_MAX_CONTINUATIONS + 2)).toEqual({
      action: "reset",
    });
  });
});
