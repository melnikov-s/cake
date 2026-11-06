import { describe, expect, it } from "vitest";
import { projectRecord } from "../fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "../renderer-store-fixture";

// Sidebar UI workflows live in sidebar-navigation-workflow.test.tsx; Draft menu identity
// is covered by session-management-workflow. Keep only contracts those journeys cannot prove.
describe("Sidebar uncovered boundary regressions", () => {
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
