import { createStore, mount } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import {
  GlobalChatStore,
  type GlobalChatPort,
} from "../../../../src/renderer/stores/GlobalChatStore";
import type {
  ApplicationState,
  SessionPreview,
  SessionSnapshot,
} from "../../../../src/ipc/session-contract";

const snapshot: SessionSnapshot = {
  workspacePath: "/home/user",
  sessionId: "global-1",
  sessionFile: "/global-1.jsonl",
  parts: [
    {
      id: "old",
      kind: "text",
      role: "assistant",
      text: "The PDF task is task-7.",
      status: "complete",
    },
  ],
  model: { provider: "openai", id: "gpt", name: "GPT" },
  models: [
    {
      provider: "openai",
      providerName: "OpenAI",
      id: "gpt",
      name: "GPT",
      reasoning: true,
      availableThinkingLevels: ["off", "medium", "high"],
      input: ["text"],
      authenticated: true,
      authTypes: [],
    },
  ],
  thinkingLevel: "medium",
  availableThinkingLevels: ["off", "medium", "high"],
  streaming: false,
  diagnostics: [],
  commands: [],
  compatibility: { resources: [], diagnostics: [] },
  extensionUi: { statuses: [] },
  sessions: [],
  tree: [],
};

function createTestStore() {
  const port = {
    listSessions: vi.fn(async () => [
      {
        id: "global-1",
        title: "Existing chat",
        created: "2026-08-16T12:00:00.000Z",
        modified: "2026-08-16T12:00:00.000Z",
        messageCount: 1,
        resolved: false,
      },
    ]),
    loadSession: vi.fn(async (): Promise<SessionPreview | undefined> => undefined),
    listModels: vi.fn(async () => []),
    showComposerContextMenu: vi.fn(async () => undefined),
    rewordComposerSelection: vi.fn(async () => "rewritten"),
    generateSessionTitle: vi.fn(async () => "Planned Cake work"),
    open: vi.fn(async (input: Parameters<GlobalChatPort["open"]>[0]) => {
      void input;
    }),
    prompt: vi.fn(async (input: Parameters<GlobalChatPort["prompt"]>[0]) => {
      void input;
    }),
    editMessage: vi.fn(async (input: Parameters<NonNullable<GlobalChatPort["editMessage"]>>[0]) => {
      void input;
    }),
    abort: vi.fn(async (input: Parameters<GlobalChatPort["abort"]>[0]) => {
      void input;
    }),
    compact: vi.fn(async (input: Parameters<GlobalChatPort["compact"]>[0]) => {
      void input;
    }),
    handoff: vi.fn(async (input: Parameters<GlobalChatPort["handoff"]>[0]) => {
      void input;
    }),
    setConfiguration: vi.fn(async (input: Parameters<GlobalChatPort["setConfiguration"]>[0]) => {
      void input;
    }),
    setModel: vi.fn(async (input: Parameters<GlobalChatPort["setModel"]>[0]) => {
      void input;
    }),
    setThinkingLevel: vi.fn(async (input: Parameters<GlobalChatPort["setThinkingLevel"]>[0]) => {
      void input;
    }),
    setFastMode: vi.fn(async (input: Parameters<GlobalChatPort["setFastMode"]>[0]) => {
      void input;
    }),
    rename: vi.fn(async (input: Parameters<GlobalChatPort["rename"]>[0]) => {
      void input;
    }),
    resolveSession: vi.fn(async (): Promise<ApplicationState> => ({
      projects: [],
      resolvedSessionIds: [],
      resolvedCakeChatSessionIds: [],
      unreadSessionIds: [],
      trustedProjectPaths: [],
    })),
    deleteSession: vi.fn(async (): Promise<ApplicationState> => ({
      projects: [],
      resolvedSessionIds: [],
      resolvedCakeChatSessionIds: [],
      unreadSessionIds: [],
      trustedProjectPaths: [],
    })),
  };
  const store = mount(
    createStore(GlobalChatStore, {
      port,
      tools: () => [
        {
          command: "app.state",
          topic: "app",
          summary: "Read app state",
          parameters: { type: "object", properties: {} },
        },
      ],
    }),
  );
  void store.initialize();
  return { store, port };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("GlobalChatStore", () => {
  it("hydrates the persistent transcript and submits a follow-up", async () => {
    const { store, port } = createTestStore();
    await vi.waitFor(() => expect(port.open).toHaveBeenCalledOnce());
    store.receive({
      type: "global-chat-snapshot-received",
      snapshot,
    });

    const active = store.activeSession!;
    active.chatStore.setDraft("Open it");
    await active.chatStore.submit();

    expect(active.parts.map((part) => (part.kind === "text" ? part.text : ""))).toEqual([
      "The PDF task is task-7.",
    ]);
    expect(port.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "global-1", text: "Open it" }),
    );
    store.receive({
      type: "global-chat-part-updated",
      sessionId: "global-1",
      part: { id: "user-message", kind: "text", role: "user", text: "Open it", status: "complete" },
    });
    expect(active.parts.map((part) => (part.kind === "text" ? part.text : ""))).toEqual([
      "The PDF task is task-7.",
      "Open it",
    ]);
    await active.configurationStore.selectModel("openai/gpt");
    await active.configurationStore.selectThinkingLevel("high");
    await active.configurationStore.selectFastMode(true);
    expect(active.configurationStore.fastMode).toBe(true);
    expect(port.setFastMode).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "global-1", enabled: true }),
    );
    expect(port.setModel).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "global-1", provider: "openai", modelId: "gpt" }),
    );
    expect(port.setThinkingLevel).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "global-1", level: "high" }),
    );
    store[Symbol.dispose]();
  });

  it("replays deltas that arrive before the opening snapshot", async () => {
    const { store, port } = createTestStore();
    await vi.waitFor(() => expect(port.open).toHaveBeenCalledOnce());

    store.receive({
      type: "global-chat-part-updated",
      sessionId: "global-1",
      part: {
        id: "startup-notice",
        kind: "notice",
        tone: "info",
        title: "Resuming interrupted turn",
      },
    });
    store.receive({
      type: "global-chat-streaming-changed",
      sessionId: "global-1",
      streaming: true,
    });
    store.receive({ type: "global-chat-snapshot-received", snapshot });

    expect(store.activeSession?.parts).toContainEqual(
      expect.objectContaining({ id: "startup-notice" }),
    );
    expect(store.activeSession?.streaming).toBe(true);
    store[Symbol.dispose]();
  });

  it("prepares a new Cake Chat without creating a runtime", async () => {
    const { store, port } = createTestStore();
    await vi.waitFor(() => expect(port.open).toHaveBeenCalledOnce());

    await store.startNewSession();

    expect(port.open).toHaveBeenCalledOnce();
    expect(store.activeSession?.sessionId).not.toBe("global-1");
    expect(store.activeSession?.parts).toEqual([]);
    store[Symbol.dispose]();
  });

  it("does not let a late startup snapshot steal selection from a new chat", async () => {
    const { store, port } = createTestStore();
    await vi.waitFor(() => expect(port.open).toHaveBeenCalledOnce());
    const startupOperationId = port.open.mock.calls[0]![0].operationId;

    await store.startNewSession();
    const pendingSessionId = store.selectedSessionId;
    store.receive({
      type: "global-chat-snapshot-received",
      operationId: startupOperationId,
      snapshot,
    });

    expect(store.selectedSessionId).toBe(pendingSessionId);
    store[Symbol.dispose]();
  });

  it("activates a pending Cake Chat on the first prompt and renames it without IPC", async () => {
    const { store, port } = createTestStore();
    await vi.waitFor(() => expect(port.open).toHaveBeenCalledOnce());
    await store.startNewSession();
    const pending = store.activeSession!;

    await store.renameSession(pending.sessionId, "Deferred title");
    pending.chatStore.setDraft("First message");
    await pending.chatStore.submit();

    expect(port.rename).not.toHaveBeenCalled();
    expect(port.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: pending.sessionId,
        text: "First message",
        newSession: expect.objectContaining({
          name: "Deferred title",
          tools: expect.any(Array),
        }),
      }),
    );
    store[Symbol.dispose]();
  });

  it("restores a pending Cake Chat without opening a runtime", async () => {
    const { store, port } = createTestStore();
    store.restorePendingSession({
      sessionId: "restored-pending",
      draft: "Unsent work",
      name: "Pending title",
    });
    await store.initialize();

    expect(store.selectedSessionId).toBe("restored-pending");
    expect(store.activeSession?.chatStore.draft).toBe("Unsent work");
    expect(store.pendingSessionState()).toEqual(
      expect.objectContaining({ sessionId: "restored-pending", name: "Pending title" }),
    );
    expect(port.open).not.toHaveBeenCalled();
    store[Symbol.dispose]();
  });

  it("reconciles a restored pending chat that already has a transcript", async () => {
    const { store, port } = createTestStore();
    store.restorePendingSession({
      sessionId: "global-1",
      draft: "Recovered after a crash",
      name: "Recovered title",
    });
    await store.initialize();

    expect(store.pendingSessionState()).toBeUndefined();
    expect(port.open).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "global-1" }));
    store[Symbol.dispose]();
  });

  it("stages, names, edits, resolves, and activates a Cake Chat draft", async () => {
    const { store, port } = createTestStore();
    await vi.waitFor(() => expect(store.hydrated).toBe(true));
    await store.startNewSession();
    const session = store.activeSession!;
    session.chatStore.setDraft("Plan this Cake task");

    await expect(session.createDraftSession()).resolves.toBe(true);
    await vi.waitFor(() =>
      expect(store.summaries.find((summary) => summary.id === session.sessionId)).toMatchObject({
        title: "Planned Cake work",
        draft: true,
      }),
    );
    expect(session.parts).toEqual([
      expect.objectContaining({ text: "Plan this Cake task", draft: true }),
    ]);

    await store.resolveSession(session.sessionId, true);
    expect(store.summaries.find((summary) => summary.id === session.sessionId)?.resolved).toBe(
      true,
    );
    await store.resolveSession(session.sessionId, false);

    session.beginEditMessage(`draft:${session.sessionId}`);
    session.chatStore.setDraft("Plan only the renderer task");
    await session.submit(session.chatStore.draft);
    expect(session.parts).toEqual([
      expect.objectContaining({ text: "Plan only the renderer task", draft: true }),
    ]);

    await session.activateDraftSession();
    expect(port.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: session.sessionId,
        text: "Plan only the renderer task",
      }),
    );
    store[Symbol.dispose]();
  });

  it("applies persisted resolved state and can restore a Cake Chat", async () => {
    const { store, port } = createTestStore();
    await vi.waitFor(() => expect(port.open).toHaveBeenCalledOnce());
    const now = new Date().toISOString();
    store.applyApplicationState({
      projects: [],
      resolvedSessionIds: [],
      resolvedCakeChatSessionIds: ["global-1"],
      unreadSessionIds: [],
      trustedProjectPaths: [],
    });
    store.receive({
      type: "global-chat-snapshot-received",
      snapshot: {
        ...snapshot,
        sessions: [
          {
            id: "global-1",
            title: "Resolved work",
            created: now,
            modified: now,
            messageCount: 1,
            resolved: false,
          },
        ],
      },
    });

    expect(store.summaries[0]?.resolved).toBe(true);
    port.resolveSession.mockResolvedValueOnce({
      projects: [],
      resolvedSessionIds: [],
      resolvedCakeChatSessionIds: [],
      unreadSessionIds: [],
      trustedProjectPaths: [],
    });
    await store.resolveSession("global-1", false);
    expect(port.resolveSession).toHaveBeenCalledWith("global-1", false);
    expect(store.summaries[0]?.resolved).toBe(false);
    store[Symbol.dispose]();
  });

  it("opens a resolved Cake Chat from preview without restoring its runtime", async () => {
    const { store, port } = createTestStore();
    await vi.waitFor(() => expect(port.open).toHaveBeenCalledOnce());
    store.applyApplicationState({
      projects: [],
      resolvedSessionIds: [],
      resolvedCakeChatSessionIds: ["global-1"],
      unreadSessionIds: [],
      trustedProjectPaths: [],
    });
    await store.startNewSession();
    port.loadSession.mockResolvedValue({
      workspacePath: "/home/user",
      sessionId: "global-1",
      sessionFile: "/resolved/global-1.jsonl",
      parts: [
        {
          kind: "text",
          id: "message-1",
          role: "user",
          text: "Resolved Cake Chat prompt",
          status: "complete",
        },
      ],
    });

    await store.openSession("global-1");

    expect(port.loadSession).toHaveBeenCalledWith("global-1");
    expect(port.open).toHaveBeenCalledOnce();
    expect(store.selectedSessionId).toBe("global-1");
    expect(store.activeSession?.parts).toEqual([
      expect.objectContaining({ kind: "text", text: "Resolved Cake Chat prompt" }),
    ]);
    store[Symbol.dispose]();
  });

  it("deletes a resolved Cake Chat from its collection", async () => {
    const { store, port } = createTestStore();
    await vi.waitFor(() => expect(port.open).toHaveBeenCalledOnce());
    const now = new Date().toISOString();
    store.receive({
      type: "global-chat-snapshot-received",
      snapshot: {
        ...snapshot,
        sessions: [
          {
            id: "global-1",
            title: "Resolved work",
            created: now,
            modified: now,
            messageCount: 1,
            resolved: true,
          },
        ],
      },
    });
    store.applyApplicationState({
      projects: [],
      resolvedSessionIds: [],
      resolvedCakeChatSessionIds: ["global-1"],
      unreadSessionIds: [],
      trustedProjectPaths: [],
    });

    await store.deleteSession("global-1");

    expect(port.deleteSession).toHaveBeenCalledWith("global-1");
    expect(store.summaries).toEqual([]);
    store[Symbol.dispose]();
  });

  it("queues resolution mutations so responses commit in invocation order", async () => {
    const { store, port } = createTestStore();
    await vi.waitFor(() => expect(port.open).toHaveBeenCalledOnce());
    const first = deferred<Awaited<ReturnType<GlobalChatPort["resolveSession"]>>>();
    port.resolveSession
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({
        projects: [],
        resolvedSessionIds: [],
        resolvedCakeChatSessionIds: ["global-1", "global-2"],
        unreadSessionIds: [],
        trustedProjectPaths: [],
      });

    const firstResolution = store.resolveSession("global-1", true);
    const secondResolution = store.resolveSession("global-2", true);
    await vi.waitFor(() => expect(port.resolveSession).toHaveBeenCalledTimes(1));
    expect(port.resolveSession).not.toHaveBeenCalledWith("global-2", true);

    first.resolve({
      projects: [],
      resolvedSessionIds: [],
      resolvedCakeChatSessionIds: ["global-1"],
      unreadSessionIds: [],
      trustedProjectPaths: [],
    });
    await Promise.all([firstResolution, secondResolution]);

    expect(port.resolveSession.mock.calls.slice(-2)).toEqual([
      ["global-1", true],
      ["global-2", true],
    ]);
    expect(store.resolvedSessionIds).toEqual(["global-1", "global-2"]);
    store[Symbol.dispose]();
  });

  it("routes operation failures only to the owning Cake Chat session", async () => {
    const { store, port } = createTestStore();
    await vi.waitFor(() => expect(port.open).toHaveBeenCalledOnce());
    store.receive({ type: "global-chat-snapshot-received", snapshot });
    store.receive({
      type: "global-chat-snapshot-received",
      snapshot: { ...snapshot, sessionId: "global-2", sessionFile: "/global-2.jsonl" },
    });
    const first = store.findSession("global-1")!;
    const second = store.findSession("global-2")!;
    const operationId = store.operations.start(first.promptOwner);

    store.receive({
      type: "global-chat-operation-failed",
      operationId,
      message: "first failed",
    });

    expect(first.error).toBe("first failed");
    expect(second.error).toBeUndefined();
    store[Symbol.dispose]();
  });

  it("pins unsubmitted Cake Chat sessions above submitted ones", async () => {
    const { store, port } = createTestStore();
    await vi.waitFor(() => expect(port.open).toHaveBeenCalledOnce());
    store.receive({
      type: "global-chat-snapshot-received",
      snapshot: {
        ...snapshot,
        sessions: [
          {
            id: "submitted",
            title: "Older work",
            created: "2026-08-16T12:00:00.000Z",
            modified: "2026-08-16T12:00:00.000Z",
            messageCount: 3,
            resolved: false,
          },
          {
            id: "brand-new",
            title: "New chat",
            created: "2026-08-10T00:00:00.000Z",
            modified: "2026-08-10T00:00:00.000Z",
            messageCount: 0,
            resolved: false,
          },
        ],
      },
    });

    expect(store.summaries.map((summary) => summary.id)).toEqual([
      "brand-new",
      "submitted",
      "global-1",
    ]);
    store[Symbol.dispose]();
  });

  it("keeps independent Stores for multiple selected and background Cake Chat sessions", async () => {
    const { store, port } = createTestStore();
    await vi.waitFor(() => expect(port.open).toHaveBeenCalledOnce());
    store.receive({ type: "global-chat-snapshot-received", snapshot });
    store.activeSession!.chatStore.setDraft("draft one");

    await store.startNewSession();
    const pendingSessionId = store.activeSession!.sessionId;
    const now = new Date().toISOString();
    const second = {
      ...snapshot,
      sessionId: pendingSessionId,
      sessionFile: `/${pendingSessionId}.jsonl`,
      parts: [],
      sessions: [
        {
          id: "global-1",
          title: "First chat",
          created: now,
          modified: now,
          messageCount: 2,
          resolved: false,
        },
        {
          id: pendingSessionId,
          title: "Second chat",
          created: now,
          modified: now,
          messageCount: 0,
          resolved: false,
        },
      ],
    };
    store.receive({ type: "global-chat-snapshot-received", snapshot: second });
    store.activeSession!.chatStore.setDraft("draft two");
    store.receive({
      type: "global-chat-streaming-changed",
      sessionId: "global-1",
      streaming: true,
    });

    expect(store.selectedSessionId).toBe(pendingSessionId);
    expect(store.loadedSessions).toHaveLength(2);
    expect(store.findSession("global-1")!.chatStore.draft).toBe("draft one");
    expect(store.findSession(pendingSessionId)!.chatStore.draft).toBe("draft two");
    expect(store.findSession("global-1")!.streaming).toBe(true);
    store[Symbol.dispose]();
  });

  it("lets only the latest concurrent open request control selection", async () => {
    const { store, port } = createTestStore();
    await vi.waitFor(() => expect(port.open).toHaveBeenCalledOnce());
    store.receive({ type: "global-chat-snapshot-received", snapshot });

    const firstOpen = store.openSession("global-2");
    const firstOperationId = port.open.mock.calls.at(-1)![0].operationId;
    const secondOpen = store.openSession("global-3");
    const secondOperationId = port.open.mock.calls.at(-1)![0].operationId;
    await Promise.all([firstOpen, secondOpen]);

    store.receive({
      type: "global-chat-snapshot-received",
      operationId: secondOperationId,
      snapshot: { ...snapshot, sessionId: "global-3", sessionFile: "/global-3.jsonl" },
    });
    store.receive({
      type: "global-chat-snapshot-received",
      operationId: firstOperationId,
      snapshot: { ...snapshot, sessionId: "global-2", sessionFile: "/global-2.jsonl" },
    });

    expect(store.selectedSessionId).toBe("global-3");
    expect(store.findSession("global-2")).toBeDefined();
    expect(store.findSession("global-3")).toBeDefined();
    store[Symbol.dispose]();
  });

  it("uses the shared chat store to submit pasted image attachments", async () => {
    const { store, port } = createTestStore();
    await vi.waitFor(() => expect(port.open).toHaveBeenCalledOnce());
    store.receive({ type: "global-chat-snapshot-received", snapshot });
    const active = store.activeSession!;
    active.attachments.push({
      kind: "image",
      name: "clipboard.png",
      mimeType: "image/png",
      data: "aW1hZ2U=",
    });

    expect(active.chatStore.canPasteImages).toBe(true);
    expect(active.chatStore.canSubmit).toBe(true);
    await active.chatStore.submit();

    expect(port.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "",
        attachments: [
          { kind: "image", name: "clipboard.png", mimeType: "image/png", data: "aW1hZ2U=" },
        ],
      }),
    );
    expect(active.attachments).toEqual([]);
    store.receive({
      type: "global-chat-part-updated",
      sessionId: "global-1",
      part: {
        id: "user-image",
        kind: "attachment",
        name: "clipboard.png",
        mediaType: "image/png",
        attachmentKind: "image",
        data: "aW1hZ2U=",
      },
    });
    expect(active.parts).toContainEqual(
      expect.objectContaining({ kind: "attachment", name: "clipboard.png", data: "aW1hZ2U=" }),
    );
    store[Symbol.dispose]();
  });
});
