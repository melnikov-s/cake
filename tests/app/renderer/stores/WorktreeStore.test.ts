import { createStore, observable } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { WorktreeLandingOperation } from "../../../../src/domain/worktree-landing-data";
import type { WorktreeStatus } from "../../../../src/ipc/worktree-contract";
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
    aheadCount: 1,
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

function operation(
  phase: WorktreeLandingOperation["phase"],
  extra: Partial<WorktreeLandingOperation> = {},
): WorktreeLandingOperation {
  return {
    operationId: "landing-operation",
    workspacePath: "/worktree",
    sessionId: "session-1",
    kind: "landing",
    phase,
    strategy: "preserve",
    allowDirtyTarget: false,
    ...extra,
  };
}

const props = (
  activity = observable({ workspacePath: "/worktree", enabled: true }),
  projectedOperation: () => WorktreeLandingOperation | undefined = () => undefined,
) => ({
  workspacePath: () => activity.workspacePath,
  sessionId: () => "session-1",
  enabled: () => activity.enabled,
  isStreaming: () => false,
  operation: projectedOperation,
  onLanded: vi.fn(),
  onDiscarded: vi.fn(),
  retirement: {
    prepare: vi.fn(async () => true),
  },
  onResolveWorkspace: vi.fn(),
});

describe("WorktreeStore", () => {
  it("starts one semantic landing operation without owning Git or Pi prompt policy", async () => {
    const startLanding = vi.fn(async () => operation("waiting"));
    const projectSessions = { prompt: vi.fn() };
    const { root, subject: store } = mountWithClient(createStore(WorktreeStore, props()), {
      managedWorktrees: {
        landing: vi.fn(async () => ({ status: worktreeStatus("/worktree") })),
        startLanding,
      },
      projectSessions,
    } as unknown as Client);
    try {
      await vi.waitFor(() => expect(store.status).toBeDefined());
      await store.commitAndMerge(true, true);
      expect(startLanding).toHaveBeenCalledWith(
        expect.objectContaining({
          workspacePath: "/worktree",
          sessionId: "session-1",
          strategy: "preserve",
          allowDirtyTarget: true,
          commitBeforeLanding: true,
        }),
      );
      expect(projectSessions.prompt).not.toHaveBeenCalled();
      expect(store.phase).toBe("landing");
    } finally {
      root[Symbol.dispose]();
    }
  });

  it("shows waiting only for the matching authoritative queue reservation", async () => {
    let status = worktreeStatus("/worktree");
    const current = operation("waiting");
    const { root, subject: store } = mountWithClient(
      createStore(
        WorktreeStore,
        props(undefined, () => current),
      ),
      {
        managedWorktrees: {
          landing: vi.fn(async () => ({ status, operation: current })),
        },
      } as unknown as Client,
    );
    try {
      await vi.waitFor(() => expect(store.status).toBeDefined());
      expect(store.phase).toBe("landing");
      expect(store.isQueued).toBe(false);

      status = {
        ...status,
        landingState: "queued",
        landingOperationId: current.operationId,
        landingQueuePosition: 1,
      };
      await store.refresh();
      expect(store.phase).toBe("waiting");
      expect(store.isQueued).toBe(true);
    } finally {
      root[Symbol.dispose]();
    }
  });

  it("submits authoritative merge-and-resolve intent even when acknowledgement is unavailable", async () => {
    let started = false;
    let projected: WorktreeLandingOperation | undefined;
    const landedStatus = {
      ...worktreeStatus("/worktree"),
      record: { ...worktreeStatus("/worktree").record, state: "landed" as const },
      merged: true,
    };
    const onLanded = vi.fn();
    const onResolveWorkspace = vi.fn();
    const cancelLanding = vi.fn(async () => {
      throw new Error("acknowledgement transport failed");
    });
    const { root, subject: store } = mountWithClient(
      createStore(WorktreeStore, {
        ...props(undefined, () => projected),
        onLanded,
        onResolveWorkspace,
      }),
      {
        managedWorktrees: {
          landing: vi.fn(async () =>
            started ? { status: landedStatus } : { status: worktreeStatus("/worktree") },
          ),
          startLanding: vi.fn(async (input) => {
            expect(input).toMatchObject({ resolveAfterLanding: true });
            started = true;
            projected = operation("landed", { resolveAfterLanding: true });
            return operation("waiting", { resolveAfterLanding: true });
          }),
          cancelLanding,
        },
      } as unknown as Client,
    );
    try {
      await vi.waitFor(() => expect(store.status).toBeDefined());
      await store.commitAndMerge(false, true);

      expect(onLanded).toHaveBeenCalledWith(expect.objectContaining({ state: "landed" }));
      expect(onResolveWorkspace).not.toHaveBeenCalled();
      expect(cancelLanding).toHaveBeenCalledWith(
        expect.objectContaining({ intent: "acknowledge" }),
      );
    } finally {
      root[Symbol.dispose]();
    }
  });

  it("projects authoritative pause and completion after submitting resolve intent", async () => {
    let current: WorktreeLandingOperation | undefined;
    const onLanded = vi.fn();
    const onResolveWorkspace = vi.fn();
    const currentProps = {
      ...props(undefined, () => current),
      onLanded,
      onResolveWorkspace,
    };
    const cancelLanding = vi.fn(async () => undefined);
    const { root, subject: store } = mountWithClient(createStore(WorktreeStore, currentProps), {
      managedWorktrees: {
        landing: vi.fn(async () => ({ status: worktreeStatus("/worktree"), operation: current })),
        startLanding: vi.fn(async (input) => {
          expect(input).toMatchObject({ resolveAfterLanding: true });
          return operation("waiting", { resolveAfterLanding: true });
        }),
        cancelLanding,
      },
    } as unknown as Client);
    try {
      await vi.waitFor(() => expect(store.status).toBeDefined());
      await store.commitAndMerge(false, true);
      current = operation("stalled", { pauseReason: "commit" });
      await store.refresh();
      expect(store.phase).toBe("committing");
      expect(store.stalled).toBe(true);

      current = operation("landed");
      await store.refresh();
      expect(onLanded).toHaveBeenCalledOnce();
      expect(cancelLanding).toHaveBeenCalledWith({
        operationId: "landing-operation",
        workspacePath: "/worktree",
        intent: "acknowledge",
      });
      expect(onResolveWorkspace).not.toHaveBeenCalled();
    } finally {
      root[Symbol.dispose]();
    }
  });

  it("delegates retry, cancel, and rebase to semantic main-process operations", async () => {
    const retryLanding = vi.fn(async () => operation("resolving"));
    const cancelLanding = vi.fn(async () => undefined);
    const startRebase = vi.fn(async () => operation("rebasing", { kind: "rebase" }));
    let current = operation("stalled", { pauseReason: "conflict" });
    const { root, subject: store } = mountWithClient(
      createStore(
        WorktreeStore,
        props(undefined, () => current),
      ),
      {
        managedWorktrees: {
          landing: vi.fn(async () => ({ status: worktreeStatus("/worktree"), operation: current })),
          retryLanding,
          cancelLanding,
          startRebase,
        },
      } as unknown as Client,
    );
    try {
      await vi.waitFor(() => expect(store.stalled).toBe(true));
      await store.retryLanding();
      expect(retryLanding).toHaveBeenCalledWith(
        expect.objectContaining({ workspacePath: "/worktree", sessionId: "session-1" }),
      );
      current = operation("stalled", { pauseReason: "conflict" });
      await store.refresh();
      await store.cancelLanding();
      expect(cancelLanding).toHaveBeenCalledWith({
        operationId: "landing-operation",
        workspacePath: "/worktree",
        intent: "cancel",
      });
      await store.rebase();
      expect(startRebase).toHaveBeenCalledWith(
        expect.objectContaining({ workspacePath: "/worktree", sessionId: "session-1" }),
      );
    } finally {
      root[Symbol.dispose]();
    }
  });

  it("reconciles a rebase that completes before the start response arrives", async () => {
    let current: WorktreeLandingOperation | undefined;
    const cancelLanding = vi.fn(async () => undefined);
    const startRebase = vi.fn(async () => {
      current = operation("complete", { kind: "rebase", strategy: undefined });
      return operation("rebasing", { kind: "rebase", strategy: undefined });
    });
    const { root, subject: store } = mountWithClient(
      createStore(
        WorktreeStore,
        props(undefined, () => current),
      ),
      {
        managedWorktrees: {
          landing: vi.fn(async () => ({
            status: worktreeStatus("/worktree"),
            operation: current,
          })),
          startRebase,
          cancelLanding,
        },
      } as unknown as Client,
    );
    try {
      await vi.waitFor(() => expect(store.status).toBeDefined());
      await store.rebase();

      expect(store.phase).toBe("idle");
      expect(cancelLanding).toHaveBeenCalledWith({
        operationId: "landing-operation",
        workspacePath: "/worktree",
        intent: "acknowledge",
      });
    } finally {
      root[Symbol.dispose]();
    }
  });

  it("does not discard a worktree when terminal retirement is cancelled", async () => {
    const discard = vi.fn(async () => undefined);
    const currentProps = props();
    currentProps.retirement = {
      prepare: vi.fn(async () => false),
    };
    const { root, subject: store } = mountWithClient(createStore(WorktreeStore, currentProps), {
      managedWorktrees: {
        landing: vi.fn(async () => ({ status: worktreeStatus("/worktree") })),
        discard,
      },
    } as unknown as Client);
    await store.discard(false);
    expect(currentProps.retirement.prepare).toHaveBeenCalledWith(["/worktree"]);
    expect(discard).not.toHaveBeenCalled();
    root[Symbol.dispose]();
  });

  it("ignores a late refresh after the selected working directory changes", async () => {
    const activity = observable({ workspacePath: "/project", enabled: true });
    let finishProject!: (value: { status: WorktreeStatus }) => void;
    const project = new Promise<{ status: WorktreeStatus }>((resolve) => {
      finishProject = resolve;
    });
    const landing = vi.fn((input: { workspacePath: string }) =>
      input.workspacePath === "/project"
        ? project
        : Promise.resolve({ status: worktreeStatus(input.workspacePath) }),
    );
    const { root, subject: store } = mountWithClient(createStore(WorktreeStore, props(activity)), {
      managedWorktrees: { landing },
    } as unknown as Client);
    await vi.waitFor(() =>
      expect(landing).toHaveBeenCalledWith(expect.objectContaining({ workspacePath: "/project" })),
    );
    activity.workspacePath = "/worktree";
    await vi.waitFor(() => expect(store.status?.record.worktreePath).toBe("/worktree"));
    finishProject({ status: worktreeStatus("/project") });
    await project;
    expect(store.status?.record.worktreePath).toBe("/worktree");
    root[Symbol.dispose]();
  });
});
