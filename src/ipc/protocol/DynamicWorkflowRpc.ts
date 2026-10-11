import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import {
  SavedWorkflow,
  WorkflowCatalogUpdate,
  WorkflowError,
  WorkflowOwner,
  WorkflowRelaunchInput,
  WorkflowRun,
  WorkflowRunReceipt,
  WorkflowRunSummary,
  WorkflowRunTarget,
  WorkflowRunUpdate,
  WorkflowSaveInput,
  WorkflowStartInput,
  WorkflowWorkerActivity,
  WorkflowWorkerTarget,
} from "../../contracts/workflows/workflow-data";

/** Review skeleton: deliberately not merged into CakeRpc/BackendRpc until implementation. */
export const DynamicWorkflowRpc = RpcGroup.make(
  Rpc.make("workflows.start", {
    payload: WorkflowStartInput,
    success: WorkflowRunReceipt,
    error: WorkflowError,
  }),
  Rpc.make("workflows.list", {
    payload: WorkflowOwner,
    success: Schema.Array(WorkflowRunSummary),
    error: WorkflowError,
  }),
  Rpc.make("workflows.inspect", {
    payload: WorkflowRunTarget,
    success: WorkflowRun,
    error: WorkflowError,
  }),
  Rpc.make("workflows.observe", {
    payload: WorkflowOwner,
    success: WorkflowCatalogUpdate,
    error: WorkflowError,
    stream: true,
  }),
  Rpc.make("workflows.observeRun", {
    payload: WorkflowRunTarget,
    success: WorkflowRunUpdate,
    error: WorkflowError,
    stream: true,
  }),
  Rpc.make("workflows.pause", { payload: WorkflowRunTarget, error: WorkflowError }),
  Rpc.make("workflows.resume", { payload: WorkflowRunTarget, error: WorkflowError }),
  Rpc.make("workflows.stop", { payload: WorkflowRunTarget, error: WorkflowError }),
  Rpc.make("workflows.relaunch", {
    payload: WorkflowRelaunchInput,
    success: WorkflowRunReceipt,
    error: WorkflowError,
  }),
  Rpc.make("workflows.stopWorker", { payload: WorkflowWorkerTarget, error: WorkflowError }),
  Rpc.make("workflows.restartWorker", { payload: WorkflowWorkerTarget, error: WorkflowError }),
  Rpc.make("workflows.inspectWorker", {
    payload: WorkflowWorkerTarget,
    success: WorkflowWorkerActivity,
    error: WorkflowError,
  }),
  Rpc.make("workflows.saved", {
    payload: WorkflowOwner,
    success: Schema.Array(SavedWorkflow),
    error: WorkflowError,
  }),
  Rpc.make("workflows.save", {
    payload: WorkflowSaveInput,
    success: SavedWorkflow,
    error: WorkflowError,
  }),
);
