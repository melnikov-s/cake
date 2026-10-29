import { expect, it } from "vitest";
import { createRendererStoreFixture } from "../renderer-store-fixture";
import { applyWorktreeOperationCatalogUpdate } from "../../../../src/renderer/reducers/WorktreeOperationReducer";

const operation = (phase: "waiting" | "landing") => ({
  operationId: "operation-1",
  workspacePath: "/worktree",
  sessionId: "session-1",
  kind: "landing" as const,
  phase,
  strategy: "preserve" as const,
  allowDirtyTarget: false,
});

// User-visible queue/landing/removal is covered by worktree-workflow. This keeps
// only the keyed operation identity contract that rendered progress cannot prove.
it("preserves operation identity across authoritative progress snapshots", () => {
  using fixture = createRendererStoreFixture();
  const catalog = fixture.models.worktreeOperations;
  applyWorktreeOperationCatalogUpdate(catalog, { operations: [operation("waiting")] });
  const projected = catalog.find("/worktree");
  applyWorktreeOperationCatalogUpdate(catalog, { operations: [operation("landing")] });
  expect(catalog.find("/worktree")).toBe(projected);
  expect(projected?.phase).toBe("landing");
  applyWorktreeOperationCatalogUpdate(catalog, { operations: [] });
  expect(catalog.find("/worktree")).toBeUndefined();
});
