import { createStore, mount } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import { GlobalChatStore, type GlobalChatPort } from "../../../../src/renderer/stores/GlobalChatStore";
import { SessionRegistryStore } from "../../../../src/renderer/stores/SessionRegistryStore";
import type { SessionSnapshot } from "../../../../src/ipc/session-contract";
import type { DesktopClient } from "../../../../src/renderer/desktop-client";
import type { ReviewsStore } from "../../../../src/renderer/stores/ReviewsStore";
import type { PluginCommandStore } from "../../../../src/renderer/stores/PluginCommandStore";
import { SessionOperationCoordinator } from "../../../../src/renderer/stores/SessionOperationCoordinator";

const snapshot: SessionSnapshot = {
  workspacePath: "/home/user",
  sessionId: "global-1",
  sessionFile: "/global-1.jsonl",
  parts: [{ id: "old", kind: "text", role: "assistant", text: "The PDF task is task-7.", status: "complete" }],
  model: { provider: "openai", id: "gpt", name: "GPT" },
  models: [{ provider: "openai", providerName: "OpenAI", id: "gpt", name: "GPT", reasoning: true, input: ["text"], authenticated: true, authTypes: [] }],
  thinkingLevel: "medium",
  availableThinkingLevels: ["off", "medium", "high"],
  streaming: false,
  diagnostics: [],
  commands: [],
  compatibility: { resources: [], diagnostics: [] },
  extensionUi: { statuses: [] },
  sessions: [],
  tree: []
};

function createTestStore() {
  const port = {
    open: vi.fn(async (input: Parameters<GlobalChatPort["open"]>[0]) => { void input; }),
    prompt: vi.fn(async (input: Parameters<GlobalChatPort["prompt"]>[0]) => { void input; }),
    abort: vi.fn(async (input: Parameters<GlobalChatPort["abort"]>[0]) => { void input; }),
    setModel: vi.fn(async (input: Parameters<GlobalChatPort["setModel"]>[0]) => { void input; }),
    setThinkingLevel: vi.fn(async (input: Parameters<GlobalChatPort["setThinkingLevel"]>[0]) => { void input; }),
    resolveSession: vi.fn(async () => ({ schemaVersion: 1 as const, projects: [], resolvedSessionIds: [], resolvedCakeChatSessionIds: [], trustedProjectPaths: [] }))
  };
  const sessions = mount(createStore(SessionRegistryStore, {
    client: {} as DesktopClient,
    operations: {} as SessionOperationCoordinator,
    reviews: () => ({} as ReviewsStore),
    pluginCommands: () => ({} as PluginCommandStore),
    canSubmit: () => false,
    isActive: () => false,
    openCommandPane: async () => undefined,
    persist: () => undefined,
    projectName: () => "Project",
    abort: async () => undefined
  }));
  const operations = mount(createStore(SessionOperationCoordinator));
  const store = mount(createStore(GlobalChatStore, {
    port,
    tools: () => [{ name: "get_app_state", description: "Read app state", parameters: { type: "object", properties: {} } }],
    sessions: () => sessions,
    operations
  }));
  return { store, port, sessions, operations };
}

