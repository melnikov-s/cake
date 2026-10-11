import {
  Context,
  type FiberMap,
  type Latch,
  type PubSub,
  type Scope,
  type SubscriptionRef,
} from "effect";
import type {
  WorkflowRunId,
  WorkflowStepId,
  WorkflowWorkerActivity,
} from "../../contracts/workflows/workflow-data";
import type { WorkflowCheckpoint } from "../storage/WorkflowRunStorage";

/** Backend-only transient state. Nothing here crosses RPC or gets persisted. */
export interface LiveWorkflowRun {
  readonly checkpoint: WorkflowCheckpoint;
  /** Closed by Pause; only admission of new worker attempts awaits this gate. */
  readonly schedulingGate: Latch.Latch;
  readonly workers: FiberMap.FiberMap<WorkflowStepId>;
  readonly scope: Scope.Closeable;
}

/**
 * Process-scoped owner for accepted background work. Free domain Effects own
 * workflow policy; this resource service owns scopes, keyed fibers, and ordered
 * projections. Closing a window or ending the initiating turn doesn't close it.
 */
export class WorkflowSupervisor extends Context.Service<
  WorkflowSupervisor,
  {
    readonly scope: Scope.Scope;
    readonly runs: FiberMap.FiberMap<WorkflowRunId>;
    readonly reports: FiberMap.FiberMap<WorkflowRunId>;
    readonly state: SubscriptionRef.SubscriptionRef<ReadonlyMap<WorkflowRunId, LiveWorkflowRun>>;
    /** Transient Pi projections, never checkpointed as a second transcript. */
    readonly activity: PubSub.PubSub<{
      readonly runId: WorkflowRunId;
      readonly activity: WorkflowWorkerActivity;
    }>;
  }
>()("cake/services/workflows/WorkflowSupervisor") {}
