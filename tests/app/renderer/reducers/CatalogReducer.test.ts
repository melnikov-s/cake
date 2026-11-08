import { applySnapshot, batch, effect, toSnapshot } from "r-state-tree";
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

  it("reconciles only the snapshot lane in place and leaves presentation ordering to consumers", () => {
    const one = sessionSummary({ sessionId: "one", projectPath: "/one", modifiedAt: "2026-01-01" });
    const other = sessionSummary({ sessionId: "other", projectPath: "/two" });
    const archived = sessionSummary({ sessionId: "archived", projectPath: "/one", resolved: true });
    using fixture = createRendererStoreFixture({
      sessions: [
        one,
        other,
        archived,
        sessionSummary({ sessionId: "removed", projectPath: "/one" }),
      ],
    });
    const catalog = fixture.models.sessionCatalog;
    const sessions = catalog.sessions;
    const records = [...sessions];
    const pagination = catalog.resolvedHasMoreByProject;
    pagination["/two"] = true;
    const store = fixture.root.sessionCatalogStore;
    const unrelated = store.projectSessions("/two", false);
    const incoming = [
      sessionSummary({ sessionId: "new", projectPath: "/one", modifiedAt: "2026-01-03" }),
      { ...one, title: "Updated", modifiedAt: "2026-01-02" },
    ];
    applySessionCatalogGroupUpdate(
      catalog,
      { projectPath: "/one", resolved: false },
      {
        _tag: "Snapshot",
        revision: 1,
        sessions: incoming,
      },
    );
    expect(catalog.sessions).toBe(sessions);
    expect(catalog.sessions.map((session) => session.sessionId)).toEqual([
      "one",
      "other",
      "archived",
      "new",
    ]);
    expect(catalog.find("one")).toBe(records[0]);
    expect(catalog.find("other")).toBe(records[1]);
    expect(catalog.find("archived")).toBe(records[2]);
    expect(records[3]!.parent).toBeNull();
    expect(catalog.find("one")?.title).toBe("Updated");
    expect(catalog.resolvedHasMoreByProject).toBe(pagination);
    expect(pagination["/two"]).toBe(true);
    // Structural changes may invalidate group computeds, but never replace their Models.
    expect(store.projectSessions("/two", false)[0]).toBe(unrelated[0]);
    expect(store.projectSessions("/one", false).map((session) => session.sessionId)).toEqual([
      "new",
      "one",
    ]);
    expect(
      fixture.root.sidebarStore.sessionListStore
        .projectSessions("/one")
        .map((session) => session.sessionId),
    ).toEqual(["new", "one"]);
    expect(store.sessions.map((session) => session.sessionId)).toEqual([
      "new",
      "one",
      "other",
      "archived",
    ]);
  });

  it("retains omitted inherited metadata and does not invalidate unrelated groups or idempotent snapshots", () => {
    const one = {
      ...sessionSummary({
        sessionId: "one",
        projectPath: "/one",
        workingDirectory: "/worktree",
        running: true,
        unread: true,
        workingStartedAt: 123,
        recoveryIssue: "recover",
        latestTurnOutcome: "failed",
        familyId: "family",
        familyParentSessionId: "parent",
        familyChildSessionIds: ["child"],
      }),
      worktreeName: "Inherited worktree",
    };
    using fixture = createRendererStoreFixture({
      sessions: [one, sessionSummary({ sessionId: "other", projectPath: "/two" })],
    });
    const catalog = fixture.models.sessionCatalog;
    const model = catalog.find("one")!;
    const children = model.familyChildSessionIds;
    const unrelated = fixture.root.sessionCatalogStore.projectSessions("/two", false);
    let membershipRuns = 0;
    let unrelatedRuns = 0;
    let ownRuns = 0;
    const stops = [
      effect(() => {
        catalog.sessions.map((session) => session.sessionId);
        membershipRuns += 1;
      }),
      effect(() => {
        fixture.root.sessionCatalogStore.projectSessions("/two", false);
        unrelatedRuns += 1;
      }),
      effect(() => {
        fixture.root.sessionCatalogStore
          .projectSessions("/one", false)
          .map((session) => session.title);
        ownRuns += 1;
      }),
    ];
    try {
      const summary = sessionSummary({
        sessionId: one.sessionId,
        projectPath: one.projectPath,
        workingDirectory: one.workingDirectory,
        running: true,
        unread: true,
      });
      for (let revision = 1; revision <= 3; revision += 1) {
        applySessionCatalogGroupUpdate(
          catalog,
          { projectPath: "/one", resolved: false },
          {
            _tag: "Snapshot",
            revision,
            sessions: [{ ...summary, title: "Updated" }],
          },
        );
      }
      expect(catalog.find("one")).toBe(model);
      expect(model).toMatchObject({ ...one, title: "Updated" });
      expect(model.familyChildSessionIds).toBe(children);
      expect(fixture.root.sessionCatalogStore.projectSessions("/two", false)).toBe(unrelated);
      expect({ membershipRuns, unrelatedRuns, ownRuns }).toEqual({
        membershipRuns: 1,
        unrelatedRuns: 1,
        ownRuns: 2,
      });
    } finally {
      stops.forEach((stop) => stop());
    }
  });

  it("moves one identity between lanes and ignores late removals from the previous lane", () => {
    const record = sessionSummary({ sessionId: "moving", projectPath: "/one" });
    using fixture = createRendererStoreFixture({ sessions: [record] });
    const catalog = fixture.models.sessionCatalog;
    const model = catalog.find("moving");
    const sessions = catalog.sessions;
    for (const resolved of [true, false]) {
      applySessionCatalogGroupUpdate(
        catalog,
        { projectPath: "/one", resolved },
        {
          _tag: "Snapshot",
          revision: 1,
          sessions: [{ ...record, resolved }],
          hasMore: true,
        },
      );
      applySessionCatalogGroupUpdate(
        catalog,
        { projectPath: "/one", resolved: !resolved },
        {
          _tag: "Snapshot",
          revision: 2,
          sessions: [],
          hasMore: false,
        },
      );
      expect(catalog.sessions).toBe(sessions);
      expect(catalog.sessions).toEqual([model]);
      expect(model?.resolved).toBe(resolved);
    }
  });

  it.each(["Snapshot", "Replaced"] as const)(
    "handles empty %s without disturbing another project/lane or pagination",
    (tag) => {
      using fixture = createRendererStoreFixture({
        sessions: [
          sessionSummary({ sessionId: "active", projectPath: "/one" }),
          sessionSummary({ sessionId: "archive", projectPath: "/one", resolved: true }),
          sessionSummary({ sessionId: "other", projectPath: "/two", resolved: true }),
        ],
      });
      const catalog = fixture.models.sessionCatalog;
      const sessions = catalog.sessions;
      const [active, , other] = sessions;
      catalog.resolvedHasMoreByProject["/one"] = true;
      catalog.resolvedHasMoreByProject["/two"] = true;
      const update =
        tag === "Snapshot"
          ? { _tag: "Snapshot" as const, revision: 1, sessions: [], hasMore: false }
          : {
              _tag: "Event" as const,
              revision: 1,
              event: { _tag: "Replaced" as const, sessions: [] },
            };
      for (let i = 0; i < 2; i += 1)
        applySessionCatalogGroupUpdate(catalog, { projectPath: "/one", resolved: true }, update);
      expect(catalog.sessions).toBe(sessions);
      expect(catalog.sessions).toEqual([active, other]);
      expect(catalog.resolvedHasMoreByProject).toEqual({
        "/one": tag === "Replaced",
        "/two": true,
      });
    },
  );

  it.each(["Snapshot", "Replaced"] as const)(
    "rejects duplicate IDs in %s before any mutation",
    (tag) => {
      const one = sessionSummary({ sessionId: "one", projectPath: "/one" });
      using fixture = createRendererStoreFixture({ sessions: [one] });
      const catalog = fixture.models.sessionCatalog;
      const sessions = catalog.sessions;
      const model = catalog.find("one");
      const before = toSnapshot(catalog);
      const incoming = [{ ...one, title: "Changed" }, one];
      expect(() =>
        applySessionCatalogGroupUpdate(
          catalog,
          { projectPath: "/one", resolved: false },
          tag === "Snapshot"
            ? { _tag: "Snapshot", revision: 1, sessions: incoming }
            : { _tag: "Event", revision: 1, event: { _tag: "Replaced", sessions: incoming } },
        ),
      ).toThrow("Session ID collision: one");
      expect(catalog.sessions).toBe(sessions);
      expect(catalog.find("one")).toBe(model);
      expect(toSnapshot(catalog)).toEqual(before);
    },
  );

  it("rolls back earlier row updates and additions when a later snapshot row fails", () => {
    const one = sessionSummary({
      sessionId: "one",
      projectPath: "/one",
      familyChildSessionIds: ["child"],
    });
    const two = sessionSummary({ sessionId: "two", projectPath: "/one" });
    using fixture = createRendererStoreFixture({ sessions: [one, two] });
    const catalog = fixture.models.sessionCatalog;
    const sessions = catalog.sessions;
    const models = [...sessions];
    const before = toSnapshot(catalog);
    let visibleUpdates = 0;
    const stop = effect(() => {
      catalog.sessions.map((session) => session.title);
      visibleUpdates += 1;
    });
    try {
      expect(() =>
        applySessionCatalogGroupUpdate(
          catalog,
          { projectPath: "/one", resolved: false },
          {
            _tag: "Snapshot",
            revision: 1,
            sessions: [
              { ...one, title: "Changed", familyChildSessionIds: ["replacement"] },
              sessionSummary({ sessionId: "new", projectPath: "/one" }),
              {
                ...two,
                get title(): string {
                  throw new Error("bad row");
                },
              },
            ],
          },
        ),
      ).toThrow("bad row");
      expect(catalog.sessions).toBe(sessions);
      expect(catalog.sessions).toEqual(models);
      expect(toSnapshot(catalog)).toEqual(before);
      expect(catalog.find("new")).toBeUndefined();
      // Batching prevents partial state from escaping; rollback may still notify once.
      expect(visibleUpdates).toBeLessThanOrEqual(2);
    } finally {
      stop();
    }
  });

  it("restores removed rows, additions, metadata and pagination if snapshot completion fails", () => {
    const one = sessionSummary({ sessionId: "one", projectPath: "/one", resolved: true });
    const removed = sessionSummary({ sessionId: "removed", projectPath: "/one", resolved: true });
    using fixture = createRendererStoreFixture({ sessions: [one, removed] });
    const catalog = fixture.models.sessionCatalog;
    catalog.resolvedHasMoreByProject["/one"] = true;
    const sessions = catalog.sessions;
    const models = [...sessions];
    const before = toSnapshot(catalog);
    expect(() =>
      applySessionCatalogGroupUpdate(
        catalog,
        { projectPath: "/one", resolved: true },
        {
          _tag: "Snapshot",
          revision: 1,
          sessions: [
            { ...one, title: "Changed" },
            sessionSummary({ sessionId: "new", projectPath: "/one", resolved: true }),
          ],
          get hasMore(): boolean {
            throw new Error("bad pagination");
          },
        },
      ),
    ).toThrow("bad pagination");
    expect(catalog.sessions).toBe(sessions);
    expect(catalog.sessions).toEqual(models);
    expect(toSnapshot(catalog)).toEqual(before);
    expect(models.every((model) => model.parent === catalog)).toBe(true);
  });

  it("avoids legacy membership/group invalidations for eight lane refreshes across 1,000 sessions", () => {
    const records = Array.from({ length: 1_000 }, (_, index) =>
      sessionSummary({
        sessionId: `session-${index}`,
        projectPath: `/project-${Math.floor(index / 50)}`,
      }),
    );
    using incremental = createRendererStoreFixture({ sessions: records });
    using legacy = createRendererStoreFixture({ sessions: records });
    const runs = {
      incremental: { membership: 0, unrelated: 0 },
      legacy: { membership: 0, unrelated: 0 },
    };
    const stops = [
      { fixture: incremental, counts: runs.incremental },
      { fixture: legacy, counts: runs.legacy },
    ].flatMap(({ fixture, counts }) => {
      return [
        effect(() => {
          fixture.models.sessionCatalog.sessions.map((session) => session.sessionId);
          counts.membership += 1;
        }),
        effect(() => {
          fixture.root.sessionCatalogStore.projectSessions("/project-19", false);
          counts.unrelated += 1;
        }),
      ];
    });
    let retainedSnapshots = 0;
    try {
      for (let revision = 1; revision <= 8; revision += 1) {
        const incoming = records.slice(0, 50).map((session) => ({
          ...session,
          title: revision <= 4 ? session.title : `Updated ${revision}`,
        }));
        applySessionCatalogGroupUpdate(
          incremental.models.sessionCatalog,
          { projectPath: "/project-0", resolved: false },
          {
            _tag: "Snapshot",
            revision,
            sessions: incoming,
          },
        );
        // The previous reducer's valid-snapshot path, retained only as a deterministic
        // comparison. Counts are reactive executions, not React commits or wall time.
        const model = legacy.models.sessionCatalog;
        const sessions = [
          ...model.sessions
            .filter((session) => session.projectPath !== "/project-0")
            .map((session) => {
              retainedSnapshots += 1;
              return toSnapshot(session);
            }),
          ...incoming,
        ];
        sessions.sort(
          (left, right) =>
            Number(left.resolved) - Number(right.resolved) ||
            (right.modifiedAt ?? "").localeCompare(left.modifiedAt ?? ""),
        );
        batch(() =>
          applySnapshot(model, {
            sessions,
            resolvedHasMoreByProject: { ...model.resolvedHasMoreByProject },
          }),
        );
      }
      expect(runs).toEqual({
        incremental: { membership: 1, unrelated: 1 },
        legacy: { membership: 9, unrelated: 9 },
      });
      expect(retainedSnapshots).toBe(7_600);
      expect(toSnapshot(incremental.models.sessionCatalog).sessions).toEqual(
        expect.arrayContaining(toSnapshot(legacy.models.sessionCatalog).sessions!),
      );
    } finally {
      stops.forEach((stop) => stop());
    }
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
