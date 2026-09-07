import { createStore, mount } from "r-state-tree";
import { describe, expect, it } from "vitest";
import type { ProjectCatalogStore } from "../../../../src/renderer/stores/ProjectCatalogStore";
import type { SessionCatalogStore } from "../../../../src/renderer/stores/SessionCatalogStore";
import type { SessionRegistryStore } from "../../../../src/renderer/stores/SessionRegistryStore";
import type { CakeChatCollectionStore } from "../../../../src/renderer/stores/CakeChatCollectionStore";
import { SidebarStore } from "../../../../src/renderer/stores/SidebarStore";
import type { EmbeddedEditorSettingsStore } from "../../../../src/renderer/stores/EmbeddedEditorSettingsStore";

const embeddedEditorSettings = (sidebarAutoHide: "never" | "always" | "below-width" = "never") =>
  ({ sidebarAutoHide, sidebarAutoHideWidth: 1440 }) as EmbeddedEditorSettingsStore;

describe("SidebarStore catalog demand", () => {
  it("reveals sessions ten at a time independently for each group and lane", () => {
    const store = mount(
      createStore(SidebarStore, {
        projects: { orderedProjectPaths: [] } as unknown as ProjectCatalogStore,
        catalog: {} as SessionCatalogStore,
        sessions: {} as SessionRegistryStore,
        cakeChat: () => ({}) as CakeChatCollectionStore,
        setSessionResolved: async () => undefined,
        setCakeChatSessionResolved: async () => undefined,
        deleteSession: async () => undefined,
        deleteCakeChatSession: async () => undefined,
        setSessionUnread: async () => undefined,
        embeddedEditorSettings: embeddedEditorSettings(),
      }),
    );

    expect(store.sessionLimit("/cake")).toBe(10);
    store.showMoreSessions("/cake");
    expect(store.sessionLimit("/cake")).toBe(20);
    expect(store.sessionLimit("/pi")).toBe(10);
    expect(store.sessionLimit("/cake", true)).toBe(10);

    store.showMoreSessions("/cake", true);
    expect(store.sessionLimit("/cake", true)).toBe(20);
    expect(store.sessionLimit("/cake")).toBe(20);
    store[Symbol.dispose]();
  });

  it("treats sidebar visibility inside VS Code as a temporary override", () => {
    const store = mount(
      createStore(SidebarStore, {
        projects: { orderedProjectPaths: [] } as unknown as ProjectCatalogStore,
        catalog: {} as SessionCatalogStore,
        sessions: {} as SessionRegistryStore,
        cakeChat: () => ({}) as CakeChatCollectionStore,
        setSessionResolved: async () => undefined,
        setCakeChatSessionResolved: async () => undefined,
        deleteSession: async () => undefined,
        deleteCakeChatSession: async () => undefined,
        setSessionUnread: async () => undefined,
        embeddedEditorSettings: embeddedEditorSettings("always"),
      }),
    );

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
    store[Symbol.dispose]();
  });

  it("auto-hides below the configured window width", () => {
    const store = mount(
      createStore(SidebarStore, {
        projects: { orderedProjectPaths: [] } as unknown as ProjectCatalogStore,
        catalog: {} as SessionCatalogStore,
        sessions: {} as SessionRegistryStore,
        cakeChat: () => ({}) as CakeChatCollectionStore,
        setSessionResolved: async () => undefined,
        setCakeChatSessionResolved: async () => undefined,
        deleteSession: async () => undefined,
        deleteCakeChatSession: async () => undefined,
        setSessionUnread: async () => undefined,
        embeddedEditorSettings: embeddedEditorSettings("below-width"),
      }),
    );

    store.enterIdeMode(1280);
    expect(store.visible).toBe(false);
    store.updateIdeViewportWidth(1728);
    expect(store.visible).toBe(true);
    store[Symbol.dispose]();
  });

  it("loads resolved catalogs on first expansion and retains them for the window lifetime", () => {
    const store = mount(
      createStore(SidebarStore, {
        projects: {
          orderedProjectPaths: ["/cake", "/pi"],
        } as ProjectCatalogStore,
        catalog: {} as SessionCatalogStore,
        sessions: {} as SessionRegistryStore,
        cakeChat: () => ({}) as CakeChatCollectionStore,
        setSessionResolved: async () => undefined,
        setCakeChatSessionResolved: async () => undefined,
        deleteSession: async () => undefined,
        deleteCakeChatSession: async () => undefined,
        setSessionUnread: async () => undefined,
        embeddedEditorSettings: embeddedEditorSettings(),
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
      { projectPath: "/cake", resolved: true, limit: 10 },
      { projectPath: "/pi", resolved: false },
    ]);
    expect(store.cakeChatCatalogQueries).toEqual([{ resolved: false }]);

    store.toggleResolvedGroupExpanded("cake-chat");
    expect(store.cakeChatCatalogQueries).toEqual([
      { resolved: false },
      { resolved: true, limit: 10 },
    ]);

    store.showMoreSessions("/cake", true);
    store.showMoreSessions("cake-chat", true);
    expect(store.projectSessionCatalogQueries).toContainEqual({
      projectPath: "/cake",
      resolved: true,
      limit: 20,
    });
    expect(store.cakeChatCatalogQueries).toContainEqual({ resolved: true, limit: 20 });

    store.toggleResolvedGroupExpanded("/cake");
    store.toggleResolvedGroupExpanded("cake-chat");
    store.toggleResolvedLane();
    expect(store.isResolvedGroupExpanded("/cake")).toBe(false);
    expect(store.projectSessionCatalogQueries).toEqual([
      { projectPath: "/cake", resolved: false },
      { projectPath: "/cake", resolved: true, limit: 20 },
      { projectPath: "/pi", resolved: false },
    ]);
    expect(store.cakeChatCatalogQueries).toEqual([
      { resolved: false },
      { resolved: true, limit: 20 },
    ]);

    store[Symbol.dispose]();
  });
});
