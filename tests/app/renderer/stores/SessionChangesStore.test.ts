import { createStore, mount, observable } from "r-state-tree";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeChanges } from "../../../../src/contracts/worktrees/worktree-changes";
import type { Client } from "../../../../src/renderer/client/Client";
import { SessionChangesStore } from "../../../../src/renderer/stores/SessionChangesStore";
import { SideChatStore } from "../../../../src/renderer/stores/SideChatStore";
import { mountWithClient } from "../mount-with-client";
import { createTestClient } from "../test-client";

const clean: WorktreeChanges = {
  branch: "agent/review",
  base: "main",
  baseAlternatives: [],
  baseRevision: "contribution",
  branchPointRevision: "creation",
  headRevision: "head",
  contributionUnavailableReason: null,
  files: [],
  commits: [],
  totalCommits: 0,
  staged: [],
  unstaged: [],
};
const dirty: WorktreeChanges = {
  ...clean,
  staged: [
    { path: "staged.ts", deleted: false, workingTreeExists: true, additions: 1, deletions: 0 },
  ],
  unstaged: [
    { path: "unstaged.ts", deleted: false, workingTreeExists: true, additions: 1, deletions: 0 },
    { path: "untracked.ts", deleted: false, workingTreeExists: true, additions: 1, deletions: 0 },
  ],
};

function fixture() {
  const state = observable({ enabled: true, path: "/worktree" });
  const inspectChanges = vi.fn<Client["managedWorktrees"]["inspectChanges"]>(async () => clean);
  const panel = mount(createStore(SideChatStore, {}));
  const mounted = mountWithClient(
    createStore(SessionChangesStore, {
      workspacePath: () => state.path,
      enabled: () => state.enabled,
      isStreaming: () => false,
      worktreeOperation: () => undefined,
      panel: () => panel,
    }),
    createTestClient({ managedWorktrees: { inspectChanges } }),
  );
  return {
    ...mounted,
    state,
    inspectChanges,
    [Symbol.dispose]() {
      mounted.root[Symbol.dispose]();
      panel[Symbol.dispose]();
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("Session Changes refresh ownership", () => {
  it("discovers external clean-to-dirty and dirty-to-clean transitions while open without a turn or operation", async () => {
    using f = fixture();
    f.subject.toggle();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.subject.data).toEqual(clean);
    f.inspectChanges.mockResolvedValue(dirty);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.subject.data).toEqual(dirty);
    f.inspectChanges.mockResolvedValue(clean);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.subject.data).toEqual(clean);
  });

  it("only polls an open active panel and releases its timer on close, deactivation and disposal", async () => {
    using f = fixture();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.inspectChanges).toHaveBeenCalledTimes(1);
    f.subject.toggle();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.inspectChanges).toHaveBeenCalledTimes(3);
    f.subject.close();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.inspectChanges).toHaveBeenCalledTimes(3);
    f.subject.toggle();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.inspectChanges).toHaveBeenCalledTimes(5);
    f.state.enabled = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.inspectChanges).toHaveBeenCalledTimes(5);
    f.state.enabled = true;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.inspectChanges).toHaveBeenCalledTimes(7);
    f.root[Symbol.dispose]();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.inspectChanges).toHaveBeenCalledTimes(7);
  });

  it("waits for slow reads and does not reschedule a read completed after closing", async () => {
    using f = fixture();
    f.subject.toggle();
    await vi.advanceTimersByTimeAsync(0);
    let complete!: (data: WorktreeChanges) => void;
    f.inspectChanges.mockImplementationOnce(() => new Promise((resolve) => (complete = resolve)));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.inspectChanges).toHaveBeenCalledTimes(3);
    f.subject.close();
    complete(dirty);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.inspectChanges).toHaveBeenCalledTimes(3);
  });

  it("retains the comparison choice, surfaces errors, and retries without dropping the last data", async () => {
    using f = fixture();
    f.subject.toggle();
    await vi.advanceTimersByTimeAsync(0);
    f.subject.selectBase("main");
    await vi.advanceTimersByTimeAsync(0);
    f.inspectChanges.mockRejectedValueOnce(new Error("Git unavailable"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.subject.error).toBe("Git unavailable");
    expect(f.subject.data).toEqual(clean);
    f.inspectChanges.mockResolvedValue(dirty);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.subject.error).toBeUndefined();
    expect(f.subject.data).toEqual(dirty);
    expect(f.inspectChanges).toHaveBeenLastCalledWith(
      { workspacePath: "/worktree", base: "main" },
      expect.objectContaining({ signal: f.subject.signal }),
    );
  });

  it("follows the current workspace rather than caching the previous checkout's dirty files", async () => {
    using f = fixture();
    f.subject.toggle();
    await vi.advanceTimersByTimeAsync(0);
    f.state.path = "/other";
    await vi.advanceTimersByTimeAsync(0);
    f.inspectChanges.mockResolvedValue(dirty);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.inspectChanges).toHaveBeenLastCalledWith(
      { workspacePath: "/other", base: undefined },
      expect.anything(),
    );
    expect(f.subject.data).toEqual(dirty);
  });
});
