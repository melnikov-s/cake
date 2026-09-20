import { createStore, mount } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { Client } from "../../../../src/renderer/client/Client";
import { ReviewThread } from "../../../../src/renderer/models/ReviewThread";
import { RootProjection } from "../../../../src/renderer/models/RootProjection";
import { ChatStore } from "../../../../src/renderer/stores/ChatStore";
import type { ProjectPendingSessionsStore } from "../../../../src/renderer/stores/ProjectPendingSessionsStore";
import type { ReviewsStore } from "../../../../src/renderer/stores/ReviewsStore";
import { ProjectSessionStore } from "../../../../src/renderer/stores/ProjectSessionStore";
import { SessionOperationCoordinatorStore } from "../../../../src/renderer/stores/SessionOperationCoordinatorStore";
import { mountWithClient } from "../mount-with-client";

describe("ProjectSessionStore", () => {
  it("restores a resolved session before delivering a message or changing its model", async () => {
    const calls: string[] = [];
    const ensureSessionActive = vi.fn(async () => {
      calls.push("restore");
      return true;
    });
    const prompt = vi.fn(async () => {
      calls.push("prompt");
    });
    const setModel = vi.fn(async () => {
      calls.push("model");
    });
    const models = RootProjection.create();
    const model = models.projectConversation("resolved-session", "/project");
    const operations = mount(createStore(SessionOperationCoordinatorStore));
    const pendingSessions = {
      isTemporary: () => false,
      isDraft: () => false,
      conversation: () => undefined,
      cancelSubmission: vi.fn(),
    } as unknown as ProjectPendingSessionsStore;
    const { root, subject: session } = mountWithClient(
      createStore(ProjectSessionStore, {
        workspacePath: "/project",
        sessionId: "resolved-session",
        model,
        projectSession: models.projectSession(model.sessionId),
        discussionCatalog: models.discussionCatalog(model.sessionId),
        subagentCatalog: models.subagentCatalog(model.sessionId),
        scheduledMessageCatalog: models.scheduledMessageCatalog(model.sessionId),
        artifactModel: models.artifacts,
        pendingSessions,
        operations,
        reviews: () => {
          throw new Error("ReviewsStore is not used by this test");
        },
        canSubmit: () => true,
        isActive: () => true,
        worktreeOperation: () => undefined,
        openCommandPane: async () => undefined,
        projectName: () => "project",
        familyId: () => undefined,
        renameSession: async () => undefined,
        toolCompactSession: async () => false,
        modelPresets: () => [],
        openModelPresetSettings: () => undefined,
        newSessionRequest: () => undefined,
        prepareNewSession: async () => true,
        ensureSessionActive,
        configureDraftActivation: () => undefined,
        sessionCreationChoice: () => ({ kind: "current" }),
        draftActivationCandidates: () => [],
        onWorktreeLanded: () => undefined,
        onWorktreeDiscarded: () => undefined,
        retirement: { prepare: async () => true },
        onResolveWorktree: () => undefined,
      }),
      { sessionChats: { prompt, setModel } } as unknown as Client,
    );

    const submission = session.conversationSessionStore.chatStore.submit("Continue");

    expect(session.conversationSessionStore.chatStore.parts).toEqual([
      expect.objectContaining({ text: "Continue", deliveryState: "sending" }),
    ]);
    expect(session.conversationSessionStore.chatStore.loading).toBe(true);
    await Promise.resolve();
    expect(prompt).not.toHaveBeenCalled();
    model.observedSnapshotRevision += 1;
    await expect(submission).resolves.toBe(true);

    expect(calls).toEqual(["restore", "prompt"]);
    const selection =
      session.conversationSessionStore.configurationStore.selectModel("openai/gpt-5");
    await Promise.resolve();
    expect(setModel).not.toHaveBeenCalled();
    model.observedSnapshotRevision += 1;
    await selection;

    expect(calls).toEqual(["restore", "prompt", "restore", "model"]);
    expect(ensureSessionActive).toHaveBeenCalledTimes(2);
    root[Symbol.dispose]();
    operations[Symbol.dispose]();
    models[Symbol.dispose]();
  });

  it("opens a command-created side chat when its authoritative projection arrives", async () => {
    const models = RootProjection.create();
    const model = models.projectConversation("session-1", "/project");
    const operations = mount(createStore(SessionOperationCoordinatorStore));
    const sideChat = mount(
      createStore(ChatStore, {
        id: () => "thread-1",
        parts: () => [],
        streaming: () => false,
        submitting: () => false,
        configuration: () => undefined,
        commands: () => [],
        placeholder: () => "Ask a follow-up…",
        inputLabel: () => "Reply to side chat",
        canSubmit: () => true,
        submit: async () => true,
      }),
    );
    const createSideChat = vi.fn(async () => "thread-1");
    const reviews = {
      createSideChat,
      chatStore: (threadId: string) => (threadId === "thread-1" ? sideChat : undefined),
    } as unknown as ReviewsStore;
    const pendingSessions = {
      isTemporary: () => false,
      isDraft: () => false,
      conversation: () => undefined,
      cancelSubmission: vi.fn(),
    } as unknown as ProjectPendingSessionsStore;
    const { root, subject: session } = mountWithClient(
      createStore(ProjectSessionStore, {
        workspacePath: "/project",
        sessionId: "session-1",
        model,
        projectSession: models.projectSession(model.sessionId),
        discussionCatalog: models.discussionCatalog(model.sessionId),
        subagentCatalog: models.subagentCatalog(model.sessionId),
        scheduledMessageCatalog: models.scheduledMessageCatalog(model.sessionId),
        artifactModel: models.artifacts,
        pendingSessions,
        operations,
        reviews: () => reviews,
        canSubmit: () => true,
        isActive: () => true,
        worktreeOperation: () => undefined,
        openCommandPane: async () => undefined,
        projectName: () => "project",
        familyId: () => undefined,
        renameSession: async () => undefined,
        toolCompactSession: async () => false,
        modelPresets: () => [],
        openModelPresetSettings: () => undefined,
        newSessionRequest: () => undefined,
        prepareNewSession: async () => true,
        ensureSessionActive: () => true,
        configureDraftActivation: () => undefined,
        sessionCreationChoice: () => ({ kind: "current" }),
        draftActivationCandidates: () => [],
        onWorktreeLanded: () => undefined,
        onWorktreeDiscarded: () => undefined,
        retirement: { prepare: async () => true },
        onResolveWorktree: () => undefined,
      }),
      {} as Client,
    );
    session.conversationSessionStore.chatStore.setDraft("/sidechat Compare approaches");

    await expect(session.conversationSessionStore.chatStore.submit()).resolves.toBe(true);
    expect(createSideChat).toHaveBeenCalledWith(
      { sessionId: "session-1", workingDirectory: "/project" },
      "Compare approaches",
    );
    expect(session.conversationSessionStore.sideChatStore.target).toBeUndefined();

    models.discussionCatalog(model.sessionId).threads.push(
      ReviewThread.create({
        id: "thread-1",
        workingDirectory: "/project",
        parentSessionId: "session-1",
        anchor: {
          path: "session:session-1",
          view: "session",
          start: { diffLine: 0 },
          end: { diffLine: 0 },
          selectedText: "",
          contextBefore: "",
          contextAfter: "",
          diff: "",
        },
        status: "open",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    expect(session.conversationSessionStore.sideChatStore.target).toMatchObject({
      key: "discussion:thread-1",
      title: "Side chat",
      chatStore: sideChat,
    });
    root[Symbol.dispose]();
    sideChat[Symbol.dispose]();
    operations[Symbol.dispose]();
    models[Symbol.dispose]();
  });

  it("hands a selection draft side chat over to the created thread's chat", async () => {
    const models = RootProjection.create();
    const model = models.projectConversation("session-1", "/project");
    const operations = mount(createStore(SessionOperationCoordinatorStore));
    const threadChat = mount(
      createStore(ChatStore, {
        id: () => "thread-1",
        parts: () => [],
        streaming: () => false,
        submitting: () => false,
        configuration: () => undefined,
        commands: () => [],
        placeholder: () => "Ask a follow-up…",
        inputLabel: () => "Reply to selection side chat",
        canSubmit: () => true,
        submit: async () => true,
      }),
    );
    const createThread = vi.fn(async () => "thread-1");
    const reviews = {
      createThread,
      configuration: undefined,
      error: undefined,
      errorDetails: undefined,
      // Like the real Store, a thread has a chat only once its sidecar is live.
      chatStore: (threadId: string) =>
        threadId === "thread-1" &&
        models.discussionCatalog(model.sessionId).threads.find((thread) => thread.id === threadId)
          ?.sidecarSessionId
          ? threadChat
          : undefined,
    } as unknown as ReviewsStore;
    const pendingSessions = {
      isTemporary: () => false,
      isDraft: () => false,
      conversation: () => undefined,
      cancelSubmission: vi.fn(),
    } as unknown as ProjectPendingSessionsStore;
    const { root, subject: session } = mountWithClient(
      createStore(ProjectSessionStore, {
        workspacePath: "/project",
        sessionId: "session-1",
        model,
        projectSession: models.projectSession(model.sessionId),
        discussionCatalog: models.discussionCatalog(model.sessionId),
        subagentCatalog: models.subagentCatalog(model.sessionId),
        scheduledMessageCatalog: models.scheduledMessageCatalog(model.sessionId),
        artifactModel: models.artifacts,
        pendingSessions,
        operations,
        reviews: () => reviews,
        canSubmit: () => true,
        isActive: () => true,
        worktreeOperation: () => undefined,
        openCommandPane: async () => undefined,
        projectName: () => "project",
        familyId: () => undefined,
        renameSession: async () => undefined,
        toolCompactSession: async () => false,
        modelPresets: () => [],
        openModelPresetSettings: () => undefined,
        newSessionRequest: () => undefined,
        prepareNewSession: async () => true,
        ensureSessionActive: () => true,
        configureDraftActivation: () => undefined,
        sessionCreationChoice: () => ({ kind: "current" }),
        draftActivationCandidates: () => [],
        onWorktreeLanded: () => undefined,
        onWorktreeDiscarded: () => undefined,
        retirement: { prepare: async () => true },
        onResolveWorktree: () => undefined,
      }),
      {} as Client,
    );
    const comments = session.messageCommentsStore;
    const sideChat = session.conversationSessionStore.sideChatStore;
    comments.prepareDraft({
      messageId: "assistant-1",
      entryId: "entry-1",
      selectedText: "Original selection",
      startOffset: 0,
      endOffset: 18,
      contextBefore: "",
      contextAfter: "",
    });
    sideChat.open({
      key: "selection-draft:session-1",
      title: "Side chat",
      eyebrow: () => "Selection",
      chatStore: comments.draftChatStore,
    });

    await expect(comments.draftChatStore.submit("Why this?")).resolves.toBe(true);
    expect(createThread).toHaveBeenCalledWith(
      expect.objectContaining({ view: "message", messageId: "assistant-1" }),
      "Why this?",
      [],
    );
    // Until the authoritative thread arrives, the draft keeps the side chat and
    // bridges the gap as busy rather than accepting a second submission.
    expect(sideChat.target?.chatStore).toBe(comments.draftChatStore);
    expect(comments.draftChatStore.submitting).toBe(true);
    expect(comments.draftChatStore.canSubmitValue("Again?")).toBe(false);

    // The catalog lists the thread before its sidecar is linked; the draft
    // still holds the side chat until the thread's conversation exists.
    const thread = ReviewThread.create({
      id: "thread-1",
      workingDirectory: "/project",
      parentSessionId: "session-1",
      anchor: {
        path: "session:session-1/message/assistant-1",
        view: "message",
        start: { diffLine: 0 },
        end: { diffLine: 0 },
        selectedText: "Original selection",
        contextBefore: "",
        contextAfter: "",
        diff: "",
        messageId: "assistant-1",
      },
      status: "open",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    models.discussionCatalog(model.sessionId).threads.push(thread);
    expect(sideChat.target?.chatStore).toBe(comments.draftChatStore);

    thread.sidecarSessionId = "sidecar-1";

    expect(sideChat.target).toMatchObject({
      key: "discussion:thread-1",
      title: "Side chat",
      chatStore: threadChat,
    });
    expect(sideChat.target?.eyebrow()).toBe("Selection");

    // A draft submitted while the side chat shows something else stays put.
    sideChat.close();
    comments.prepareDraft({
      messageId: "assistant-2",
      selectedText: "Another",
      startOffset: 0,
      endOffset: 7,
      contextBefore: "",
      contextAfter: "",
    });
    createThread.mockResolvedValueOnce("thread-2");
    await expect(comments.draftChatStore.submit("And this?")).resolves.toBe(true);
    expect(sideChat.target).toBeUndefined();
    root[Symbol.dispose]();
    threadChat[Symbol.dispose]();
    operations[Symbol.dispose]();
    models[Symbol.dispose]();
  });
});
