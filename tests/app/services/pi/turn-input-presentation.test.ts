import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { addResponseModeReminder } from "../../../../src/contracts/conversations/response-mode-reminders";
import type { InternalInput } from "../../../../src/contracts/conversations/internal-input";
import {
  projectPendingInputParts,
  turnInputContent,
  type QueuedInputPayload,
} from "../../../../src/services/pi/runtime/turn-input-presentation";

describe("turn input presentation", () => {
  it("reconstructs response style in steering then follow-up order without retaining mode state", () => {
    const sessionManager = SessionManager.inMemory("/project");
    const voice = addResponseModeReminder("Voice request", "voice");
    const text = addResponseModeReminder("Text request", "text");
    const session = {
      sessionManager,
      isStreaming: true,
      getSteeringMessages: () => [],
      getFollowUpMessages: () => [],
    };
    const input = {
      session,
      heldInputs: [
        { content: voice, delivery: "steer" as const },
        { content: text, delivery: "follow-up" as const },
      ],
      busy: true,
      internalInput: () => undefined,
      text: "Next input",
      attachments: [],
      responseMode: "voice" as const,
    };
    expect(turnInputContent({ ...input, delivery: "steer" })).toBe("Next input");
    expect(turnInputContent({ ...input, delivery: "follow-up" })).toBe(
      addResponseModeReminder("Next input", "voice"),
    );
    expect(turnInputContent({ ...input, delivery: "prompt" })).toBe(
      addResponseModeReminder("Next input", "voice"),
    );
    // The active Pi branch replaces the previous controller's queued context.
    sessionManager.appendMessage({ role: "user", content: voice, timestamp: 0 });
    expect(
      turnInputContent({
        ...input,
        session: { ...session, isStreaming: false },
        heldInputs: [],
        busy: false,
        delivery: "prompt",
      }),
    ).toBe("Next input");
  });

  it("leaves slash command input undecorated even when queued styles differ", () => {
    expect(
      turnInputContent({
        session: {
          sessionManager: SessionManager.inMemory("/project"),
          isStreaming: false,
          getSteeringMessages: () => [],
          getFollowUpMessages: () => [],
        },
        heldInputs: [],
        busy: false,
        internalInput: () => undefined,
        text: "/compact keep decisions",
        attachments: [],
        delivery: "prompt",
        responseMode: "voice",
        presentationMode: "normal",
      }),
    ).toBe("/compact keep decisions");
  });

  it("binds identical lane content to each admitted payload and origin without mutating queues", () => {
    const item = (id: string, markdown: boolean): QueuedInputPayload => ({
      itemId: id,
      turnId: id,
      text: "Transport text",
      content: "Same queued content",
      attachments: [],
      renderUserMessageAsMarkdown: markdown,
    });
    const steering = item("steer-id", true);
    const followUp = item("follow-up-id", false);
    const origin = (turnId: string): InternalInput => ({
      _tag: "UserWithReminders",
      text: "Transport text",
      userText: turnId === "steer-id" ? "Human steering" : "Human follow-up",
      notices: [],
    });
    const queues = { steering: [steering], "follow-up": [followUp] };
    const before = structuredClone(queues);
    const rows = projectPendingInputParts(queues, origin);
    expect(rows).toHaveLength(2);
    const [first, second] = rows;
    expect(first).toMatchObject({
      kind: "text",
      text: "Human steering",
      renderAs: "markdown",
      queuedInput: { itemId: "steer-id", turnId: "steer-id", text: "Human steering" },
    });
    expect(second).toMatchObject({
      kind: "text",
      text: "Human follow-up",
      queuedInput: { itemId: "follow-up-id", turnId: "follow-up-id", text: "Human follow-up" },
    });
    expect(first?.id).not.toBe(second?.id);
    expect(queues).toEqual(before);
  });
});
