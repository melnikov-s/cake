import { describe, expect, it, vi } from "vitest";
import type { InterviewDefinition } from "../../../src/contracts/interviews/interview";
import { createCakeInterviewOperations } from "../../../src/domain/interviews/cake-interview-operations";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";
import { projectSessionEntries } from "../../../src/services/pi/runtime/session-projection";

const request: InterviewDefinition = {
  protocol: "cake.request/v1",
  id: "choice",
  title: "Choose",
  responseSchema: { type: "object", properties: { answer: { type: "string" } } },
  view: { type: "form", fields: [{ id: "answer", label: "Answer", type: "text" }] },
  fallback: { markdown: "Choose an answer." },
};
const context = () => ({
  signal: new AbortController().signal,
  toolCallId: "call-1",
  runtime: {
    sessionId: "session-1",
    assistantEntryId: "assistant-1",
  },
});

describe("Interview operation and Pi projection", () => {
  it("records an independent interview beside its originating tool and projects its completed answer", async () => {
    const appendEntry = vi.fn();
    const requestInterview = vi.fn(async () => ({ answer: "yes" }));
    const registry = new CakeOperationRegistry(
      createCakeInterviewOperations({ appendEntry }, { requestInterview }),
    );
    const result = await registry.invoke(
      { command: "interview.open", input: { request } },
      context(),
    );
    expect(requestInterview).toHaveBeenCalledWith(
      { id: "call-1", sessionId: "session-1", request },
      expect.any(AbortSignal),
    );
    expect(result.details).toMatchObject({
      command: "interview.open",
      result: { interviewId: "call-1", cancelled: false, value: { answer: "yes" } },
    });
    expect(appendEntry).toHaveBeenCalledTimes(1);
    expect(appendEntry).toHaveBeenCalledWith("cake.interview/v1", {
      id: "call-1",
      sessionId: "session-1",
      request,
      origin: { assistantEntryId: "assistant-1", toolCallId: "call-1" },
    });
    const common = { parentId: null, timestamp: new Date(0).toISOString() };
    const assistant = {
      ...common,
      id: "assistant-1",
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "cake",
            arguments: { command: "interview.open", input: { request } },
          },
        ],
      },
    };
    const metadata = {
      ...common,
      id: "metadata",
      type: "custom",
      customType: appendEntry.mock.calls[0]![0],
      data: appendEntry.mock.calls[0]![1],
    };
    const toolResult = {
      ...common,
      id: "answer",
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "cake",
        content: result.content,
        details: result.details,
        isError: false,
      },
    };
    // The tool appears before the separate interview metadata is projected.
    const pending = projectSessionEntries([assistant] as never, undefined, { live: true });
    expect(pending).toEqual([
      expect.objectContaining({
        kind: "tool",
        command: "interview.open",
        artifactId: undefined,
        state: "running",
      }),
    ]);
    const waiting = projectSessionEntries([assistant, metadata] as never, undefined, {
      live: true,
    });
    expect(waiting).toEqual([
      expect.objectContaining({
        kind: "tool",
        artifactId: undefined,
        interview: { id: "call-1", sessionId: "session-1", request },
        state: "running",
      }),
    ]);
    const parts = projectSessionEntries([assistant, metadata, toolResult] as never);
    expect(parts.filter((part) => part.kind === "tool")).toEqual([
      expect.objectContaining({
        id: "tool-call-1",
        artifactId: undefined,
        interview: { id: "call-1", sessionId: "session-1", request },
        interviewResult: { interviewId: "call-1", cancelled: false, value: { answer: "yes" } },
        state: "success",
      }),
    ]);
    expect(projectSessionEntries([metadata] as never)).toEqual([]);
    expect(projectSessionEntries([], [assistant, metadata, toolResult] as never)).toEqual([]);
    const wrongOrigin = {
      ...metadata,
      data: {
        ...metadata.data,
        origin: { assistantEntryId: "other-assistant", toolCallId: "call-1" },
      },
    };
    const unrelated = projectSessionEntries([assistant, wrongOrigin, toolResult] as never).find(
      (part) => part.kind === "tool",
    );
    expect(unrelated?.kind === "tool" ? unrelated.interview : undefined).toBeUndefined();
  });

  it("returns cancellation explicitly and preserves turn interruption", async () => {
    const registry = new CakeOperationRegistry(
      createCakeInterviewOperations(
        { appendEntry: vi.fn() },
        { requestInterview: async () => undefined },
      ),
    );
    expect(
      (await registry.invoke({ command: "interview.open", input: { request } }, context())).details,
    ).toMatchObject({ result: { interviewId: "call-1", cancelled: true } });
    const controller = new AbortController();
    const interrupted = new CakeOperationRegistry(
      createCakeInterviewOperations(
        { appendEntry: vi.fn() },
        {
          requestInterview: async () => {
            controller.abort(new Error("Interrupted"));
            return undefined;
          },
        },
      ),
    );
    await expect(
      interrupted.invoke(
        { command: "interview.open", input: { request } },
        { ...context(), signal: controller.signal },
      ),
    ).rejects.toThrow("Interrupted");
  });

  it("validates responses and requires an originating assistant tool call", async () => {
    const registry = new CakeOperationRegistry(
      createCakeInterviewOperations(
        { appendEntry: vi.fn() },
        { requestInterview: async () => ({ answer: 7 }) },
      ),
    );
    await expect(
      registry.invoke({ command: "interview.open", input: { request } }, context()),
    ).rejects.toThrow("string");
    await expect(
      registry.invoke(
        { command: "interview.open", input: { request } },
        {
          ...context(),
          runtime: { sessionId: "session-1" },
        },
      ),
    ).rejects.toThrow("originating assistant");
  });
});
