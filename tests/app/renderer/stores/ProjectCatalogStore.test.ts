import { createStore, mount } from "r-state-tree";
import { describe, expect, it } from "vitest";
import { ProjectCatalogStore } from "../../../../src/renderer/stores/ProjectCatalogStore";
import { SessionCatalogStore } from "../../../../src/renderer/stores/SessionCatalogStore";

describe("ProjectCatalogStore", () => {
  it("owns project records while preserving persisted order for project navigation", () => {
    const sessions = mount(createStore(SessionCatalogStore));
    sessions.replace([
      {
        id: "session-1",
        title: "Task",
        created: "",
        modified: "",
        messageCount: 1,
        resolved: false,
        unread: false,
        workspacePath: "/second",
        workspaceName: "old",
      },
    ]);
    const projects = mount(createStore(ProjectCatalogStore, { sessions }));

    projects.applyApplicationState({
      schemaVersion: 1,
      resolvedSessionIds: [],
      resolvedCakeChatSessionIds: [],
      unreadSessionIds: [],
      trustedProjectPaths: [],
      projects: [
        { path: "/first", name: "First", addedAt: "", lastOpenedAt: "" },
        { path: "/second", name: "Second", addedAt: "", lastOpenedAt: "" },
      ],
    });
    projects.restoreRecentPaths(["/second", "/first"]);

    expect(projects.recentProjectPaths).toEqual(["/second", "/first"]);
    expect(projects.nameForPath("/second")).toBe("Second");
    expect(sessions.find("session-1")?.workspaceName).toBe("Second");
    projects[Symbol.dispose]();
    sessions[Symbol.dispose]();
  });

  it("orders projects by the most recently modified session", () => {
    const sessions = mount(createStore(SessionCatalogStore));
    sessions.replace([
      {
        id: "older-session",
        title: "Older",
        created: "2026-08-01T00:00:00.000Z",
        modified: "2026-08-02T00:00:00.000Z",
        messageCount: 1,
        resolved: false,
        unread: false,
        workspacePath: "/first",
        workspaceName: "First",
      },
      {
        id: "newer-session",
        title: "Newer",
        created: "2026-08-03T00:00:00.000Z",
        modified: "2026-08-04T00:00:00.000Z",
        messageCount: 1,
        resolved: false,
        unread: false,
        workspacePath: "/second",
        workspaceName: "Second",
      },
    ]);
    const projects = mount(createStore(ProjectCatalogStore, { sessions }));

    projects.applyApplicationState({
      schemaVersion: 1,
      resolvedSessionIds: [],
      resolvedCakeChatSessionIds: [],
      unreadSessionIds: [],
      trustedProjectPaths: [],
      projects: [
        { path: "/first", name: "First", addedAt: "", lastOpenedAt: "" },
        { path: "/second", name: "Second", addedAt: "", lastOpenedAt: "" },
      ],
    });
    projects.restoreRecentPaths(["/first", "/second"]);

    expect(projects.orderedProjectPaths).toEqual(["/second", "/first"]);
    projects[Symbol.dispose]();
    sessions[Symbol.dispose]();
  });
});

describe("ProjectCatalogStore managed worktrees", () => {
  it("presents managed worktree workspaces under their parent project's name", () => {
    const sessions = mount(createStore(SessionCatalogStore));
    const projects = mount(createStore(ProjectCatalogStore, { sessions }));

    // Before any listing exists, the association can be noted at creation time.
    sessions.noteManagedWorktree({
      projectPath: "/repo",
      worktreePath: "/repo/.cake-worktrees/repo-abc",
      branch: "agent/repo-abc",
      baseBranch: "main",
      createdAt: new Date(0).toISOString(),
    });
    projects.applyApplicationState({
      schemaVersion: 1,
      resolvedSessionIds: [],
      resolvedCakeChatSessionIds: [],
      unreadSessionIds: [],
      trustedProjectPaths: [],
      projects: [{ path: "/repo", name: "Repo", addedAt: "", lastOpenedAt: "" }],
    });

    expect(projects.nameForPath("/repo/.cake-worktrees/repo-abc")).toBe("Repo");

    // A listed session reinforces the association via its projectPath.
    sessions.replace([
      {
        id: "session-wt",
        title: "Worktree task",
        created: "",
        modified: "",
        messageCount: 1,
        resolved: false,
        unread: false,
        workspacePath: "/repo/.cake-worktrees/repo-abc",
        projectPath: "/repo",
        workspaceName: "Repo",
      },
    ]);
    expect(projects.nameForPath("/repo/.cake-worktrees/repo-abc")).toBe("Repo");

    projects[Symbol.dispose]();
    sessions[Symbol.dispose]();
  });
});
