import { createStore, mount } from "r-state-tree";
import { describe, expect, it } from "vitest";
import type { ProjectCatalogStore } from "../../../../src/renderer/stores/ProjectCatalogStore";
import type { SessionCatalogStore } from "../../../../src/renderer/stores/SessionCatalogStore";
import type { SessionRegistryStore } from "../../../../src/renderer/stores/SessionRegistryStore";
import type { GlobalChatStore } from "../../../../src/renderer/stores/GlobalChatStore";
import { SidebarStore } from "../../../../src/renderer/stores/SidebarStore";

describe("SidebarStore catalog demand", () => {
  it("loads resolved catalogs on first expansion and retains them for the window lifetime", () => {
    const store = mount(
      createStore(SidebarStore, {
        projects: {
          orderedProjectPaths: ["/cake", "/pi"],
        } as ProjectCatalogStore,
        catalog: {} as SessionCatalogStore,
        sessions: {} as SessionRegistryStore,
        cakeChat: () => ({}) as GlobalChatStore,
        setSessionResolved: async () => undefined,
        setCakeChatSessionResolved: async () => undefined,
        deleteSession: async () => undefined,
        deleteCakeChatSession: async () => undefined,
        setSessionUnread: async () => undefined,
      }),
    );

    expect(store.projectSessionCatalogQueries).toEqual([
      { projectPath: "/cake", resolved: false },
      { projectPath: "/pi", resolved: false },
    ]);
    expect(store.cakeChatCatalogQueries).toEqual([{ resolved: false }]);

    store.toggleActiveGroupExpanded("/cake");
    expect(store.isActiveGroupExpanded("/cake")).toBe(false);
    expect(store.projectSessionCatalogQueries).toEqual([
      { projectPath: "/cake", resolved: false },
      { projectPath: "/pi", resolved: false },
    ]);

    store.toggleResolvedLane();
    store.toggleResolvedGroupExpanded("/cake");

    expect(store.projectSessionCatalogQueries).toEqual([
      { projectPath: "/cake", resolved: false },
      { projectPath: "/cake", resolved: true },
      { projectPath: "/pi", resolved: false },
    ]);
    expect(store.cakeChatCatalogQueries).toEqual([{ resolved: false }]);

    store.toggleResolvedGroupExpanded("cake-chat");
    expect(store.cakeChatCatalogQueries).toEqual([{ resolved: false }, { resolved: true }]);

    store.toggleResolvedGroupExpanded("/cake");
    store.toggleResolvedGroupExpanded("cake-chat");
    store.toggleResolvedLane();
    expect(store.isResolvedGroupExpanded("/cake")).toBe(false);
    expect(store.projectSessionCatalogQueries).toEqual([
      { projectPath: "/cake", resolved: false },
      { projectPath: "/cake", resolved: true },
      { projectPath: "/pi", resolved: false },
    ]);
    expect(store.cakeChatCatalogQueries).toEqual([{ resolved: false }, { resolved: true }]);

    store[Symbol.dispose]();
  });
});
