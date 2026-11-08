import type {
  AgentSession,
  AgentSessionEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCakeSessionRuntimeSubscription } from "../../../../src/services/pi/runtime/cake-session-runtime-subscription";
import type { CakeSessionRuntimeOptions } from "../../../../src/services/pi/runtime/cake-session-runtime";
import type { CakeSessionRuntimeTurnController } from "../../../../src/services/pi/runtime/cake-session-runtime-turn-controller";
import type { CakeSessionRuntimeContinuations } from "../../../../src/services/pi/runtime/cake-session-runtime-continuations";
import type { RuntimeEventProjection } from "../../../../src/services/pi/runtime/cake-session-runtime-event-projection";
import type { AbortPresentation } from "../../../../src/services/pi/runtime/message-projection";
import { internalInputEntryType } from "../../../../src/services/pi/runtime/internal-input-projection";
import { recoveryInputEntryType } from "../../../../src/services/pi/runtime/restart-recovery";
import {
  turnHandoffEntryType,
  userMessagePresentationEntryType,
} from "../../../../src/services/pi/runtime/session-projection";

function fixture() {
  const order: string[] = [];
  const microtasks: VoidFunction[] = [];
  vi.spyOn(globalThis, "queueMicrotask").mockImplementation((task) => microtasks.push(task));
  let listener: (event: AgentSessionEvent) => void = () => undefined;
  let disposed = false;
  const entries: SessionEntry[] = [];
  const appendCustomEntry = vi.fn((type: string) => order.push(type));
  const unsubscribe = vi.fn();
  const session = {
    sessionFile: import.meta.filename,
    sessionManager: {
      getSessionId: () => "session-1",
      getBranch: () => entries,
      getEntries: () => entries,
      appendCustomEntry,
    },
    subscribe: (handler: typeof listener) => {
      listener = handler;
      return unsubscribe;
    },
  } as unknown as AgentSession;
  const options = {
    newSession: true,
    onTurnResult: vi.fn(() => order.push("result")),
    onInitialTranscriptPersisted: vi.fn(),
    sessionTitleChanged: vi.fn(async () => undefined),
  } as unknown as CakeSessionRuntimeOptions;
  const turnController = {
    executingTurnIds: () => ["turn-1"],
    internalInput: vi.fn(),
    consumeUserMessage: vi.fn(() => "turn-1"),
    cancellationPending: vi.fn(() => false),
    settleTurn: vi.fn(() => order.push("settle")),
    compactionEnded: vi.fn(() => order.push("compaction-ended")),
  } as unknown as CakeSessionRuntimeTurnController;
  const projection = {
    projectEvent: vi.fn(() => order.push("project")),
    consumeUserPresentation: vi.fn(),
  } as unknown as RuntimeEventProjection;
  const continuations = {
    initializeSessionFromFirstMessage: vi.fn(async () => undefined),
    finishSettledTurn: vi.fn(async () => {
      order.push("finish");
    }),
  } as unknown as CakeSessionRuntimeContinuations;
  let abortPresentation: AbortPresentation = { kind: "interrupted" };
  const emitSnapshotInBackground = vi.fn(() => order.push("snapshot"));
  const subscription = createCakeSessionRuntimeSubscription({
    options,
    session,
    turnController,
    projection,
    continuations,
    abortPresentation: () => abortPresentation,
    isDisposed: () => disposed,
    emitSnapshotInBackground,
  });
  return {
    order,
    entries,
    options,
    turnController,
    projection,
    continuations,
    appendCustomEntry,
    unsubscribe,
    subscription,
    emitSnapshotInBackground,
    emit: (event: AgentSessionEvent) => listener(event),
    flushMicrotasks: () => {
      while (microtasks.length) microtasks.shift()?.();
    },
    setDisposed: () => {
      disposed = true;
    },
    setHandoff: () => {
      abortPresentation = { kind: "handoff" };
    },
  };
}

const userEnd = (text = "hello"): AgentSessionEvent => ({
  type: "message_end",
  message: { role: "user", content: text, timestamp: 10 },
});

const assistantEnd = (stopReason: "stop" | "error" = "stop"): AgentSessionEvent => ({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "answer" }],
    timestamp: 20,
    api: "openai-responses",
    provider: "openai",
    model: "test",
    stopReason,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  },
});

