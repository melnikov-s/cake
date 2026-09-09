import { applySnapshot, createStore, mount, toSnapshot } from "r-state-tree";
import { describe, expect, it } from "vitest";
import type { WorktreeRecord } from "../../../../src/domain/worktrees/managed-worktree-data";
import { SessionCatalog } from "../../../../src/renderer/models/SessionCatalog";
import { WorktreeCatalog } from "../../../../src/renderer/models/WorktreeCatalog";
import { SessionCatalogStore } from "../../../../src/renderer/stores/SessionCatalogStore";

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

describe("SessionCatalogStore indexes", () => {
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

  it("pins saved drafts but does not mistake lightweight Pi metadata for unsent sessions", () => {
    const model = SessionCatalog.create({
      sessions: [
        { ...session("older-pi-session", "2026-01-01T00:00:00.000Z"), messageCount: 0 },
        {
          ...session("draft", "2025-12-31T00:00:00.000Z"),
          messageCount: 0,
          draft: true,
        },
      ],
    });
    const pending = [
      {
        ...session("activating-session", "2026-01-03T00:00:00.000Z"),
        pending: true as const,
      },
    ];
    const store = mount(
      createStore(SessionCatalogStore, {
        model,
        worktrees: WorktreeCatalog.create(),
        pendingSessions: () => pending,
      }),
    );

    expect(store.projectSessions("/project").map((current) => current.sessionId)).toEqual([
      "draft",
      "activating-session",
      "older-pi-session",
    ]);
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

  it("shows the first-message projection until the authoritative Pi summary arrives", () => {
    const model = SessionCatalog.create({ sessions: [] });
    const pending = [
      {
        ...session("new-session", "2026-01-03T00:00:00.000Z"),
        title: "Hi",
        pending: true as const,
      },
    ];
    const store = mount(
      createStore(SessionCatalogStore, {
        model,
        worktrees: WorktreeCatalog.create(),
        pendingSessions: () => pending,
      }),
    );

    expect(store.sessions).toMatchObject([
      {
        sessionId: "new-session",
        title: "Hi",
        messageCount: 1,
        pending: true,
      },
    ]);

    applySnapshot(model, {
      sessions: [
        {
          ...session("new-session", "2026-01-03T00:00:00.000Z"),
          title: "Authoritative Pi title",
        },
      ],
    });

    expect(store.sessions).toHaveLength(1);
    expect(store.find("new-session")).toMatchObject({
      title: "Authoritative Pi title",
      pending: false,
    });
    store[Symbol.dispose]();
  });
});
