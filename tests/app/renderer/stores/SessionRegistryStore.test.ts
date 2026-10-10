import { applySnapshot, createStore, mount, toSnapshot, type StoreSnapshot } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import { piBuiltinSlashCommands } from "../../../../src/ipc/session-contract";
import { SessionSummary } from "../../../../src/renderer/models/SessionSummary";
import { ReviewsStore } from "../../../../src/renderer/stores/ReviewsStore";
import { applyDiscussionCatalogUpdate } from "../../../../src/renderer/reducers/DiscussionReducer";
import { sessionAssistantThreadPath } from "../../../../src/domain/discussion-sessions/discussion-session-data";
import { fakeSavedDrafts, type FakeSavedDrafts } from "../fakes/saved-drafts";
import { createRendererStoreFixture } from "../renderer-store-fixture";

function registryFixture(
  snapshot?: StoreSnapshot,
  activeSessionId?: string,
  savedDrafts: FakeSavedDrafts = fakeSavedDrafts(),
) {
  const fixture = createRendererStoreFixture({
    client: { savedDrafts: savedDrafts.client },
    snapshot: snapshot ? { state: {}, children: { sessionRegistry: snapshot } } : undefined,
  });
  if (activeSessionId) fixture.root.appShellStore.selectProjectSession(activeSessionId);
  return {
    root: fixture.root,
    catalog: fixture.root.sessionCatalogStore,
    catalogModel: fixture.models.sessionCatalog,
    models: fixture.models,
    operations: fixture.root.sessionOperationCoordinator,
    registry: fixture.root.sessionRegistry,
    savedDrafts,
    dispose: () => fixture[Symbol.dispose](),
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

  it("indexes all realized keyed Stores for subsequent session switches", () => {
    const fixture = registryFixture();
    const first = fixture.registry.load("session-1", "/project");
    const second = fixture.registry.load("session-2", "/project");
    const snapshot = toSnapshot(fixture.registry);
    fixture.dispose();

    const restored = registryFixture(snapshot);
    const firstRestored = restored.registry.findSession("session-1");
    const sessionsGetter = vi.spyOn(restored.registry, "sessions", "get");
    const secondRestored = restored.registry.findSession("session-2");
    expect(secondRestored?.sessionId).toBe("session-2");
    expect(sessionsGetter).not.toHaveBeenCalled();
    expect(firstRestored).not.toBe(first);
    expect(secondRestored).not.toBe(second);
    restored.dispose();
  });

  it("does not reconcile the loaded Store collection when active selection changes", () => {
    const fixture = registryFixture(undefined, "session-1");
    for (let index = 0; index < 20; index += 1)
      fixture.registry.load(`session-${index}`, "/project");
    const sessionsGetter = vi.spyOn(fixture.registry, "sessions", "get");

    fixture.root.appShellStore.selectProjectSession("session-2");

    expect(sessionsGetter).not.toHaveBeenCalled();
    expect(
      fixture.registry.observationRetention.sessions.map((session) => session.sessionId),
    ).toEqual(expect.arrayContaining(["session-1", "session-2"]));
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

    // Saved Drafts are main-owned: the restored window reloads them from the same authority.
    const restored = registryFixture(snapshot, undefined, fixture.savedDrafts);
    await restored.registry.pendingSessions.refreshSavedDrafts();
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

  it("provides Discussion Stores for staged parents before materialization", () => {
    const fixture = registryFixture(undefined, "staged");
    const staged = fixture.registry.pendingSessions.prepareStaged("/project", "staged");
    const reviews = mount(
      createStore(ReviewsStore, {
        sessionRegistry: fixture.registry,
        discussionSessionModel: (sessionId, workingDirectory) =>
          fixture.models.discussionConversation(sessionId, workingDirectory),
        operations: fixture.operations,
        modelPresets: () => [],
        openModelPresetSettings: () => undefined,
      }),
    );
    applyDiscussionCatalogUpdate(staged.props.discussionCatalog, "staged", {
      _tag: "Snapshot",
      revision: 1,
      parentSessionId: "staged",
      threads: [
        {
          id: "assistant-thread",
          parentSessionId: "staged",
          sidecarSessionId: "sidecar",
          workingDirectory: "/project",
          status: "open",
          parts: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          anchor: {
            path: sessionAssistantThreadPath("staged"),
            view: "session",
            start: { diffLine: 0 },
            end: { diffLine: 0 },
            selectedText: "",
            contextBefore: "",
            contextAfter: "",
            diff: "",
          },
        },
      ],
    });

    expect(fixture.registry.observationRetention.sessions).toEqual([]);
    expect(fixture.registry.discussionSessionDemand).toEqual([staged]);
    expect(reviews.discussionSession("assistant-thread")).toBeDefined();

    reviews[Symbol.dispose]();
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
    session.showPresentation("vscode");
    session.toggleWorkspaceChatSidebar();
    session.setWorkspaceChatSidebarWidth(512);
    expect(session.presentationMode).toBe("vscode");
    expect(session.workspaceChatSidebarVisible).toBe(false);
    expect(session.workspaceChatSidebarWidth).toBe(512);
    expect(otherSession.presentationMode).toBe("normal");
    expect(otherSession.workspaceChatSidebarVisible).toBe(true);
    expect(otherSession.workspaceChatSidebarWidth).toBe(420);

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

  it("projects a main-created family child with family-safe continuation capabilities", () => {
    const fixture = registryFixture();
    const parent = fixture.registry.load("parent", "/project");
    parent.model.commands = piBuiltinSlashCommands;
    const child = fixture.registry.loadUnlistedFamilySession("child", "/project", "Child task", {
      familyId: "family",
      parentSessionId: "parent",
      childOrder: 1,
      depth: 1,
    });
    child.model.commands = piBuiltinSlashCommands;

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
      parent.conversationSessionStore.chatStore.commands.map((command) => command.name),
    ).toEqual(["compact", "model", "name", "sidechat", "schedule", "toolcompact"]);
    expect(
      child.conversationSessionStore.chatStore.commands.map((command) => command.name),
    ).toEqual(["compact", "model", "name", "sidechat", "schedule", "toolcompact"]);
    expect(
      fixture.registry.observationRetention.sessions.map((session) => session.sessionId),
    ).toEqual(["parent", "child"]);

    fixture.dispose();
  });

  it("opens a new family child without quadratic catalog scans across restored identities", () => {
    const fixture = registryFixture({
      state: {
        targets: Array.from({ length: 100 }, (_, index) => ({
          sessionId: `session-${index}`,
          workspacePath: "/project",
        })),
      },
      children: {},
    });
    const { registry, models } = fixture;
    const parent = registry.findSession("session-0")!;
    const other = registry.findSession("session-99")!;
    const scans = [
      vi.spyOn(models.discussionCatalogs, "find"),
      vi.spyOn(models.subagentCatalogs, "find"),
      vi.spyOn(models.scheduledMessageCatalogs, "find"),
    ];
    const child = registry.loadUnlistedFamilySession("child", "/project", "Child task", {
      familyId: "family",
      parentSessionId: parent.sessionId,
      childOrder: 1,
      depth: 1,
    });

    expect(registry.findSession(parent.sessionId)).toBe(parent);
    expect(registry.findSession(other.sessionId)).toBe(other);
    expect(registry.findSession("child")).toBe(child);
    expect(registry.discussionSessionDemand).toEqual([child]);
    expect(child.model).toBe(models.findProjectConversation("child"));
    expect(child.props.discussionCatalog).toBe(models.discussionCatalog("child"));
    expect(child.props.subagentCatalog).toBe(models.subagentCatalog("child"));
    expect(child.props.scheduledMessageCatalog).toBe(models.scheduledMessageCatalog("child"));
    expect(fixture.catalog.find("child")).toMatchObject({
      familyParentSessionId: parent.sessionId,
      familyId: "family",
      title: "Child task",
    });
    for (const scan of scans) expect(scan).not.toHaveBeenCalled();

    // Ordinary payload changes keep the same catalog and Store identities.
    const sessionsGetter = vi.spyOn(registry, "sessions", "get");
    child.model.streaming = true;
    applyDiscussionCatalogUpdate(child.props.discussionCatalog, "child", {
      _tag: "Snapshot",
      revision: 1,
      parentSessionId: "child",
      threads: [],
    });
    expect(sessionsGetter).not.toHaveBeenCalled();
    expect(registry.findSession("child")).toBe(child);
    expect(child.activity).toBe("running");
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

  it("deletes a resolved saved Draft through the Saved Draft authority", async () => {
    const fixture = registryFixture();
    const { registry, savedDrafts } = fixture;
    registry.pendingSessions.prepare("/project", "draft-1");
    await registry.pendingSessions.createDraft("draft-1", "Planned work", []);

    // An unresolved saved Draft is not deletable through this path.
    await expect(registry.pendingSessions.deleteResolvedDraft("draft-1")).resolves.toBe(false);
    expect(savedDrafts.records.has("draft-1")).toBe(true);

    await registry.pendingSessions.updateSavedMetadata("draft-1", { resolved: true });
    await expect(registry.pendingSessions.deleteResolvedDraft("draft-1")).resolves.toBe(true);

    expect(savedDrafts.records.has("draft-1")).toBe(false);
    expect(registry.pendingSessions.isDraft("draft-1")).toBe(false);
    expect(registry.findSession("draft-1")).toBeUndefined();
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
      "session-1",
    );

    expect(
      fixture.registry.observationRetention.sessions.map((session) => session.sessionId),
    ).toEqual(["session-1"]);

    fixture.dispose();
  });

  it("retains four idle observations without evicting a running session", () => {
    const fixture = registryFixture();
    const { registry } = fixture;
    const running = registry.load("running", "/project");
    running.model.streaming = true;

    for (let index = 0; index < 5; index += 1) registry.load(`idle-${index}`, "/project");

    expect(registry.observationRetention.sessions).toHaveLength(5);
    expect(registry.observationRetention.sessions).toContain(running);
    expect(
      registry.observationRetention.sessions.map((session) => session.sessionId),
    ).not.toContain("idle-0");

    running.model.streaming = false;
    expect(registry.observationRetention.sessions).toHaveLength(4);
    expect(registry.observationRetention.sessions).toContain(running);
    expect(
      registry.observationRetention.sessions.map((session) => session.sessionId),
    ).not.toContain("idle-1");

    fixture.dispose();
  });
});
