import { createStore, mount } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import {
  GlobalChatStore,
  type GlobalChatPort,
} from "../../../../src/renderer/stores/GlobalChatStore";
import type { ApplicationState, SessionSnapshot } from "../../../../src/ipc/session-contract";

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
    open: vi.fn(async (input: Parameters<GlobalChatPort["open"]>[0]) => {
      void input;
    }),
    prompt: vi.fn(async (input: Parameters<GlobalChatPort["prompt"]>[0]) => {
      void input;
    }),
    abort: vi.fn(async (input: Parameters<GlobalChatPort["abort"]>[0]) => {
      void input;
    }),
    compact: vi.fn(async (input: Parameters<GlobalChatPort["compact"]>[0]) => {
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
      schemaVersion: 1 as const,
      projects: [],
      resolvedSessionIds: [],
      resolvedCakeChatSessionIds: [],
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

  it("starts a new Cake Chat session without clearing prior history", async () => {
    const { store, port } = createTestStore();
    await vi.waitFor(() => expect(port.open).toHaveBeenCalledOnce());

    await store.startNewSession();

    expect(port.open).toHaveBeenLastCalledWith(
      expect.objectContaining({
        newSession: true,
        tools: [
          {
            command: "app.state",
            topic: "app",
            summary: "Read app state",
            parameters: { type: "object", properties: {} },
          },
        ],
      }),
    );
    store[Symbol.dispose]();
  });

  it("applies persisted resolved state and can restore a Cake Chat", async () => {
    const { store, port } = createTestStore();
    await vi.waitFor(() => expect(port.open).toHaveBeenCalledOnce());
    const now = new Date().toISOString();
    store.applyApplicationState({
      schemaVersion: 1,
      projects: [],
      resolvedSessionIds: [],
      resolvedCakeChatSessionIds: ["global-1"],
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
      schemaVersion: 1,
      projects: [],
      resolvedSessionIds: [],
      resolvedCakeChatSessionIds: [],
      trustedProjectPaths: [],
    });
    await store.resolveSession("global-1", false);
    expect(port.resolveSession).toHaveBeenCalledWith("global-1", false);
    expect(store.summaries[0]?.resolved).toBe(false);
    store[Symbol.dispose]();
  });

  it("queues resolution mutations so responses commit in invocation order", async () => {
    const { store, port } = createTestStore();
    await vi.waitFor(() => expect(port.open).toHaveBeenCalledOnce());
    const first = deferred<Awaited<ReturnType<GlobalChatPort["resolveSession"]>>>();
    port.resolveSession
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({
        schemaVersion: 1,
        projects: [],
        resolvedSessionIds: [],
        resolvedCakeChatSessionIds: ["global-1", "global-2"],
        trustedProjectPaths: [],
      });

    const firstResolution = store.resolveSession("global-1", true);
    const secondResolution = store.resolveSession("global-2", true);
    await vi.waitFor(() => expect(port.resolveSession).toHaveBeenCalledTimes(1));
    expect(port.resolveSession).not.toHaveBeenCalledWith("global-2", true);

    first.resolve({
      schemaVersion: 1,
      projects: [],
      resolvedSessionIds: [],
      resolvedCakeChatSessionIds: ["global-1"],
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

    // "global-1" stays an open but unsubmitted target, so it is also pinned.
    expect(store.summaries.map((summary) => summary.id)).toEqual([
      "global-1",
      "brand-new",
      "submitted",
    ]);
    store[Symbol.dispose]();
  });

  it("keeps independent Stores for multiple selected and background Cake Chat sessions", async () => {
    const { store, port } = createTestStore();
    await vi.waitFor(() => expect(port.open).toHaveBeenCalledOnce());
    store.receive({ type: "global-chat-snapshot-received", snapshot });
    store.activeSession!.chatStore.setDraft("draft one");

    await store.startNewSession();
    const operationId = port.open.mock.calls.at(-1)![0].operationId;
    const now = new Date().toISOString();
    const second = {
      ...snapshot,
      sessionId: "global-2",
      sessionFile: "/global-2.jsonl",
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
          id: "global-2",
          title: "Second chat",
          created: now,
          modified: now,
          messageCount: 0,
          resolved: false,
        },
      ],
    };
    store.receive({ type: "global-chat-snapshot-received", operationId, snapshot: second });
    store.activeSession!.chatStore.setDraft("draft two");
    store.receive({
      type: "global-chat-streaming-changed",
      sessionId: "global-1",
      streaming: true,
    });

    expect(store.selectedSessionId).toBe("global-2");
    expect(store.loadedSessions).toHaveLength(2);
    expect(store.findSession("global-1")!.chatStore.draft).toBe("draft one");
    expect(store.findSession("global-2")!.chatStore.draft).toBe("draft two");
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
