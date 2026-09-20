import { child, createStore, mount, Store } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { Client } from "../../../../src/renderer/client/Client";
import {
  sessionAssistantThreadPath,
  type DiscussionAnchor,
} from "../../../../src/domain/discussion-sessions/discussion-session-data";
import type { ConversationSnapshot } from "../../../../src/domain/conversations/conversation-data";
import { RootProjection } from "../../../../src/renderer/models/RootProjection";
import type { Conversation } from "../../../../src/renderer/models/Conversation";
import {
  applyConversationSnapshot,
  applyDiscussionSessionUpdate,
} from "../../../../src/renderer/reducers/ConversationReducer";
import { applyDiscussionCatalogUpdate } from "../../../../src/renderer/reducers/DiscussionReducer";
import { applyPartUpdate } from "../../../../src/renderer/reducers/SessionPartReducer";
import { ActiveProjectSessionContext } from "../../../../src/renderer/stores/context/ActiveProjectSessionContext";
import { ReviewsStore } from "../../../../src/renderer/stores/ReviewsStore";
import { SessionOperationCoordinatorStore } from "../../../../src/renderer/stores/SessionOperationCoordinatorStore";
import type { SessionRegistryStore } from "../../../../src/renderer/stores/SessionRegistryStore";
import type { UiPart } from "../../../../src/ipc/session-contract";
import { mountWithClient } from "../mount-with-client";

class ReviewsHarnessStore extends Store<{
  sessionRegistry: SessionRegistryStore;
  projection: RootProjection;
  operations: SessionOperationCoordinatorStore;
}> {
  [ActiveProjectSessionContext.provide]() {
    return { sessionId: "parent-1", workingDirectory: "/project" };
  }

  @child
  get reviews(): ReviewsStore {
    return createStore(ReviewsStore, {
      sessionRegistry: this.props.sessionRegistry,
      discussionSessionModel: (sessionId, workingDirectory) =>
        this.props.projection.discussionConversation(sessionId, workingDirectory),
      operations: this.props.operations,
      modelPresets: () => [],
      openModelPresetSettings: () => undefined,
    });
  }
}

const sessionAnchor: DiscussionAnchor = {
  path: "session:parent-1",
  view: "session",
  start: { diffLine: 0 },
  end: { diffLine: 0 },
  selectedText: "",
  contextBefore: "",
  contextAfter: "",
  diff: "",
};

const assistantAnchor: DiscussionAnchor = {
  path: sessionAssistantThreadPath("parent-1"),
  view: "session",
  start: { diffLine: 0 },
  end: { diffLine: 0 },
  selectedText: "",
  contextBefore: "",
  contextAfter: "",
  diff: "",
};

const selectionAnchor: DiscussionAnchor = {
  path: "session:parent-1/message/assistant-1",
  view: "message",
  start: { diffLine: 0 },
  end: { diffLine: 0 },
  selectedText: "Original selection",
  contextBefore: "",
  contextAfter: "",
  diff: "",
  messageId: "assistant-1",
};

const modelOption = (provider: string, providerName: string, id: string, name: string) => ({
  provider,
  providerName,
  id,
  name,
  reasoning: true,
  availableThinkingLevels: ["off", "low", "high"],
  input: ["text"],
  authenticated: true,
  authTypes: ["api_key"],
});

const conversation = (
  sessionId: string,
  overrides: Partial<ConversationSnapshot> = {},
): ConversationSnapshot => ({
  sessionId,
  sessionFile: `/reviews/${sessionId}.jsonl`,
  parts: [],
  models: [
    modelOption("openai-codex", "OpenAI Codex", "gpt-5.6-sol", "Sol"),
    modelOption("google", "Google", "gemini-3.5-flash-lite", "Gemini"),
  ],
  thinkingLevel: "off",
  availableThinkingLevels: ["off", "low", "high"],
  streaming: false,
  diagnostics: [],
  commands: [],
  compatibility: { resources: [], diagnostics: [] },
  extensionUi: { statuses: [] },
  tree: [],
  ...overrides,
});

/**
 * A parent Project Session whose Discussion catalog lists the given threads,
 * plus each thread's live sidecar conversation, projected the way the window's
 * observer projects them.
 */
