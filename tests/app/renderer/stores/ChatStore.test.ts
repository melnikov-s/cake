import { createStore, mount } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatStore } from "../../../../src/renderer/stores/ChatStore";

function createChatStore(submit: () => Promise<boolean>) {
  return mount(
    createStore(ChatStore, {
      id: () => "chat",
      parts: () => [],
      streaming: () => false,
      submitting: () => false,
      configuration: () => undefined,
      commands: () => [],
      placeholder: () => "Message Cake",
      inputLabel: () => "Message",
      canSubmit: () => true,
      submit,
    }),
  );
}

describe("ChatStore loading timer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("owns the loading start time for the full operation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T12:00:00Z"));
    let finish!: (value: boolean) => void;
    const store = createChatStore(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );

    const submission = store.submit("Keep working");
    const startedAt = store.loadingStartedAt;
    expect(startedAt).toBe(Date.now());

    vi.advanceTimersByTime(2_000);
    expect(store.loadingStartedAt).toBe(startedAt);

    finish(true);
    await submission;
    expect(store.loadingStartedAt).toBeUndefined();
    store[Symbol.dispose]();
  });
});
