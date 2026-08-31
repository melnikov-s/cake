import { Effect, Layer, Queue } from "effect";
import { mount as mountEffectStore } from "effect-state-tree";
import { createStore, mount } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import { CakeIpcClient } from "../../../../src/ipc/client/CakeIpcClient";
import { SessionCatalogStoreFactory } from "../../../../src/renderer/stores/SessionCatalogStore";
import { SessionOperationCoordinatorStore } from "../../../../src/renderer/stores/SessionOperationCoordinatorStore";
import { WorktreeCreationStore } from "../../../../src/renderer/stores/WorktreeCreationStore";
import { makeCatalogTestClient } from "./catalog-test-client";

const worktree = {
  projectPath: "/project",
  worktreePath: "/project-worktree",
  branch: "agent/feature",
  baseBranch: "main",
  createdAt: "2026-08-01T00:00:00.000Z",
};

async function mountCatalog() {
  const controlled = await Effect.runPromise(makeCatalogTestClient());
  const handle = await Effect.runPromise(
    mountEffectStore(SessionCatalogStoreFactory, {
      managedWorktrees: [],
      loading: true,
      revision: 0,
      sourceRevision: -1,
    }).pipe(Effect.provide(Layer.succeed(CakeIpcClient)(controlled.client))),
  );
  await Effect.runPromise(
    Queue.offer(controlled.sessionUpdates, { _tag: "Snapshot", revision: 1, sessions: [] }),
  );
  await Effect.runPromise(handle.instance.awaitHydrated());
  return handle;
}

describe("WorktreeCreationStore", () => {
  it("creates and catalogs a managed worktree for an external session workflow", async () => {
    const catalog = await mountCatalog();
    const operations = mount(createStore(SessionOperationCoordinatorStore));
    const createWorktree = vi.fn(async () => worktree);
    const store = mount(
      createStore(WorktreeCreationStore, {
        client: { createWorktree },
        operations,
        catalog: catalog.instance,
        relocateTemporarySession: vi.fn(),
        reportError: vi.fn(),
      }),
    );
    await expect(
      store.create("/project", { name: "feature", baseWorktreePath: "/parent-worktree" }),
    ).resolves.toEqual(worktree);
    expect(catalog.instance.managedWorktree(worktree.worktreePath)).toEqual(worktree);
    store[Symbol.dispose]();
    operations[Symbol.dispose]();
    await Effect.runPromise(catalog.dispose);
  });

  it("passes the first prompt before relocating a new worktree session", async () => {
    const catalog = await mountCatalog();
    const operations = mount(createStore(SessionOperationCoordinatorStore));
    const createWorktree = vi.fn(async () => worktree);
    const relocateTemporarySession = vi.fn();
    const store = mount(
      createStore(WorktreeCreationStore, {
        client: { createWorktree },
        operations,
        catalog: catalog.instance,
        relocateTemporarySession,
        reportError: vi.fn(),
      }),
    );
    store.select("session-1", { kind: "new" });
    await expect(
      store.prepare("session-1", "/project", "  Fix the login redirect  "),
    ).resolves.toBe(true);
    expect(createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ firstUserMessage: "Fix the login redirect" }),
    );
    expect(relocateTemporarySession).toHaveBeenCalledWith("session-1", worktree.worktreePath);
    store[Symbol.dispose]();
    operations[Symbol.dispose]();
    await Effect.runPromise(catalog.dispose);
  });

  it("includes the most recently active session title with an existing worktree", async () => {
    const catalog = await mountCatalog();
    const operations = mount(createStore(SessionOperationCoordinatorStore));
    await Effect.runPromise(
      catalog.instance.replace([
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
      ]),
    );
    const store = mount(
      createStore(WorktreeCreationStore, {
        client: { createWorktree: vi.fn() },
        operations,
        catalog: catalog.instance,
        relocateTemporarySession: vi.fn(),
        reportError: vi.fn(),
      }),
    );
    expect(store.candidates("/project")).toEqual([
      { ...worktree, sessionTitle: "Finish the feature" },
    ]);
    store[Symbol.dispose]();
    operations[Symbol.dispose]();
    await Effect.runPromise(catalog.dispose);
  });
});
