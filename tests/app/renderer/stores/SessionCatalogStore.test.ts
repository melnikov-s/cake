import { applySnapshot, createStore, effect, mount, toSnapshot } from "r-state-tree";
import { describe, expect, it } from "vitest";
import type { WorktreeRecord } from "../../../../src/contracts/worktrees/managed-worktree-data";
import { SessionCatalog } from "../../../../src/renderer/models/SessionCatalog";
import { WorktreeCatalog } from "../../../../src/renderer/models/WorktreeCatalog";
import { SessionCatalogStore } from "../../../../src/renderer/stores/SessionCatalogStore";
import { applySessionCatalogGroupUpdate } from "../../../../src/renderer/reducers/CatalogReducer";

const worktree = (state: WorktreeRecord["state"] = "active"): WorktreeRecord => ({
  projectPath: "/project",
  worktreePath: "/worktree",
  branch: "agent/session",
  baseBranch: "main",
  state,
  createdAt: new Date(0).toISOString(),
});

const session = (sessionId: string, modifiedAt: string, worktreePath?: string) => ({
  sessionId,
  title: sessionId,
  createdAt: modifiedAt,
  modifiedAt,
  messageCount: 1,
  resolved: false,
  unread: false,
  projectPath: "/project",
  projectName: "project",
  workingDirectory: worktreePath ?? "/project",
  pending: false,
  draft: false,
});

// Migration backlog: referential cache stability and derivation isolation are internal
// performance contracts, and pending-worktree authority handoff has no complete UI fixture yet.
// Visible ordering and pending-title authority handoff now live in session-catalog-workflow.test.tsx.
describe("SessionCatalogStore internal contract migration backlog", () => {
  it("joins sessions to the shared authoritative worktree catalog", () => {
    const model = SessionCatalog.create({
      sessions: [
        session("newer", "2026-01-02T00:00:00.000Z", "/worktree"),
        session("older", "2026-01-01T00:00:00.000Z"),
      ],
    });
    const worktrees = WorktreeCatalog.create({ worktrees: [worktree()] });
    const store = mount(createStore(SessionCatalogStore, { model, worktrees }));

    const firstProjectSessions = store.projectSessions("/project");
    expect(store.projectSessions("/project")).toBe(firstProjectSessions);
    expect(store.find("newer")).toBe(firstProjectSessions[0]);
    expect(store.managedWorktree("/worktree")).toBe(worktrees.worktrees[0]);

    applySnapshot(model, {
      sessions: [
        ...model.sessions.map((current) => toSnapshot(current)),
        session("newest", "2026-01-03T00:00:00.000Z"),
      ],
    });

    expect(store.projectSessions("/project")).not.toBe(firstProjectSessions);
    expect(store.projectSessions("/project").map((current) => current.sessionId)).toEqual([
      "newest",
      "newer",
      "older",
    ]);
    store[Symbol.dispose]();
  });

  it("does not invalidate one Project group for another Project's metadata update", () => {
    const model = SessionCatalog.create({
      sessions: [
        session("project-session", "2026-01-02T00:00:00.000Z"),
        {
          ...session("other-session", "2026-01-01T00:00:00.000Z"),
          projectPath: "/other",
          projectName: "other",
          workingDirectory: "/other",
        },
      ],
    });
    const store = mount(
      createStore(SessionCatalogStore, { model, worktrees: WorktreeCatalog.create() }),
    );
    let otherProjectDerivations = 0;
    const stop = effect(() => {
      store.projectSessions("/other").map((current) => [current.sessionId, current.title]);
      otherProjectDerivations += 1;
    });

    applySessionCatalogGroupUpdate(
      model,
      { projectPath: "/project", resolved: false },
      {
        _tag: "Event",
        revision: 2,
        event: {
          _tag: "Upserted",
          session: {
            ...session("project-session", "2026-01-03T00:00:00.000Z"),
            title: "Updated",
          },
        },
      },
    );
    applySessionCatalogGroupUpdate(
      model,
      { projectPath: "/project", resolved: false },
      {
        _tag: "Event",
        revision: 3,
        event: {
          _tag: "StatusChanged",
          sessionId: "project-session",
          resolved: true,
          unread: false,
        },
      },
    );
    applySessionCatalogGroupUpdate(
      model,
      { projectPath: "/project", resolved: true },
      {
        _tag: "Event",
        revision: 2,
        event: {
          _tag: "Upserted",
          session: {
            ...session("project-session", "2026-01-03T00:00:00.000Z"),
            title: "Updated",
            resolved: true,
          },
        },
      },
    );

    expect(otherProjectDerivations).toBe(1);
    stop();
    store[Symbol.dispose]();
  });

  it("uses a pending creation fact only until the authoritative worktree arrives", () => {
    const model = SessionCatalog.create({ sessions: [] });
    const worktrees = WorktreeCatalog.create();
    const pendingWorktree = worktree();
    const pending = [
      {
        ...session("session", "2026-01-01T00:00:00.000Z", "/worktree"),
        pending: true as const,
      },
    ];
    const store = mount(
      createStore(SessionCatalogStore, { model, worktrees, pendingSessions: () => pending }),
    );
    store.notePendingManagedWorktree(pendingWorktree);

    expect(store.managedWorktree("/worktree")).toBe(pendingWorktree);

    applySnapshot(worktrees, { worktrees: [worktree("landed")] });
    expect(store.managedWorktree("/worktree")).toBe(worktrees.worktrees[0]);
    expect(store.managedWorktree("/worktree")?.state).toBe("landed");
    applySnapshot(worktrees, { worktrees: [] });
    expect(store.managedWorktree("/worktree")).toBeUndefined();
    store[Symbol.dispose]();
  });
});
