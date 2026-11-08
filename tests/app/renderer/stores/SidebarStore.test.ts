import { describe, expect, it } from "vitest";
import { projectRecord } from "../fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "../renderer-store-fixture";

// Sidebar UI workflows live in sidebar-navigation-workflow.test.tsx.
describe("Sidebar catalog demand", () => {
  it("subscribes only expanded Project archives and increases their page demand", () => {
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: "/cake" }), projectRecord({ path: "/pi" })],
    });
    const list = fixture.root.sidebarStore.sessionListStore;
    const active = [
      { projectPath: "/cake", resolved: false },
      { projectPath: "/pi", resolved: false },
    ];
    expect(list.projectSessionCatalogQueries).toEqual(active);
    expect(list.cakeChatCatalogQueries).toEqual([{ resolved: false }]);
    list.toggleActiveGroupExpanded("/cake");
    expect(list.projectSessionCatalogQueries).toEqual(active);
    list.toggleResolvedGroupExpanded("/cake");
    expect(list.projectSessionCatalogQueries).toEqual([
      active[0],
      { projectPath: "/cake", resolved: true, limit: 10 },
      active[1],
    ]);
    list.showMoreSessions("/cake", true);
    expect(list.projectSessionCatalogQueries).toContainEqual({
      projectPath: "/cake",
      resolved: true,
      limit: 20,
    });
    list.toggleResolvedGroupExpanded("/cake");
    expect(list.projectSessionCatalogQueries).toEqual(active);
    list.toggleResolvedGroupExpanded("/cake");
    expect(list.projectSessionCatalogQueries).toContainEqual({
      projectPath: "/cake",
      resolved: true,
      limit: 20,
    });

    list.toggleResolvedGroupExpanded("cake-chat");
    list.showMoreSessions("cake-chat", true);
    expect(list.cakeChatCatalogQueries).toContainEqual({ resolved: true, limit: 20 });
    list.toggleResolvedGroupExpanded("cake-chat");
    expect(list.cakeChatCatalogQueries).toContainEqual({ resolved: true, limit: 20 });
  });
});
