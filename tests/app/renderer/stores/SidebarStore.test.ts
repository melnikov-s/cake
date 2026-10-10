import { describe, expect, it, vi } from "vitest";
import { applySnapshot } from "r-state-tree";
import { projectRecord, sessionSummary } from "../fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "../renderer-store-fixture";

// Low-level ordering, snapshot and observation-demand invariants supplement the real
// sidebar-session-order-workflow and session-catalog-sidebar-sync React workflows.
function summary(
  sessionId: string,
  day = 1,
  extra: Partial<ReturnType<typeof sessionSummary>> = {},
) {
  return sessionSummary({
    sessionId,
    projectPath: "/cake",
    modifiedAt: new Date(Date.UTC(2026, 0, day)).toISOString(),
    ...extra,
  });
}
const family = [
  summary("root", 1, {
    familyId: "root",
    familyChildSessionIds: ["planner", "sibling"],
    familyDepth: 0,
  }),
  summary("planner", 2, {
    familyId: "root",
    familyParentSessionId: "root",
    familyChildSessionIds: ["worker"],
    familyChildOrder: 0,
    familyDepth: 1,
  }),
  summary("worker", 4, {
    familyId: "root",
    familyParentSessionId: "planner",
    familyChildOrder: 0,
    familyDepth: 2,
  }),
  summary("sibling", 1, {
    familyId: "root",
    familyParentSessionId: "root",
    familyChildOrder: 1,
    familyDepth: 1,
  }),
];

