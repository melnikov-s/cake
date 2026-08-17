import { createStore, mount } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { ReviewThread } from "../../../../src/ipc/review-contract";
import type { DesktopClient } from "../../../../src/renderer/desktop-client";
import { MessageCommentsStore } from "../../../../src/renderer/stores/MessageCommentsStore";
import type { ChatStore } from "../../../../src/renderer/stores/ChatStore";
import { SessionRegistryStore } from "../../../../src/renderer/stores/SessionRegistryStore";
import type { ReviewsStore } from "../../../../src/renderer/stores/ReviewsStore";
import type { SessionOperationCoordinator } from "../../../../src/renderer/stores/SessionOperationCoordinator";
import type { PluginCommandStore } from "../../../../src/renderer/stores/PluginCommandStore";

describe("MessageCommentsStore", () => {
  it("keeps one editable draft chat store for the active selection", () => {
    const cache = mount(createStore(SessionRegistryStore, {
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
    const store = mount(createStore(MessageCommentsStore, {
      client: {} as DesktopClient,
      sessionRegistry: cache,
      reviews: () => ({ configuration: undefined }) as unknown as ReviewsStore,
      draftChatStore: () => popupChat,
      context: () => ({ workspacePath: "/project", sessionId: "session-1" })
    }));
    const popupChat: ChatStore = mount(store.draftChatStoreElement);
    store.prepareDraft({ messageId: "assistant-1", selectedText: "value", startOffset: 0, endOffset: 5, contextBefore: "", contextAfter: "" });
    const draftChat = store.draftChatStore;

    draftChat.setDraft("Why this value?");

    expect(store.draftChatStore).toBe(draftChat);
    expect(draftChat.parts).toEqual([expect.objectContaining({ role: "user", text: "value" })]);
    expect(store.draftChatStore.draft).toBe("Why this value?");
    expect(store.draftChatStore.focusRequestRevision).toBe(1);
    store[Symbol.dispose]();
    popupChat[Symbol.dispose]();
    cache[Symbol.dispose]();
  });

  it("creates a transcript anchor and immediately submits its sidecar thread", async () => {
    const now = new Date(0).toISOString();
    const createReviewThread = vi.fn(async (input: { anchor: ReviewThread["anchor"] }) => ({
      id: "thread-1", workspacePath: "/project", sessionId: "session-1", anchor: input.anchor,
      messages: [{ id: "question-1", role: "user" as const, body: "Why?", createdAt: now, delivered: false, status: "complete" as const }],
      status: "open" as const, createdAt: now, updatedAt: now
    }));
    const submitThreads = vi.fn(async () => undefined);
    const cache = mount(createStore(SessionRegistryStore, {
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
    const store = mount(createStore(MessageCommentsStore, {
      client: { createReviewThread } as unknown as DesktopClient,
      sessionRegistry: cache,
      reviews: () => ({ submitThreads, threadStreaming: () => false, resolveThread: vi.fn() }) as unknown as ReviewsStore,
      draftChatStore: () => popupChat,
      context: () => ({ workspacePath: "/project", sessionId: "session-1" }),
      reportError: vi.fn()
    }));
    const popupChat: ChatStore = mount(store.draftChatStoreElement);

    store.prepareDraft({ messageId: "assistant-1", entryId: "entry-1", selectedText: "important", startOffset: 6, endOffset: 15, contextBefore: "Alpha ", contextAfter: " detail" });
    const chat = store.draftChatStore;
    await expect(chat.submit("Why?")).resolves.toBe(true);

    expect(createReviewThread).toHaveBeenCalledWith(expect.objectContaining({
      workspacePath: "/project",
      sessionId: "session-1",
      anchor: expect.objectContaining({ view: "message", messageId: "assistant-1", entryId: "entry-1", startOffset: 6, endOffset: 15 })
    }));
    expect(submitThreads).toHaveBeenCalledWith(["thread-1"]);
    expect(store.threadsForMessage("assistant-1")).toHaveLength(1);
    expect(store.draftChatStore).toBe(chat);
    expect(chat.composerVisible).toBe(true);
    expect(chat.parts.map((part) => part.kind === "text" ? part.text : "")).toEqual(["important", "Why?"]);

    store[Symbol.dispose]();
    popupChat[Symbol.dispose]();
    cache[Symbol.dispose]();
  });
});
