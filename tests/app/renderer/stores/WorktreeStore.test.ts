import { createStore, observable } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { WorktreeStatus } from "../../../../src/ipc/worktree-contract";
import type { RendererClient } from "../../../../src/renderer/client/RendererClient";
import { WorktreeStore } from "../../../../src/renderer/stores/WorktreeStore";
import { mountWithRendererClient } from "../mount-with-renderer-client";

function worktreeStatus(worktreePath: string): WorktreeStatus {
  return {
    record: {
      projectPath: "/project",
      worktreePath,
      branch: "agent/new-chat",
      baseBranch: "main",
      createdAt: new Date(0).toISOString(),
      state: "active",
    },
    targetBranch: "main",
    aheadCount: 0,
    dirtyCount: 0,
    merged: false,
    targetDirty: false,
    targetOnBranch: true,
    merging: false,
    rebasing: false,
    squashMessageReady: false,
  };
}

describe("WorktreeStore", () => {
  it("refreshes immediately when a new session moves into its created worktree", async () => {
    const activity = observable({ workspacePath: "/project" });
    let finishProjectRefresh!: (status: WorktreeStatus | undefined) => void;
    const projectRefresh = new Promise<WorktreeStatus | undefined>((resolve) => {
      finishProjectRefresh = resolve;
    });
    const status = vi.fn((input: { workspacePath: string }) =>
      input.workspacePath === "/project"
        ? projectRefresh
        : Promise.resolve(worktreeStatus(input.workspacePath)),
    );
    const { root, subject: store } = mountWithRendererClient(
      createStore(WorktreeStore, {
        workspacePath: () => activity.workspacePath,
        sessionId: () => "session-1",
        enabled: () => true,
        isStreaming: () => false,
        onLanded: vi.fn(),
        onDiscarded: vi.fn(),
        onResolveWorkspace: vi.fn(),
      }),
      { managedWorktrees: { status } } as unknown as RendererClient,
    );

    await vi.waitFor(() => expect(status).toHaveBeenCalledWith({ workspacePath: "/project" }));
    activity.workspacePath = "/worktree";

    await vi.waitFor(() => expect(status).toHaveBeenCalledWith({ workspacePath: "/worktree" }));
    await vi.waitFor(() => expect(store.status?.record.worktreePath).toBe("/worktree"));

    finishProjectRefresh(undefined);
    await projectRefresh;
    expect(store.status?.record.worktreePath).toBe("/worktree");
    root[Symbol.dispose]();
  });
});
