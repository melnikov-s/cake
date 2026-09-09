import { describe, expect, it } from "vitest";
import {
  applyCakeChatCatalogGroupUpdate,
  applyProjectCatalogUpdate,
  applySessionCatalogGroupUpdate,
} from "../../../../src/renderer/reducers/CatalogReducer";
import { CakeChatCatalog } from "../../../../src/renderer/models/CakeChatCatalog";
import { SessionCatalog } from "../../../../src/renderer/models/SessionCatalog";
import { ProjectCatalog } from "../../../../src/renderer/models/ProjectCatalog";

describe("CatalogReducer", () => {
  it("tracks whether each resolved catalog has another page", () => {
    const projectCatalog = SessionCatalog.create();
    const cakeChatCatalog = CakeChatCatalog.create();

    applySessionCatalogGroupUpdate(
      projectCatalog,
      { projectPath: "/project", resolved: true },
      { _tag: "Snapshot", revision: 1, sessions: [], hasMore: true },
    );
    applyCakeChatCatalogGroupUpdate(
      cakeChatCatalog,
      { resolved: true, limit: 10 },
      { _tag: "Snapshot", revision: 1, sessions: [], hasMore: true },
    );

    expect(projectCatalog.resolvedHasMoreByProject["/project"]).toBe(true);
    expect(cakeChatCatalog.resolvedHasMore).toBe(true);
    projectCatalog[Symbol.dispose]();
    cakeChatCatalog[Symbol.dispose]();
  });

  it("projects Project workflow changes", () => {
    const catalog = ProjectCatalog.create();
    applyProjectCatalogUpdate(catalog, {
      _tag: "Snapshot",
      revision: 1,
      projects: [
        {
          path: "/project",
          name: "Project",
          addedAt: "2026-01-01T00:00:00.000Z",
          lastOpenedAt: "2026-01-01T00:00:00.000Z",
          workflow: {
            columns: [
              {
                id: "b925b5dd-9661-4f1a-9f40-406be3c96c27",
                name: "Blocked",
                color: "rose",
              },
            ],
            assignments: [],
            sessionDetails: [],
          },
        },
      ],
    });

    expect(catalog.projects[0]?.workflow.columns[0]?.name).toBe("Blocked");
    catalog[Symbol.dispose]();
  });

  it("does not let one Project Session catalog lane mutate another lane's summary", () => {
    const catalog = SessionCatalog.create({
      sessions: [
        {
          sessionId: "session-1",
          title: "Session",
          createdAt: "2026-01-01T00:00:00.000Z",
          modifiedAt: "2026-01-01T00:00:00.000Z",
          messageCount: 1,
          resolved: true,
          unread: false,
          projectPath: "/project",
          projectName: "Project",
          workingDirectory: "/project",
        },
      ],
    });

    applySessionCatalogGroupUpdate(
      catalog,
      { projectPath: "/project", resolved: false },
      {
        _tag: "Event",
        revision: 2,
        event: {
          _tag: "StatusChanged",
          sessionId: "session-1",
          resolved: false,
          unread: false,
        },
      },
    );

    expect(catalog.sessions).toHaveLength(1);
    expect(catalog.sessions[0]?.resolved).toBe(true);
    catalog[Symbol.dispose]();
  });

  it("does not let a late active-lane removal delete a resolved summary", () => {
    const catalog = SessionCatalog.create({
      sessions: [
        {
          sessionId: "session-1",
          title: "Session",
          createdAt: "2026-01-01T00:00:00.000Z",
          modifiedAt: "2026-01-01T00:00:00.000Z",
          messageCount: 1,
          resolved: true,
          unread: false,
          projectPath: "/project",
          projectName: "Project",
          workingDirectory: "/project",
        },
      ],
    });

    applySessionCatalogGroupUpdate(
      catalog,
      { projectPath: "/project", resolved: false },
      {
        _tag: "Event",
        revision: 2,
        event: { _tag: "Removed", sessionId: "session-1" },
      },
    );

    expect(catalog.sessions).toHaveLength(1);
    expect(catalog.sessions[0]?.resolved).toBe(true);
    catalog[Symbol.dispose]();
  });

  it("moves a Cake Chat summary between lanes without replacing the catalog", () => {
    const catalog = CakeChatCatalog.create({
      loaded: true,
      sessions: [
        {
          sessionId: "session-1",
          title: "Session",
          createdAt: "2026-01-01T00:00:00.000Z",
          modifiedAt: "2026-01-01T00:00:00.000Z",
          messageCount: 1,
          resolved: false,
        },
      ],
    });

    applyCakeChatCatalogGroupUpdate(
      catalog,
      { resolved: false },
      {
        _tag: "Event",
        revision: 2,
        event: { _tag: "StatusChanged", sessionId: "session-1", resolved: true },
      },
    );

    expect(catalog.sessions).toHaveLength(1);
    expect(catalog.sessions[0]?.resolved).toBe(true);
    catalog[Symbol.dispose]();
  });
});

