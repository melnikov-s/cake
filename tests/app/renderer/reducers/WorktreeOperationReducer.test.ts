import { expect, it } from "vitest";
import { WorktreeOperationCatalog } from "../../../../src/renderer/models/WorktreeOperationCatalog";
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

it("preserves operation identity across authoritative progress snapshots", () => {
  const catalog = WorktreeOperationCatalog.create();
  applyWorktreeOperationCatalogUpdate(catalog, { operations: [operation("waiting")] });
  const projected = catalog.find("/worktree");
  applyWorktreeOperationCatalogUpdate(catalog, { operations: [operation("landing")] });
  expect(catalog.find("/worktree")).toBe(projected);
  expect(projected?.phase).toBe("landing");
  applyWorktreeOperationCatalogUpdate(catalog, { operations: [] });
  expect(catalog.find("/worktree")).toBeUndefined();
});
