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
    const createThread = vi.fn(async (anchor: ReviewThread["anchor"]) => {
      cache.upsertReviewThread({
        id: "thread-1", workspacePath: "/project", sessionId: "session-1", anchor,
        parts: [{ id: "question-1", kind: "text" as const, role: "user" as const, text: "Why?", status: "complete" as const, deliveryState: "sending" as const }],
        status: "open" as const, createdAt: now, updatedAt: now
      });
      return "thread-1";
    });
    const store = mount(createStore(MessageCommentsStore, {
      sessionRegistry: cache,
      reviews: () => ({ createThread, submitThread: vi.fn(), threadStreaming: () => false, resolveThread: vi.fn() }) as unknown as ReviewsStore,
      draftChatStore: () => popupChat,
      context: () => ({ workspacePath: "/project", sessionId: "session-1" })
    }));
    const popupChat: ChatStore = mount(store.draftChatStoreElement);

    store.prepareDraft({ messageId: "assistant-1", entryId: "entry-1", selectedText: "important", startOffset: 6, endOffset: 15, contextBefore: "Alpha ", contextAfter: " detail" });
    const chat = store.draftChatStore;
    await expect(chat.submit("Why?")).resolves.toBe(true);

    expect(createThread).toHaveBeenCalledWith(expect.objectContaining({ view: "message", messageId: "assistant-1", entryId: "entry-1", startOffset: 6, endOffset: 15 }), "Why?");
    expect(store.threadsForMessage("assistant-1")).toHaveLength(1);
    expect(store.draftChatStore).toBe(chat);
    expect(chat.composerVisible).toBe(true);
    expect(chat.parts.map((part) => part.kind === "text" ? part.text : "")).toEqual(["important", "Why?"]);

    store[Symbol.dispose]();
    popupChat[Symbol.dispose]();
    cache[Symbol.dispose]();
  });
});
