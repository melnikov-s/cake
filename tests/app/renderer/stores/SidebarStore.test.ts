import { createStore, mount } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { ProjectCatalogStore } from "../../../../src/renderer/stores/ProjectCatalogStore";
import type { SessionCatalogStore } from "../../../../src/renderer/stores/SessionCatalogStore";
import type { SessionRegistryStore } from "../../../../src/renderer/stores/SessionRegistryStore";
import type { CakeChatCollectionStore } from "../../../../src/renderer/stores/CakeChatCollectionStore";
import { SidebarStore } from "../../../../src/renderer/stores/SidebarStore";
import type { EmbeddedEditorSettingsStore } from "../../../../src/renderer/stores/EmbeddedEditorSettingsStore";
import type { RendererClient } from "../../../../src/renderer/client/RendererClient";
import { mountWithRendererClient } from "../mount-with-renderer-client";

const embeddedEditorSettings = (sidebarAutoHide: "never" | "always" | "below-width" = "never") =>
  ({ sidebarAutoHide, sidebarAutoHideWidth: 1440 }) as EmbeddedEditorSettingsStore;

describe("SidebarStore catalog demand", () => {
  it("provides custom workflow statuses and the current status to the native menu", async () => {
    const status = {
      id: "b925b5dd-9661-4f1a-9f40-406be3c96c27",
      name: "In review",
      color: "violet" as const,
    };
    const showSessionContextMenu = vi.fn(async () => undefined);
    const { root, subject } = mountWithRendererClient(
      createStore(SidebarStore, {
        projects: {
          orderedProjectPaths: ["/cake"],
          find: () => ({
            workflow: {
              columns: [status],
              assignments: [{ sessionId: "session-1", statusId: status.id }],
            },
          }),
        } as unknown as ProjectCatalogStore,
        catalog: {
          find: () => ({
            sessionId: "session-1",
            projectPath: "/cake",
            draft: false,
          }),
        } as unknown as SessionCatalogStore,
        sessions: {} as SessionRegistryStore,
        cakeChat: () => ({}) as CakeChatCollectionStore,
        setSessionResolved: async () => undefined,
        setSessionWorkflowStatus: async () => undefined,
        setCakeChatSessionResolved: async () => undefined,
        deleteSession: async () => undefined,
        deleteCakeChatSession: async () => undefined,
        setSessionUnread: async () => undefined,
        embeddedEditorSettings: embeddedEditorSettings(),
      }),
      { electron: { showSessionContextMenu } } as unknown as RendererClient,
    );

    try {
      await subject.showSessionContextMenu("session-1", 12, 34, false, false);
      expect(showSessionContextMenu).toHaveBeenCalledWith({
        sessionId: "session-1",
        x: 12,
        y: 34,
        resolved: false,
        draft: false,
        unread: false,
        familyChild: undefined,
        workflow: {
          currentStatus: status.id,
          statuses: [status],
        },
      });
    } finally {
      root[Symbol.dispose]();
    }
  });

  it("reveals sessions ten at a time independently for each group and lane", () => {
    const store = mount(
      createStore(SidebarStore, {
        projects: { orderedProjectPaths: [] } as unknown as ProjectCatalogStore,
        catalog: {} as SessionCatalogStore,
        sessions: {} as SessionRegistryStore,
        cakeChat: () => ({}) as CakeChatCollectionStore,
        setSessionResolved: async () => undefined,
        setSessionWorkflowStatus: async () => undefined,
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
        setSessionWorkflowStatus: async () => undefined,
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
        setSessionWorkflowStatus: async () => undefined,
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

  it("keeps Project resolved metadata loaded while Cake Chat archives remain lazy", () => {
    const store = mount(
      createStore(SidebarStore, {
        projects: {
          orderedProjectPaths: ["/cake", "/pi"],
        } as ProjectCatalogStore,
        catalog: {} as SessionCatalogStore,
        sessions: {} as SessionRegistryStore,
        cakeChat: () => ({}) as CakeChatCollectionStore,
        setSessionResolved: async () => undefined,
        setSessionWorkflowStatus: async () => undefined,
        setCakeChatSessionResolved: async () => undefined,
        deleteSession: async () => undefined,
        deleteCakeChatSession: async () => undefined,
        setSessionUnread: async () => undefined,
        embeddedEditorSettings: embeddedEditorSettings(),
      }),
    );

    const projectQueries = [
      { projectPath: "/cake", resolved: false },
      { projectPath: "/cake", resolved: true },
      { projectPath: "/pi", resolved: false },
      { projectPath: "/pi", resolved: true },
    ];
    expect(store.projectSessionCatalogQueries).toEqual(projectQueries);
    expect(store.cakeChatCatalogQueries).toEqual([{ resolved: false }]);

    store.toggleActiveGroupExpanded("/cake");
    store.toggleResolvedLane();
    store.toggleResolvedGroupExpanded("/cake");
    expect(store.isActiveGroupExpanded("/cake")).toBe(false);
    expect(store.projectSessionCatalogQueries).toEqual(projectQueries);
    expect(store.cakeChatCatalogQueries).toEqual([{ resolved: false }]);

    store.toggleResolvedGroupExpanded("cake-chat");
    expect(store.cakeChatCatalogQueries).toEqual([
      { resolved: false },
      { resolved: true, limit: 10 },
    ]);

    store.showMoreSessions("/cake", true);
    store.showMoreSessions("cake-chat", true);
    expect(store.projectSessionCatalogQueries).toEqual(projectQueries);
    expect(store.cakeChatCatalogQueries).toContainEqual({ resolved: true, limit: 20 });

    store.toggleResolvedGroupExpanded("/cake");
    store.toggleResolvedGroupExpanded("cake-chat");
    store.toggleResolvedLane();
    expect(store.isResolvedGroupExpanded("/cake")).toBe(false);
    expect(store.projectSessionCatalogQueries).toEqual(projectQueries);
    expect(store.cakeChatCatalogQueries).toEqual([
      { resolved: false },
      { resolved: true, limit: 20 },
    ]);

    store[Symbol.dispose]();
  });
});
