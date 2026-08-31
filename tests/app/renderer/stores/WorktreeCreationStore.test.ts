import { createStore, mount } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import { SessionCatalogStore } from "../../../../src/renderer/stores/SessionCatalogStore";
import { SessionOperationCoordinatorStore } from "../../../../src/renderer/stores/SessionOperationCoordinatorStore";
import { WorktreeCreationStore } from "../../../../src/renderer/stores/WorktreeCreationStore";

const worktree = {
  projectPath: "/project",
  worktreePath: "/project-worktree",
  branch: "agent/feature",
  baseBranch: "main",
  createdAt: "2026-08-01T00:00:00.000Z",
};

describe("WorktreeCreationStore", () => {
  it("creates and catalogs a managed worktree for an external session workflow", async () => {
    const catalog = mount(createStore(SessionCatalogStore));
    const operations = mount(createStore(SessionOperationCoordinatorStore));
    const createWorktree = vi.fn(async () => worktree);
    const store = mount(
      createStore(WorktreeCreationStore, {
        client: { createWorktree },
        operations,
        catalog,
        relocateTemporarySession: vi.fn(),
        reportError: vi.fn(),
      }),
    );

    await expect(
      store.create("/project", { name: "feature", baseWorktreePath: "/parent-worktree" }),
    ).resolves.toEqual(worktree);
    expect(createWorktree).toHaveBeenCalledWith({
      operationId: expect.any(String),
      path: "/project",
      baseWorktreePath: "/parent-worktree",
      worktreeName: "feature",
    });
    expect(catalog.managedWorktree(worktree.worktreePath)).toEqual(worktree);
    expect(operations.active("project-workbench")).toEqual([]);

    store[Symbol.dispose]();
    operations[Symbol.dispose]();
    catalog[Symbol.dispose]();
  });

  it("passes the first prompt for utility naming before relocating a new worktree session", async () => {
    const catalog = mount(createStore(SessionCatalogStore));
    const operations = mount(createStore(SessionOperationCoordinatorStore));
    const createWorktree = vi.fn(async () => worktree);
    const relocateTemporarySession = vi.fn();
    const store = mount(
      createStore(WorktreeCreationStore, {
        client: { createWorktree },
        operations,
        catalog,
        relocateTemporarySession,
        reportError: vi.fn(),
      }),
    );
    store.select("session-1", { kind: "new" });

    await expect(
      store.prepare("session-1", "/project", "  Fix the login redirect  "),
    ).resolves.toBe(true);
    expect(createWorktree).toHaveBeenCalledWith({
      operationId: expect.any(String),
      path: "/project",
      baseWorktreePath: undefined,
      firstUserMessage: "Fix the login redirect",
    });
    expect(relocateTemporarySession).toHaveBeenCalledWith("session-1", worktree.worktreePath);

    store[Symbol.dispose]();
    operations[Symbol.dispose]();
    catalog[Symbol.dispose]();
  });

  it("includes the most recently active session title with an existing worktree", () => {
    const catalog = mount(createStore(SessionCatalogStore));
    const operations = mount(createStore(SessionOperationCoordinatorStore));
    catalog.replace([
      {
        id: "older",
        title: "Earlier approach",
        created: "2026-08-01T00:00:00.000Z",
        modified: "2026-08-02T00:00:00.000Z",
        messageCount: 1,
        resolved: false,
        unread: false,
        workspacePath: worktree.worktreePath,
        workspaceName: "project-worktree",
        projectPath: worktree.projectPath,
        managedWorktree: worktree,
      },
      {
        id: "newer",
        title: "Finish the feature",
        created: "2026-08-03T00:00:00.000Z",
        modified: "2026-08-04T00:00:00.000Z",
        messageCount: 1,
        resolved: false,
        unread: false,
        workspacePath: worktree.worktreePath,
        workspaceName: "project-worktree",
        projectPath: worktree.projectPath,
        managedWorktree: worktree,
      },
    ]);
    const store = mount(
      createStore(WorktreeCreationStore, {
        client: { createWorktree: vi.fn() },
        operations,
        catalog,
        relocateTemporarySession: vi.fn(),
        reportError: vi.fn(),
      }),
    );

    expect(store.candidates("/project")).toEqual([
      { ...worktree, sessionTitle: "Finish the feature" },
    ]);

    store[Symbol.dispose]();
    operations[Symbol.dispose]();
    catalog[Symbol.dispose]();
  });
});
