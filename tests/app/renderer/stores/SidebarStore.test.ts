import { createStore, mount, observable } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { ProjectCatalogStore } from "../../../../src/renderer/stores/ProjectCatalogStore";
import type { SessionCatalogStore } from "../../../../src/renderer/stores/SessionCatalogStore";
import type { SessionRegistryStore } from "../../../../src/renderer/stores/SessionRegistryStore";
import type { CakeChatCollectionStore } from "../../../../src/renderer/stores/CakeChatCollectionStore";
import { SidebarStore } from "../../../../src/renderer/stores/SidebarStore";
import { SessionMetadataStore } from "../../../../src/renderer/stores/SessionMetadataStore";
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
        sessionMetadata: {
          projectLabels: () => [],
          sessionLabelIds: () => [],
          sessionActivity: () => undefined,
        } as unknown as SessionMetadataStore,
        cakeChat: () => ({ summaries: [] }) as unknown as CakeChatCollectionStore,
        setSessionResolved: async () => undefined,
        setSessionLabels: async () => undefined,
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
    expect(store.sessionListStore.isActiveGroupExpanded("/cake")).toBe(true);
    store.leaveProjectFocus();
    expect(store.focusModeProjectPath).toBeUndefined();
    store[Symbol.dispose]();
  });

  it("hydrates sidebar presentation and extracted session-list preferences", () => {
    const store = mount(
      createStore(SidebarStore, {
        projects: { orderedProjectPaths: [] } as unknown as ProjectCatalogStore,
        catalog: {} as SessionCatalogStore,
        sessions: { sessions: [] } as unknown as SessionRegistryStore,
        sessionMetadata: {
          projectLabels: () => [],
          sessionLabelIds: () => [],
          sessionActivity: () => undefined,
        } as unknown as SessionMetadataStore,
        cakeChat: () => ({ summaries: [] }) as unknown as CakeChatCollectionStore,
        setSessionResolved: async () => undefined,
        setSessionLabels: async () => undefined,
        setCakeChatSessionResolved: async () => undefined,
        deleteSession: async () => undefined,
        deleteCakeChatSession: async () => undefined,
        setSessionUnread: async () => undefined,
        embeddedEditorSettings: embeddedEditorSettings(),
      }),
      {
        snapshot: {
          state: { hidden: true, width: 344, navigationMode: "activity" },
          children: {
            sessionListStore: {
              state: {
                projectSessionSorts: { "/cake": "label" },
                expandedActiveGroups: { "cake-chat": true, "/cake": false },
                collapsedFamilies: { root: true },
              },
              children: {},
            },
          },
        },
      },
    );

    expect(store.hidden).toBe(true);
    expect(store.width).toBe(344);
    expect(store.navigationMode).toBe("activity");
    expect(store.sessionListStore.projectSessionSort("/cake")).toBe("label");
    expect(store.sessionListStore.isActiveGroupExpanded("/cake")).toBe(false);
    expect(store.sessionListStore.isFamilyCollapsed("root")).toBe(true);
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
        sessionMetadata: {
          projectLabels: () => [],
          sessionLabelIds: () => [],
          sessionActivity: () => undefined,
        } as unknown as SessionMetadataStore,
        cakeChat: () => ({ summaries: [] }) as unknown as CakeChatCollectionStore,
        selectedConversation: () => selection.current,
        setSessionResolved: async () => undefined,
        setSessionLabels: async () => undefined,
        setCakeChatSessionResolved: async () => undefined,
        deleteSession: async () => undefined,
        deleteCakeChatSession: async () => undefined,
        setSessionUnread: async () => undefined,
        embeddedEditorSettings: embeddedEditorSettings(),
      }),
    );

    const list = store.sessionListStore;
    selection.current = { kind: "project-session", sessionId: "selected" };
    summaries[1]!.modifiedAt = "2026-01-04T00:00:00.000Z";
    expect(list.projectSessions("/cake").map((session) => session.sessionId)).toEqual([
      "newer",
      "selected",
      "older",
    ]);

    selection.current = undefined;
    expect(list.projectSessions("/cake").map((session) => session.sessionId)).toEqual([
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
          sessions: (Object.keys(activities) as Array<keyof typeof activities>).map(
            (sessionId) => ({
              sessionId,
              get activity() {
                return activities[sessionId];
              },
            }),
          ),
          findSession: (sessionId: keyof typeof activities) => ({
            activity: activities[sessionId],
          }),
        } as unknown as SessionRegistryStore,
        sessionMetadata: {
          projectLabels: () => [],
          sessionLabelIds: () => [],
          sessionActivity: () => undefined,
        } as unknown as SessionMetadataStore,
        cakeChat: () => ({ summaries: [] }) as unknown as CakeChatCollectionStore,
        setSessionResolved: async () => undefined,
        setSessionLabels: async () => undefined,
        setCakeChatSessionResolved: async () => undefined,
        deleteSession: async () => undefined,
        deleteCakeChatSession: async () => undefined,
        setSessionUnread: async () => undefined,
        embeddedEditorSettings: embeddedEditorSettings(),
      }),
    );

    const list = store.sessionListStore;
    activities.newest = "running";
    activities.middle = "running";
    activities.oldest = "running";
    summaries[2]!.modifiedAt = "2026-01-06T00:00:00.000Z";
    summaries[1]!.modifiedAt = "2026-01-05T00:00:00.000Z";
    expect(list.projectSessions("/cake").map((session) => session.sessionId)).toEqual([
      "newest",
      "middle",
      "oldest",
    ]);

    activities.newest = undefined;
    activities.middle = undefined;
    expect(list.projectSessions("/cake").map((session) => session.sessionId)).toEqual([
      "newest",
      "middle",
      "oldest",
    ]);

    activities.oldest = undefined;
    expect(list.projectSessions("/cake").map((session) => session.sessionId)).toEqual([
      "oldest",
      "middle",
      "newest",
    ]);
    store[Symbol.dispose]();
  });

  it("tracks active lane order without querying every catalog session's activity", () => {
    const summaries = observable(
      Array.from({ length: 100 }, (_, index) => ({
        sessionId: `session-${index}`,
        modifiedAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
        resolved: false,
        draft: false,
        projectPath: "/cake",
      })),
    );
    const findSession = vi.fn(() => undefined);
    const store = mount(
      createStore(SidebarStore, {
        projects: { orderedProjectPaths: [] } as unknown as ProjectCatalogStore,
        catalog: {
          sessions: summaries,
          projectSessions: () => summaries,
          find: (sessionId: string) => summaries.find((session) => session.sessionId === sessionId),
        } as unknown as SessionCatalogStore,
        sessions: {
          sessions: [{ sessionId: "session-50", activity: "running" }],
          findSession,
        } as unknown as SessionRegistryStore,
        sessionMetadata: {
          projectLabels: () => [],
          sessionLabelIds: () => [],
          sessionActivity: () => undefined,
        } as unknown as SessionMetadataStore,
        cakeChat: () => ({ summaries: [] }) as unknown as CakeChatCollectionStore,
        setSessionResolved: async () => undefined,
        setSessionLabels: async () => undefined,
        setCakeChatSessionResolved: async () => undefined,
        deleteSession: async () => undefined,
        deleteCakeChatSession: async () => undefined,
        setSessionUnread: async () => undefined,
        embeddedEditorSettings: embeddedEditorSettings(),
      }),
    );

    expect(findSession).not.toHaveBeenCalled();
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
        sessionMetadata: {
          projectLabels: () => [],
          sessionLabelIds: () => [],
          sessionActivity: (sessionId: string) => activities.get(sessionId),
        } as unknown as SessionMetadataStore,
        cakeChat: () => ({ summaries: [] }) as unknown as CakeChatCollectionStore,
        setSessionResolved: async () => undefined,
        setSessionLabels: async () => undefined,
        setCakeChatSessionResolved: async () => undefined,
        deleteSession: async () => undefined,
        deleteCakeChatSession: async () => undefined,
        setSessionUnread: async () => undefined,
        embeddedEditorSettings: embeddedEditorSettings(),
      }),
    );
    const parent = { sessionId: "parent", familyChildSessionIds: ["child"] };

    expect(store.sessionListStore.sessionActivityForDisplay(parent)).toBeUndefined();
    store.sessionListStore.toggleFamilyCollapsed("parent");
    expect(store.sessionListStore.sessionActivityForDisplay(parent)).toBe("running");
    expect(store.sessionListStore.sessionActivityForDisplay({ sessionId: "child" })).toBe(
      "running",
    );
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
      createStore(SessionMetadataStore, {
        projects: { orderedProjectPaths: [] } as unknown as ProjectCatalogStore,
        catalog: {
          find: (sessionId: string) => ({ sessionId, unread: false }),
        } as unknown as SessionCatalogStore,
        sessions: {
          findSession: () => undefined,
        } as unknown as SessionRegistryStore,
        worktreeOperations,
        globalLabels: () => [],
      }),
    );

    expect(store.sessionActivity("queued-session")).toBe("running");
    expect(store.sessionActivity("merging-session")).toBeUndefined();
    store[Symbol.dispose]();
  });

  it("keeps labels out of the native session context menu", async () => {
    const projectStatus = {
      id: "b925b5dd-9661-4f1a-9f40-406be3c96c27",
      name: "In review",
      color: "violet" as const,
    };
    const globalStatus = {
      id: "bcf5bcc1-9126-4192-a0a8-eadb851c5075",
      name: "Feature",
      color: "blue" as const,
    };
    const showSessionContextMenu = vi.fn(async () => undefined);
    const { root, subject } = mountWithClient(
      createStore(SidebarStore, {
        projects: {
          orderedProjectPaths: ["/cake"],
          find: () => ({
            workflow: {
              labels: [projectStatus],
              assignments: [{ sessionId: "session-1", labelIds: [globalStatus.id] }],
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
        sessionMetadata: {
          projectLabels: () => [],
          sessionLabelIds: () => [],
          sessionActivity: () => undefined,
        } as unknown as SessionMetadataStore,
        cakeChat: () => ({}) as CakeChatCollectionStore,
        setSessionResolved: async () => undefined,
        setSessionLabels: async () => undefined,
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
        sessionMetadata: {
          projectLabels: () => [],
          sessionLabelIds: () => [],
          sessionActivity: () => undefined,
        } as unknown as SessionMetadataStore,
        cakeChat: () => ({}) as CakeChatCollectionStore,
        setSessionResolved: async () => undefined,
        setSessionLabels: async () => undefined,
        setCakeChatSessionResolved: async () => undefined,
        deleteSession: async () => undefined,
        deleteCakeChatSession: async () => undefined,
        setSessionUnread: async () => undefined,
        embeddedEditorSettings: embeddedEditorSettings(),
      }),
    );

    expect(store.sessionListStore.sessionLimit("/cake")).toBe(10);
    store.sessionListStore.showMoreSessions("/cake");
    expect(store.sessionListStore.sessionLimit("/cake")).toBe(20);
    expect(store.sessionListStore.sessionLimit("/pi")).toBe(10);
    expect(store.sessionListStore.sessionLimit("/cake", true)).toBe(10);

    store.sessionListStore.showMoreSessions("/cake", true);
    expect(store.sessionListStore.sessionLimit("/cake", true)).toBe(20);
    expect(store.sessionListStore.sessionLimit("/cake")).toBe(20);
    store[Symbol.dispose]();
  });

  it("flattens recursive families in parent-first order and collapses each subtree", () => {
    const summaries = [
      {
        sessionId: "root",
        modifiedAt: "2026-01-01T00:00:00.000Z",
        resolved: false,
        draft: false,
        projectPath: "/cake",
        familyParentSessionId: "root",
        familyChildSessionIds: ["planner", "sibling"],
      },
      {
        sessionId: "planner",
        modifiedAt: "2026-01-02T00:00:00.000Z",
        resolved: false,
        draft: false,
        projectPath: "/cake",
        familyParentSessionId: "root",
        familyChildSessionIds: ["worker"],
        familyChildOrder: 0,
      },
      {
        sessionId: "worker",
        modifiedAt: "2026-01-03T00:00:00.000Z",
        resolved: false,
        draft: false,
        projectPath: "/cake",
        familyParentSessionId: "planner",
        familyChildSessionIds: [],
        familyChildOrder: 0,
      },
      {
        sessionId: "sibling",
        modifiedAt: "2026-01-01T00:00:00.000Z",
        resolved: false,
        draft: false,
        projectPath: "/cake",
        familyParentSessionId: "root",
        familyChildSessionIds: [],
        familyChildOrder: 1,
      },
    ];
    const catalog = {
      projectSessions: () => summaries,
      find: (sessionId: string) => summaries.find((session) => session.sessionId === sessionId),
    } as unknown as SessionCatalogStore;
    const store = mount(
      createStore(SidebarStore, {
        projects: { orderedProjectPaths: [] } as unknown as ProjectCatalogStore,
        catalog,
        sessions: {} as SessionRegistryStore,
        sessionMetadata: {
          projectLabels: () => [],
          sessionLabelIds: () => [],
          sessionActivity: () => undefined,
        } as unknown as SessionMetadataStore,
        cakeChat: () => ({ summaries: [] }) as unknown as CakeChatCollectionStore,
        setSessionResolved: async () => undefined,
        setSessionLabels: async () => undefined,
        setCakeChatSessionResolved: async () => undefined,
        deleteSession: async () => undefined,
        deleteCakeChatSession: async () => undefined,
        setSessionUnread: async () => undefined,
        embeddedEditorSettings: embeddedEditorSettings(),
      }),
    );

    expect(
      store.sessionListStore.projectSessions("/cake").map(({ sessionId }) => sessionId),
    ).toEqual(["root", "planner", "worker", "sibling"]);
    store.sessionListStore.toggleFamilyCollapsed("planner");
    expect(
      store.sessionListStore.projectSessions("/cake").map(({ sessionId }) => sessionId),
    ).toEqual(["root", "planner", "sibling"]);
    store[Symbol.dispose]();
  });

  it("groups active session families by their latest descendant activity", () => {
    const summaries = [
      {
        sessionId: "root",
        modifiedAt: "2026-01-01T00:00:00.000Z",
        resolved: false,
        projectPath: "/cake",
        familyChildSessionIds: ["child", "sibling"],
      },
      {
        sessionId: "child",
        modifiedAt: "2026-01-04T00:00:00.000Z",
        resolved: false,
        projectPath: "/cake",
        familyParentSessionId: "root",
        familyChildOrder: 0,
      },
      {
        sessionId: "sibling",
        modifiedAt: "2026-01-02T00:00:00.000Z",
        resolved: false,
        projectPath: "/cake",
        familyParentSessionId: "root",
        familyChildOrder: 1,
      },
      {
        sessionId: "standalone",
        modifiedAt: "2026-01-03T00:00:00.000Z",
        resolved: false,
        projectPath: "/cake",
      },
    ];
    const catalog = {
      sessions: summaries,
      find: (sessionId: string) => summaries.find((session) => session.sessionId === sessionId),
    } as unknown as SessionCatalogStore;
    const store = mount(
      createStore(SidebarStore, {
        projects: { orderedProjectPaths: [] } as unknown as ProjectCatalogStore,
        catalog,
        sessions: {} as SessionRegistryStore,
        sessionMetadata: {
          projectLabels: () => [],
          sessionLabelIds: () => [],
          sessionActivity: () => undefined,
        } as unknown as SessionMetadataStore,
        cakeChat: () => ({ summaries: [] }) as unknown as CakeChatCollectionStore,
        setSessionResolved: async () => undefined,
        setSessionLabels: async () => undefined,
        setCakeChatSessionResolved: async () => undefined,
        deleteSession: async () => undefined,
        deleteCakeChatSession: async () => undefined,
        setSessionUnread: async () => undefined,
        embeddedEditorSettings: embeddedEditorSettings(),
      }),
    );

    expect(
      store.sessionListStore.activeProjectSessionFamilies.map(
        ({ rootSessionId, latestModifiedAt, sessions }) => ({
          rootSessionId,
          latestModifiedAt,
          sessionIds: sessions.map((session) => session.sessionId),
        }),
      ),
    ).toEqual([
      {
        rootSessionId: "root",
        latestModifiedAt: "2026-01-04T00:00:00.000Z",
        sessionIds: ["root", "child", "sibling"],
      },
      {
        rootSessionId: "standalone",
        latestModifiedAt: "2026-01-03T00:00:00.000Z",
        sessionIds: ["standalone"],
      },
    ]);

    store.sessionListStore.toggleFamilyCollapsed("root");
    expect(
      store.sessionListStore.activeProjectSessionFamilies[0]?.sessions.map(
        (session) => session.sessionId,
      ),
    ).toEqual(["root"]);
    expect(store.sessionListStore.activeProjectSessionFamilies[0]?.latestModifiedAt).toBe(
      "2026-01-04T00:00:00.000Z",
    );
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
        sessionMetadata: {
          projectLabels: () => [],
          sessionLabelIds: () => [],
          sessionActivity: () => undefined,
        } as unknown as SessionMetadataStore,
        cakeChat: () => ({}) as CakeChatCollectionStore,
        setSessionResolved: async () => undefined,
        setSessionLabels: async () => undefined,
        setCakeChatSessionResolved: async () => undefined,
        deleteSession: async () => undefined,
        deleteCakeChatSession: async () => undefined,
        setSessionUnread: async () => undefined,
        embeddedEditorSettings: embeddedEditorSettings(),
      }),
    );

    expect(store.sessionListStore.visibleProjectSessions("/cake")).toHaveLength(20);
    expect(store.sessionListStore.visibleProjectSessions("/cake")).toEqual(
      store.sessionListStore.projectSessions("/cake"),
    );

    summaries.push({
      sessionId: "standalone-11",
      modifiedAt: "2025-01-01T00:00:00.000Z",
      resolved: false,
      draft: false,
      projectPath: "/cake",
      familyChildSessionIds: [],
    });
    expect(store.sessionListStore.projectSessions("/cake")).toHaveLength(21);
    expect(store.sessionListStore.visibleProjectSessions("/cake")).toHaveLength(20);
    expect(
      store.sessionListStore.visibleProjectSessions("/cake").map((session) => session.sessionId),
    ).not.toContain("standalone-11");
    store[Symbol.dispose]();
  });

  it("treats sidebar visibility inside VS Code as a temporary override", () => {
    const store = mount(
      createStore(SidebarStore, {
        projects: { orderedProjectPaths: [] } as unknown as ProjectCatalogStore,
        catalog: {} as SessionCatalogStore,
        sessions: {} as SessionRegistryStore,
        sessionMetadata: {
          projectLabels: () => [],
          sessionLabelIds: () => [],
          sessionActivity: () => undefined,
        } as unknown as SessionMetadataStore,
        cakeChat: () => ({}) as CakeChatCollectionStore,
        setSessionResolved: async () => undefined,
        setSessionLabels: async () => undefined,
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
        sessionMetadata: {
          projectLabels: () => [],
          sessionLabelIds: () => [],
          sessionActivity: () => undefined,
        } as unknown as SessionMetadataStore,
        cakeChat: () => ({}) as CakeChatCollectionStore,
        setSessionResolved: async () => undefined,
        setSessionLabels: async () => undefined,
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
        sessionMetadata: {
          projectLabels: () => [],
          sessionLabelIds: () => [],
          sessionActivity: () => undefined,
        } as unknown as SessionMetadataStore,
        cakeChat: () => ({}) as CakeChatCollectionStore,
        setSessionResolved: async () => undefined,
        setSessionLabels: async () => undefined,
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
    expect(store.sessionListStore.projectSessionCatalogQueries).toEqual(projectQueries);
    expect(store.sessionListStore.cakeChatCatalogQueries).toEqual([{ resolved: false }]);

    store.sessionListStore.toggleActiveGroupExpanded("/cake");
    store.sessionListStore.toggleResolvedLane();
    store.sessionListStore.toggleResolvedGroupExpanded("/cake");
    expect(store.sessionListStore.isActiveGroupExpanded("/cake")).toBe(false);
    expect(store.sessionListStore.projectSessionCatalogQueries).toEqual(projectQueries);
    expect(store.sessionListStore.cakeChatCatalogQueries).toEqual([{ resolved: false }]);

    store.sessionListStore.toggleResolvedGroupExpanded("cake-chat");
    expect(store.sessionListStore.cakeChatCatalogQueries).toEqual([
      { resolved: false },
      { resolved: true, limit: 10 },
    ]);

    store.sessionListStore.showMoreSessions("/cake", true);
    store.sessionListStore.showMoreSessions("cake-chat", true);
    expect(store.sessionListStore.projectSessionCatalogQueries).toEqual(projectQueries);
    expect(store.sessionListStore.cakeChatCatalogQueries).toContainEqual({
      resolved: true,
      limit: 20,
    });

    store.sessionListStore.toggleResolvedGroupExpanded("/cake");
    store.sessionListStore.toggleResolvedGroupExpanded("cake-chat");
    store.sessionListStore.toggleResolvedLane();
    expect(store.sessionListStore.isResolvedGroupExpanded("/cake")).toBe(false);
    expect(store.sessionListStore.projectSessionCatalogQueries).toEqual(projectQueries);
    expect(store.sessionListStore.cakeChatCatalogQueries).toEqual([
      { resolved: false },
      { resolved: true, limit: 20 },
    ]);

    store[Symbol.dispose]();
  });
});
