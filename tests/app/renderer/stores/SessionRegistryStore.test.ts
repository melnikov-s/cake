import { createStore, mount } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import { SessionCatalog } from "../../../../src/renderer/models/SessionCatalog";
import { SessionCatalogStore } from "../../../../src/renderer/stores/SessionCatalogStore";
import { SessionOperationCoordinatorStore } from "../../../../src/renderer/stores/SessionOperationCoordinatorStore";
import { SessionRegistryStore } from "../../../../src/renderer/stores/SessionRegistryStore";
import { RendererModels } from "../../../../src/renderer/RendererModels";

describe("SessionRegistryStore materialization", () => {
  it("keeps a relocated composer unmaterialized until its Pi Session has started", () => {
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
        isActive: () => false,
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
    );
    registryRef.current = registry;

    const stagedSession = registry.prepareNewSession("/project", "session-1");
    registry.relocateTemporarySession("session-1", "/worktree");

    expect(registry.materializedSessions).toEqual([]);
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
    expect(registry.materializedSessions).toHaveLength(1);
    expect(registry.materializedSessions[0]?.workspacePath).toBe("/worktree");
    expect(catalog.find("session-1")?.workingDirectory).toBe("/worktree");

    const session = registry.materializedSessions[0]!;
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

    registry[Symbol.dispose]();
    operations[Symbol.dispose]();
    catalog[Symbol.dispose]();
    catalogModel[Symbol.dispose]();
    models[Symbol.dispose]();
  });
});
