import { effect } from "r-state-tree";
import { expect, it } from "vitest";
import { applyManagedWorktreeCatalogUpdate } from "../../../../src/renderer/reducers/WorktreeCatalogReducer";
import { sessionSummary } from "../fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "../renderer-store-fixture";

const active = {
  projectPath: "/project",
  worktreePath: "/worktree",
  branch: "agent/change",
  baseBranch: "main",
  state: "active" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
};

// Visible landing/removal and stale-status behavior is covered by worktree-workflow
// and session-identity-workflow. React cannot prove that multiple sessions share
// one indexed Model or that replacement snapshots invalidate its reactive index.
it("shares one reactive indexed worktree across mounted sessions and invalidates replaced membership", () => {
  using fixture = createRendererStoreFixture({
    sessions: ["one", "two"].map((sessionId) =>
      sessionSummary({
        sessionId,
        projectPath: active.projectPath,
        workingDirectory: active.worktreePath,
      }),
    ),
  });
  const catalog = fixture.models.worktrees;
  const store = fixture.root.sessionCatalogStore;
  const observed: Array<ReturnType<typeof catalog.find>> = [];
  const stop = effect(() => {
    observed.push(catalog.find(active.worktreePath));
  });
  try {
    expect(observed.at(-1)).toBeUndefined();
    applyManagedWorktreeCatalogUpdate(catalog, { _tag: "Snapshot", worktrees: [active] });
    const first = catalog.find(active.worktreePath);
    expect(first).toBeDefined();
    expect(observed.at(-1)).toBe(first);
    expect(catalog.find("/missing")).toBeUndefined();
    const joined = () =>
      store.sessions.map((session) => store.managedWorktree(session.workingDirectory));
    expect(joined()).toEqual([first, first]);
    expect(joined().every((worktree) => worktree === first)).toBe(true);

    applyManagedWorktreeCatalogUpdate(catalog, {
      _tag: "Event",
      event: { _tag: "Upserted", worktree: { ...active, state: "landed" } },
    });
    expect(catalog.find(active.worktreePath)).toBe(first);
    expect(joined().every((worktree) => worktree === first && worktree?.state === "landed")).toBe(
      true,
    );

    applyManagedWorktreeCatalogUpdate(catalog, {
      _tag: "Snapshot",
      worktrees: [{ ...active, worktreePath: "/other" }],
    });
    expect(observed.at(-1)).toBeUndefined();
    expect(joined()).toEqual([undefined, undefined]);
    expect(catalog.find("/other")?.branch).toBe(active.branch);

    applyManagedWorktreeCatalogUpdate(catalog, { _tag: "Snapshot", worktrees: [active] });
    expect(observed.at(-1)).toBe(catalog.find(active.worktreePath));
    expect(observed.at(-1)).not.toBe(first);
    applyManagedWorktreeCatalogUpdate(catalog, { _tag: "Snapshot", worktrees: [] });
    expect(observed.at(-1)).toBeUndefined();
  } finally {
    stop();
  }
});