it("updates project entries without resnapshotting unrelated workflow state", () => {
  const catalog = ProjectCatalog.create();
  const record = (path: string) => ({
    path,
    name: path,
    addedAt: "2026-01-01",
    lastOpenedAt: "2026-01-01",
  });
  applyProjectCatalogUpdate(catalog, {
    _tag: "Snapshot",
    revision: 1,
    projects: [record("/one"), record("/two")],
  });
  const first = catalog.projects[0]!;
  const second = catalog.projects[1]!;
  const workflow = second.workflow;
  const projects = catalog.projects;
  applyProjectCatalogUpdate(catalog, {
    _tag: "Event",
    revision: 2,
    event: { _tag: "Upserted", project: { ...record("/one"), name: "Updated" } },
  });
  expect(catalog.projects).toBe(projects);
  expect(catalog.projects[0]).toBe(first);
  expect(first.name).toBe("Updated");
  expect(second.workflow).toBe(workflow);
  applyProjectCatalogUpdate(catalog, {
    _tag: "Event",
    revision: 3,
    event: { _tag: "Removed", path: "/one" },
  });
  expect(catalog.projects).toEqual([second]);
  expect(second.workflow).toBe(workflow);
  catalog[Symbol.dispose]();
});

it("upserts a batch in place and preserves ordering and other lanes", () => {
  const record = (sessionId: string, modifiedAt: string) => ({
    sessionId,
    modifiedAt,
    createdAt: "2026-01-01",
    title: sessionId,
    messageCount: 1,
    resolved: false,
    unread: false,
    projectPath: "/project",
    projectName: "Project",
    workingDirectory: "/project",
  });
  const catalog = SessionCatalog.create({
    sessions: [
      { ...record("one", "2026-01-01"), parentSessionId: "parent" },
      { ...record("resolved", "2026-01-03"), resolved: true },
    ],
  });
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
  expect(catalog.sessions.map((session) => session.sessionId)).toEqual(["two", "one", "resolved"]);
  applySessionCatalogGroupUpdate(catalog, query, {
    _tag: "Event",
    revision: 2,
    event: {
      _tag: "StatusChanged",
      sessionId: "two",
      resolved: true,
      unread: true,
    },
  });
  expect(catalog.sessions.map((session) => session.sessionId)).toEqual(["one", "two", "resolved"]);
  expect(catalog.find("two")?.unread).toBe(true);
  applySessionCatalogGroupUpdate(catalog, query, {
    _tag: "Event",
    revision: 3,
    event: { _tag: "RemovedBatch", sessionIds: ["one", "two"] },
  });
  expect(catalog.sessions.map((session) => session.sessionId)).toEqual(["two", "resolved"]);
  catalog[Symbol.dispose]();
});

it("reconciles overlapping active and resolved snapshots during a resolve transition", () => {
  const active = {
    sessionId: "moving-session",
    modifiedAt: "2026-01-02",
    createdAt: "2026-01-01",
    title: "Moving",
    messageCount: 1,
    resolved: false,
    unread: false,
    projectPath: "/project",
    projectName: "Project",
    workingDirectory: "/project",
  };
  const catalog = SessionCatalog.create();

  applySessionCatalogGroupUpdate(
    catalog,
    { projectPath: "/project", resolved: false },
    { _tag: "Snapshot", revision: 1, sessions: [active] },
  );
  applySessionCatalogGroupUpdate(
    catalog,
    { projectPath: "/project", resolved: true },
    {
      _tag: "Snapshot",
      revision: 1,
      sessions: [{ ...active, resolved: true, workingDirectory: "/resolved/project" }],
    },
  );

  expect(catalog.sessions).toHaveLength(1);
  expect(catalog.sessions[0]?.sessionId).toBe("moving-session");
  expect(catalog.sessions[0]?.resolved).toBe(true);
  catalog[Symbol.dispose]();
});

it("reports the colliding IDs while preserving cross-project identity safeguards", () => {
  const record = (projectPath: string) => ({
    sessionId: "duplicate-session",
    modifiedAt: "2026-01-02",
    createdAt: "2026-01-01",
    title: "Duplicate",
    messageCount: 1,
    resolved: false,
    unread: false,
    projectPath,
    projectName: projectPath,
    workingDirectory: projectPath,
  });
  const catalog = SessionCatalog.create({ sessions: [record("/one")] });

  expect(() =>
    applySessionCatalogGroupUpdate(
      catalog,
      { projectPath: "/two", resolved: false },
      { _tag: "Snapshot", revision: 1, sessions: [record("/two")] },
    ),
  ).toThrow("Session ID collision: duplicate-session (snapshot for /two)");
  catalog[Symbol.dispose]();
});

it("upserts and removes Cake Chat summaries while retaining existing Models", () => {
  const catalog = CakeChatCatalog.create();
  const record = (sessionId: string, modifiedAt: string) => ({
    sessionId,
    modifiedAt,
    createdAt: "2026-01-01",
    title: sessionId,
    messageCount: 1,
    resolved: false,
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
    event: {
      _tag: "Upserted",
      session: record("two", "2026-01-02"),
    },
  });
  applyCakeChatCatalogGroupUpdate(catalog, query, {
    _tag: "Event",
    revision: 3,
    event: {
      _tag: "Upserted",
      session: { ...record("one", "2026-01-03"), title: "Updated" },
    },
  });
  expect(catalog.sessions).toBe(sessions);
  expect(catalog.find("one")).toBe(one);
  expect(one?.title).toBe("Updated");
  expect(catalog.sessions.map((session) => session.sessionId)).toEqual(["one", "two"]);
  applyCakeChatCatalogGroupUpdate(catalog, query, {
    _tag: "Event",
    revision: 4,
    event: { _tag: "Removed", sessionId: "two" },
  });
  expect(catalog.sessions).toEqual([one]);
  catalog[Symbol.dispose]();
});
