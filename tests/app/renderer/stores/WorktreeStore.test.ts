import { createStore, mount } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorktreeStatus } from "../../../../src/ipc/worktree-contract";
import { WorktreeStore } from "../../../../src/renderer/stores/WorktreeStore";

const status: WorktreeStatus = {
  record: {
    projectPath: "/project",
    worktreePath: "/project-worktree",
    branch: "agent/session",
    baseBranch: "main",
    createdAt: new Date(0).toISOString(),
  },
  targetBranch: "main",
  dirtyCount: 0,
  aheadCount: 1,
  merged: false,
  targetDirty: false,
  targetOnBranch: true,
  merging: false,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createTestStore(
  getWorktreeStatus: (input: {
    workspacePath: string;
  }) => Promise<WorktreeStatus | undefined> = vi.fn(async () => status),
) {
  const client = {
    getWorktreeStatus,
    getWorkspaceGitStatus: vi.fn(async ({ workspacePath }) => ({ workspacePath, dirtyCount: 0 })),
    commitWorkspace: vi.fn(async () => ({ commit: "commit" })),
    landWorktree: vi.fn(async () => ({ outcome: "landed" as const })),
    discardWorktree: vi.fn(async () => undefined),
    submit: vi.fn(async () => undefined),
  };
  const store = mount(
    createStore(WorktreeStore, {
      client,
      workspacePath: () => "/project-worktree",
      sessionId: () => "session-1",
      sessionTitle: () => "Test session",
      isStreaming: () => false,
      onLanded: vi.fn(),
      onResolveWorkspace: vi.fn(),
    }),
  );
  return { store, client };
}

afterEach(() => vi.useRealTimers());

describe("WorktreeStore", () => {
  it("schedules the next poll only after the current refresh settles", async () => {
    vi.useFakeTimers();
    const first = deferred<WorktreeStatus | undefined>();
    const getWorktreeStatus = vi
      .fn<() => Promise<WorktreeStatus | undefined>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(status);
    const { store } = createTestStore(getWorktreeStatus);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(getWorktreeStatus).toHaveBeenCalledOnce();

    first.resolve(status);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getWorktreeStatus).toHaveBeenCalledTimes(2);
    store[Symbol.dispose]();
  });

  it("does not commit a refresh that settles after disposal", async () => {
    const pending = deferred<WorktreeStatus | undefined>();
    const { store } = createTestStore(vi.fn(() => pending.promise));
    store[Symbol.dispose]();

    pending.resolve(status);
    await pending.promise;
    await Promise.resolve();

    expect(store.status).toBeUndefined();
  });

  it("rejects concurrent public worktree operations", async () => {
    const landing = deferred<{ outcome: "landed" }>();
    const { store, client } = createTestStore();
    client.landWorktree.mockImplementationOnce(() => landing.promise);
    await vi.waitFor(() => expect(store.status).toEqual(status));

    const first = store.land();
    await expect(store.discard(false)).rejects.toThrow("already in progress");
    landing.resolve({ outcome: "landed" });
    await first;
    store[Symbol.dispose]();
  });
});
