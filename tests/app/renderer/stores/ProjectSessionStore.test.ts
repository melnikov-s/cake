import { createStore, mount } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { Client } from "../../../../src/renderer/client/Client";
import { RootProjection } from "../../../../src/renderer/models/RootProjection";
import type { ProjectPendingSessionsStore } from "../../../../src/renderer/stores/ProjectPendingSessionsStore";
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
        handoffSession: async () => false,
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
});
