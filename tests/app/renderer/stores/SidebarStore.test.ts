import { createStore, mount, observable } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { ProjectCatalogStore } from "../../../../src/renderer/stores/ProjectCatalogStore";
import type { SessionCatalogStore } from "../../../../src/renderer/stores/SessionCatalogStore";
import type { SessionRegistryStore } from "../../../../src/renderer/stores/SessionRegistryStore";
import type { CakeChatCollectionStore } from "../../../../src/renderer/stores/CakeChatCollectionStore";
import { SidebarStore } from "../../../../src/renderer/stores/SidebarStore";
import type { EmbeddedEditorSettingsStore } from "../../../../src/renderer/stores/EmbeddedEditorSettingsStore";
import type { Client } from "../../../../src/renderer/client/Client";
import { mountWithClient } from "../mount-with-client";
import { WorktreeOperationCatalog } from "../../../../src/renderer/models/WorktreeOperationCatalog";

const embeddedEditorSettings = (sidebarAutoHide: "never" | "always" | "below-width" = "never") =>
  ({ sidebarAutoHide, sidebarAutoHideWidth: 1440 }) as EmbeddedEditorSettingsStore;

describe("SidebarStore catalog demand", () => {
  it("owns persistent project focus presentation state", () => {
    const store = mount(
      createStore(SidebarStore, {
        projects: {
          find: (path: string) => (path === "/cake" ? { path } : undefined),
        } as unknown as ProjectCatalogStore,
        catalog: {} as SessionCatalogStore,
        sessions: {} as SessionRegistryStore,
        cakeChat: () => ({ summaries: [] }) as unknown as CakeChatCollectionStore,
        setSessionResolved: async () => undefined,
        setSessionWorkflowStatus: async () => undefined,
        setCakeChatSessionResolved: async () => undefined,
        deleteSession: async () => undefined,
        deleteCakeChatSession: async () => undefined,
        setSessionUnread: async () => undefined,
        embeddedEditorSettings: embeddedEditorSettings(),
      }),
    );

    store.focusProject("/missing");
    expect(store.focusModeProjectPath).toBeUndefined();
    store.focusProject("/cake");
    expect(store.focusModeProjectPath).toBe("/cake");
    expect(store.isActiveGroupExpanded("/cake")).toBe(true);
    store.leaveProjectFocus();
    expect(store.focusModeProjectPath).toBeUndefined();
    store[Symbol.dispose]();
  });

  it("keeps the selected session in its current slot until it is deselected", () => {
    const selection = observable({
      current: undefined as
        | { kind: "project-session" | "cake-chat"; sessionId: string }
        | undefined,
    });
    const summaries = observable([
      {
        sessionId: "newer",
        modifiedAt: "2026-01-03T00:00:00.000Z",
        resolved: false,
        draft: false,
        projectPath: "/cake",
      },
      {
        sessionId: "selected",
        modifiedAt: "2026-01-02T00:00:00.000Z",
        resolved: false,
        draft: false,
        projectPath: "/cake",
      },
      {
        sessionId: "older",
        modifiedAt: "2026-01-01T00:00:00.000Z",
        resolved: false,
        draft: false,
        projectPath: "/cake",
      },
    ]);
    const catalog = {
      projectSessions: () => summaries,
      find: (sessionId: string) => summaries.find((session) => session.sessionId === sessionId),
    } as unknown as SessionCatalogStore;
    const store = mount(
      createStore(SidebarStore, {
        projects: { orderedProjectPaths: [] } as unknown as ProjectCatalogStore,
        catalog,
        sessions: {} as SessionRegistryStore,
        cakeChat: () => ({ summaries: [] }) as unknown as CakeChatCollectionStore,
        selectedConversation: () => selection.current,
        setSessionResolved: async () => undefined,
        setSessionWorkflowStatus: async () => undefined,
        setCakeChatSessionResolved: async () => undefined,
        deleteSession: async () => undefined,
        deleteCakeChatSession: async () => undefined,
        setSessionUnread: async () => undefined,
        embeddedEditorSettings: embeddedEditorSettings(),
      }),
    );

    selection.current = { kind: "project-session", sessionId: "selected" };
    summaries[1]!.modifiedAt = "2026-01-04T00:00:00.000Z";
    expect(store.projectSessions("/cake").map((session) => session.sessionId)).toEqual([
      "newer",
      "selected",
      "older",
    ]);

    selection.current = undefined;
    expect(store.projectSessions("/cake").map((session) => session.sessionId)).toEqual([
      "selected",
      "newer",
      "older",
    ]);
    store[Symbol.dispose]();
  });

  it("keeps session rows stable while their lane has active turns", () => {
    const activities = observable({
      newest: undefined as "running" | undefined,
      middle: undefined as "running" | undefined,
      oldest: undefined as "running" | undefined,
    });
    const summaries = observable([
      {
        sessionId: "newest",
        modifiedAt: "2026-01-03T00:00:00.000Z",
        resolved: false,
        draft: false,
        projectPath: "/cake",
      },
      {
        sessionId: "middle",
        modifiedAt: "2026-01-02T00:00:00.000Z",
        resolved: false,
        draft: false,
        projectPath: "/cake",
      },
      {
        sessionId: "oldest",
        modifiedAt: "2026-01-01T00:00:00.000Z",
        resolved: false,
        draft: false,
        projectPath: "/cake",
      },
    ]);
    const catalog = {
      sessions: summaries,
      projectSessions: () => summaries,
      find: (sessionId: string) => summaries.find((session) => session.sessionId === sessionId),
    } as unknown as SessionCatalogStore;
    const store = mount(
      createStore(SidebarStore, {
        projects: { orderedProjectPaths: [] } as unknown as ProjectCatalogStore,
        catalog,
        sessions: {
          findSession: (sessionId: keyof typeof activities) => ({
            activity: activities[sessionId],
          }),
        } as unknown as SessionRegistryStore,
        cakeChat: () => ({ summaries: [] }) as unknown as CakeChatCollectionStore,
        setSessionResolved: async () => undefined,
        setSessionWorkflowStatus: async () => undefined,
        setCakeChatSessionResolved: async () => undefined,
        deleteSession: async () => undefined,
        deleteCakeChatSession: async () => undefined,
        setSessionUnread: async () => undefined,
        embeddedEditorSettings: embeddedEditorSettings(),
      }),
    );

    activities.newest = "running";
    activities.middle = "running";
    activities.oldest = "running";
    summaries[2]!.modifiedAt = "2026-01-06T00:00:00.000Z";
    summaries[1]!.modifiedAt = "2026-01-05T00:00:00.000Z";
    expect(store.projectSessions("/cake").map((session) => session.sessionId)).toEqual([
      "newest",
      "middle",
      "oldest",
    ]);

    activities.newest = undefined;
    activities.middle = undefined;
    expect(store.projectSessions("/cake").map((session) => session.sessionId)).toEqual([
      "newest",
      "middle",
      "oldest",
    ]);

    activities.oldest = undefined;
    expect(store.projectSessions("/cake").map((session) => session.sessionId)).toEqual([
      "oldest",
      "middle",
      "newest",
    ]);
    store[Symbol.dispose]();
  });

  it("resolves persisted Session avatar seeds and falls back to the Session ID", () => {
    const sessions = [
      { sessionId: "seeded", projectPath: "/cake" },
      { sessionId: "legacy", projectPath: "/cake" },
    ];
    const store = mount(
      createStore(SidebarStore, {
        projects: {
          orderedProjectPaths: ["/cake"],
          find: () => ({
            workflow: {
              sessionDetails: [{ sessionId: "seeded", avatarSeed: "prompt-seed" }],
            },
          }),
        } as unknown as ProjectCatalogStore,
        catalog: {
          find: (sessionId: string) => sessions.find((session) => session.sessionId === sessionId),
        } as unknown as SessionCatalogStore,
        sessions: {} as SessionRegistryStore,
        cakeChat: () => ({ summaries: [] }) as unknown as CakeChatCollectionStore,
        setSessionResolved: async () => undefined,
        setSessionWorkflowStatus: async () => undefined,
        setCakeChatSessionResolved: async () => undefined,
        deleteSession: async () => undefined,
        deleteCakeChatSession: async () => undefined,
        setSessionUnread: async () => undefined,
        embeddedEditorSettings: embeddedEditorSettings(),
      }),
    );

    expect(store.sessionAvatarSeed("seeded")).toBe("prompt-seed");
    expect(store.sessionAvatarSeed("legacy")).toBe("legacy");
    store[Symbol.dispose]();
  });

  it("shows child activity on the parent only while its family is collapsed", () => {
    const activities = new Map([
      ["parent", undefined],
      ["child", "running" as const],
    ]);
    const store = mount(
      createStore(SidebarStore, {
        projects: { orderedProjectPaths: [] } as unknown as ProjectCatalogStore,
        catalog: {
          find: (sessionId: string) => ({ sessionId, unread: false }),
        } as unknown as SessionCatalogStore,
        sessions: {
          findSession: (sessionId: string) => ({ activity: activities.get(sessionId) }),
        } as unknown as SessionRegistryStore,
        cakeChat: () => ({ summaries: [] }) as unknown as CakeChatCollectionStore,
        setSessionResolved: async () => undefined,
        setSessionWorkflowStatus: async () => undefined,
        setCakeChatSessionResolved: async () => undefined,
        deleteSession: async () => undefined,
        deleteCakeChatSession: async () => undefined,
        setSessionUnread: async () => undefined,
        embeddedEditorSettings: embeddedEditorSettings(),
      }),
    );
    const parent = { sessionId: "parent", familyChildSessionIds: ["child"] };

    expect(store.sessionActivityForDisplay(parent)).toBeUndefined();
    store.toggleFamilyCollapsed("parent");
    expect(store.sessionActivityForDisplay(parent)).toBe("running");
    expect(store.sessionActivityForDisplay({ sessionId: "child" })).toBe("running");
    store[Symbol.dispose]();
  });

  it("shows queued worktree merges as running session activity", () => {
    const worktreeOperations = WorktreeOperationCatalog.create({
      operations: [
        {
          operationId: "merge-1",
          workspacePath: "/cake-worktree",
          sessionId: "queued-session",
          kind: "landing",
          phase: "waiting",
          allowDirtyTarget: false,
        },
        {
          operationId: "merge-2",
          workspacePath: "/other-worktree",
          sessionId: "merging-session",
          kind: "landing",
          phase: "landing",
          allowDirtyTarget: false,
        },
      ],
    });
    const store = mount(
      createStore(SidebarStore, {
        projects: { orderedProjectPaths: [] } as unknown as ProjectCatalogStore,
        catalog: {
          find: (sessionId: string) => ({ sessionId, unread: false }),
        } as unknown as SessionCatalogStore,
        sessions: {
          findSession: () => undefined,
        } as unknown as SessionRegistryStore,
        worktreeOperations,
        cakeChat: () => ({ summaries: [] }) as unknown as CakeChatCollectionStore,
        setSessionResolved: async () => undefined,
        setSessionWorkflowStatus: async () => undefined,
        setCakeChatSessionResolved: async () => undefined,
        deleteSession: async () => undefined,
        deleteCakeChatSession: async () => undefined,
        setSessionUnread: async () => undefined,
        embeddedEditorSettings: embeddedEditorSettings(),
      }),
    );

    expect(store.sessionActivity("queued-session")).toBe("running");
    expect(store.sessionActivity("merging-session")).toBeUndefined();
    store[Symbol.dispose]();
  });

  it("provides custom workflow statuses and the current status to the native menu", async () => {
    const status = {
      id: "b925b5dd-9661-4f1a-9f40-406be3c96c27",
      name: "In review",
      color: "violet" as const,
    };
    const showSessionContextMenu = vi.fn(async () => undefined);
    const { root, subject } = mountWithClient(
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
      { electron: { showSessionContextMenu } } as unknown as Client,
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

  it("does not count expanded family children toward the project session limit", () => {
    const summaries = Array.from({ length: 10 }, (_, index) => {
      const parentId = `parent-${index}`;
      const modifiedAt = new Date(Date.UTC(2026, 0, 20 - index)).toISOString();
      return [
        {
          sessionId: parentId,
          modifiedAt,
          resolved: false,
          draft: false,
          projectPath: "/cake",
          familyChildSessionIds: [`child-${index}`],
        },
        {
          sessionId: `child-${index}`,
          modifiedAt,
          resolved: false,
          draft: false,
          projectPath: "/cake",
          familyParentSessionId: parentId,
          familyChildOrder: 0,
        },
      ];
    }).flat();
    const catalog = {
      projectSessions: () => summaries,
      find: (sessionId: string) => summaries.find((session) => session.sessionId === sessionId),
    } as unknown as SessionCatalogStore;
    const store = mount(
      createStore(SidebarStore, {
        projects: { orderedProjectPaths: [] } as unknown as ProjectCatalogStore,
        catalog,
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

    expect(store.visibleProjectSessions("/cake")).toHaveLength(20);
    expect(store.visibleProjectSessions("/cake")).toEqual(store.projectSessions("/cake"));

    summaries.push({
      sessionId: "standalone-11",
      modifiedAt: "2025-01-01T00:00:00.000Z",
      resolved: false,
      draft: false,
      projectPath: "/cake",
      familyChildSessionIds: [],
    });
    expect(store.projectSessions("/cake")).toHaveLength(21);
    expect(store.visibleProjectSessions("/cake")).toHaveLength(20);
    expect(store.visibleProjectSessions("/cake").map((session) => session.sessionId)).not.toContain(
      "standalone-11",
    );
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
