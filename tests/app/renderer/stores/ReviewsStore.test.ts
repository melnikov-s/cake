import { child, createStore, Store } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { RendererClient } from "../../../../src/renderer/client/RendererClient";
import { ActiveProjectSessionContext } from "../../../../src/renderer/context/ActiveProjectSessionContext";
import { ReviewsStore } from "../../../../src/renderer/stores/ReviewsStore";
import type { SessionRegistryStore } from "../../../../src/renderer/stores/SessionRegistryStore";
import { mountWithRendererClient } from "../mount-with-renderer-client";

class ReviewsHarnessStore extends Store<{ sessionRegistry: SessionRegistryStore }> {
  [ActiveProjectSessionContext.provide]() {
    return { sessionId: "parent-1", workingDirectory: "/project" };
  }

  @child
  get reviews(): ReviewsStore {
    return createStore(ReviewsStore, { sessionRegistry: this.props.sessionRegistry });
  }
}

describe("ReviewsStore", () => {
  it("submits transcript annotations from side chats", async () => {
    const prompt = vi.fn(async () => ({ turnId: crypto.randomUUID() }));
    const thread = {
      id: "thread-1",
      anchor: {
        path: "session:parent-1/message/assistant-1",
        view: "message" as const,
        start: { diffLine: 0 },
        end: { diffLine: 0 },
        selectedText: "Original selection",
        contextBefore: "",
        contextAfter: "",
        diff: "",
        messageId: "assistant-1",
      },
      status: "open" as const,
      streaming: false,
      uiParts: [],
      usage: undefined,
    };
    const sessionRegistry = {
      findModel: () => ({ reviewThreads: [thread] }),
      findSession: () => undefined,
    } as unknown as SessionRegistryStore;
    const { root, subject } = mountWithRendererClient(
      createStore(ReviewsHarnessStore, { sessionRegistry }),
      { discussionSessions: { prompt } } as unknown as RendererClient,
    );
    const chat = subject.reviews.chatStore("thread-1")!;

    chat.addAnnotation({
      messageId: "side-assistant-1",
      selectedText: "important answer",
      startOffset: 3,
      endOffset: 19,
      contextBefore: "An ",
      contextAfter: " follows.",
      comment: "Go deeper",
    });
    await chat.submit();

    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: "parent-1",
        workingDirectory: "/project",
        threadId: "thread-1",
        text: "",
        annotations: [
          expect.objectContaining({
            messageId: "side-assistant-1",
            selectedText: "important answer",
            comment: "Go deeper",
          }),
        ],
      }),
      expect.any(Object),
    );
    expect(chat.annotations).toEqual([]);
    root[Symbol.dispose]();
  });
});
