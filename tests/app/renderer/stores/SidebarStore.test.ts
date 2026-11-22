import { describe, expect, it, vi } from "vitest";
import { projectRecord } from "../fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "../renderer-store-fixture";

const active = [
  { projectPath: "/cake", resolved: false },
  { projectPath: "/pi", resolved: false },
];
const archive = (projectPath: string, limit = 10) => ({ projectPath, resolved: true, limit });

describe("Sidebar catalog demand", () => {
  it.each([undefined, "/pi"])(
    "observes the same project lanes regardless of focused project (%s)",
    (projectPath) => {
      using fixture = createRendererStoreFixture({
        projects: [projectRecord({ path: "/cake" }), projectRecord({ path: "/pi" })],
      });
      const navigator = fixture.root.workspaceNavigatorStore;
      vi.spyOn(navigator, "projectPath", "get").mockReturnValue(projectPath);
      navigator.show("sessions");
      const list = fixture.root.sidebarStore.sessionListStore;
      expect(list.projectSessionCatalogQueries).toEqual(active);
      expect(list.cakeChatCatalogQueries).toEqual([{ resolved: false }]);
      list.toggleResolvedGroupExpanded();
      expect(list.projectSessionCatalogQueries).toEqual([
        active[0],
        archive("/cake"),
        active[1],
        archive("/pi"),
      ]);
      list.showMoreSessions("/cake", true);
      expect(list.projectSessionCatalogQueries).toContainEqual(archive("/cake", 20));
      list.toggleResolvedGroupExpanded();
      expect(list.projectSessionCatalogQueries).toEqual(active);
      expect(list.cakeChatCatalogQueries).toContainEqual({ resolved: true, limit: 10 });
    },
  );

  it("keeps visible archives observed under Search sessions, then releases them when the pane closes", () => {
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: "/cake" }), projectRecord({ path: "/pi" })],
    });
    const navigator = fixture.root.workspaceNavigatorStore;
    navigator.show("sessions");
    const list = fixture.root.sidebarStore.sessionListStore;
    list.toggleResolvedGroupExpanded();
    fixture.root.sidebarStore.sessionSearchStore.show();
    expect(list.projectSessionCatalogQueries).toEqual([
      active[0],
      archive("/cake"),
      active[1],
      archive("/pi"),
    ]);
    navigator.close();
    expect(list.projectSessionCatalogQueries).toEqual(active);
  });
});
