import { createStore, mount } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { Client } from "../../../../src/renderer/client/Client";
import type { WorktreeRecord } from "../../../../src/domain/worktrees/managed-worktree-data";
import type { SessionCatalogStore } from "../../../../src/renderer/stores/SessionCatalogStore";
import { SessionOperationCoordinatorStore } from "../../../../src/renderer/stores/SessionOperationCoordinatorStore";
import { WorktreeCreationStore } from "../../../../src/renderer/stores/WorktreeCreationStore";
import { mountWithClient } from "../mount-with-client";

const worktree: WorktreeRecord = {
  projectPath: "/project",
  worktreePath: "/.project-worktrees/planned-work",
  branch: "agent/planned-work",
  baseBranch: "main",
  state: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((complete) => (resolve = complete)),
    resolve,
  };
}

describe("WorktreeCreationStore", () => {
  it("uses a saved draft's session name for its new worktree", async () => {
    const create = vi.fn(async () => worktree);
    const notePendingManagedWorktree = vi.fn();
    const relocateTemporarySession = vi.fn();
    const operations = mount(createStore(SessionOperationCoordinatorStore));
    const client = { managedWorktrees: { create } } as unknown as Client;
    const mounted = mountWithClient(
      createStore(WorktreeCreationStore, {
        operations,
        catalog: {
          managedWorktree: vi.fn(),
          notePendingManagedWorktree,
        } as unknown as SessionCatalogStore,
        relocateTemporarySession,
        reportError: vi.fn(),
      }),
      client,
    );

    try {
      mounted.subject.select("draft-1", { kind: "new" });

      await expect(
        mounted.subject.prepare(
          "draft-1",
          "/project",
          "Implement the planned work",
          "Planned Work",
        ),
      ).resolves.toBe(true);

      expect(create).toHaveBeenCalledWith({
        operationId: expect.any(String),
        path: "/project",
        baseWorktreePath: undefined,
        worktreeName: "planned-work",
        firstUserMessage: "Implement the planned work",
        backgroundSetup: true,
      });
      expect(notePendingManagedWorktree).toHaveBeenCalledWith(worktree);
      expect(relocateTemporarySession).toHaveBeenCalledWith("draft-1", worktree.worktreePath);
    } finally {
      mounted.root[Symbol.dispose]();
      operations[Symbol.dispose]();
    }
  });

  it("prepares different sessions concurrently", async () => {
    const first = deferred<WorktreeRecord>();
    const second = deferred<WorktreeRecord>();
    const create = vi
      .fn<() => Promise<WorktreeRecord>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const operations = mount(createStore(SessionOperationCoordinatorStore));
    const mounted = mountWithClient(
      createStore(WorktreeCreationStore, {
        operations,
        catalog: {
          managedWorktree: vi.fn(),
          notePendingManagedWorktree: vi.fn(),
        } as unknown as SessionCatalogStore,
        relocateTemporarySession: vi.fn(),
        reportError: vi.fn(),
      }),
      { managedWorktrees: { create } } as unknown as Client,
    );

    try {
      mounted.subject.select("session-1", { kind: "new" });
      mounted.subject.select("session-2", { kind: "new" });
      const preparingFirst = mounted.subject.prepare("session-1", "/project", "First");
      const preparingSecond = mounted.subject.prepare("session-2", "/project", "Second");

      expect(create).toHaveBeenCalledTimes(2);
      expect(mounted.subject.isPreparing("session-1")).toBe(true);
      expect(mounted.subject.isPreparing("session-2")).toBe(true);

      first.resolve(worktree);
      second.resolve({ ...worktree, worktreePath: "/.project-worktrees/second" });
      await expect(Promise.all([preparingFirst, preparingSecond])).resolves.toEqual([true, true]);
      expect(mounted.subject.isPreparing("session-1")).toBe(false);
      expect(mounted.subject.isPreparing("session-2")).toBe(false);
    } finally {
      mounted.root[Symbol.dispose]();
      operations[Symbol.dispose]();
    }
  });
});
