import { createStore, mount } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { Client } from "../../../../src/renderer/client/Client";
import type { WorktreeRecord } from "../../../../src/ipc/worktree-contract";
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
      });
      expect(notePendingManagedWorktree).toHaveBeenCalledWith(worktree);
      expect(relocateTemporarySession).toHaveBeenCalledWith("draft-1", worktree.worktreePath);
    } finally {
      mounted.root[Symbol.dispose]();
      operations[Symbol.dispose]();
    }
  });
});
