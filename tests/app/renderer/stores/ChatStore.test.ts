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

describe("ChatStore work-log view mode and expansion", () => {
  it("manages local workLogViewMode and cycles auto -> diff -> log -> auto", () => {
    const store = createChatStore(() => Promise.resolve(true));
    expect(store.workLogViewMode).toBe("auto");

    store.cycleWorkLogViewMode();
    expect(store.workLogViewMode).toBe("diff");

    store.cycleWorkLogViewMode();
    expect(store.workLogViewMode).toBe("log");

    store.cycleWorkLogViewMode();
    expect(store.workLogViewMode).toBe("auto");

    store.setWorkLogViewMode("diff");
    expect(store.workLogViewMode).toBe("diff");
    store[Symbol.dispose]();
  });

  it("manages local workLogsExpansion and cycles collapsed -> expanded -> fully-expanded -> collapsed", () => {
    const store = createChatStore(() => Promise.resolve(true));
    expect(store.workLogsExpansion).toBe("collapsed");
    expect(store.workLogItemOpen("item-1")).toBe(false);

    store.cycleWorkLogsExpansion();
    expect(store.workLogsExpansion).toBe("expanded");
    expect(store.workLogItemOpen("item-1")).toBe(false);

    store.setWorkLogItemOpen("item-1", true);
    expect(store.workLogItemOpen("item-1")).toBe(true);

    store.cycleWorkLogsExpansion();
    expect(store.workLogsExpansion).toBe("fully-expanded");
    // In fully-expanded, overrides are cleared and all items are open
    expect(store.workLogItemOpen("item-1")).toBe(true);
    expect(store.workLogItemOpen("item-2")).toBe(true);

    store.cycleWorkLogsExpansion();
    expect(store.workLogsExpansion).toBe("collapsed");
    expect(store.workLogItemOpen("item-1")).toBe(false);
    store[Symbol.dispose]();
  });

  it("delegates view mode and expansion to props when provided", () => {
    let mode: "auto" | "diff" | "log" = "log";
    let expansion: "collapsed" | "expanded" | "fully-expanded" = "expanded";
    const setMode = vi.fn((next: typeof mode) => {
      mode = next;
    });
    const setExpansion = vi.fn((next: typeof expansion) => {
      expansion = next;
    });

    const store = createChatStore(() => Promise.resolve(true), {
      workLogViewMode: () => mode,
      setWorkLogViewMode: setMode,
      workLogsExpansion: () => expansion,
      setWorkLogsExpansion: setExpansion,
    });

    expect(store.workLogViewMode).toBe("log");
    expect(store.workLogsExpansion).toBe("expanded");

    store.setWorkLogViewMode("diff");
    expect(setMode).toHaveBeenCalledWith("diff");

    store.setWorkLogsExpansion("fully-expanded");
    expect(setExpansion).toHaveBeenCalledWith("fully-expanded");
    store[Symbol.dispose]();
  });

  it("keeps non-diff work logs collapsed in diff view mode and allows group overrides", () => {
    const store = createChatStore(() => Promise.resolve(true));
    store.setWorkLogsExpansion("expanded");
    store.setWorkLogViewMode("diff");

    // In diff mode, groups with diffs open, while groups without diffs stay collapsed
    expect(store.workLogGroupOpen("group-diff", true)).toBe(true);
    expect(store.workLogGroupOpen("group-no-diff", false)).toBe(false);

    // Manual click overrides the default for that group
    store.setWorkLogGroupOpen("group-no-diff", true);
    expect(store.workLogGroupOpen("group-no-diff", false)).toBe(true);

    // Changing expansion clears group overrides
    store.setWorkLogsExpansion("collapsed");
    expect(store.workLogGroupOpen("group-no-diff", false)).toBe(false);
    expect(store.workLogGroupOpen("group-diff", true)).toBe(false);

    store[Symbol.dispose]();
  });
});
