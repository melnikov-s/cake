import { createStore, mount } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatStore, type ChatStoreProps } from "../../../../src/renderer/stores/ChatStore";

function createChatStore(submit: () => Promise<boolean>, overrides: Partial<ChatStoreProps> = {}) {
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
      ...overrides,
    }),
  );
}

describe("ChatStore empty-composer submit", () => {
  it("steers the head of the prompt queue when submitting an empty composer", async () => {
    const steerQueuedPrompt = vi.fn();
    const submit = vi.fn(() => Promise.resolve(true));
    const store = createChatStore(submit, {
      queuedPrompts: () => [
        { id: "first", text: "First", attachments: [] },
        { id: "second", text: "Second", attachments: [] },
      ],
      steerQueuedPrompt,
    });

    await expect(store.submit("")).resolves.toBe(true);

    expect(steerQueuedPrompt).toHaveBeenCalledWith("first");
    expect(submit).not.toHaveBeenCalled();
    store[Symbol.dispose]();
  });

  it("keeps an empty-composer submit as a no-op without queued prompts", async () => {
    const submit = vi.fn(() => Promise.resolve(true));
    const store = createChatStore(submit, {
      // Real surfaces reject an empty draft.
      canSubmit: (draft) => draft.trim().length > 0,
    });

    await expect(store.submit("")).resolves.toBe(false);

    expect(submit).not.toHaveBeenCalled();
    store[Symbol.dispose]();
  });

  it("prefers the draft over the queue when the composer has content", async () => {
    const steerQueuedPrompt = vi.fn();
    const submit = vi.fn(() => Promise.resolve(true));
    const store = createChatStore(submit, {
      queuedPrompts: () => [{ id: "first", text: "First", attachments: [] }],
      steerQueuedPrompt,
    });
    store.setDraft("New instruction");

    await expect(store.submit()).resolves.toBe(true);

    expect(steerQueuedPrompt).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalled();
    store[Symbol.dispose]();
  });
});

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
