import { createStore, mount } from "r-state-tree";
import { describe, expect, it } from "vitest";
import type { ProjectCatalog } from "../../../../src/renderer/models/ProjectCatalog";
import type { SessionCatalogStore } from "../../../../src/renderer/stores/SessionCatalogStore";
import { ProjectCatalogStore } from "../../../../src/renderer/stores/ProjectCatalogStore";

function createProjectCatalogStore() {
  return mount(
    createStore(ProjectCatalogStore, {
      sessions: {} as SessionCatalogStore,
      model: {
        projects: [
          { path: "/first", name: "First" },
          { path: "/second", name: "Second" },
          { path: "/third", name: "Third" },
        ],
        find(path: string) {
          return this.projects.find((project) => project.path === path);
        },
      } as ProjectCatalog,
    }),
  );
}

describe("ProjectCatalogStore", () => {
  it("keeps a stable registration order instead of sorting by session activity", () => {
    const store = createProjectCatalogStore();
    store.projectOrder.push("/first", "/second");
    expect(store.orderedProjectPaths).toEqual(["/first", "/second", "/third"]);
  });

  it("persists an explicit drag order", () => {
    const store = createProjectCatalogStore();
    store.projectOrder.push("/first", "/second", "/third");
    store.move("/third", "/first", "before");
    expect(store.projectOrder).toEqual(["/third", "/first", "/second"]);
  });
});
