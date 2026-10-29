import { expect, it } from "vitest";
import { WorkflowCatalog } from "../../../../src/renderer/models/WorkflowCatalog";
import {
  applyWorkflowCatalogUpdate,
  applyWorkflowRunUpdate,
  unloadWorkflowRun,
} from "../../../../src/renderer/reducers/WorkflowReducer";
import { workflowSummary } from "../../../../src/contracts/workflows/workflow-projection";
import { workflowRunFixture } from "../../../fixtures/dynamic-workflow";

// Details/relaunch/result clearing and stale execution/attempt activity are visible
// contracts in dynamic-workflow and projection-finish-workflow. Keep the actual
// allocation/unload and Model identity contract, which DOM output cannot establish.
it("isolates demand-loaded details from compact progress and releases their payload without replacing keyed Models", () => {
  const run = workflowRunFixture();
  using catalog = WorkflowCatalog.create({ sessionId: run.ownerSessionId });
  applyWorkflowCatalogUpdate(catalog, {
    _tag: "Snapshot",
    revision: 1,
    ownerSessionId: run.ownerSessionId,
    runs: [workflowSummary(run)],
  });
  expect(catalog.details).toHaveLength(0);
  const detail = catalog.detail(run.id);
  applyWorkflowRunUpdate(detail, { _tag: "Snapshot", revision: 1, run });
  const step = detail.steps[0];
  applyWorkflowRunUpdate(detail, {
    _tag: "RunChanged",
    revision: 2,
    run: {
      ...run,
      execution: 2,
      steps: run.steps.map((worker) => ({ ...worker, execution: 2, attempt: 1 })),
    },
  });
  expect(detail.steps[0]).toBe(step);
  applyWorkflowCatalogUpdate(catalog, {
    _tag: "Snapshot",
    revision: 2,
    ownerSessionId: run.ownerSessionId,
    runs: [workflowSummary({ ...run, status: "paused" })],
  });
  const compact = catalog.runs[0];
  expect(catalog.details[0]).toBe(detail);
  expect(detail.program?.source).toBe(run.program.source);
  expect(() =>
    applyWorkflowCatalogUpdate(catalog, {
      _tag: "RunChanged",
      revision: 3,
      run: workflowSummary({ ...run, ownerSessionId: "foreign" }),
    }),
  ).toThrow("identity collision");

  unloadWorkflowRun(detail);
  expect(detail.loaded).toBe(false);
  expect(detail.program).toBeUndefined();
  expect(detail.steps).toHaveLength(0);
  expect(catalog.runs[0]).toBe(compact);
  expect(compact?.status).toBe("paused");
  expect(catalog.detail(run.id)).toBe(detail);
  applyWorkflowRunUpdate(detail, { _tag: "Snapshot", revision: 3, run });
  expect(detail.program?.args).toEqual({ scope: "routes/auth" });
});
