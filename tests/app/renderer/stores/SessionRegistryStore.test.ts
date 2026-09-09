import { applySnapshot, createStore, mount, toSnapshot, type StoreSnapshot } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import { SessionCatalog } from "../../../../src/renderer/models/SessionCatalog";
import { SessionSummary } from "../../../../src/renderer/models/SessionSummary";
import { RootProjection } from "../../../../src/renderer/models/RootProjection";
import { WorktreeCatalog } from "../../../../src/renderer/models/WorktreeCatalog";
import { SessionCatalogStore } from "../../../../src/renderer/stores/SessionCatalogStore";
import { SessionOperationCoordinatorStore } from "../../../../src/renderer/stores/SessionOperationCoordinatorStore";
import { SessionRegistryStore } from "../../../../src/renderer/stores/SessionRegistryStore";

function registryFixture(
  snapshot?: StoreSnapshot,
  isActive: (sessionId: string) => boolean = () => false,
  abort: (sessionId: string) => Promise<void> = async () => undefined,
) {
  const catalogModel = SessionCatalog.create({ sessions: [] });
  const registryRef: { current?: SessionRegistryStore } = {};
  const catalog = mount(
    createStore(SessionCatalogStore, {
      model: catalogModel,
      worktrees: WorktreeCatalog.create(),
      pendingSessions: () => registryRef.current?.pendingSessions.summaries ?? [],
    }),
  );
  const operations = mount(createStore(SessionOperationCoordinatorStore));
  const models = RootProjection.create();
  const registry = mount(
    createStore(SessionRegistryStore, {
      catalog,
      sessionModel: (sessionId, workingDirectory) =>
        models.projectSession(sessionId, workingDirectory),
      operations,
      reviews: () => {
        throw new Error("ReviewsStore is not used by this test");
      },
      canSubmit: () => true,
      isActive,
      worktreeOperation: () => undefined,
      openCommandPane: async () => undefined,
      persistNow: async () => undefined,
      projectName: (workingDirectory) => workingDirectory,
      abort,
      renameSession: async () => undefined,
      handoffSession: async () => false,
      onWorktreeLanded: () => undefined,
      onWorktreeDiscarded: () => undefined,
      retirement: {
        prepare: async () => true,
      },
      onResolveWorktree: () => undefined,
    }),
    snapshot ? { snapshot } : undefined,
  );
  registryRef.current = registry;
  return {
    catalog,
    catalogModel,
    registry,
    dispose() {
      registry[Symbol.dispose]();
      operations[Symbol.dispose]();
      catalog[Symbol.dispose]();
      catalogModel[Symbol.dispose]();
      models[Symbol.dispose]();
    },
  };
}

