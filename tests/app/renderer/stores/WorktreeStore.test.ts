import { createStore, observable } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { WorktreeLandingOperation } from "../../../../src/services/worktrees/worktree-landing-data";
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

const props = (
  activity = observable({ workspacePath: "/worktree", enabled: true, streaming: false }),
  projectedOperation: () => WorktreeLandingOperation | undefined = () => undefined,
) => ({
  workspacePath: () => activity.workspacePath,
  sessionId: () => "session-1",
  enabled: () => activity.enabled,
  isStreaming: () => activity.streaming,
  operation: projectedOperation,
  onLanded: vi.fn(),
  onDiscarded: vi.fn(),
  retirement: {
    prepare: vi.fn(async () => true),
  },
  onResolveWorkspace: vi.fn(),
});

// Migration backlog: this regression changes the same Store's working-directory getter while a
// request is pending. The running-session Pill has no directory-switch action. Preserve it until
// a real pending-session activation/relocation workflow exercises this exact cross-request case.
// All reachable Pill operations are covered by ../worktree-workflow.test.tsx.
describe("WorktreeStore directory-relocation regression (migration backlog)", () => {
  it("ignores a late refresh after the selected working directory changes", async () => {
    const activity = observable({ workspacePath: "/project", enabled: true, streaming: false });
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