function fixture(
  threads: Array<{
    id: string;
    anchor?: DiscussionAnchor;
    parts?: UiPart[];
    streaming?: boolean;
    model?: { provider: string; id: string; name: string };
    thinkingLevel?: string;
    observed?: boolean;
  }>,
  client: Partial<Record<keyof Client, unknown>>,
) {
  const projection = RootProjection.create({});
  const parent = projection.projectConversation("parent-1", "/project");
  applyConversationSnapshot(
    parent,
    conversation("parent-1", {
      model: { provider: "openai-codex", id: "gpt-5.6-sol", name: "Sol" },
      thinkingLevel: "high",
    }),
  );
  const discussionCatalog = projection.discussionCatalog("parent-1");
  applyDiscussionCatalogUpdate(discussionCatalog, "parent-1", {
    _tag: "Snapshot",
    revision: 1,
    parentSessionId: "parent-1",
    threads: threads.map((thread) => ({
      id: thread.id,
      workingDirectory: "/project",
      parentSessionId: "parent-1",
      sidecarSessionId: `sidecar-${thread.id}`,
      anchor: thread.anchor ?? sessionAnchor,
      parts: [],
      status: "open",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    })),
  });
  const sidecars = new Map<string, Conversation>();
  for (const thread of threads) {
    const sidecar = projection.discussionConversation(`sidecar-${thread.id}`, "/project");
    sidecars.set(thread.id, sidecar);
    if (thread.observed === false) continue;
    applyDiscussionSessionUpdate(sidecar, sidecar.sessionId, {
      _tag: "Snapshot",
      revision: 1,
      snapshot: {
        identity: {
          _tag: "DiscussionSession",
          sessionId: sidecar.sessionId,
          parentSessionId: "parent-1",
        },
        conversation: conversation(sidecar.sessionId, {
          parts: thread.parts ?? [],
          streaming: thread.streaming ?? false,
          model: thread.model,
          thinkingLevel: thread.thinkingLevel ?? "off",
        }),
      },
    });
  }
  const parentSession = { model: parent, props: { discussionCatalog } };
  const sessionRegistry = {
    sessions: [parentSession],
    observationRetention: { sessions: [parentSession] },
    findModel: (sessionId: string) => (sessionId === "parent-1" ? parent : undefined),
    findSession: (sessionId: string) => (sessionId === "parent-1" ? parentSession : undefined),
  } as unknown as SessionRegistryStore;
  const operations = mount(createStore(SessionOperationCoordinatorStore));
  const mounted = mountWithClient(
    createStore(ReviewsHarnessStore, { sessionRegistry, projection, operations }),
    client as unknown as Client,
  );
  return {
    ...mounted,
    reviews: mounted.subject.reviews,
    parent,
    discussionCatalog,
    sidecar: (threadId: string) => sidecars.get(threadId)!,
    dispose() {
      mounted.root[Symbol.dispose]();
      operations[Symbol.dispose]();
      projection[Symbol.dispose]();
    },
  };
}

const sidecarTarget = { sessionId: "sidecar-thread-1" };