describe("SessionRegistryStore materialization", () => {
  it("preserves keyed identity and rejects a conflicting Working Directory", () => {
    const fixture = registryFixture();
    const first = fixture.registry.load("session-1", "/project");

    const conversation = first.conversationSessionStore;
    const composer = conversation.composerStore;
    const configuration = conversation.configurationStore;
    const chat = conversation.chatStore;

    expect(fixture.registry.load("session-1", "/project")).toBe(first);
    expect(first.conversationSessionStore).toBe(conversation);
    expect(conversation.composerStore).toBe(composer);
    expect(conversation.configurationStore).toBe(configuration);
    expect(conversation.chatStore).toBe(chat);
    expect(() => fixture.registry.load("session-1", "/other-project")).toThrow(
      "Session ID collision detected: session-1",
    );
    expect(fixture.registry.findSession("session-1")).toBe(first);

    fixture.dispose();
  });

  it("restores pending lifecycles and keyed loaded Store state from a window snapshot", async () => {
    const fixture = registryFixture();
    const staged = fixture.registry.pendingSessions.prepareStaged("/project", "staged");
    staged.conversationSessionStore.composerStore.draftStore.setText("Keep staged input");
    fixture.registry.pendingSessions.prepare("/project", "draft");
    const pendingConversation = fixture.registry.pendingSessions.conversation("draft")!;
    pendingConversation.setName("Saved draft");
    pendingConversation.setConfiguration({
      provider: "openai",
      modelId: "gpt-5",
      thinkingLevel: "high",
      fastMode: false,
    });
    await fixture.registry.pendingSessions.createDraft("draft", "Do this later", []);
    const snapshot = toSnapshot(fixture.registry);
    fixture.dispose();

    const restored = registryFixture(snapshot);
    const restoredStaged = restored.registry.findSession("staged")!;
    const restoredDraft = restored.registry.findSession("draft")!;

    expect(restored.registry.pendingSessions.isStaged("staged")).toBe(true);
    expect(restoredStaged.conversationSessionStore.composerStore.draftStore.text).toBe(
      "Keep staged input",
    );
    expect(restored.registry.pendingSessions.isDraft("draft")).toBe(true);
    const restoredConversation = restored.registry.pendingSessions.conversation("draft")!;
    expect(restoredConversation.draftPrompt?.text).toBe("Do this later");
    expect(restoredConversation.name).toBe("Saved draft");
    expect(restoredConversation.configuration).toMatchObject({
      provider: "openai",
      modelId: "gpt-5",
      thinkingLevel: "high",
      fastMode: false,
    });
    expect(restored.registry.findSession("staged")).toBe(restoredStaged);
    expect(restored.registry.findSession("draft")).toBe(restoredDraft);
    expect(toSnapshot(restored.registry)).toMatchObject({
      children: {
        sessions: expect.arrayContaining([
          expect.objectContaining({
            key: "staged",
            children: {
              conversationSessionStore: expect.objectContaining({
                children: {
                  composerStore: expect.objectContaining({
                    children: {
                      draftStore: expect.objectContaining({
                        state: expect.objectContaining({ text: "Keep staged input" }),
                      }),
                    },
                  }),
                },
              }),
            },
          }),
        ]),
      },
    });

    restored.dispose();
  });

  it("routes stop to the session that owns the chat control", async () => {
    const abort = vi.fn(async () => undefined);
    const fixture = registryFixture(undefined, () => true, abort);
    const parent = fixture.registry.pendingSessions.prepare("/project", "parent");
    const child = fixture.registry.pendingSessions.prepare("/project", "child");
    parent.model.streaming = true;
    child.model.streaming = true;

    await child.conversationSessionStore.chatStore.abort();

    expect(abort).toHaveBeenCalledExactlyOnceWith("child");
    fixture.dispose();
  });

  it("retains independent staged chats for multiple panes", () => {
    const fixture = registryFixture();
    const first = fixture.registry.pendingSessions.prepareStaged("/project", "staged-1");
    const second = fixture.registry.pendingSessions.prepareStaged("/project", "staged-2");

    expect(first).not.toBe(second);
    expect(fixture.registry.pendingSessions.isStaged("staged-1")).toBe(true);
    expect(fixture.registry.pendingSessions.isStaged("staged-2")).toBe(true);

    fixture.registry.removeSession("staged-1");
    expect(fixture.registry.pendingSessions.isStaged("staged-1")).toBe(false);
    expect(fixture.registry.pendingSessions.isStaged("staged-2")).toBe(true);

    fixture.dispose();
  });

  it("keeps a relocated composer unmaterialized until its Pi Session has started", () => {
    const fixture = registryFixture();
    const { registry } = fixture;

    const stagedSession = registry.pendingSessions.prepare("/project", "session-1");
    registry.pendingSessions.relocate("session-1", "/worktree");

    expect(registry.observationRetention.sessions).toEqual([]);
    expect(registry.findSession("session-1")).toBe(stagedSession);
    expect(stagedSession.workspacePath).toBe("/worktree");

    const invalidate = vi.spyOn(
      registry.findSession("session-1")!.stagedCommandStore,
      "invalidate",
    );
    const materializedSession = registry.pendingSessions.materialize("session-1", "/worktree");

    expect(materializedSession).toBe(stagedSession);
    expect(invalidate).toHaveBeenCalledOnce();
    expect(registry.pendingSessions.isTemporary("session-1")).toBe(false);
    expect(registry.observationRetention.sessions).toHaveLength(1);
    expect(registry.observationRetention.sessions[0]?.workspacePath).toBe("/worktree");
    expect(fixture.catalog.find("session-1")?.workingDirectory).toBe("/worktree");

    const session = registry.observationRetention.sessions[0]!;
    const otherSession = registry.pendingSessions.prepare("/project", "session-2");
    session.enterIde();
    session.toggleIdeChatSidebar();
    session.setIdeChatSidebarWidth(512);
    expect(session.ideMode).toBe(true);
    expect(session.ideChatSidebarVisible).toBe(false);
    expect(session.ideChatSidebarWidth).toBe(512);
    expect(otherSession.ideMode).toBe(false);
    expect(otherSession.ideChatSidebarVisible).toBe(true);
    expect(otherSession.ideChatSidebarWidth).toBe(420);

    session.model.streaming = true;
    expect(session.activity).toBe("running");
    session.receive({
      type: "artifact-requested",
      operationId: "interview-operation",
      artifactRequestId: "interview-request",
      record: {
        artifact: { sessionId: "session-1", id: "interview", revision: 1 },
      },
    } as never);
    expect(session.activity).toBe("waiting");
    session.receive({
      type: "agent-availability-changed",
      availability: { state: "unavailable" },
    });
    expect(session.activity).toBe("running");
    session.model.streaming = false;
    session.model.settledTurnRevision += 1;
    expect(session.activity).toBe("unread");
    session.markRead();
    expect(session.activity).toBeUndefined();

    fixture.dispose();
  });

  it("projects a main-created family child until the authoritative catalog arrives", () => {
    const fixture = registryFixture();
    fixture.registry.loadUnlistedFamilySession("child", "/project", "Child task", {
      familyId: "family",
      parentSessionId: "parent",
      childOrder: 1,
    });

    expect(fixture.catalog.find("child")).toMatchObject({
      sessionId: "child",
      title: "Child task",
      workingDirectory: "/project",
      familyId: "family",
      familyParentSessionId: "parent",
      familyChildOrder: 1,
      pending: true,
    });
    expect(
      fixture.registry.observationRetention.sessions.map((session) => session.sessionId),
    ).toEqual(["child"]);

    fixture.dispose();
  });

  it("clears the pending summary when authority arrives after materialization", () => {
    const fixture = registryFixture();
    const { catalogModel, registry } = fixture;
    registry.pendingSessions.prepare("/project", "session-1");
    registry.pendingSessions.projectSubmission("session-1", "Newest session");
    registry.pendingSessions.materialize("session-1", "/project");
    expect(fixture.catalog.find("session-1")).toMatchObject({ pending: true });

    catalogModel.sessions.push(
      SessionSummary.create({
        sessionId: "session-1",
        title: "Newest session",
        createdAt: "2026-01-01T00:00:00.000Z",
        modifiedAt: "2026-01-01T00:00:01.000Z",
        messageCount: 0,
        resolved: false,
        unread: false,
        projectPath: "/project",
        projectName: "project",
        workingDirectory: "/project",
      }),
    );
    applySnapshot(catalogModel, { sessions: [] });

    expect(fixture.catalog.sessions).toEqual([]);
    fixture.dispose();
  });

  it("does not retain a hidden pending summary when authority wins before materialization", () => {
    const fixture = registryFixture();
    const { catalogModel, registry } = fixture;
    registry.pendingSessions.prepare("/project", "session-1");
    registry.pendingSessions.projectSubmission("session-1", "Newest session");
    catalogModel.sessions.push(
      SessionSummary.create({
        sessionId: "session-1",
        title: "Newest session",
        createdAt: "2026-01-01T00:00:00.000Z",
        modifiedAt: "2026-01-01T00:00:01.000Z",
        messageCount: 0,
        resolved: false,
        unread: false,
        projectPath: "/project",
        projectName: "project",
        workingDirectory: "/project",
      }),
    );

    registry.pendingSessions.materialize("session-1", "/project");
    applySnapshot(catalogModel, { sessions: [] });

    expect(fixture.catalog.sessions).toEqual([]);
    fixture.dispose();
  });

  it("deletes a resolved draft from renderer-owned state", async () => {
    const fixture = registryFixture();
    const { registry } = fixture;
    registry.pendingSessions.prepare("/project", "draft-1");
    await registry.pendingSessions.createDraft("draft-1", "Planned work", []);
    registry.pendingSessions.conversation("draft-1")!.setDraftResolved(true);

    await expect(registry.pendingSessions.deleteResolvedDraft("draft-1")).resolves.toBe(true);

    expect(registry.pendingSessions.isDraft("draft-1")).toBe(false);
    expect(fixture.catalog.find("draft-1")).toBeUndefined();
    fixture.dispose();
  });

  it("does not turn persisted loaded sessions into startup observation demand", () => {
    const fixture = registryFixture({
      state: {
        targets: [
          { sessionId: "session-1", workspacePath: "/project" },
          { sessionId: "session-2", workspacePath: "/project" },
        ],
      },
      children: {
        observationRetention: {
          state: { materializedSessionIds: ["session-1", "session-2"] },
          children: {},
        },
      },
    });

    expect(fixture.registry.observationRetention.sessions).toEqual([]);

    fixture.registry.observationRetention.retain("session-2");
    expect(
      fixture.registry.observationRetention.sessions.map((session) => session.sessionId),
    ).toEqual(["session-2"]);

    fixture.dispose();
  });

  it("observes a loaded resolved session so its archived transcript can be projected", () => {
    const fixture = registryFixture();
    fixture.catalogModel.sessions.push(
      SessionSummary.create({
        sessionId: "resolved-session",
        title: "Resolved session",
        createdAt: "1970-01-01T00:00:00.000Z",
        modifiedAt: "1970-01-01T00:00:00.000Z",
        resolved: true,
        projectPath: "/project",
        projectName: "project",
        workingDirectory: "/project",
      }),
    );

    fixture.registry.load("resolved-session", "/project");

    expect(
      fixture.registry.observationRetention.sessions.map((session) => session.sessionId),
    ).toEqual(["resolved-session"]);

    fixture.dispose();
  });

  it("pins the selected session even before it enters the process-local LRU", () => {
    const fixture = registryFixture(
      {
        state: {
          targets: [
            { sessionId: "session-1", workspacePath: "/project" },
            { sessionId: "session-2", workspacePath: "/project" },
          ],
        },
        children: {
          observationRetention: {
            state: { materializedSessionIds: ["session-1", "session-2"] },
            children: {},
          },
        },
      },
      (sessionId) => sessionId === "session-1",
    );

    expect(
      fixture.registry.observationRetention.sessions.map((session) => session.sessionId),
    ).toEqual(["session-1"]);

    fixture.dispose();
  });

  it("retains 20 idle observations without evicting a running session", () => {
    const fixture = registryFixture();
    const { registry } = fixture;
    const running = registry.load("running", "/project");
    running.model.streaming = true;

    for (let index = 0; index < 21; index += 1) registry.load(`idle-${index}`, "/project");

    expect(registry.observationRetention.sessions).toHaveLength(21);
    expect(registry.observationRetention.sessions).toContain(running);
    expect(
      registry.observationRetention.sessions.map((session) => session.sessionId),
    ).not.toContain("idle-0");

    running.model.streaming = false;
    expect(registry.observationRetention.sessions).toHaveLength(20);
    expect(registry.observationRetention.sessions).toContain(running);
    expect(
      registry.observationRetention.sessions.map((session) => session.sessionId),
    ).not.toContain("idle-1");

    fixture.dispose();
  });
});
