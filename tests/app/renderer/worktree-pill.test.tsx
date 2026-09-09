/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorktreePill } from "../../../src/renderer/components/worktree-pill";
import type { WorktreeCreationStore } from "../../../src/renderer/stores/WorktreeCreationStore";
import type { WorktreeStore } from "../../../src/renderer/stores/WorktreeStore";
import type { WorktreeRecord } from "../../../src/ipc/worktree-contract";

function actionStore({
  aheadCount,
  dirtyCount,
  behindCount = 0,
  running = false,
  targetDirty = false,
  targetOnBranch = true,
}: {
  aheadCount: number;
  dirtyCount: number;
  behindCount?: number;
  running?: boolean;
  targetDirty?: boolean;
  targetOnBranch?: boolean;
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
      behindCount,
      dirtyCount,
      merged: false,
      targetDirty,
      targetOnBranch,
      merging: false,
      rebasing: false,
      squashMessageReady: false,
    },
    phase: "idle",
    isBusy: false,
    isQueued: false,
    isSessionRunning: running,
    stalled: false,
    error: undefined,
    commitAndMerge: vi.fn(async () => undefined),
    rebase: vi.fn(async () => undefined),
    resolve: vi.fn(async () => undefined),
    retryLanding: vi.fn(async () => undefined),
    cancelLanding: vi.fn(async () => undefined),
    discard: vi.fn(async () => undefined),
  } as unknown as WorktreeStore;
}

const candidates = vi.fn(() => []);
const select = vi.fn();
const creation = {
  choice: () => ({ kind: "current" }),
  select,
  candidates,
  preparingSessionId: undefined,
  preparingStartedAt: undefined,
} as unknown as WorktreeCreationStore;

