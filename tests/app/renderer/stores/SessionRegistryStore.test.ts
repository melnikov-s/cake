import { applySnapshot, createStore, mount, type StoreSnapshot } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import { SessionCatalog } from "../../../../src/renderer/models/SessionCatalog";
import { SessionSummary } from "../../../../src/renderer/models/SessionSummary";
import { RendererModels } from "../../../../src/renderer/RendererModels";
import { SessionCatalogStore } from "../../../../src/renderer/stores/SessionCatalogStore";
import { SessionOperationCoordinatorStore } from "../../../../src/renderer/stores/SessionOperationCoordinatorStore";
import { SessionRegistryStore } from "../../../../src/renderer/stores/SessionRegistryStore";

function registryFixture(
  snapshot?: StoreSnapshot,
  isActive: (sessionId: string) => boolean = () => false,
) {
  const catalogModel = SessionCatalog.create({ sessions: [] });
  const registryRef: { current?: SessionRegistryStore } = {};
  const catalog = mount(
    createStore(SessionCatalogStore, {
      model: catalogModel,
      pendingSessions: () => registryRef.current?.pendingSummaries ?? [],
    }),
  );
  const operations = mount(createStore(SessionOperationCoordinatorStore));
  const models = new RendererModels();
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
      openCommandPane: async () => undefined,
      persistNow: async () => undefined,
      projectName: (workingDirectory) => workingDirectory,
      abort: async () => undefined,
      renameSession: async () => undefined,
      handoffSession: async () => false,
      onWorktreeLanded: () => undefined,
      onWorktreeDiscarded: () => undefined,
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
  it("retains independent staged chats for multiple panes", () => {
    const fixture = registryFixture();
    const first = fixture.registry.prepareStagedSession("/project", "staged-1");
    const second = fixture.registry.prepareStagedSession("/project", "staged-2");

    expect(first).not.toBe(second);
    expect(fixture.registry.isStagedSession("staged-1")).toBe(true);
    expect(fixture.registry.isStagedSession("staged-2")).toBe(true);

    fixture.registry.removeSession("staged-1");
    expect(fixture.registry.isStagedSession("staged-1")).toBe(false);
    expect(fixture.registry.isStagedSession("staged-2")).toBe(true);

    fixture.dispose();
  });

  it("keeps a relocated composer unmaterialized until its Pi Session has started", () => {
    const fixture = registryFixture();
    const { registry } = fixture;

    const stagedSession = registry.prepareNewSession("/project", "session-1");
    registry.relocateTemporarySession("session-1", "/worktree");

    expect(registry.observationSessions).toEqual([]);
    expect(registry.findSession("session-1")).toBe(stagedSession);
    expect(stagedSession.workspacePath).toBe("/worktree");

    const invalidate = vi.spyOn(
      registry.findSession("session-1")!.stagedCommandStore,
      "invalidate",
    );
    const materializedSession = registry.materializeNewSession("session-1", "/worktree");

    expect(materializedSession).toBe(stagedSession);
    expect(invalidate).toHaveBeenCalledOnce();
    expect(registry.isTemporarySession("session-1")).toBe(false);
    expect(registry.observationSessions).toHaveLength(1);
    expect(registry.observationSessions[0]?.workspacePath).toBe("/worktree");
    expect(fixture.catalog.find("session-1")?.workingDirectory).toBe("/worktree");

    const session = registry.observationSessions[0]!;
    const otherSession = registry.prepareNewSession("/project", "session-2");
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
    session.model.streaming = false;
    session.model.settledTurnRevision += 1;
    expect(session.activity).toBe("unread");
    session.markRead();
    expect(session.activity).toBeUndefined();

    fixture.dispose();
  });

  it("clears the pending summary when authority arrives after materialization", () => {
    const fixture = registryFixture();
    const { catalogModel, registry } = fixture;
    registry.prepareNewSession("/project", "session-1");
    registry.projectNewSessionSubmission("session-1", "Newest session");
    registry.materializeNewSession("session-1", "/project");
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
    registry.prepareNewSession("/project", "session-1");
    registry.projectNewSessionSubmission("session-1", "Newest session");
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

    registry.materializeNewSession("session-1", "/project");
    applySnapshot(catalogModel, { sessions: [] });

    expect(fixture.catalog.sessions).toEqual([]);
    fixture.dispose();
  });

  it("deletes a resolved draft from renderer-owned state", async () => {
    const fixture = registryFixture();
    const { registry } = fixture;
    registry.prepareNewSession("/project", "draft-1");
    await registry.createDraftSession("draft-1", "Planned work", []);
    registry.setDraftSessionResolved("draft-1", true);

    await expect(registry.deleteResolvedDraftSession("draft-1")).resolves.toBe(true);

    expect(registry.isDraftSession("draft-1")).toBe(false);
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
        materializedSessionIds: ["session-1", "session-2"],
      },
      children: {},
    });

    expect(fixture.registry.observationSessions).toEqual([]);

    fixture.registry.retainObservation("session-2");
    expect(fixture.registry.observationSessions.map((session) => session.sessionId)).toEqual([
      "session-2",
    ]);

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

    expect(fixture.registry.observationSessions.map((session) => session.sessionId)).toEqual([
      "resolved-session",
    ]);

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
          materializedSessionIds: ["session-1", "session-2"],
        },
        children: {},
      },
      (sessionId) => sessionId === "session-1",
    );

    expect(fixture.registry.observationSessions.map((session) => session.sessionId)).toEqual([
      "session-1",
    ]);

    fixture.dispose();
  });

  it("retains 20 idle observations without evicting a running session", () => {
    const fixture = registryFixture();
    const { registry } = fixture;
    const running = registry.load("running", "/project");
    running.model.streaming = true;

    for (let index = 0; index < 21; index += 1) registry.load(`idle-${index}`, "/project");

    expect(registry.observationSessions).toHaveLength(21);
    expect(registry.observationSessions).toContain(running);
    expect(registry.observationSessions.map((session) => session.sessionId)).not.toContain(
      "idle-0",
    );

    running.model.streaming = false;
    expect(registry.observationSessions).toHaveLength(20);
    expect(registry.observationSessions).toContain(running);
    expect(registry.observationSessions.map((session) => session.sessionId)).not.toContain(
      "idle-1",
    );

    fixture.dispose();
  });
});
