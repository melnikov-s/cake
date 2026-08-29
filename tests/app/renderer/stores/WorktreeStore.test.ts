import { createStore, mount } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorktreeLandOutcome, WorktreeStatus } from "../../../../src/ipc/worktree-contract";
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
  rebasing: false,
  squashMessageReady: false,
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
    landWorktree: vi.fn<(input: { request: { strategy: string } }) => Promise<WorktreeLandOutcome>>(
      async () => ({ outcome: "landed" }),
    ),
    discardWorktree: vi.fn<(input: { keepBranch: boolean }) => Promise<void>>(
      async () => undefined,
    ),
    submit: vi.fn<(input: { sessionId: string; delivery: string; text: string }) => Promise<void>>(
      async () => undefined,
    ),
  };
  const onLanded = vi.fn();
  const onDiscarded = vi.fn();
  const onResolveWorkspace = vi.fn(async () => undefined);
  const store = mount(
    createStore(WorktreeStore, {
      client,
      workspacePath: () => "/project-worktree",
      sessionId: () => "session-1",
      enabled: () => true,
      isStreaming: () => false,
      onLanded,
      onDiscarded,
      onResolveWorkspace,
    }),
  );
  return { store, client, onLanded, onDiscarded, onResolveWorkspace };
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

  it("lands with the preserve strategy by default", async () => {
    const { store, client } = createTestStore();
    await vi.waitFor(() => expect(store.status).toEqual(status));

    await store.land();
    expect(client.landWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: "/project-worktree",
        request: { strategy: "preserve" },
      }),
    );
    expect(store.phase).toBe("idle");
    store[Symbol.dispose]();
  });

  it("asks the session to commit dirty changes and merges after the turn cleans the worktree", async () => {
    const dirtyStatus = { ...status, dirtyCount: 2, aheadCount: 0 };
    const { store, client } = createTestStore(vi.fn(async () => dirtyStatus));
    await vi.waitFor(() => expect(store.status).toEqual(dirtyStatus));

    await store.commitAndMerge();
    expect(store.phase).toBe("committing");
    expect(client.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        delivery: "prompt",
        text: expect.stringContaining("commit all intended work"),
      }),
    );
    expect(client.landWorktree).not.toHaveBeenCalled();

    vi.mocked(client.getWorktreeStatus).mockResolvedValue({ ...status, aheadCount: 1 });
    await store.refresh();
    expect(client.landWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ request: { strategy: "preserve" } }),
    );
    expect(store.status).toMatchObject({ merged: true, record: { state: "landed" } });
    store[Symbol.dispose]();
  });

  it("delegates resolution-time checkout cleanup to the workspace resolver", async () => {
    const { store, client, onResolveWorkspace } = createTestStore();
    await vi.waitFor(() => expect(store.status).toEqual(status));

    await store.resolve();

    expect(onResolveWorkspace).toHaveBeenCalledWith("/project-worktree");
    expect(client.discardWorktree).not.toHaveBeenCalled();
    store[Symbol.dispose]();
  });

  it("merges and resolves in one operation", async () => {
    const { store, client, onResolveWorkspace } = createTestStore();
    await vi.waitFor(() => expect(store.status).toEqual(status));

    await store.commitAndMerge(false, true);

    expect(client.landWorktree).toHaveBeenCalledOnce();
    expect(onResolveWorkspace).toHaveBeenCalledWith("/project-worktree");
    store[Symbol.dispose]();
  });

  it("projects a discarded record after cleanup", async () => {
    const { store, onDiscarded } = createTestStore();
    await vi.waitFor(() => expect(store.status).toEqual(status));

    await store.discard(false);

    expect(onDiscarded).toHaveBeenCalledWith(expect.objectContaining({ state: "discarded" }));
    store[Symbol.dispose]();
  });

  it("preserves dirty-target confirmation while a landing pauses and retries", async () => {
    const dirtyTargetStatus = { ...status, targetDirty: true };
    const { store, client } = createTestStore(vi.fn(async () => dirtyTargetStatus));
    client.landWorktree
      .mockResolvedValueOnce({ outcome: "resolving", files: ["shared.txt"] })
      .mockResolvedValueOnce({ outcome: "landed", commit: "abc" });
    await vi.waitFor(() => expect(store.status).toEqual(dirtyTargetStatus));

    await store.land({ strategy: "preserve", allowDirtyTarget: true });
    await store.refresh();

    expect(client.landWorktree).toHaveBeenLastCalledWith(
      expect.objectContaining({
        request: { strategy: "preserve", allowDirtyTarget: true },
      }),
    );
    store[Symbol.dispose]();
  });

  it("delegates preserve conflict resolution to the session", async () => {
    const { store, client } = createTestStore();
    client.landWorktree.mockResolvedValueOnce({ outcome: "resolving", files: ["shared.txt"] });
    await vi.waitFor(() => expect(store.status).toEqual(status));

    const outcome = await store.land();
    expect(outcome).toEqual({ outcome: "resolving", files: ["shared.txt"] });
    expect(store.phase).toBe("resolving");
    expect(client.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        delivery: "prompt",
        text: expect.stringContaining("rebase"),
      }),
    );
    store[Symbol.dispose]();
  });

  it("asks the session for a squash message when landing pauses for a proposal", async () => {
    const { store, client } = createTestStore();
    client.landWorktree.mockResolvedValueOnce({ outcome: "proposal" });
    await vi.waitFor(() => expect(store.status).toEqual(status));

    const outcome = await store.land({ strategy: "squash" });
    expect(outcome).toEqual({ outcome: "proposal" });
    expect(store.phase).toBe("proposing");
    expect(client.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        delivery: "prompt",
        text: expect.stringContaining("worktrees.proposeSquashMessage"),
      }),
    );
    store[Symbol.dispose]();
  });

  it("delegates squash conflict resolution and the message request in one turn", async () => {
    const { store, client } = createTestStore();
    client.landWorktree.mockResolvedValueOnce({ outcome: "resolving", files: ["shared.txt"] });
    await vi.waitFor(() => expect(store.status).toEqual(status));

    await store.land({ strategy: "squash" });
    const prompt = client.submit.mock.calls[0]![0]!.text;
    expect(prompt).toContain("squash");
    expect(prompt).toContain("worktrees.proposeSquashMessage");
    expect(prompt).toContain("shared.txt");
    store[Symbol.dispose]();
  });

  it("auto-retries squash landing once the agent proposes a message", async () => {
    const { store, client } = createTestStore();
    client.landWorktree
      .mockResolvedValueOnce({ outcome: "proposal" })
      .mockResolvedValueOnce({ outcome: "landed", commit: "abc" });
    await vi.waitFor(() => expect(store.status).toEqual(status));

    await store.land({ strategy: "squash" });
    expect(client.landWorktree).toHaveBeenCalledTimes(1);

    await store.refresh();
    // Without a proposal the landing stays paused.
    expect(client.landWorktree).toHaveBeenCalledTimes(1);

    await store.refresh();
    expect(client.landWorktree).toHaveBeenCalledTimes(1);

    const ready = { ...status, squashMessageReady: true };
    vi.mocked(client.getWorktreeStatus).mockResolvedValue(ready);
    await store.refresh();
    expect(client.landWorktree).toHaveBeenCalledTimes(2);
    expect(client.landWorktree).toHaveBeenLastCalledWith(
      expect.objectContaining({ request: { strategy: "squash" } }),
    );
    expect(store.phase).toBe("idle");
    expect(store.status).toMatchObject({ merged: true, record: { state: "landed" } });
    store[Symbol.dispose]();
  });

  it("auto-retries preserve landing once the rebase is resolved", async () => {
    const { store, client } = createTestStore();
    client.landWorktree
      .mockResolvedValueOnce({ outcome: "resolving", files: ["shared.txt"] })
      .mockResolvedValueOnce({ outcome: "landed", commit: "abc" });
    await vi.waitFor(() => expect(store.status).toEqual(status));

    await store.land();
    expect(store.phase).toBe("resolving");

    // A still-conflicted worktree does not retry.
    const conflicted = { ...status, rebasing: true, dirtyCount: 1 };
    vi.mocked(client.getWorktreeStatus).mockResolvedValue(conflicted);
    await store.refresh();
    expect(client.landWorktree).toHaveBeenCalledTimes(1);

    vi.mocked(client.getWorktreeStatus).mockResolvedValue(status);
    await store.refresh();
    expect(client.landWorktree).toHaveBeenCalledTimes(2);
    expect(client.landWorktree).toHaveBeenLastCalledWith(
      expect.objectContaining({ request: { strategy: "preserve" } }),
    );
    store[Symbol.dispose]();
  });

  it("adopts a paused squash landing recorded before a reload", async () => {
    const paused = {
      ...status,
      squashMessageReady: true,
      record: { ...status.record, pendingStrategy: "squash" as const },
    };
    const { store, client } = createTestStore(vi.fn(async () => paused));
    client.landWorktree.mockResolvedValueOnce({ outcome: "landed", commit: "abc" });

    // Adoption and the auto-continue happen within one refresh, so the landing
    // completes without ever pausing on the UI.
    await vi.waitFor(() => expect(client.landWorktree).toHaveBeenCalledTimes(1));
    expect(client.landWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ request: { strategy: "squash" } }),
    );
    expect(store.phase).toBe("idle");
    store[Symbol.dispose]();
  });

  it("adopts a paused preserve landing and marks it stalled while unresolved", async () => {
    const paused = {
      ...status,
      rebasing: true,
      dirtyCount: 1,
      record: { ...status.record, pendingStrategy: "preserve" as const },
    };
    const { store, client } = createTestStore(vi.fn(async () => paused));

    await vi.waitFor(() => expect(store.phase).toBe("resolving"));
    // The rebase is still unresolved and the agent is not streaming: recovery
    // is up to the user.
    expect(client.landWorktree).not.toHaveBeenCalled();
    expect(store.stalled).toBe(true);
    store[Symbol.dispose]();
  });

  it("retries a stalled landing on request", async () => {
    const { store, client } = createTestStore();
    client.landWorktree
      .mockResolvedValueOnce({ outcome: "resolving", files: ["shared.txt"] })
      .mockResolvedValueOnce({ outcome: "landed", commit: "abc" });
    await vi.waitFor(() => expect(store.status).toEqual(status));

    await store.land();
    const conflicted = { ...status, rebasing: true, dirtyCount: 1 };
    vi.mocked(client.getWorktreeStatus).mockResolvedValue(conflicted);
    await store.refresh();
    expect(store.stalled).toBe(true);

    vi.mocked(client.getWorktreeStatus).mockResolvedValue(status);
    await store.retryLanding();
    expect(client.landWorktree).toHaveBeenCalledTimes(2);
    expect(client.landWorktree).toHaveBeenLastCalledWith(
      expect.objectContaining({ request: { strategy: "preserve" } }),
    );
    expect(store.phase).toBe("idle");
    expect(store.stalled).toBe(false);
    store[Symbol.dispose]();
  });

  it("cancels a stalled landing without re-adopting it", async () => {
    const { store, client } = createTestStore();
    client.landWorktree.mockResolvedValueOnce({ outcome: "resolving", files: ["shared.txt"] });
    await vi.waitFor(() => expect(store.status).toEqual(status));

    await store.land();
    const conflicted = { ...status, rebasing: true, dirtyCount: 1 };
    vi.mocked(client.getWorktreeStatus).mockResolvedValue(conflicted);
    await store.refresh();
    expect(store.stalled).toBe(true);

    store.cancelLanding();
    expect(store.phase).toBe("idle");

    // The worktree stays paused service-side, but the store must not adopt the
    // same landing again within this session.
    await store.refresh();
    expect(store.phase).toBe("idle");
    expect(client.landWorktree).toHaveBeenCalledTimes(1);
    store[Symbol.dispose]();
  });
});
