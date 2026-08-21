import { createStore, mount, observable } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { SessionRegistryStore } from "../../../../src/renderer/stores/SessionRegistryStore";
import { SessionOperationCoordinatorStore } from "../../../../src/renderer/stores/SessionOperationCoordinatorStore";
import { MessageComposerStore } from "../../../../src/renderer/stores/MessageComposerStore";

interface SubmittedPrompt {
  sessionId?: string;
  text?: string;
  delivery?: string;
}

function createComposerStore(options: {
  clientSubmit: (input: unknown) => Promise<void>;
  streaming: () => boolean;
}) {
  let draft = "";
  const store = mount(
    createStore(MessageComposerStore, {
      client: {
        chooseAttachments: vi.fn(async () => []),
        suggestFiles: vi.fn(async () => []),
        submit: options.clientSubmit,
      },
      sessionRegistry: {
        findModel: () => undefined,
      } as unknown as SessionRegistryStore,
      reviews: () => {
        throw new Error("not used");
      },
      projectPath: () => undefined,
      sessionId: () => "session-1",
      canonicalParts: () => [],
      draft: () => draft,
      setDraft: (value: string) => {
        draft = value;
      },
      canSubmit: () => true,
      isStreaming: options.streaming,
      openCommandPane: vi.fn(async () => undefined),
      matchesPluginCommand: () => false,
      runPluginCommand: vi.fn(async () => true),
      operations: mount(createStore(SessionOperationCoordinatorStore)),
      operationOwner: "message-composer:test",
    }),
  );
  return {
    store,
    setDraft: (value: string) => {
      draft = value;
    },
    getDraft: () => draft,
    dispose: () => {
      store[Symbol.dispose]();
    },
  };
}

describe("MessageComposerStore prompt queue", () => {
  it("queues prompts locally instead of delivering follow-ups while streaming", async () => {
    const state = observable({ streaming: true });
    const submissions: SubmittedPrompt[] = [];
    const clientSubmit = vi.fn(async (input: unknown) => {
      submissions.push(input as SubmittedPrompt);
    });
    const harness = createComposerStore({
      clientSubmit,
      streaming: () => state.streaming,
    });
    const { store } = harness;

    harness.setDraft("First fix the tests");
    await store.submit();

    expect(clientSubmit).not.toHaveBeenCalled();
    expect(store.queuedPrompts.map((entry) => entry.text)).toEqual(["First fix the tests"]);
    expect(harness.getDraft()).toBe("");

    // When streaming ends, the queue drains as normal prompts.
    state.streaming = false;
    await vi.waitFor(() => expect(clientSubmit).toHaveBeenCalledTimes(1));
    expect(submissions[0]).toMatchObject({
      sessionId: "session-1",
      text: "First fix the tests",
      delivery: "prompt",
    });
    expect(store.queuedPrompts).toEqual([]);
    harness.dispose();
  });

  it("steers a queued prompt immediately while streaming", async () => {
    const state = observable({ streaming: true });
    const submissions: SubmittedPrompt[] = [];
    const clientSubmit = vi.fn(async (input: unknown) => {
      submissions.push(input as SubmittedPrompt);
    });
    const harness = createComposerStore({
      clientSubmit,
      streaming: () => state.streaming,
    });
    const { store } = harness;

    harness.setDraft("Redirect now");
    await store.submit();
    expect(store.queuedPrompts).toHaveLength(1);

    store.steerQueuedPrompt(store.queuedPrompts[0]!.id);
    await vi.waitFor(() => expect(clientSubmit).toHaveBeenCalledTimes(1));
    expect(submissions[0]).toMatchObject({ text: "Redirect now", delivery: "steer" });
    expect(store.queuedPrompts).toEqual([]);
    harness.dispose();
  });

  it("edits a queued prompt by moving it back into the draft", async () => {
    const state = observable({ streaming: true });
    const submissions: SubmittedPrompt[] = [];
    const clientSubmit = vi.fn(async (input: unknown) => {
      submissions.push(input as SubmittedPrompt);
    });
    const harness = createComposerStore({
      clientSubmit,
      streaming: () => state.streaming,
    });
    const { store } = harness;

    harness.setDraft("Draft to edit");
    await store.submit();
    const revision = store.focusRequestRevision;

    store.editQueuedPrompt(store.queuedPrompts[0]!.id);

    expect(store.queuedPrompts).toEqual([]);
    expect(harness.getDraft()).toBe("Draft to edit");
    expect(store.focusRequestRevision).toBe(revision + 1);
    expect(clientSubmit).not.toHaveBeenCalled();
    harness.dispose();
  });

  it("removes a queued prompt without delivering it", async () => {
    const state = observable({ streaming: true });
    const submissions: SubmittedPrompt[] = [];
    const clientSubmit = vi.fn(async (input: unknown) => {
      submissions.push(input as SubmittedPrompt);
    });
    const harness = createComposerStore({
      clientSubmit,
      streaming: () => state.streaming,
    });
    const { store } = harness;

    harness.setDraft("Never mind");
    await store.submit();
    store.removeQueuedPrompt(store.queuedPrompts[0]!.id);

    expect(store.queuedPrompts).toEqual([]);
    state.streaming = false;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(clientSubmit).not.toHaveBeenCalled();
    harness.dispose();
  });
});