describe("GlobalChatStore", () => {
  it("hydrates the persistent transcript and submits a follow-up", async () => {
    const { store, port, sessions, operations } = createTestStore();
    await vi.waitFor(() => expect(port.open).toHaveBeenCalledOnce());
    store.receive({
      type: "global-chat-snapshot-received",
      snapshot
    });

    const active = store.activeSession!;
    active.chatStore.setDraft("Open it");
    await active.chatStore.submit();

    expect(active.parts.map((part) => part.kind === "text" ? part.text : "")).toEqual(["The PDF task is task-7.", "Open it"]);
    expect(port.prompt).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "global-1", text: "Open it" }));
    await active.configurationStore.selectModel("openai/gpt");
    await active.configurationStore.selectThinkingLevel("high");
    expect(port.setModel).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "global-1", provider: "openai", modelId: "gpt" }));
    expect(port.setThinkingLevel).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "global-1", level: "high" }));
    store[Symbol.dispose]();
    sessions[Symbol.dispose]();
    operations[Symbol.dispose]();
  });

  it("starts a new Cake Chat session without clearing prior history", async () => {
    const { store, port, sessions, operations } = createTestStore();
    await vi.waitFor(() => expect(port.open).toHaveBeenCalledOnce());

    await store.startNewSession();

    expect(port.open).toHaveBeenLastCalledWith(expect.objectContaining({ newSession: true, tools: [{ name: "get_app_state", description: "Read app state", parameters: { type: "object", properties: {} } }] }));
    store[Symbol.dispose]();
    sessions[Symbol.dispose]();
    operations[Symbol.dispose]();
  });

  it("applies persisted resolved state and can restore a Cake Chat", async () => {
    const { store, port, sessions, operations } = createTestStore();
    await vi.waitFor(() => expect(port.open).toHaveBeenCalledOnce());
    const now = new Date().toISOString();
    store.applyApplicationState({ schemaVersion: 1, projects: [], resolvedSessionIds: [], resolvedCakeChatSessionIds: ["global-1"], trustedProjectPaths: [] });
    store.receive({
      type: "global-chat-snapshot-received",
      snapshot: { ...snapshot, sessions: [{ id: "global-1", title: "Resolved work", created: now, modified: now, messageCount: 1, resolved: false }] }
    });

    expect(store.summaries[0]?.resolved).toBe(true);
    port.resolveSession.mockResolvedValueOnce({ schemaVersion: 1, projects: [], resolvedSessionIds: [], resolvedCakeChatSessionIds: [], trustedProjectPaths: [] });
    await store.resolveSession("global-1", false);
    expect(port.resolveSession).toHaveBeenCalledWith("global-1", false);
    expect(store.summaries[0]?.resolved).toBe(false);
    store[Symbol.dispose]();
    sessions[Symbol.dispose]();
    operations[Symbol.dispose]();
  });

  it("keeps independent Stores for multiple selected and background Cake Chat sessions", async () => {
    const { store, port, sessions, operations } = createTestStore();
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
        { id: "global-1", title: "First chat", created: now, modified: now, messageCount: 2, resolved: false },
        { id: "global-2", title: "Second chat", created: now, modified: now, messageCount: 0, resolved: false }
      ]
    };
    store.receive({ type: "global-chat-snapshot-received", operationId, snapshot: second });
    store.activeSession!.chatStore.setDraft("draft two");
    store.receive({ type: "global-chat-streaming-changed", sessionId: "global-1", streaming: true });

    expect(store.selectedSessionId).toBe("global-2");
    expect(store.loadedSessions).toHaveLength(2);
    expect(store.findSession("global-1")!.chatStore.draft).toBe("draft one");
    expect(store.findSession("global-2")!.chatStore.draft).toBe("draft two");
    expect(store.findSession("global-1")!.streaming).toBe(true);
    store[Symbol.dispose]();
    sessions[Symbol.dispose]();
    operations[Symbol.dispose]();
  });

  it("uses the shared chat store to submit pasted image attachments", async () => {
    const { store, port, sessions, operations } = createTestStore();
    await vi.waitFor(() => expect(port.open).toHaveBeenCalledOnce());
    store.receive({ type: "global-chat-snapshot-received", snapshot });
    const active = store.activeSession!;
    active.attachments.push({ kind: "image", name: "clipboard.png", mimeType: "image/png", data: "aW1hZ2U=" });

    expect(active.chatStore.canPasteImages).toBe(true);
    expect(active.chatStore.canSubmit).toBe(true);
    await active.chatStore.submit();

    expect(port.prompt).toHaveBeenCalledWith(expect.objectContaining({
      text: "",
      attachments: [{ kind: "image", name: "clipboard.png", mimeType: "image/png", data: "aW1hZ2U=" }]
    }));
    expect(active.attachments).toEqual([]);
    expect(active.parts).toContainEqual(expect.objectContaining({ kind: "attachment", name: "clipboard.png", data: "aW1hZ2U=" }));
    store[Symbol.dispose]();
    sessions[Symbol.dispose]();
    operations[Symbol.dispose]();
  });
});