describe("ReviewsStore", () => {
  it("replies to a side chat through the shared Session Chat core by sidecar id", async () => {
    const prompt = vi.fn(async () => crypto.randomUUID());
    const { reviews, dispose } = fixture([{ id: "thread-1", anchor: selectionAnchor }], {
      sessionChats: { prompt },
    });
    const chat = reviews.chatStore("thread-1")!;

    // The selected passage opens the transcript as the thread's context.
    expect(chat.parts.map((part) => part.id)).toEqual(["anchor:thread-1"]);
    expect(chat.inputLabel).toBe("Reply to selection side chat");

    chat.addAnnotation({
      messageId: "side-assistant-1",
      selectedText: "important answer",
      startOffset: 3,
      endOffset: 19,
      contextBefore: "An ",
      contextAfter: " follows.",
      comment: "Go deeper",
    });
    await expect(chat.submit("Explain further")).resolves.toBe(true);

    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sidecar-thread-1",
        text: "Explain further",
        attachments: [
          expect.objectContaining({
            kind: "annotation",
            annotations: [
              expect.objectContaining({
                messageId: "side-assistant-1",
                selectedText: "important answer",
                comment: "Go deeper",
              }),
            ],
          }),
        ],
      }),
      expect.any(Object),
    );
    expect(chat.annotations).toEqual([]);
    expect(chat.draft).toBe("");
    dispose();
  });

  it("keeps the composer open, queues, and stops exactly like the main chat while streaming", async () => {
    const prompt = vi.fn(async () => crypto.randomUUID());
    const abort = vi.fn(async () => undefined);
    const { reviews, sidecar, dispose } = fixture(
      [
        {
          id: "thread-1",
          streaming: true,
          parts: [
            { id: "user-1", kind: "text", role: "user", text: "Explain this", status: "complete" },
            {
              id: "assistant-1",
              kind: "text",
              role: "assistant",
              text: "Working",
              status: "streaming",
            },
          ],
        },
      ],
      { sessionChats: { prompt, abort } },
    );
    const chat = reviews.chatStore("thread-1")!;
    const model = sidecar("thread-1");

    expect(chat.composerVisible).toBe(true);
    expect(chat.streaming).toBe(true);
    expect(chat.canStop).toBe(true);
    expect(chat.parts.map((part) => part.id)).toEqual(["user-1", "assistant-1"]);
    chat.setDraft("And then?");
    expect(chat.canSubmit).toBe(true);

    // A prompt during a turn joins the shared local queue rather than being refused.
    await chat.submit();
    expect(prompt).not.toHaveBeenCalled();
    expect(chat.queuedPrompts).toEqual([
      expect.objectContaining({ text: "And then?", state: "queued" }),
    ]);
    expect(chat.draft).toBe("");

    await chat.abort();
    expect(abort).toHaveBeenCalledWith(sidecarTarget, expect.any(Object));

    // Once the turn settles the queue drains into the sidecar and Stop goes away.
    applyDiscussionSessionUpdate(model, model.sessionId, {
      _tag: "Event",
      revision: 2,
      sessionId: model.sessionId,
      event: { _tag: "StreamingChanged", sessionId: model.sessionId, streaming: false },
    });
    await vi.waitFor(() =>
      expect(prompt).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "sidecar-thread-1", text: "And then?" }),
        expect.any(Object),
      ),
    );
    expect(chat.composerVisible).toBe(true);
    expect(chat.canStop).toBe(false);
    await chat.abort();
    expect(abort).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("manages the sidecar's runtime-held prompts through the shared queue operations", async () => {
    const steerQueuedMessage = vi.fn(async () => ({ steering: [], followUp: [] }));
    const removeQueuedMessage = vi.fn(async () => ({ steering: [], followUp: [] }));
    const cancelSteering = vi.fn(async () => ({ steering: [], followUp: [] }));
    const { reviews, sidecar, dispose } = fixture([{ id: "thread-1", streaming: true }], {
      sessionChats: { steerQueuedMessage, removeQueuedMessage, cancelSteering },
    });
    const chat = reviews.chatStore("thread-1")!;
    const model = sidecar("thread-1");
    for (const [id, deliveryState, text] of [
      ["queued-follow-up-1", "queued", "First"],
      ["queued-steering-1", "steering", "Now"],
    ] as const)
      applyPartUpdate(
        model.parts,
        { id, kind: "text", role: "user", text, status: "complete", deliveryState },
        model.sessionId,
      );

    expect(chat.queuedPrompts.map((entry) => [entry.id, entry.state, entry.editable])).toEqual([
      ["queued-follow-up-1", "queued", false],
      ["queued-steering-1", "steering", false],
    ]);
    expect(chat.parts).toEqual([]);

    chat.steerQueuedPrompt("queued-follow-up-1");
    chat.removeQueuedPrompt("queued-follow-up-1");
    await chat.cancelSteering();
    await Promise.resolve();

    expect(steerQueuedMessage).toHaveBeenCalledWith(
      { ...sidecarTarget, partId: "queued-follow-up-1" },
      expect.any(Object),
    );
    expect(removeQueuedMessage).toHaveBeenCalledWith(
      { ...sidecarTarget, partId: "queued-follow-up-1" },
      expect.any(Object),
    );
    expect(cancelSteering).toHaveBeenCalledWith(sidecarTarget, expect.any(Object));
    dispose();
  });

  it("starts a session-level side chat on the parent's current model", async () => {
    const start = vi.fn(async () => ({
      turnId: crypto.randomUUID(),
      thread: { id: "thread-2", sidecarSessionId: "sidecar-thread-2" },
    }));
    const { reviews, dispose } = fixture([], { discussionSessions: { start } });

    await expect(
      reviews.createSideChat(
        { sessionId: "parent-1", workingDirectory: "/project" },
        "Compare the two approaches",
      ),
    ).resolves.toBe("thread-2");

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: "parent-1",
        workingDirectory: "/project",
        anchor: expect.objectContaining({
          path: "session:parent-1",
          view: "session",
          selectedText: "",
        }),
        text: "Compare the two approaches",
        model: { provider: "openai-codex", id: "gpt-5.6-sol" },
        thinkingLevel: "high",
      }),
      expect.any(Object),
    );
    dispose();
  });

  it("configures a side chat's own sidecar without touching the parent session", async () => {
    const setModel = vi.fn(async () => undefined);
    const { reviews, parent, sidecar, dispose } = fixture(
      [
        {
          id: "thread-1",
          model: { provider: "google", id: "gemini-3.5-flash-lite", name: "Gemini" },
          thinkingLevel: "low",
        },
      ],
      { sessionChats: { setModel } },
    );
    const chat = reviews.chatStore("thread-1")!;
    const configuration = chat.configuration!;

    // The picker reflects the sidecar's live model, not the parent's.
    expect(configuration.session).toBe(sidecar("thread-1"));
    expect(configuration.session?.model?.modelId).toBe("gemini-3.5-flash-lite");
    expect(configuration.session?.thinkingLevel).toBe("low");

    await configuration.selectModel("openai-codex/gpt-5.6-sol");

    expect(setModel).toHaveBeenCalledWith(
      { sessionId: "sidecar-thread-1", provider: "openai-codex", modelId: "gpt-5.6-sol" },
      expect.any(Object),
    );
    expect(parent.model?.modelId).toBe("gpt-5.6-sol");
    expect(parent.thinkingLevel).toBe("high");
    dispose();
  });

  it("hides the model picker for the session assistant but not for a side chat", () => {
    const { reviews, dispose } = fixture(
      [
        { id: "assistant", anchor: assistantAnchor },
        { id: "thread-1", anchor: selectionAnchor },
      ],
      {},
    );

    const assistant = reviews.discussionSession("assistant")!;
    expect(assistant.isSessionAssistant).toBe(true);
    // The assistant is pinned to the utility model, so its chat keeps the
    // shared configuration Store but offers no picker.
    expect(assistant.chatStore.configuration).toBe(assistant.configurationStore);
    expect(assistant.chatStore.modelPickerVisible).toBe(false);

    const sideChat = reviews.discussionSession("thread-1")!;
    expect(sideChat.isSessionAssistant).toBe(false);
    expect(sideChat.chatStore.modelPickerVisible).toBe(true);
    dispose();
  });

  it("waits for the sidecar's first live snapshot before delivering a reply", async () => {
    const prompt = vi.fn(async () => crypto.randomUUID());
    const { reviews, sidecar, dispose } = fixture([{ id: "thread-1", observed: false }], {
      sessionChats: { prompt },
    });
    const chat = reviews.chatStore("thread-1")!;
    const model = sidecar("thread-1");
    expect(model.observedSnapshotRevision).toBe(0);

    const submission = chat.submit("Too early?");
    await Promise.resolve();
    expect(prompt).not.toHaveBeenCalled();

    applyDiscussionSessionUpdate(model, model.sessionId, {
      _tag: "Snapshot",
      revision: 1,
      snapshot: {
        identity: {
          _tag: "DiscussionSession",
          sessionId: model.sessionId,
          parentSessionId: "parent-1",
        },
        conversation: conversation(model.sessionId),
      },
    });
    await expect(submission).resolves.toBe(true);
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sidecar-thread-1", text: "Too early?" }),
      expect.any(Object),
    );
    dispose();
  });

  it("drops a thread's conversation Store when its sidecar leaves the catalog", () => {
    const { reviews, discussionCatalog, dispose } = fixture(
      [{ id: "thread-1" }, { id: "thread-2" }],
      {},
    );
    const first = reviews.discussionSession("thread-1")!;
    expect(reviews.discussionSessions.map((session) => session.threadId)).toEqual([
      "thread-1",
      "thread-2",
    ]);
    expect(reviews.threadStreaming("thread-1")).toBe(false);

    applyDiscussionCatalogUpdate(discussionCatalog, "parent-1", {
      _tag: "Event",
      revision: 2,
      parentSessionId: "parent-1",
      event: {
        _tag: "Replaced",
        threads: [
          {
            id: "thread-1",
            workingDirectory: "/project",
            parentSessionId: "parent-1",
            sidecarSessionId: "sidecar-thread-1",
            anchor: sessionAnchor,
            parts: [],
            status: "resolved",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z",
          },
        ],
      },
    });

    expect(reviews.discussionSession("thread-1")).toBe(first);
    expect(first.thread.status).toBe("resolved");
    expect(reviews.discussionSession("thread-2")).toBeUndefined();
    expect(reviews.chatStore("thread-2")).toBeUndefined();
    dispose();
  });
});
