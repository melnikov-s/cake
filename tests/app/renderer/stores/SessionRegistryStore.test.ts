import { createStore, mount } from "r-state-tree";
import { describe, expect, it } from "vitest";
import { SessionCatalog } from "../../../../src/renderer/models/SessionCatalog";
import { SessionCatalogStore } from "../../../../src/renderer/stores/SessionCatalogStore";
import { SessionOperationCoordinatorStore } from "../../../../src/renderer/stores/SessionOperationCoordinatorStore";
import { SessionRegistryStore } from "../../../../src/renderer/stores/SessionRegistryStore";

describe("SessionRegistryStore materialization", () => {
  it("keeps a relocated composer unmaterialized until its Pi Session has started", () => {
    const catalogModel = SessionCatalog.create({ sessions: [] });
    const catalog = mount(createStore(SessionCatalogStore, { model: catalogModel }));
    const operations = mount(createStore(SessionOperationCoordinatorStore));
    const registry = mount(
      createStore(SessionRegistryStore, {
        catalog,
        operations,
        reviews: () => {
          throw new Error("ReviewsStore is not used by this test");
        },
        pluginCommands: () => {
          throw new Error("PluginCommandStore is not used by this test");
        },
        canSubmit: () => true,
        isActive: () => true,
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

    registry.prepareNewSession("/project", "session-1");
    registry.relocateTemporarySession("session-1", "/worktree");

    expect(registry.materializedSessions).toEqual([]);
    expect(registry.findSession("session-1")?.workspacePath).toBe("/worktree");

    registry.materializeNewSession("session-1", "/worktree");

    expect(registry.isTemporarySession("session-1")).toBe(false);
    expect(registry.materializedSessions).toHaveLength(1);
    expect(registry.materializedSessions[0]?.workspacePath).toBe("/worktree");
    expect(catalog.find("session-1")?.workingDirectory).toBe("/worktree");

    registry[Symbol.dispose]();
    operations[Symbol.dispose]();
    catalog[Symbol.dispose]();
    catalogModel[Symbol.dispose]();
  });
});