describe("WorktreePill", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    candidates.mockClear();
    select.mockClear();
    creation.preparingSessionId = undefined;
    creation.preparingStartedAt = undefined;
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

  function render(
    actions: WorktreeStore,
    record?: WorktreeRecord,
    configurationMode?: "new-session" | "activate-draft" | "edit-draft",
    resolved = false,
  ) {
    act(() =>
      root.render(
        <WorktreePill
          creation={creation}
          actions={actions}
          record={record}
          sessionId="session"
          projectPath="/project"
          resolved={resolved}
          configurationMode={configurationMode}
          onConfigured={vi.fn()}
        />,
      ),
    );
  }

  it("shows explicit checkout preparation progress", () => {
    creation.preparingSessionId = "session";
    creation.preparingStartedAt = Date.now();
    render(actionStore({ aheadCount: 0, dirtyCount: 0 }), undefined, "new-session");

    expect(container.textContent).toContain("Creating worktree and running setup commands");
    expect(container.querySelector('[data-testid="worktree-creation-progress"]')).not.toBeNull();
  });

  function button(label: string) {
    return [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === label,
    )!;
  }

  it("uses commit labels only when the worktree has uncommitted changes", () => {
    render(actionStore({ aheadCount: 1, dirtyCount: 2 }));
    expect(button("Commit & merge").disabled).toBe(false);
    expect(button("Merge & resolve").disabled).toBe(false);

    render(actionStore({ aheadCount: 1, dirtyCount: 0 }));
    expect(button("Merge").disabled).toBe(false);
    expect(button("Merge & resolve").disabled).toBe(false);
  });

  it("shows queued merges waiting and lets the user remove them from the queue", () => {
    const actions = actionStore({ aheadCount: 1, dirtyCount: 0 });
    actions.phase = "waiting";
    Object.defineProperty(actions, "isQueued", { value: true });
    render(actions);

    expect(container.textContent).toContain("Waiting to merge…");
    expect(container.textContent).toContain(
      "Another merge is in progress. This merge will start automatically when it finishes.",
    );
    act(() => button("Cancel").click());
    expect(actions.cancelLanding).toHaveBeenCalledOnce();
  });

  it("does not describe startup as another merge without an authoritative queue entry", () => {
    const actions = actionStore({ aheadCount: 1, dirtyCount: 0 });
    actions.phase = "waiting";
    Object.defineProperty(actions, "isBusy", { value: true });
    render(actions);

    expect(container.textContent).not.toContain("Another merge is in progress");
    expect(button("Cancel")).toBeUndefined();
  });

  it("offers rebase only when the target branch has advanced", () => {
    render(actionStore({ aheadCount: 1, dirtyCount: 0, behindCount: 1 }));
    expect(button("Rebase").disabled).toBe(false);

    render(actionStore({ aheadCount: 1, dirtyCount: 0 }));
    expect(button("Rebase")).toBeUndefined();
  });

  it("does not derive draft worktree candidates for an existing session", () => {
    render(actionStore({ aheadCount: 1, dirtyCount: 0 }));

    expect(candidates).not.toHaveBeenCalled();
  });

  it("hides the entire worktree pill for a resolved session", () => {
    render(actionStore({ aheadCount: 1, dirtyCount: 0 }), undefined, undefined, true);

    expect(container.querySelector('[data-slot="worktree-pill"]')).toBeNull();
    expect(container.querySelector("button")).toBeNull();
  });

  it("offers draft as the final choice for a new session", () => {
    render(actionStore({ aheadCount: 0, dirtyCount: 0 }), undefined, "new-session");

    const draft = button("Draft");
    expect(draft).toBe(container.querySelector("button:last-child"));
    act(() => draft.click());
    expect(select).toHaveBeenCalledWith("session", { kind: "draft" });
  });

  it("keeps projected worktree controls visible while live status is loading after handoff", () => {
    const actions = actionStore({ aheadCount: 0, dirtyCount: 0 });
    actions.status = undefined;

    render(actions, {
      projectPath: "/project",
      worktreePath: "/worktree",
      branch: "agent/session",
      baseBranch: "main",
      createdAt: new Date(0).toISOString(),
    });

    expect(container.querySelector('[data-slot="worktree-pill"]')?.textContent).toContain(
      "session",
    );
    expect(button("Merge").disabled).toBe(true);
    expect(button("Merge & resolve").disabled).toBe(true);
    expect(button("Discard & resolve").disabled).toBe(false);
  });

  it("shows resolve from the projected landed record before live status loads", () => {
    const actions = actionStore({ aheadCount: 0, dirtyCount: 0 });
    actions.status = undefined;

    render(actions, {
      projectPath: "/project",
      worktreePath: "/worktree",
      branch: "agent/session",
      baseBranch: "main",
      state: "landed",
      createdAt: new Date(0).toISOString(),
    });

    expect(button("Resolve").disabled).toBe(false);
  });

  it("does not let stale action status mask the catalog's landed record", () => {
    render(actionStore({ aheadCount: 1, dirtyCount: 0 }), {
      projectPath: "/project",
      worktreePath: "/worktree",
      branch: "agent/session",
      baseBranch: "main",
      state: "landed",
      createdAt: new Date(0).toISOString(),
    });

    expect(button("Merge")).toBeUndefined();
    expect(button("Resolve")).toBeDefined();
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

  it("shows target warnings beside the worktree name with details in a tooltip", () => {
    vi.useFakeTimers();
    render(actionStore({ aheadCount: 1, dirtyCount: 0, targetDirty: true }));

    const warning = container.querySelector<HTMLElement>('[data-testid="worktree-target-warning"]');
    expect(warning).not.toBeNull();
    expect(container.textContent).not.toContain("The merge target has uncommitted changes.");

    act(() => warning!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    act(() => vi.advanceTimersByTime(120));
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      "The merge target has uncommitted changes.",
    );
  });

  it("disables every worktree action while the session is running", () => {
    render(actionStore({ aheadCount: 1, dirtyCount: 1, running: true }));

    expect(button("Commit & merge").disabled).toBe(true);
    expect(button("Merge & resolve").disabled).toBe(true);
    expect(button("Discard & resolve").disabled).toBe(true);
  });

  it("keeps shared worktree management available from every session", () => {
    render(actionStore({ aheadCount: 1, dirtyCount: 1, behindCount: 1 }));

    expect(button("Rebase")).toBeDefined();
    expect(button("Commit & merge")).toBeDefined();
    expect(button("Merge & resolve")).toBeDefined();
    expect(button("Discard & resolve")).toBeDefined();
  });
});
