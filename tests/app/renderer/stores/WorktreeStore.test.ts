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
    behindCount: 0,
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
  it("delegates deterministic rebase conflicts to the session agent", async () => {
    const currentStatus = { ...worktreeStatus("/worktree"), behindCount: 1 };
    const prompt = vi.fn(
      async (input: { sessionId: string; text: string }, options?: { signal?: AbortSignal }) => {
        void input;
        void options;
      },
    );
    const { root, subject: store } = mountWithRendererClient(
      createStore(WorktreeStore, {
        workspacePath: () => "/worktree",
        sessionId: () => "session-1",
        enabled: () => true,
        isStreaming: () => false,
        onLanded: vi.fn(),
        onDiscarded: vi.fn(),
        onResolveWorkspace: vi.fn(),
      }),
      {
        managedWorktrees: {
          status: vi.fn(async () => currentStatus),
          rebase: vi.fn(async () => ({ outcome: "resolving", files: ["shared.ts"] })),
        },
        projectSessions: { prompt },
      } as unknown as RendererClient,
    );
    await vi.waitFor(() => expect(store.status).toBe(currentStatus));

    await store.rebase();

    expect(store.phase).toBe("resolving-rebase");
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        text: expect.stringContaining("deterministic rebase stopped on conflicts"),
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(prompt.mock.calls.at(0)?.[0].text).toContain("shared.ts");
    root[Symbol.dispose]();
  });

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
