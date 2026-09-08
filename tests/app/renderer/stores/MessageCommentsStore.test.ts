import { createStore, mount } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import { MessageCommentsStore } from "../../../../src/renderer/stores/MessageCommentsStore";
import type { ReviewsStore } from "../../../../src/renderer/stores/ReviewsStore";
import type { SessionRegistryStore } from "../../../../src/renderer/stores/SessionRegistryStore";

const selection = {
  messageId: "assistant-1",
  entryId: "entry-1",
  selectedText: "Original selection",
  startOffset: 4,
  endOffset: 22,
  contextBefore: "The ",
  contextAfter: " matters.",
};

describe("MessageCommentsStore", () => {
  it("submits and clears annotations from its draft Store", async () => {
    const createThread = vi.fn(async () => "thread-1");
    const reviews = {
      createThread,
      configuration: undefined,
      error: undefined,
      errorDetails: undefined,
      threadStreaming: () => false,
    } as unknown as ReviewsStore;
    const sessionRegistry = {
      findModel: () => ({ reviewThreads: [] }),
    } as unknown as SessionRegistryStore;
    const store = mount(
      createStore(MessageCommentsStore, {
        sessionRegistry,
        reviews: () => reviews,
        context: () => ({ sessionId: "parent-1" }),
      }),
    );
    store.prepareDraft(selection);

    store.draftChatStore.addAnnotation({
      messageId: "side-assistant-1",
      selectedText: "important answer",
      startOffset: 3,
      endOffset: 19,
      contextBefore: "An ",
      contextAfter: " follows.",
      comment: "Go deeper",
    });
    expect(store.annotationDraft.annotations).toHaveLength(1);
    expect(store.draftChatStore.annotations).toHaveLength(1);
    await store.draftChatStore.submit();

    expect(createThread).toHaveBeenCalledWith(
      expect.objectContaining({ view: "message", messageId: "assistant-1" }),
      "",
      [
        expect.objectContaining({
          messageId: "side-assistant-1",
          selectedText: "important answer",
          comment: "Go deeper",
        }),
      ],
    );
    expect(store.annotationDraft.annotations).toEqual([]);
    store[Symbol.dispose]();
  });
});
