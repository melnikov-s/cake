import { createStore, mount } from "r-state-tree";
import { describe, expect, it } from "vitest";
import { SessionCatalog } from "../../../../src/renderer/models/SessionCatalog";
import { WorktreeCatalog } from "../../../../src/renderer/models/WorktreeCatalog";
import { applyManagedWorktreeCatalogUpdate } from "../../../../src/renderer/reducers/WorktreeCatalogReducer";
import { SessionCatalogStore } from "../../../../src/renderer/stores/SessionCatalogStore";

const active = {
  projectPath: "/project",
  worktreePath: "/worktree",
  branch: "agent/change",
  baseBranch: "main",
  state: "active" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const summary = (sessionId: string) => ({
  sessionId,
  title: sessionId,
  createdAt: active.createdAt,
  modifiedAt: active.createdAt,
  messageCount: 1,
  resolved: false,
  unread: false,
  projectPath: active.projectPath,
  projectName: "Project",
  workingDirectory: active.worktreePath,
  pending: false,
  draft: false,
});

describe("Managed Worktree catalog projection", () => {
  it("applies a current snapshot then preserves entity identity across lifecycle events", () => {
    const catalog = WorktreeCatalog.create();
    applyManagedWorktreeCatalogUpdate(catalog, { _tag: "Snapshot", worktrees: [active] });
    const projected = catalog.find(active.worktreePath);

    applyManagedWorktreeCatalogUpdate(catalog, {
      _tag: "Event",
      event: { _tag: "Upserted", worktree: { ...active, state: "landed" } },
    });

    expect(catalog.find(active.worktreePath)).toBe(projected);
    expect(projected?.state).toBe("landed");
  });

  it("updates one shared worktree for every session joined by Working Directory", () => {
    const worktrees = WorktreeCatalog.create({ worktrees: [active] });
    const sessions = SessionCatalog.create({ sessions: [summary("one"), summary("two")] });
    const store = mount(createStore(SessionCatalogStore, { model: sessions, worktrees }));
    const before = sessions.sessions.map((session) =>
      store.managedWorktree(session.workingDirectory),
    );

    applyManagedWorktreeCatalogUpdate(worktrees, {
      _tag: "Event",
      event: { _tag: "Upserted", worktree: { ...active, state: "landed" } },
    });

    const after = sessions.sessions.map((session) =>
      store.managedWorktree(session.workingDirectory),
    );
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[0]);
    expect(after.map((worktree) => worktree?.state)).toEqual(["landed", "landed"]);
    expect(sessions.sessions.every((session) => !("managedWorktree" in session))).toBe(true);
    store[Symbol.dispose]();
  });
});