afterEach(() => vi.restoreAllMocks());

describe("Cake runtime subscription", () => {
  it("captures the turn result before projection and settlement, and records handoff before projection", () => {
    const f = fixture();
    f.emit(userEnd());
    f.setHandoff();
    f.order.length = 0;
    f.emit(assistantEnd("error"));
    expect(f.order).toEqual([turnHandoffEntryType, "project"]);
    f.order.length = 0;
    f.emit({ type: "agent_settled", aborted: false });
    expect(f.order).toEqual(["result", "project", "settle", "finish"]);
    expect(f.options.onTurnResult).toHaveBeenCalledWith("turn-1", {
      stopReason: "error",
      text: "answer",
    });
  });

  it("publishes the initial transcript and markdown metadata only after Pi persistence", () => {
    const f = fixture();
    vi.mocked(f.projection.consumeUserPresentation).mockReturnValue({
      content: "hello",
      renderUserMessageAsMarkdown: true,
      consumed: true,
    });
    const event = userEnd();
    f.subscription.setAutomaticTitle(false);
    f.emit(event);
    expect(f.options.onInitialTranscriptPersisted).not.toHaveBeenCalled();
    expect(f.appendCustomEntry).toHaveBeenCalledWith(recoveryInputEntryType, {
      turnId: "turn-1",
      timestamp: 10,
      consumedAt: expect.any(Number),
    });
    expect(f.continuations.initializeSessionFromFirstMessage).toHaveBeenLastCalledWith(
      "hello",
      false,
    );
    if (event.type !== "message_end") throw new Error("Expected message_end");
    f.entries.push({
      type: "message",
      id: "user-entry",
      parentId: null,
      timestamp: new Date(0).toISOString(),
      message: event.message,
    });
    f.flushMicrotasks();
    expect(f.options.onInitialTranscriptPersisted).toHaveBeenCalledOnce();
    expect(f.appendCustomEntry).toHaveBeenCalledWith(userMessagePresentationEntryType, {
      targetId: "user-entry",
      renderAs: "markdown",
    });
    f.emit(userEnd("second"));
    f.flushMicrotasks();
    expect(f.options.onInitialTranscriptPersisted).toHaveBeenCalledOnce();
    expect(f.continuations.initializeSessionFromFirstMessage).toHaveBeenLastCalledWith(
      "second",
      true,
    );
  });

  it("retains typed consumed-input provenance without generating a user title", () => {
    const f = fixture();
    const internal = { _tag: "WorkboardDelivery" as const, boardId: "board", sequences: [1] };
    vi.mocked(f.turnController.internalInput).mockReturnValue(internal);
    f.emit(userEnd());
    expect(f.appendCustomEntry).toHaveBeenCalledWith(internalInputEntryType, {
      timestamp: 10,
      origin: internal,
    });
    expect(f.continuations.initializeSessionFromFirstMessage).not.toHaveBeenCalled();
  });

  it("projects compaction before notifying the controller and fences cancellation settlement", () => {
    const f = fixture();
    f.emit({
      type: "compaction_end",
      reason: "threshold",
      result: undefined,
      aborted: false,
      willRetry: true,
    });
    expect(f.order).toEqual(["project", "snapshot", "compaction-ended"]);
    expect(f.turnController.compactionEnded).toHaveBeenCalledWith(true);
    vi.mocked(f.turnController.cancellationPending).mockReturnValue(true);
    f.emit({ type: "agent_settled", aborted: false });
    expect(f.turnController.settleTurn).not.toHaveBeenCalled();
    expect(f.continuations.finishSettledTurn).not.toHaveBeenCalled();
  });

  it("fences queued microtasks and late events at runtime disposal and releases its one listener", () => {
    const f = fixture();
    vi.mocked(f.projection.consumeUserPresentation).mockReturnValue({
      content: "hello",
      renderUserMessageAsMarkdown: true,
      consumed: true,
    });
    f.emit(userEnd());
    f.setDisposed();
    f.order.length = 0;
    f.flushMicrotasks();
    f.emit(assistantEnd());
    f.subscription.dispose();
    expect(f.order).toEqual([]);
    expect(f.options.onInitialTranscriptPersisted).not.toHaveBeenCalled();
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });
});
