import { expect, it } from "vitest";
import { effect } from "r-state-tree";
import type { AutoMergeRequest } from "../../../../src/contracts/worktrees/auto-merge";
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

it("projects the stable declaration binding independently of attempts and clears it on manual replacement", () => {
  using fixture = createRendererStoreFixture();
  const catalog = fixture.models.worktreeOperations;
  for (const operationId of ["declaration", "declaration:2"]) {
    applyWorktreeOperationCatalogUpdate(catalog, {
      operations: [
        {
          ...operation("waiting"),
          operationId,
          automatic: true,
          autoMergeRequestId: "declaration",
        },
      ],
    });
    expect(catalog.find("/worktree")?.autoMergeRequestId).toBe("declaration");
  }
  applyWorktreeOperationCatalogUpdate(catalog, {
    operations: [
      {
        ...operation("waiting"),
        operationId: "declaration:1",
        automatic: true,
        autoMergeRequestId: "declaration",
        cancellationRequested: true,
      },
    ],
  });
  expect(catalog.find("/worktree")?.autoMergeRequestId).toBe("declaration");
  expect(catalog.find("/worktree")?.cancellationRequested).toBe(true);
  applyWorktreeOperationCatalogUpdate(catalog, { operations: [operation("landing")] });
  expect(catalog.find("/worktree")?.autoMergeRequestId).toBeUndefined();
  expect(catalog.find("/worktree")?.cancellationRequested).toBeUndefined();
});

it("retains equivalent readiness records and observes every real field/outcome/order change", () => {
  using fixture = createRendererStoreFixture();
  const catalog = fixture.models.worktreeOperations;
  const request: AutoMergeRequest = {
    id: "first",
    sessionId: "session",
    workspacePath: "/cake",
    readyToMerge: true,
    epoch: "test",
    runId: "run",
    commit: "a".repeat(40),
    state: "ready",
    outcome: {
      targetBranch: "main",
      merged: true,
      resolutionSucceeded: false,
      message: "Follow-up",
    },
  };
  const project = { projectPath: "/cake", enabled: false, epoch: "test", status: "Off" };
  const update = (requests = [request]) =>
    applyWorktreeOperationCatalogUpdate(catalog, {
      operations: [],
      autoMergeRequests: requests,
      autoMergeProjects: [{ ...project }],
    });
  update();
  let observations = 0;
  const stop = effect(() => {
    catalog.autoMergeRequests.map((item) => item.id);
    catalog.autoMergeProjects.map((item) => item.enabled);
    observations += 1;
  });
  try {
    const first = catalog.autoMergeRequests[0];
    update([
      {
        ...request,
        message: undefined,
        outcome: {
          message: "Follow-up",
          resolutionSucceeded: false,
          merged: true,
          targetBranch: "main",
        },
      },
    ]);
    expect(catalog.autoMergeRequests[0]).toBe(first);
    expect(observations).toBe(1);
    for (const [key, value] of Object.entries(request)) {
      const changed = {
        ...request,
        [key]:
          key === "outcome"
            ? { ...request.outcome, message: "Changed" }
            : key === "state"
              ? "failed"
              : key === "commit"
                ? "b".repeat(40)
                : typeof value === "boolean"
                  ? !value
                  : `${value}-changed`,
      };
      update([changed]);
      expect(catalog.autoMergeRequests[0]).not.toBe(first);
      expect(observations).toBeGreaterThan(1);
      update();
    }
    for (const outcome of [
      { ...request.outcome!, targetBranch: "other" },
      { ...request.outcome!, merged: false },
      { ...request.outcome!, resolutionSucceeded: true },
      { ...request.outcome!, landedCommit: "b".repeat(40) },
    ]) {
      update([{ ...request, outcome }]);
      expect(catalog.autoMergeRequests[0]?.outcome).toEqual(outcome);
    }
    const second = { ...request, id: "second" };
    update([request, second]);
    update([second, request]);
    expect(catalog.autoMergeRequests.map((item) => item.id)).toEqual(["second", "first"]);
    project.enabled = true;
    update();
    expect(catalog.autoMergeProjects[0]?.enabled).toBe(true);
    applyWorktreeOperationCatalogUpdate(catalog, { operations: [] });
    expect(catalog.autoMergeRequests).toHaveLength(0);
    expect(catalog.autoMergeProjects).toHaveLength(0);
  } finally {
    stop();
  }
});
