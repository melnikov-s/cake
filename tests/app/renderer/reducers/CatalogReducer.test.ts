import { effect } from "r-state-tree";
import { describe, expect, it } from "vitest";
import {
  applyCakeChatCatalogGroupUpdate,
  applyProjectCatalogUpdate,
  applySessionCatalogGroupUpdate,
} from "../../../../src/renderer/reducers/CatalogReducer";
import { projectRecord, sessionSummary } from "../fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "../renderer-store-fixture";

// Visible lane/title/pagination contracts live in session-catalog-workflow and
// workflow labels in session-metadata-workflow. These are real Root-composition
// resource/identity contracts: React output cannot prove that Models were retained
// or that an unchanged authority event caused no reactive invalidation.
describe("Catalog projection resource integration", () => {
  it("updates project entries without resnapshotting unrelated workflow state", () => {
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: "/one" }), projectRecord({ path: "/two" })],
    });
    const catalog = fixture.models.projects;
    applyProjectCatalogUpdate(catalog, {
      _tag: "Snapshot",
      revision: 1,
      projects: [
        projectRecord({ path: "/one" }),
        projectRecord({
          path: "/two",
          workflow: {
            labels: [
              { id: "b925b5dd-9661-4f1a-9f40-406be3c96c27", name: "Blocked", color: "rose" },
            ],
            assignments: [],
            sessionDetails: [],
          },
        }),
      ],
    });
    expect(fixture.root.sessionMetadataStore.projectLabels("/two")[0]?.name).toBe("Blocked");
    const first = catalog.projects[0]!;
    const second = catalog.projects[1]!;
    const workflow = second.workflow;
    const projects = catalog.projects;
    applyProjectCatalogUpdate(catalog, {
      _tag: "Event",
      revision: 2,
      event: { _tag: "Upserted", project: projectRecord({ path: "/one", name: "Updated" }) },
    });
    expect(fixture.root.projectCatalogStore.nameForPath("/one")).toBe("Updated");
    expect(catalog.projects).toBe(projects);
    expect(catalog.projects[0]).toBe(first);
    expect(second.workflow).toBe(workflow);
    applyProjectCatalogUpdate(catalog, {
      _tag: "Event",
      revision: 3,
      event: { _tag: "Removed", path: "/one" },
    });
    expect(catalog.projects).toEqual([second]);
    expect(second.workflow).toBe(workflow);
  });

  it("does not invalidate the mounted catalog for an unchanged session upsert", () => {
    const session = sessionSummary({ sessionId: "one", projectPath: "/project" });
    using fixture = createRendererStoreFixture({ sessions: [session] });
    let reactions = 0;
    const stop = effect(() => {
      fixture.root.sessionCatalogStore.sessions.map((item) => [
        item.sessionId,
        item.title,
        item.modifiedAt,
      ]);
      reactions += 1;
    });
    try {
      applySessionCatalogGroupUpdate(
        fixture.models.sessionCatalog,
        { projectPath: "/project", resolved: false },
        { _tag: "Event", revision: 2, event: { _tag: "Upserted", session: { ...session } } },
      );
      expect(reactions).toBe(1);
    } finally {
      stop();
    }
  });

  it("retains keyed Models and unrelated order across batch upserts, transitions and lane removals", () => {
    const record = (id: string, modifiedAt: string) =>
      sessionSummary({ sessionId: id, modifiedAt, projectPath: "/project" });
    using fixture = createRendererStoreFixture({
      sessions: [
        { ...record("one", "2026-01-01"), familyParentSessionId: "parent" },
        { ...record("resolved", "2026-01-03"), resolved: true },
      ],
    });
    const catalog = fixture.models.sessionCatalog;
    const one = catalog.find("one");
    const resolved = catalog.find("resolved");
    const sessions = catalog.sessions;
    const query = { projectPath: "/project", resolved: false };
    applySessionCatalogGroupUpdate(catalog, query, {
      _tag: "Event",
      revision: 1,
      event: {
        _tag: "UpsertedBatch",
        sessions: [record("one", "2026-01-02"), record("two", "2026-01-04")],
      },
    });
    expect(catalog.sessions).toBe(sessions);
    expect(catalog.find("one")).toBe(one);
    expect(catalog.find("resolved")).toBe(resolved);
    expect(catalog.sessions.map((session) => session.sessionId)).toEqual([
      "one",
      "resolved",
      "two",
    ]);
    applySessionCatalogGroupUpdate(catalog, query, {
      _tag: "Event",
      revision: 2,
      event: { _tag: "StatusChanged", sessionId: "two", resolved: true, unread: true },
    });
    expect(fixture.root.sessionCatalogStore.find("two")?.unread).toBe(true);
    applySessionCatalogGroupUpdate(catalog, query, {
      _tag: "Event",
      revision: 3,
      event: { _tag: "RemovedBatch", sessionIds: ["one", "two"] },
    });
    expect(catalog.sessions.map((session) => session.sessionId)).toEqual(["resolved", "two"]);
    applySessionCatalogGroupUpdate(catalog, query, {
      _tag: "Event",
      revision: 4,
      event: { _tag: "Upserted", session: record("one", "2026-01-05") },
    });
    expect(catalog.find("one")).not.toBe(one);
    expect(catalog.find("resolved")).toBe(resolved);
  });

  it("rejects a colliding cross-project snapshot without changing either mounted catalog lane", () => {
    const original = sessionSummary({ sessionId: "duplicate-session", projectPath: "/one" });
    using fixture = createRendererStoreFixture({ sessions: [original] });
    const model = fixture.models.sessionCatalog.find(original.sessionId);
    expect(() =>
      applySessionCatalogGroupUpdate(
        fixture.models.sessionCatalog,
        { projectPath: "/two", resolved: false },
        { _tag: "Snapshot", revision: 1, sessions: [{ ...original, projectPath: "/two" }] },
      ),
    ).toThrow("Session ID collision: duplicate-session (snapshot for /two)");
    expect(fixture.models.sessionCatalog.find(original.sessionId)).toBe(model);
    expect(fixture.root.sessionCatalogStore.projectSessions("/one")).toHaveLength(1);
    expect(fixture.root.sessionCatalogStore.projectSessions("/two")).toHaveLength(0);
  });

  // The current Cake Chat sidebar is one launcher, not a paginated history UI.
  // Keep this authority-to-collection contract rather than manufacture a surface.
  it("projects Cake Chat pagination and transitions while retaining existing Models", () => {
    using fixture = createRendererStoreFixture();
    const catalog = fixture.models.cakeChatCatalog;
    const record = (sessionId: string, modifiedAt: string) => ({
      sessionId,
      modifiedAt,
      createdAt: "2026-01-01",
      title: sessionId,
      messageCount: 1,
      resolved: false,
      unread: false,
    });
    const query = { resolved: false } as const;
    applyCakeChatCatalogGroupUpdate(catalog, query, {
      _tag: "Snapshot",
      revision: 1,
      sessions: [record("one", "2026-01-01")],
    });
    const one = catalog.find("one");
    const sessions = catalog.sessions;
    applyCakeChatCatalogGroupUpdate(catalog, query, {
      _tag: "Event",
      revision: 2,
      event: { _tag: "Upserted", session: record("two", "2026-01-02") },
    });
    applyCakeChatCatalogGroupUpdate(catalog, query, {
      _tag: "Event",
      revision: 3,
      event: { _tag: "Upserted", session: { ...record("one", "2026-01-03"), title: "Updated" } },
    });
    expect(catalog.sessions).toBe(sessions);
    expect(catalog.find("one")).toBe(one);
    expect(one?.title).toBe("Updated");
    applyCakeChatCatalogGroupUpdate(catalog, query, {
      _tag: "Event",
      revision: 4,
      event: { _tag: "StatusChanged", sessionId: "one", resolved: true },
    });
    expect(one?.resolved).toBe(true);
    applyCakeChatCatalogGroupUpdate(
      catalog,
      { resolved: true, limit: 10 },
      {
        _tag: "Snapshot",
        revision: 5,
        sessions: [{ ...record("one", "2026-01-03"), title: "Updated", resolved: true }],
        hasMore: true,
      },
    );
    expect(fixture.root.sidebarStore.sessionListStore.hasMoreResolvedCakeChatSessions).toBe(true);
    applyCakeChatCatalogGroupUpdate(
      catalog,
      { resolved: true, limit: 20 },
      {
        _tag: "Snapshot",
        revision: 6,
        sessions: [{ ...record("one", "2026-01-03"), title: "Updated", resolved: true }],
        hasMore: false,
      },
    );
    expect(fixture.root.sidebarStore.sessionListStore.hasMoreResolvedCakeChatSessions).toBe(false);
    applyCakeChatCatalogGroupUpdate(catalog, query, {
      _tag: "Event",
      revision: 7,
      event: { _tag: "Removed", sessionId: "two" },
    });
    expect(catalog.find("one")).toBe(one);
    expect(catalog.sessions).toEqual([one]);
  });
});
