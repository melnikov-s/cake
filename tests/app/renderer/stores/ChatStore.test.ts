import { createStore, mount, observable } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatStore, type ChatStoreProps } from "../../../../src/renderer/stores/ChatStore";

function createChatStore(
  submit: ChatStoreProps["submit"],
  overrides: Partial<ChatStoreProps> = {},
) {
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

// Per-item queue controls and submitting a nonempty draft beside the queue are
// covered by prompt-queue-workflow. These two empty-composer routes are retained:
// the real Send control is disabled for an empty draft, and proving Enter capture
// needs native Electron coverage, not a fabricated React control or jsdom claim.
describe("ChatStore empty-composer submit", () => {
  it("steers the head of the prompt queue when submitting an empty composer", async () => {
    const steerQueuedPrompt = vi.fn();
    const submit = vi.fn(() => Promise.resolve(true));
    const store = createChatStore(submit, {
      queuedPrompts: () => [
        {
          id: "first",
          text: "First",
          attachments: [],
          renderUserMessageAsMarkdown: false,
          state: "queued",
        },
        {
          id: "second",
          text: "Second",
          attachments: [],
          renderUserMessageAsMarkdown: false,
          state: "queued",
        },
      ],
      steerQueuedPrompt,
    });

    await expect(store.submit("")).resolves.toBe(true);

    expect(steerQueuedPrompt).toHaveBeenCalledWith("first");
    expect(submit).not.toHaveBeenCalled();
    store[Symbol.dispose]();
  });

  it("stops and sends the steering head on the next empty-composer submit", async () => {
    const stopAndSendQueuedPrompt = vi.fn(async () => undefined);
    const steerQueuedPrompt = vi.fn();
    const submit = vi.fn(() => Promise.resolve(true));
    const store = createChatStore(submit, {
      queuedPrompts: () => [
        {
          id: "steering",
          text: "Send immediately",
          attachments: [],
          renderUserMessageAsMarkdown: false,
          state: "steering",
        },
        {
          id: "later",
          text: "Later",
          attachments: [],
          renderUserMessageAsMarkdown: false,
          state: "queued",
        },
      ],
      steerQueuedPrompt,
      stopAndSendQueuedPrompt,
    });

    await expect(store.submit("")).resolves.toBe(true);

    expect(stopAndSendQueuedPrompt).toHaveBeenCalledWith("steering");
    expect(steerQueuedPrompt).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    store[Symbol.dispose]();
  });
});

// Retained native-navigation contract: repeated requests must reach Virtuoso even
// for the same message and supersede saved geometry. jsdom cannot verify scrolling.
describe("ChatStore message navigation", () => {
  it("replaces saved scroll state and revisions repeated navigation requests", () => {
    const store = createChatStore(() => Promise.resolve(true));
    store.transcriptInteraction.setTranscriptScrollPosition({
      kind: "message",
      messageId: "message-1",
      offset: -100,
    });

    store.transcriptInteraction.navigateToMessage("assistant-1");
    expect(store.transcriptInteraction.transcriptScrollPosition).toBeUndefined();
    expect(store.transcriptInteraction.messageSelection).toMatchObject({
      messageId: "assistant-1",
      origin: "navigation",
      revision: 1,
    });

    store.transcriptInteraction.navigateToMessage("assistant-1");
    expect(store.transcriptInteraction.messageSelection).toMatchObject({
      messageId: "assistant-1",
      origin: "navigation",
      revision: 2,
    });
    store[Symbol.dispose]();
  });
});

// Retained until the delivery/session-layer migration supplies the accepted-turn
// transition through real authority events. Existing assistant/conversation-mode
// workflows prove visible loading, not preservation of this operation's start time.
// Do not duplicate the concurrently owned delivery/session workflows here.
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
    const startedAt = store.transcriptInteraction.loadingStartedAt;
    expect(startedAt).toBe(Date.now());

    vi.advanceTimersByTime(2_000);
    expect(store.transcriptInteraction.loadingStartedAt).toBe(startedAt);

    finish(true);
    await submission;
    expect(store.transcriptInteraction.loadingStartedAt).toBeUndefined();
    store[Symbol.dispose]();
  });

  it("keeps loading continuous while an accepted turn crosses into streaming", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T12:00:00Z"));
    const activity = observable({ accepted: false, streaming: false });
    let finish!: (value: boolean) => void;
    const store = createChatStore(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
      {
        submitting: () => activity.accepted,
        streaming: () => activity.streaming,
      },
    );

    const submission = store.submit("Keep working");
    const startedAt = store.transcriptInteraction.loadingStartedAt;
    activity.accepted = true;
    finish(true);
    await submission;

    expect(store.loading).toBe(true);
    expect(store.transcriptInteraction.loadingStartedAt).toBe(startedAt);

    activity.streaming = true;
    activity.accepted = false;
    expect(store.transcriptInteraction.loadingStartedAt).toBe(startedAt);

    activity.streaming = false;
    expect(store.transcriptInteraction.loadingStartedAt).toBeUndefined();
    store[Symbol.dispose]();
  });
});
