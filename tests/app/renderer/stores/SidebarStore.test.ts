import { describe, expect, it, vi } from "vitest";
import { projectRecord, sessionSummary } from "../fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "../renderer-store-fixture";

// Sidebar UI workflows live in sidebar-navigation-workflow.test.tsx; Draft menu identity
// is covered by session-management-workflow. Keep only contracts those journeys cannot prove.
describe("Sidebar uncovered boundary regressions", () => {
  // Invalid project identities cannot be selected through production sidebar controls.
  it("ignores Project focus requests for missing catalog identities", () => {
    using fixture = createRendererStoreFixture({ projects: [projectRecord({ path: "/cake" })] });
    fixture.root.sidebarStore.focusProject("/missing");
    expect(fixture.root.sidebarStore.focusModeProjectPath).toBeUndefined();
  });

  // Sparse activity lookup is an observation/performance contract, not visible row content.
  it("tracks active lanes without querying every catalog session's activity", () => {
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: "/cake" })],
      sessions: Array.from({ length: 100 }, (_, index) =>
        sessionSummary({
          sessionId: `session-${index}`,
          projectPath: "/cake",
          modifiedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
        }),
      ),
    });
    fixture.root.sessionRegistry.load("session-50", "/cake").model.streaming = true;
    const findSession = vi.spyOn(fixture.root.sessionRegistry, "findSession");
    expect(fixture.root.sidebarStore.sessionListStore.projectSessions("/cake")).toHaveLength(100);
    expect(findSession.mock.calls.every(([sessionId]) => sessionId === "session-50")).toBe(true);
  });

  // Native IDE entry/exit and viewport geometry are not honestly verified by jsdom navigation.
  it("treats IDE sidebar visibility as a temporary override", () => {
    using fixture = createRendererStoreFixture();
    fixture.root.settingsStore.embeddedEditor.sidebarAutoHide = "always";
    const store = fixture.root.sidebarStore;
    expect(store.visible).toBe(true);
    store.enterIdeMode(1920);
    expect(store.visible).toBe(false);
    store.toggle();
    expect(store.visible).toBe(true);
    store.toggle();
    expect(store.visible).toBe(false);
    store.leaveIdeMode();
    expect(store.visible).toBe(true);
    store.toggle();
    store.enterIdeMode(1920);
    store.toggle();
    expect(store.visible).toBe(true);
    store.leaveIdeMode();
    expect(store.visible).toBe(false);
  });

  it("auto-hides below the configured window width", () => {
    using fixture = createRendererStoreFixture();
    const settings = fixture.root.settingsStore.embeddedEditor;
    settings.sidebarAutoHide = "below-width";
    settings.sidebarAutoHideWidth = 1440;
    const store = fixture.root.sidebarStore;
    store.enterIdeMode(1280);
    expect(store.visible).toBe(false);
    store.updateIdeViewportWidth(1728);
    expect(store.visible).toBe(true);
  });

  // Root UI fixtures do not attach catalog observation transport, and the permanent
  // Cake Chat surface has no archived-group controls to exercise its lazy demand.
  it("keeps Project archives loaded while Cake Chat archive demand remains lazy", () => {
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: "/cake" }), projectRecord({ path: "/pi" })],
    });
    const list = fixture.root.sidebarStore.sessionListStore;
    const queries = [
      { projectPath: "/cake", resolved: false },
      { projectPath: "/cake", resolved: true },
      { projectPath: "/pi", resolved: false },
      { projectPath: "/pi", resolved: true },
    ];
    expect(list.projectSessionCatalogQueries).toEqual(queries);
    expect(list.cakeChatCatalogQueries).toEqual([{ resolved: false }]);
    list.toggleActiveGroupExpanded("/cake");
    list.toggleResolvedLane();
    list.toggleResolvedGroupExpanded("/cake");
    expect(list.isActiveGroupExpanded("/cake")).toBe(false);
    expect(list.projectSessionCatalogQueries).toEqual(queries);
    expect(list.cakeChatCatalogQueries).toEqual([{ resolved: false }]);
    list.toggleResolvedGroupExpanded("cake-chat");
    expect(list.cakeChatCatalogQueries).toEqual([
      { resolved: false },
      { resolved: true, limit: 10 },
    ]);
    list.showMoreSessions("/cake", true);
    list.showMoreSessions("cake-chat", true);
    expect(list.projectSessionCatalogQueries).toEqual(queries);
    expect(list.cakeChatCatalogQueries).toContainEqual({ resolved: true, limit: 20 });
    list.toggleResolvedGroupExpanded("/cake");
    list.toggleResolvedGroupExpanded("cake-chat");
    list.toggleResolvedLane();
    expect(list.isResolvedGroupExpanded("/cake")).toBe(false);
    expect(list.cakeChatCatalogQueries).toEqual([
      { resolved: false },
      { resolved: true, limit: 20 },
    ]);
  });
});
