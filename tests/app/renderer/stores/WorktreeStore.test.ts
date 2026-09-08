import { createStore, observable } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { WorktreeLandOutcome, WorktreeStatus } from "../../../../src/ipc/worktree-contract";
import type { Client } from "../../../../src/renderer/client/Client";
import { WorktreeStore } from "../../../../src/renderer/stores/WorktreeStore";
import { mountWithClient } from "../mount-with-client";

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
  it.each(["committing", "resolving", "proposing"] as const)(
    "continues %s after switching sessions and stops polling when finished",
    async (phase) => {
      vi.useFakeTimers();
      const activity = observable({ enabled: true, streaming: false });
      let currentStatus = {
        ...worktreeStatus("/worktree"),
        aheadCount: 1,
        dirtyCount: phase === "committing" ? 1 : 0,
      };
      const status = vi.fn(async () => currentStatus);
      const land = vi.fn(async (): Promise<WorktreeLandOutcome> => ({ outcome: "landed" }));
      if (phase !== "committing")
        land.mockResolvedValueOnce(
          phase === "resolving"
            ? { outcome: "resolving", files: ["shared.ts"] }
            : { outcome: "proposal" },
        );
      const onLanded = vi.fn();
      const onResolveWorkspace = vi.fn();
      const { root, subject: store } = mountWithClient(
        createStore(WorktreeStore, {
          workspacePath: () => "/worktree",
          sessionId: () => "session-1",
          enabled: () => activity.enabled,
          isStreaming: () => activity.streaming,
          onLanded,
          onDiscarded: vi.fn(),
          onResolveWorkspace,
        }),
        {
          managedWorktrees: {
            status,
            prepareLanding: vi.fn(async () => undefined),
            land,
            cancelLanding: vi.fn(async () => undefined),
          },
          projectSessions: {
            prompt: vi.fn(async () => {
              activity.streaming = true;
            }),
          },
        } as unknown as Client,
      );
      try {
        await vi.waitFor(() => expect(store.status).toBeDefined());
        if (phase === "committing") await store.commitAndMerge(false, true);
        else await store.land({ strategy: phase === "proposing" ? "squash" : "preserve" });
        expect(store.phase).toBe(phase);

        activity.enabled = false;
        await vi.advanceTimersByTimeAsync(5_000);
        expect(store.phase).toBe(phase);
        currentStatus = { ...currentStatus, dirtyCount: 0, squashMessageReady: true };
        activity.streaming = false;
        await vi.advanceTimersByTimeAsync(10_000);

        expect(land).toHaveBeenCalledTimes(phase === "committing" ? 1 : 2);
        expect(store.phase).toBe("idle");
        expect(onLanded).toHaveBeenCalledOnce();
        expect(onResolveWorkspace).toHaveBeenCalledTimes(phase === "committing" ? 1 : 0);
        const refreshes = status.mock.calls.length;
        await vi.advanceTimersByTimeAsync(30_000);
        expect(status).toHaveBeenCalledTimes(refreshes);
      } finally {
        root[Symbol.dispose]();
        expect(vi.getTimerCount()).toBe(0);
        vi.useRealTimers();
      }
    },
  );

  it.each(["resolving", "proposal"] as const)(
    "releases a %s reservation when the agent request fails",
    async (outcome) => {
      const currentStatus = { ...worktreeStatus("/worktree"), aheadCount: 1 };
      const land = vi.fn(async (): Promise<WorktreeLandOutcome> =>
        outcome === "resolving" ? { outcome, files: ["shared.ts"] } : { outcome },
      );
      const cancelLanding = vi.fn(async (input: { operationId: string; workspacePath: string }) => {
        void input;
      });
      const prompt = vi.fn(async () => {
        throw new Error("Session unavailable");
      });
      const { root, subject: store } = mountWithClient(
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
          managedWorktrees: { status: vi.fn(async () => currentStatus), land, cancelLanding },
          projectSessions: { prompt },
        } as unknown as Client,
      );
      try {
        await vi.waitFor(() => expect(store.status).toBeDefined());
        await expect(
          store.land({ strategy: outcome === "proposal" ? "squash" : "preserve" }),
        ).rejects.toThrow("Session unavailable");
        expect(cancelLanding).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ workspacePath: "/worktree" }),
        );
        expect(cancelLanding.mock.calls[0]?.[0]).toEqual(
          expect.objectContaining({ operationId: expect.any(String) }),
        );
        expect(store.phase).toBe("idle");
        expect(store.error).toContain("Session unavailable");
      } finally {
        root[Symbol.dispose]();
      }
    },
  );

  it("projects a queued merge and starts it after the repository slot opens", async () => {
    const currentStatus = worktreeStatus("/worktree");
    let releaseLanding!: () => void;
    const prepareLanding = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseLanding = resolve;
        }),
    );
    const status = vi.fn(async () =>
      prepareLanding.mock.calls.length > 0
        ? {
            ...currentStatus,
            landingState: "queued" as const,
            landingOperationId: "landing-operation",
            landingQueuePosition: 1,
          }
        : currentStatus,
    );
    const land = vi.fn(async () => ({ outcome: "landed" as const }));
    const onLanded = vi.fn();
    const { root, subject: store } = mountWithClient(
      createStore(WorktreeStore, {
        workspacePath: () => "/worktree",
        sessionId: () => "session-1",
        enabled: () => true,
        isStreaming: () => false,
        onLanded,
        onDiscarded: vi.fn(),
        onResolveWorkspace: vi.fn(),
      }),
      {
        managedWorktrees: {
          status,
          prepareLanding,
          land,
          cancelLanding: vi.fn(async () => undefined),
        },
      } as unknown as Client,
    );
    await vi.waitFor(() => expect(store.status).toEqual(currentStatus));

    const landing = store.commitAndMerge();
    await vi.waitFor(() => expect(store.phase).toBe("waiting"));
    releaseLanding();
    await landing;

    expect(land).toHaveBeenCalledOnce();
    expect(store.phase).toBe("idle");
    expect(onLanded).toHaveBeenCalledOnce();
    root[Symbol.dispose]();
  });

  it("delegates deterministic rebase conflicts to the session agent", async () => {
    const currentStatus = { ...worktreeStatus("/worktree"), behindCount: 1 };
    const prompt = vi.fn(
      async (input: { sessionId: string; text: string }, options?: { signal?: AbortSignal }) => {
        void input;
        void options;
      },
    );
    const { root, subject: store } = mountWithClient(
      createStore(WorktreeStore, {
        workspacePath: () => "/worktree",
        sessionId: () => "session-1",
        enabled: () => true,
        isStreaming: () => false,
        onLanded: vi.fn(),
        onDiscarded: vi.fn(),
        prepareWorkingDirectoryRetirement: async () => true,
        onResolveWorkspace: vi.fn(),
      }),
      {
        managedWorktrees: {
          status: vi.fn(async () => currentStatus),
          rebase: vi.fn(async () => ({ outcome: "resolving", files: ["shared.ts"] })),
        },
        projectSessions: { prompt },
      } as unknown as Client,
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

  it("does not discard a worktree when terminal retirement is cancelled", async () => {
    const discard = vi.fn(async () => undefined);
    const prepareWorkingDirectoryRetirement = vi.fn(async () => false);
    const { root, subject: store } = mountWithClient(
      createStore(WorktreeStore, {
        workspacePath: () => "/worktree",
        sessionId: () => "session-1",
        enabled: () => true,
        isStreaming: () => false,
        onLanded: vi.fn(),
        onDiscarded: vi.fn(),
        prepareWorkingDirectoryRetirement,
        onResolveWorkspace: vi.fn(),
      }),
      {
        managedWorktrees: {
          status: vi.fn(async () => worktreeStatus("/worktree")),
          discard,
        },
      } as unknown as Client,
    );

    await store.discard(false);

    expect(prepareWorkingDirectoryRetirement).toHaveBeenCalledWith("/worktree");
    expect(discard).not.toHaveBeenCalled();
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
    const { root, subject: store } = mountWithClient(
      createStore(WorktreeStore, {
        workspacePath: () => activity.workspacePath,
        sessionId: () => "session-1",
        enabled: () => true,
        isStreaming: () => false,
        onLanded: vi.fn(),
        onDiscarded: vi.fn(),
        prepareWorkingDirectoryRetirement: async () => true,
        onResolveWorkspace: vi.fn(),
      }),
      { managedWorktrees: { status } } as unknown as Client,
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
