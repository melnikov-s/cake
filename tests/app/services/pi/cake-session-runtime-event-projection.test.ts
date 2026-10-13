import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  createCakeSessionRuntimeEventProjection,
  type RuntimeProjectionEvent,
} from "../../../../src/services/pi/runtime/cake-session-runtime-event-projection";
import { projectQueuedMessages } from "../../../../src/services/pi/runtime/session-projection";

describe("Cake runtime streaming projection", () => {
  it("keeps interview requests out of artifact projection throughout live tool execution", () => {
    const events: RuntimeProjectionEvent[] = [];
    const session = {
      agent: { state: { tools: [] } },
      systemPrompt: "",
      getSteeringMessages: () => [],
      getFollowUpMessages: () => [],
      getSessionStats: () => ({ tokens: {}, cost: 0 }),
    } as unknown as AgentSession;
    const projection = createCakeSessionRuntimeEventProjection({
      session,
      sessionId: "session-1",
      emit: (event) => events.push(event),
      compactionQueuedMessages: () => [],
      isDisposed: () => false,
    });
    const args = {
      command: "interview.open",
      input: { request: { protocol: "cake.request/v1", id: "choice" } },
    };
    const call = { toolCallId: "call-1", toolName: "cake", args };
    try {
      projection.projectEvent({
        type: "message_update",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "cake", arguments: args }],
        },
        assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "" },
      } as never);
      // Execution start flushes the streamed arguments before emitting the running tool.
      projection.projectEvent({ type: "tool_execution_start", ...call } as never);
      projection.projectEvent({
        type: "tool_execution_update",
        ...call,
        partialResult: { content: [] },
      } as never);
      projection.projectEvent({
        type: "tool_execution_end",
        ...call,
        result: {
          content: [],
          details: {
            command: "interview.open",
            result: { interviewId: "call-1", cancelled: false, value: {} },
          },
        },
        isError: false,
      } as never);
      const tools = events.flatMap((event) =>
        event.type === "part-updated" && event.part.kind === "tool" ? [event.part] : [],
      );
      expect(tools.map((part) => part.state)).toEqual(["running", "running", "running", "success"]);
      for (const part of tools) {
        expect(part.command).toBe("interview.open");
        expect(part.artifactId).toBeUndefined();
      }
    } finally {
      projection.dispose();
    }
  });

  it("coalesces superseding full-message updates before crossing the runtime boundary", () => {
    vi.useFakeTimers();
    const events: RuntimeProjectionEvent[] = [];
    const session = {
      sessionManager: { getHeader: () => undefined },
      agent: { state: { tools: [] } },
      systemPrompt: "",
      getSteeringMessages: () => [],
      getFollowUpMessages: () => [],
      getSessionStats: () => ({ tokens: {}, cost: 0 }),
    } as unknown as AgentSession;
    const projection = createCakeSessionRuntimeEventProjection({
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
      sessionManager: { getHeader: () => undefined },
      agent: { state: { tools: [] } },
      systemPrompt: "",
      getSteeringMessages: () => [],
      getFollowUpMessages: () => [],
      getSessionStats: () => ({ tokens: {}, cost: 0 }),
    } as unknown as AgentSession;
    const projection = createCakeSessionRuntimeEventProjection({
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
    // @ts-expect-error -- SAFETY: this focused test reads only the prompt, tool state and queue accessors supplied.
    const session = {
      sessionManager: { getHeader: () => undefined },
      agent: { state: { tools: [] } },
      systemPrompt: "",
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
