import { createStore, mount, observable } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScheduledMessage } from "../../../../src/renderer/models/ScheduledMessage";
import { ScheduledMessageInteractionStore } from "../../../../src/renderer/stores/ScheduledMessageInteractionStore";

describe("ScheduledMessageInteractionStore", () => {
  afterEach(() => vi.useRealTimers());

  it("owns one countdown timer only while scheduled messages exist and disposes it", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-04T12:00:00.000Z");
    const messages = observable([
      ScheduledMessage.create({
        id: "8de1a807-dc99-49ee-8d35-7a3ed20bef06",
        targetSessionId: "session-1",
        text: "Check the build",
        sendAt: "2026-09-04T12:02:00.000Z",
        createdAt: "2026-09-04T11:59:00.000Z",
      }),
    ]);
    const store = mount(
      createStore(ScheduledMessageInteractionStore, {
        capabilities: { messages: () => messages },
      }),
    );

    expect(store.remainingMs(messages[0]!.sendAt)).toBe(120_000);
    expect(vi.getTimerCount()).toBe(1);
    messages.splice(0);
    expect(vi.getTimerCount()).toBe(0);
    store[Symbol.dispose]();
  });

  it("captures cancellation errors without allowing disposal-late commits", async () => {
    let reject!: (error: Error) => void;
    const store = mount(
      createStore(ScheduledMessageInteractionStore, {
        capabilities: {
          messages: () => [],
          cancel: () => new Promise<void>((_resolve, rejectPromise) => (reject = rejectPromise)),
        },
      }),
    );
    const cancellation = store.cancel("scheduled-1");
    store[Symbol.dispose]();
    reject(new Error("offline"));
    await cancellation;
    expect(store.error).toBeUndefined();
  });
});
