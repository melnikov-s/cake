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
  it("restores a resolved session before delivering its next message", async () => {
    const calls: string[] = [];
    const ensureSessionActive = vi.fn(async () => {
      calls.push("restore");
      return true;
    });
    const prompt = vi.fn(async () => {
      calls.push("prompt");
    });
    const models = RootProjection.create();
    const model = models.projectSession("resolved-session", "/project");
    model.resolved = true;
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
        abort: async () => undefined,
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
      { projectSessions: { prompt } } as unknown as Client,
    );

    const submission = session.conversationSessionStore.chatStore.submit("Continue");

    expect(session.conversationSessionStore.chatStore.parts).toEqual([
      expect.objectContaining({ text: "Continue", deliveryState: "sending" }),
    ]);
    expect(session.conversationSessionStore.chatStore.loading).toBe(true);
    await Promise.resolve();
    expect(prompt).not.toHaveBeenCalled();

    model.resolved = false;
    model.observedSnapshotRevision += 1;
    await expect(submission).resolves.toBe(true);

    expect(calls).toEqual(["restore", "prompt"]);
    expect(ensureSessionActive).toHaveBeenCalledOnce();
    root[Symbol.dispose]();
    operations[Symbol.dispose]();
    models[Symbol.dispose]();
  });

  it("opens a command-created side chat when its authoritative projection arrives", async () => {
    const models = RootProjection.create();
    const model = models.projectSession("session-1", "/project");
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
        pendingSessions,
        operations,
        reviews: () => reviews,
        canSubmit: () => true,
        isActive: () => true,
        worktreeOperation: () => undefined,
        openCommandPane: async () => undefined,
        projectName: () => "project",
        familyId: () => undefined,
        abort: async () => undefined,
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

    model.reviewThreads.push(
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
});