describe("Sidebar metadata and catalog demand", () => {
  it("owns Project focus and hydrates extracted session-list preferences", () => {
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: "/cake" })],
      snapshot: {
        state: {},
        children: {
          sidebarStore: {
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
      },
    });
    const store = fixture.root.sidebarStore;
    const list = store.sessionListStore;
    expect(store.hidden).toBe(true);
    expect(store.width).toBe(344);
    expect(store.navigationMode).toBe("activity");
    expect(list.projectSessionSort("/cake")).toBe("label");
    expect(list.isActiveGroupExpanded("/cake")).toBe(false);
    expect(list.isFamilyCollapsed("root")).toBe(true);
    store.focusProject("/missing");
    expect(store.focusModeProjectPath).toBeUndefined();
    store.focusProject("/cake");
    expect(store.focusModeProjectPath).toBe("/cake");
    expect(list.isActiveGroupExpanded("/cake")).toBe(true);
    store.leaveProjectFocus();
    expect(store.focusModeProjectPath).toBeUndefined();
  });

  it("keeps rows stable until the last active turn in their lane settles", () => {
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: "/cake" })],
      sessions: [summary("newest", 3), summary("middle", 2), summary("oldest", 1)],
    });
    const sessions = ["newest", "middle", "oldest"].map((id) =>
      fixture.root.sessionRegistry.load(id, "/cake"),
    );
    const list = fixture.root.sidebarStore.sessionListStore;
    for (const session of sessions) session.model.streaming = true;
    fixture.models.sessionCatalog.find("oldest")!.modifiedAt = summary("oldest", 6).modifiedAt;
    fixture.models.sessionCatalog.find("middle")!.modifiedAt = summary("middle", 5).modifiedAt;
    const order = () => list.projectSessions("/cake").map((session) => session.sessionId);
    expect(order()).toEqual(["newest", "middle", "oldest"]);
    sessions[0]!.model.streaming = false;
    sessions[1]!.model.streaming = false;
    expect(order()).toEqual(["newest", "middle", "oldest"]);
    sessions[2]!.model.streaming = false;
    expect(order()).toEqual(["oldest", "middle", "newest"]);
  });

  it("tracks active lanes without querying every catalog session's activity", () => {
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: "/cake" })],
      sessions: Array.from({ length: 100 }, (_, index) => summary(`session-${index}`, index + 1)),
    });
    fixture.root.sessionRegistry.load("session-50", "/cake").model.streaming = true;
    const findSession = vi.spyOn(fixture.root.sessionRegistry, "findSession");
    expect(fixture.root.sidebarStore.sessionListStore.projectSessions("/cake")).toHaveLength(100);
    expect(findSession.mock.calls.every(([sessionId]) => sessionId === "session-50")).toBe(true);
  });

  it("shows descendant activity on collapsed families, not expanded parents", () => {
    using fixture = createRendererStoreFixture({ sessions: family });
    fixture.root.sessionRegistry.load("worker", "/cake").model.streaming = true;
    const list = fixture.root.sidebarStore.sessionListStore;
    const root = fixture.models.sessionCatalog.find("root")!;
    expect(list.sessionActivityForDisplay(root)).toBeUndefined();
    list.toggleFamilyCollapsed("root");
    expect(list.sessionActivityForDisplay(root)).toBe("running");
    expect(list.sessionActivityForDisplay({ sessionId: "worker" })).toBe("running");
    list.toggleFamilyCollapsed("root");
    expect(list.sessionActivityForDisplay(root)).toBeUndefined();
  });

  it("projects queued worktree merges as running only while waiting", () => {
    using fixture = createRendererStoreFixture();
    applySnapshot(fixture.models.worktreeOperations, {
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
    const metadata = fixture.root.sessionMetadataStore;
    expect(metadata.sessionActivity("queued-session")).toBe("running");
    expect(metadata.sessionActivity("merging-session")).toBeUndefined();
    fixture.models.worktreeOperations.operations[0]!.phase = "landing";
    expect(metadata.sessionActivity("queued-session")).toBeUndefined();
  });

  it("sends the catalog's Draft identity to the native session context menu", async () => {
    const showSessionContextMenu = vi.fn(async () => undefined);
    using fixture = createRendererStoreFixture({
      sessions: [summary("session-1", 1, { draft: true, pending: true })],
      client: { electron: { showSessionContextMenu } },
    });
    await fixture.root.sidebarStore.showSessionContextMenu("session-1", 12, 34, false, false);
    expect(showSessionContextMenu).toHaveBeenCalledWith({
      sessionId: "session-1",
      x: 12,
      y: 34,
      resolved: false,
      draft: true,
      unread: false,
      familyChild: undefined,
    });
  });

  it("reveals sessions ten at a time independently for each group and lane", () => {
    using fixture = createRendererStoreFixture();
    const list = fixture.root.sidebarStore.sessionListStore;
    expect(list.sessionLimit("/cake")).toBe(10);
    list.showMoreSessions("/cake");
    expect(list.sessionLimit("/cake")).toBe(20);
    expect(list.sessionLimit("/pi")).toBe(10);
    expect(list.sessionLimit("/cake", true)).toBe(10);
    list.showMoreSessions("/cake", true);
    expect(list.sessionLimit("/cake", true)).toBe(20);
    expect(list.sessionLimit("/cake")).toBe(20);
  });

  it("flattens recursive families parent-first and orders families by their latest descendant", () => {
    using fixture = createRendererStoreFixture({ sessions: [...family, summary("standalone", 3)] });
    const list = fixture.root.sidebarStore.sessionListStore;
    expect(list.projectSessions("/cake").map(({ sessionId }) => sessionId)).toEqual([
      "root",
      "planner",
      "worker",
      "sibling",
      "standalone",
    ]);
    expect(
      list.activeProjectSessionFamilies.map(({ rootSessionId, latestModifiedAt }) => ({
        rootSessionId,
        latestModifiedAt,
      })),
    ).toEqual([
      { rootSessionId: "root", latestModifiedAt: summary("worker", 4).modifiedAt },
      { rootSessionId: "standalone", latestModifiedAt: summary("standalone", 3).modifiedAt },
    ]);
    list.toggleFamilyCollapsed("planner");
    expect(list.projectSessions("/cake").map(({ sessionId }) => sessionId)).toEqual([
      "root",
      "planner",
      "sibling",
      "standalone",
    ]);
    list.toggleFamilyCollapsed("root");
    expect(
      list.activeProjectSessionFamilies[0]?.sessions.map(({ sessionId }) => sessionId),
    ).toEqual(["root"]);
    expect(list.activeProjectSessionFamilies[0]?.latestModifiedAt).toBe(
      summary("worker", 4).modifiedAt,
    );
  });

  it("does not count expanded family children toward the Project session limit", () => {
    using fixture = createRendererStoreFixture({
      sessions: Array.from({ length: 10 }, (_, index) => [
        summary(`parent-${index}`, 20 - index, {
          familyId: `parent-${index}`,
          familyChildSessionIds: [`child-${index}`],
          familyDepth: 0,
        }),
        summary(`child-${index}`, 20 - index, {
          familyId: `parent-${index}`,
          familyParentSessionId: `parent-${index}`,
          familyChildOrder: 0,
          familyDepth: 1,
        }),
      ]).flat(),
    });
    const list = fixture.root.sidebarStore.sessionListStore;
    expect(list.visibleProjectSessions("/cake")).toHaveLength(20);
    applySnapshot(fixture.models.sessionCatalog, {
      sessions: [...fixture.root.sessionCatalogStore.sessions, summary("standalone-11", 1)],
      resolvedHasMoreByProject: {},
    });
    expect(list.projectSessions("/cake")).toHaveLength(21);
    expect(list.visibleProjectSessions("/cake")).toHaveLength(20);
    expect(list.visibleProjectSessions("/cake").map(({ sessionId }) => sessionId)).not.toContain(
      "standalone-11",
    );
  });

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
