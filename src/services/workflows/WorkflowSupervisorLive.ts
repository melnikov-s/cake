import { Effect, FiberMap, Layer, PubSub, Scope, SubscriptionRef } from "effect";
import type {
  WorkflowRunId,
  WorkflowWorkerActivity,
} from "../../contracts/workflows/workflow-data";
import { WorkflowSupervisor, type LiveWorkflowRun } from "./WorkflowSupervisor";

export const WorkflowSupervisorLive = Layer.effect(
  WorkflowSupervisor,
  Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const runs = yield* FiberMap.make<WorkflowRunId>();
    const reports = yield* FiberMap.make<WorkflowRunId>();
    const activity = yield* Effect.acquireRelease(
      PubSub.unbounded<{
        readonly runId: WorkflowRunId;
        readonly activity: WorkflowWorkerActivity;
      }>(),
      PubSub.shutdown,
    );
    const state = yield* SubscriptionRef.make<ReadonlyMap<WorkflowRunId, LiveWorkflowRun>>(
      new Map(),
    );
    return WorkflowSupervisor.of({ scope, runs, reports, state, activity });
  }),
);
