import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  createCakeSessionRuntimeEventProjection,
  type RuntimeProjectionEvent,
} from "../../../../src/services/pi/runtime/cake-session-runtime-event-projection";
import { projectQueuedMessages } from "../../../../src/services/pi/runtime/session-projection";

describe("Cake runtime streaming projection", () => {
  it("coalesces superseding full-message updates before crossing the runtime boundary", () => {
    vi.useFakeTimers();
    const events: RuntimeProjectionEvent[] = [];
    const session = {
      getSteeringMessages: () => [],
      getFollowUpMessages: () => [],
      getSessionStats: () => ({ tokens: {}, cost: 0 }),
    } as unknown as AgentSession;
    const projection = createCakeRuntimeEventProjection({
      session,
      sessionId: "session-1",
      emit: (event) => events.push(event),
      compactionQueuedMessages: () => [],
      isDisposed: () => false,
    });
    const assistant = (text: string) => ({
      role: "assistant" as const,
      content: [{ type: "text" as const, text }],
    });

    try {
      projection.projectEvent({
        type: "message_start",
        message: assistant(""),
      } as never);
      for (let index = 1; index <= 1_000; index += 1)
        projection.projectEvent({
          type: "message_update",
          message: assistant(`partial-${index}`),
          assistantMessageEvent: { type: "text_delta", delta: String(index) },
        } as never);

      expect(events.filter((event) => event.type === "part-updated")).toEqual([]);
      vi.advanceTimersByTime(50);
      expect(events.filter((event) => event.type === "part-updated")).toEqual([
        expect.objectContaining({
          part: expect.objectContaining({ text: "partial-1000", status: "streaming" }),
        }),
      ]);
    } finally {
      projection.dispose();
      vi.useRealTimers();
    }
  });

  it("lets a final message supersede a pending streaming update", () => {
    vi.useFakeTimers();
    const events: RuntimeProjectionEvent[] = [];
    const session = {
      getSteeringMessages: () => [],
      getFollowUpMessages: () => [],
      getSessionStats: () => ({ tokens: {}, cost: 0 }),
    } as unknown as AgentSession;
    const projection = createCakeRuntimeEventProjection({
      session,
      sessionId: "session-1",
      emit: (event) => events.push(event),
      compactionQueuedMessages: () => [],
      isDisposed: () => false,
    });
    const assistant = (text: string) => ({
      role: "assistant" as const,
      content: [{ type: "text" as const, text }],
    });

    try {
      projection.projectEvent({ type: "message_start", message: assistant("") } as never);
      projection.projectEvent({
        type: "message_update",
        message: assistant("partial"),
        assistantMessageEvent: { type: "text_delta", delta: "partial" },
      } as never);
      projection.projectEvent({
        type: "message_end",
        message: { ...assistant("complete"), stopReason: "stop" },
      } as never);
      vi.advanceTimersByTime(50);

      expect(events.filter((event) => event.type === "part-updated")).toEqual([
        expect.objectContaining({
          part: expect.objectContaining({ text: "complete", status: "complete" }),
        }),
      ]);
    } finally {
      projection.dispose();
      vi.useRealTimers();
    }
  });
});

describe("Cake runtime queued-part projection", () => {
  it("emits only the queued parts that changed", () => {
    let steering: string[] = [];
    let followUp = ["First", "Remove me", "Last"];
    const events: RuntimeProjectionEvent[] = [];
    // @ts-expect-error -- SAFETY: this focused test invokes only the two queue accessors supplied.
    const session = {
      getSteeringMessages: () => steering,
      getFollowUpMessages: () => followUp,
    } as AgentSession;
    const projection = createCakeSessionRuntimeEventProjection({
      session,
      sessionId: "session-1",
      emit: (event) => events.push(event),
      compactionQueuedMessages: () => [],
      isDisposed: () => false,
    });

    const removedId = projectQueuedMessages([], followUp)[1]!.id;
    followUp = ["First", "Last"];
    projection.syncQueuedParts();

    expect(events).toEqual([{ type: "part-removed", sessionId: "session-1", partId: removedId }]);

    events.length = 0;
    followUp = ["First", "Last", "New"];
    projection.syncQueuedParts();

    expect(events).toEqual([
      {
        type: "part-updated",
        sessionId: "session-1",
        part: projectQueuedMessages([], ["New"])[0],
      },
    ]);

    events.length = 0;
    projection.syncQueuedParts();
    expect(events).toEqual([]);

    events.length = 0;
    steering = ["First"];
    followUp = ["Last", "New"];
    projection.syncQueuedParts();

    const previousFirstId = projectQueuedMessages([], ["First"])[0]!.id;
    expect(events).toEqual([
      { type: "part-removed", sessionId: "session-1", partId: previousFirstId },
      {
        type: "part-updated",
        sessionId: "session-1",
        part: projectQueuedMessages(["First"], [])[0],
      },
    ]);

    projection.dispose();
  });
});
