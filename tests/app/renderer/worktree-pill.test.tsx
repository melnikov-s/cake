/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorktreePill } from "../../../src/renderer/components/worktree-pill";
import type { WorktreeCreationStore } from "../../../src/renderer/stores/WorktreeCreationStore";
import type { WorktreeStore } from "../../../src/renderer/stores/WorktreeStore";

function actionStore({
  aheadCount,
  dirtyCount,
  running = false,
}: {
  aheadCount: number;
  dirtyCount: number;
  running?: boolean;
}) {
  return {
    status: {
      record: {
        projectPath: "/project",
        worktreePath: "/worktree",
        branch: "agent/session",
        baseBranch: "main",
        createdAt: new Date(0).toISOString(),
      },
      targetBranch: "main",
      aheadCount,
      dirtyCount,
      merged: false,
      targetDirty: false,
      targetOnBranch: true,
      merging: false,
      rebasing: false,
      squashMessageReady: false,
    },
    phase: "idle",
    isBusy: false,
    isSessionRunning: running,
    stalled: false,
    error: undefined,
    commitAndMerge: vi.fn(async () => undefined),
    resolve: vi.fn(async () => undefined),
    retryLanding: vi.fn(async () => undefined),
    cancelLanding: vi.fn(),
    discard: vi.fn(async () => undefined),
  } as unknown as WorktreeStore;
}

const candidates = vi.fn(() => []);
const creation = {
  choice: () => ({ kind: "current" }),
  candidates,
  preparingSessionId: undefined,
} as unknown as WorktreeCreationStore;

describe("WorktreePill", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    candidates.mockClear();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  function render(actions: WorktreeStore) {
    act(() =>
      root.render(
        <WorktreePill
          creation={creation}
          actions={actions}
          sessionId="session"
          projectPath="/project"
          draft={false}
          onConfigured={vi.fn()}
        />,
      ),
    );
  }

  function button(label: string) {
    return [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === label,
    )!;
  }

  it("uses commit labels only when the worktree has uncommitted changes", () => {
    render(actionStore({ aheadCount: 1, dirtyCount: 2 }));
    expect(button("Commit & merge").disabled).toBe(false);
    expect(button("Commit & merge & resolve").disabled).toBe(false);

    render(actionStore({ aheadCount: 1, dirtyCount: 0 }));
    expect(button("Merge").disabled).toBe(false);
    expect(button("Merge & resolve").disabled).toBe(false);
  });

  it("does not derive draft worktree candidates for an existing session", () => {
    render(actionStore({ aheadCount: 1, dirtyCount: 0 }));

    expect(candidates).not.toHaveBeenCalled();
  });

  it("keeps merge actions visible but disabled when there is nothing to land", () => {
    vi.useFakeTimers();
    render(actionStore({ aheadCount: 0, dirtyCount: 0 }));
    const merge = button("Merge");
    expect(merge.disabled).toBe(true);

    act(() => merge.parentElement!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    act(() => vi.advanceTimersByTime(120));
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      "There are no changes or commits to merge.",
    );
  });

  it("disables every worktree action while the session is running", () => {
    render(actionStore({ aheadCount: 1, dirtyCount: 1, running: true }));

    expect(button("Commit & merge").disabled).toBe(true);
    expect(button("Commit & merge & resolve").disabled).toBe(true);
    expect(button("Discard & resolve").disabled).toBe(true);
  });
});
