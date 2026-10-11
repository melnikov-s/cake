import { describe, expect, it } from "vitest";
import { WorkflowCatalog } from "../../../../src/renderer/models/WorkflowCatalog";
import { WorkflowRun } from "../../../../src/renderer/models/WorkflowRun";
import {
  applyWorkflowCatalogUpdate,
  applyWorkflowRunUpdate,
  unloadWorkflowRun,
} from "../../../../src/renderer/reducers/WorkflowReducer";
import { workflowSummary } from "../../../../src/contracts/workflows/workflow-projection";
import { workflowActivityFixture, workflowRunFixture } from "../../../fixtures/dynamic-workflow";

describe("Workflow projections", () => {
  it("keeps compact snapshots separate from demand-loaded details and rejects foreign owners", () => {
    const run = workflowRunFixture();
    const catalog = WorkflowCatalog.create({ sessionId: run.ownerSessionId });
    try {
      applyWorkflowCatalogUpdate(catalog, {
        _tag: "Snapshot",
        revision: 1,
        ownerSessionId: run.ownerSessionId,
        runs: [workflowSummary(run)],
      });
      expect(catalog.details).toHaveLength(0);
      const detail = catalog.detail(run.id);
      applyWorkflowRunUpdate(detail, { _tag: "Snapshot", revision: 1, run });
      applyWorkflowCatalogUpdate(catalog, {
        _tag: "Snapshot",
        revision: 2,
        ownerSessionId: run.ownerSessionId,
        runs: [workflowSummary({ ...run, status: "paused" })],
      });
      expect(catalog.details[0]).toBe(detail);
      expect(detail.program?.source).toBe(run.program.source);
      expect(() =>
        applyWorkflowCatalogUpdate(catalog, {
          _tag: "RunChanged",
          revision: 3,
          run: workflowSummary({ ...run, ownerSessionId: "foreign" }),
        }),
      ).toThrow("identity collision");
    } finally {
      catalog[Symbol.dispose]();
    }
  });

  it("applies worker activity only to matching executions and attempts, preserving identity across incremental run changes", () => {
    const run = workflowRunFixture();
    const model = WorkflowRun.create({ id: String(run.id), ownerSessionId: run.ownerSessionId });
    try {
      applyWorkflowRunUpdate(model, { _tag: "Snapshot", revision: 1, run });
      const step = model.steps[0]!;
      applyWorkflowRunUpdate(model, {
        _tag: "WorkerActivity",
        revision: 2,
        activity: workflowActivityFixture(),
      });
      expect(step.activity?.parts).toHaveLength(2);
      const replay = {
        ...run,
        execution: 2,
        steps: run.steps.map((worker) => ({ ...worker, execution: 2, attempt: 1 })),
      };
      applyWorkflowRunUpdate(model, { _tag: "RunChanged", revision: 3, run: replay });
      expect(model.steps[0]).toBe(step);
      expect(step.activity).toBeUndefined();
      applyWorkflowRunUpdate(model, {
        _tag: "WorkerActivity",
        revision: 4,
        activity: workflowActivityFixture(),
      });
      expect(step.activity).toBeUndefined();
      applyWorkflowRunUpdate(model, {
        _tag: "WorkerActivity",
        revision: 5,
        activity: { ...workflowActivityFixture(), execution: 2, attempt: 1 },
      });
      expect(step.activity?.parts).toHaveLength(2);
      applyWorkflowRunUpdate(model, {
        _tag: "WorkerActivity",
        revision: 6,
        activity: { ...workflowActivityFixture(), execution: 2, attempt: 2 },
      });
      expect(step.activity?.attempt).toBe(1);
      applyWorkflowRunUpdate(model, { _tag: "RunChanged", revision: 2, run });
      expect(model.execution).toBe(2);
    } finally {
      model[Symbol.dispose]();
    }
  });

  it("unloads inspection payload without deleting compact progress, and clears optional final fields on replay snapshots", () => {
    const run = workflowRunFixture({ status: "complete" });
    const model = WorkflowRun.create({ id: String(run.id), ownerSessionId: run.ownerSessionId });
    try {
      applyWorkflowRunUpdate(model, { _tag: "Snapshot", revision: 1, run });
      expect(model.result).toBeDefined();
      applyWorkflowRunUpdate(model, { _tag: "Snapshot", revision: 2, run: workflowRunFixture() });
      expect(model.result).toBeUndefined();
      unloadWorkflowRun(model);
      expect(model.loaded).toBe(false);
      expect(model.program).toBeUndefined();
      expect(model.steps).toHaveLength(0);
      expect(model.id).toBe(run.id);
      applyWorkflowRunUpdate(model, { _tag: "Snapshot", revision: 3, run });
      expect(model.program?.args).toEqual({ scope: "routes/auth" });
    } finally {
      model[Symbol.dispose]();
    }
  });
});
