import { createStore, mount, observable } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { UiPart } from "../../../../src/ipc/session-contract";
import type { SessionRegistryStore } from "../../../../src/renderer/stores/SessionRegistryStore";
import { SessionOperationCoordinatorStore } from "../../../../src/renderer/stores/SessionOperationCoordinatorStore";
import { MessageComposerStore } from "../../../../src/renderer/stores/MessageComposerStore";

interface SubmittedPrompt {
  sessionId?: string;
  text?: string;
  delivery?: string;
}

function createComposerStore(options: {
  clientSubmit?: (input: unknown) => Promise<void>;
  clientCompactSession?: (input: unknown) => Promise<void>;
  clientEditSessionMessage?: (input: unknown) => Promise<void>;
  clientSetModel?: (input: unknown) => Promise<void>;
  renameSession?: (name: string) => Promise<void>;
  handoffSession?: (entryId: string, prompt?: string) => Promise<boolean>;
  canonicalParts?: () => UiPart[];
  streaming: () => boolean;
}) {
  let draft = "";
  const store = mount(
    createStore(MessageComposerStore, {
      client: {
        chooseAttachments: vi.fn(async () => []),
        suggestFiles: vi.fn(async () => []),
        submit: options.clientSubmit ?? (async () => undefined),
        editSessionMessage: options.clientEditSessionMessage,
        compactSession: options.clientCompactSession ?? (async () => undefined),
        setModel: options.clientSetModel ?? (async () => undefined),
      },
      sessionRegistry: {
        findModel: () => undefined,
      } as unknown as SessionRegistryStore,
      reviews: () => {
        throw new Error("not used");
      },
      projectPath: () => undefined,
      sessionId: () => "session-1",
      canonicalParts: options.canonicalParts ?? (() => []),
      draft: () => draft,
      setDraft: (value: string) => {
        draft = value;
      },
      persist: vi.fn(),
      canSubmit: () => true,
      isStreaming: options.streaming,
      openCommandPane: vi.fn(async () => undefined),
      matchesPluginCommand: () => false,
      runPluginCommand: vi.fn(async () => true),
      renameSession: options.renameSession ?? (async () => undefined),
      handoffSession: options.handoffSession ?? (async () => false),
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
    await store.submit(undefined, true);

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
      renderUserMessageAsMarkdown: true,
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

describe("MessageComposerStore message editing", () => {
  it("restores an activated message when asynchronous preflight fails", async () => {
    const harness = createComposerStore({
      clientSubmit: async () => undefined,
      streaming: () => false,
    });
    harness.setDraft("Retry this later");
    await harness.store.submit();
    const operationId = harness.store.activeOperations[0]!;
    expect(harness.getDraft()).toBe("");

    harness.store.receive({
      type: "operation-failed",
      operationId,
      message: "No model selected",
    });

    expect(harness.getDraft()).toBe("Retry this later");
    harness.dispose();
  });

  it("restores the last user message attachments and submits an in-place branch edit", async () => {
    const editSessionMessage = vi.fn(async () => undefined);
    const canonicalParts: UiPart[] = [
      {
        id: "user-text",
        kind: "text",
        role: "user",
        entryId: "user-entry",
        text: "Original request",
        status: "complete",
        renderAs: "markdown",
      },
      {
        id: "user-image",
        kind: "attachment",
        name: "diagram.png",
        mediaType: "image/png",
        attachmentKind: "image",
        data: "aW1hZ2U=",
      },
      {
        id: "assistant-text",
        kind: "text",
        role: "assistant",
        entryId: "assistant-entry",
        text: "Original answer",
        status: "complete",
      },
    ];
    const harness = createComposerStore({
      clientEditSessionMessage: editSessionMessage,
      canonicalParts: () => canonicalParts,
      streaming: () => false,
    });

    expect(harness.store.beginEditMessage("user-entry")).toBe(true);
    expect(harness.getDraft()).toBe("Original request");
    expect(harness.store.attachments).toEqual([
      expect.objectContaining({ kind: "image", name: "diagram.png", data: "aW1hZ2U=" }),
    ]);

    harness.setDraft("Edited request");
    await harness.store.submit(undefined, true);

    expect(editSessionMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        entryId: "user-entry",
        text: "Edited request",
        attachments: [
          expect.objectContaining({ kind: "image", name: "diagram.png", data: "aW1hZ2U=" }),
        ],
        renderUserMessageAsMarkdown: true,
      }),
    );
    harness.dispose();
  });
});

describe("MessageComposerStore builtin slash commands", () => {
  it("compacts the session instead of sending /compact as a prompt", async () => {
    const clientSubmit = vi.fn(async () => undefined);
    const clientCompactSession = vi.fn(async (input: unknown) => {
      void input;
    });
    const harness = createComposerStore({
      clientSubmit,
      clientCompactSession,
      streaming: () => false,
    });
    const { store } = harness;

    harness.setDraft("/compact");
    await store.submit();

    expect(clientCompactSession).toHaveBeenCalledWith({
      operationId: expect.any(String),
      sessionId: "session-1",
      instructions: undefined,
    });
    expect(clientSubmit).not.toHaveBeenCalled();
    expect(harness.getDraft()).toBe("");
    expect(store.pendingUserMessages).toEqual([]);
    harness.dispose();
  });

  it("passes custom compaction instructions", async () => {
    const clientCompactSession = vi.fn(async (input: unknown) => {
      void input;
    });
    const harness = createComposerStore({
      clientCompactSession,
      streaming: () => false,
    });
    const { store } = harness;

    harness.setDraft("/compact  Keep the API migration details ");
    await store.submit();

    expect(clientCompactSession).toHaveBeenCalledWith({
      operationId: expect.any(String),
      sessionId: "session-1",
      instructions: "Keep the API migration details",
    });
    harness.dispose();
  });

  it("switches models with /model <provider/model>", async () => {
    const clientSetModel = vi.fn(async (input: unknown) => {
      void input;
    });
    const harness = createComposerStore({ clientSetModel, streaming: () => false });
    const { store } = harness;

    harness.setDraft("/model openai/gpt-5.2");
    await store.submit();

    expect(clientSetModel).toHaveBeenCalledWith({
      operationId: expect.any(String),
      sessionId: "session-1",
      provider: "openai",
      modelId: "gpt-5.2",
    });
    expect(harness.getDraft()).toBe("");
    expect(store.error).toBeUndefined();
    harness.dispose();
  });

  it("reports usage for /model without an argument", async () => {
    const clientSetModel = vi.fn(async (input: unknown) => {
      void input;
    });
    const harness = createComposerStore({ clientSetModel, streaming: () => false });
    const { store } = harness;

    harness.setDraft("/model");
    await store.submit();

    expect(clientSetModel).not.toHaveBeenCalled();
    expect(store.error).toContain("Usage: /model <provider/model>");
    harness.dispose();
  });

  it("renames the session with /name <title>", async () => {
    const renameSession = vi.fn(async (name: string) => {
      void name;
    });
    const harness = createComposerStore({ renameSession, streaming: () => false });
    const { store } = harness;

    harness.setDraft("/name  Migration cleanup ");
    await store.submit();

    expect(renameSession).toHaveBeenCalledWith("Migration cleanup");
    expect(harness.getDraft()).toBe("");
    harness.dispose();
  });

  it("hands off from the latest completed assistant response", async () => {
    const handoffSession = vi.fn(async () => true);
    const harness = createComposerStore({
      handoffSession,
      canonicalParts: () => [
        {
          id: "assistant-part",
          entryId: "assistant-entry",
          kind: "text",
          role: "assistant",
          text: "Investigation complete",
          status: "complete",
        },
      ],
      streaming: () => false,
    });
    const { store } = harness;

    harness.setDraft("/handoff Implement the fix");
    await store.submit();

    expect(handoffSession).toHaveBeenCalledWith("assistant-entry", "Implement the fix", false);
    expect(harness.getDraft()).toBe("");
    harness.dispose();
  });

  it("hands off and resolves the source session", async () => {
    const handoffSession = vi.fn(async () => true);
    const harness = createComposerStore({
      handoffSession,
      canonicalParts: () => [
        {
          id: "assistant-part",
          entryId: "assistant-entry",
          kind: "text",
          role: "assistant",
          text: "Investigation complete",
          status: "complete",
        },
      ],
      streaming: () => false,
    });

    harness.setDraft("/handoffandresolve Implement the fix");
    await harness.store.submit();

    expect(handoffSession).toHaveBeenCalledWith("assistant-entry", "Implement the fix", true);
    expect(harness.getDraft()).toBe("");
    harness.dispose();
  });

  it("sends unrecognized slash input as an ordinary message", async () => {
    const submissions: SubmittedPrompt[] = [];
    const clientSubmit = vi.fn(async (input: unknown) => {
      submissions.push(input as SubmittedPrompt);
    });
    const harness = createComposerStore({ clientSubmit, streaming: () => false });
    const { store } = harness;

    harness.setDraft("/share this with the team");
    await store.submit();

    expect(submissions[0]).toMatchObject({ text: "/share this with the team" });
    expect(store.error).toBeUndefined();
    harness.dispose();
  });
});
