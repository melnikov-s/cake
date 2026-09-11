import { child, createStore, Store } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { Client } from "../../../../src/renderer/client/Client";
import { ActiveProjectSessionContext } from "../../../../src/renderer/stores/context/ActiveProjectSessionContext";
import { ReviewsStore } from "../../../../src/renderer/stores/ReviewsStore";
import type { SessionRegistryStore } from "../../../../src/renderer/stores/SessionRegistryStore";
import { mountWithClient } from "../mount-with-client";

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
      parentSessionId: "parent-1",
      workingDirectory: "/project",
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
    const sessionModel = {
      reviewThreads: [thread],
      model: {
        id: '["openai-codex","gpt-5.6-sol"]',
        provider: "openai-codex",
        modelId: "gpt-5.6-sol",
        name: "Sol",
      },
      thinkingLevel: "medium",
    };
    const sessionRegistry = {
      sessions: [{ model: sessionModel }],
      findModel: () => sessionModel,
      findSession: () => undefined,
    } as unknown as SessionRegistryStore;
    const { root, subject } = mountWithClient(
      createStore(ReviewsHarnessStore, { sessionRegistry }),
      { discussionSessions: { prompt } } as unknown as Client,
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
        model: { provider: "openai-codex", id: "gpt-5.6-sol" },
        thinkingLevel: "medium",
      }),
      expect.any(Object),
    );
    expect(chat.annotations).toEqual([]);
    root[Symbol.dispose]();
  });

  it("creates a session-level side chat with the parent model configuration", async () => {
    const create = vi.fn(async () => ({ id: "thread-2" }));
    const prompt = vi.fn(async () => ({ turnId: crypto.randomUUID() }));
    const sessionModel = {
      reviewThreads: [],
      model: {
        id: '["openai-codex","gpt-5.6-sol"]',
        provider: "openai-codex",
        modelId: "gpt-5.6-sol",
      },
      thinkingLevel: "high",
    };
    const sessionRegistry = {
      sessions: [],
      findModel: () => sessionModel,
      findSession: () => undefined,
    } as unknown as SessionRegistryStore;
    const { root, subject } = mountWithClient(
      createStore(ReviewsHarnessStore, { sessionRegistry }),
      { discussionSessions: { create, prompt } } as unknown as Client,
    );

    await expect(
      subject.reviews.createSideChat(
        { sessionId: "parent-1", workingDirectory: "/project" },
        "Compare the two approaches",
      ),
    ).resolves.toBe("thread-2");

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: "parent-1",
        workingDirectory: "/project",
        anchor: expect.objectContaining({
          path: "session:parent-1",
          view: "session",
          selectedText: "",
        }),
      }),
      expect.any(Object),
    );
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-2",
        text: "Compare the two approaches",
        model: { provider: "openai-codex", id: "gpt-5.6-sol" },
        thinkingLevel: "high",
      }),
      expect.any(Object),
    );
    root[Symbol.dispose]();
  });
});
