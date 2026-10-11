import { DateTime, Effect, Exit, FiberMap, Latch, Option, Scope, SubscriptionRef } from "effect";
import {
  WorkflowError,
  type WorkflowStepId,
  type WorkflowRunId,
  type WorkflowRunTarget,
} from "../../contracts/workflows/workflow-data";
import {
  WorkflowRunStorage,
  type WorkflowCheckpoint,
} from "../../services/storage/WorkflowRunStorage";
import {
  WorkflowSupervisor,
  type LiveWorkflowRun,
} from "../../services/workflows/WorkflowSupervisor";

export const workflowError = (
  operation: string,
  reason: WorkflowError["reason"],
  message: string,
) => new WorkflowError({ operation, reason, message: message.slice(0, 16_384) });

export const makeLiveRun = Effect.fn("Workflows.makeLiveRun")(function* (
  checkpoint: WorkflowCheckpoint,
) {
  const supervisor = yield* WorkflowSupervisor;
  const scope = yield* Scope.make();
  yield* Scope.addFinalizer(supervisor.scope, Scope.close(scope, Exit.void));
  const workers = yield* Scope.provide(scope)(FiberMap.make<WorkflowStepId>());
  const schedulingGate = yield* Latch.make(checkpoint.run.status !== "paused");
  return { checkpoint, workers, scope, schedulingGate } satisfies LiveWorkflowRun;
});

/** The SubscriptionRef lock serializes checkpoint writes and their publication. */
export const updateRun = Effect.fn("Workflows.updateRun")(function* (
  id: WorkflowRunId,
  transition: (checkpoint: WorkflowCheckpoint) => WorkflowCheckpoint,
) {
  const supervisor = yield* WorkflowSupervisor;
  const storage = yield* WorkflowRunStorage;
  return yield* SubscriptionRef.modifyEffect(supervisor.state, (current) =>
    Effect.gen(function* () {
      const live = current.get(id);
      if (!live) return yield* workflowError("update", "not-found", "Workflow run not found.");
      const next = yield* Effect.try({
        try: () => transition(live.checkpoint),
        catch: (error) =>
          error instanceof WorkflowError
            ? error
            : workflowError("update", "invalid-state", String(error)),
      });
      const checkpoint = {
        ...next,
        run: {
          ...next.run,
          revision: live.checkpoint.run.revision + 1,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        },
      };
      yield* storage.save(checkpoint, live.checkpoint.run.revision);
      const map = new Map(current);
      map.set(id, { ...live, checkpoint });
      return [checkpoint, map] as const;
    }),
  );
});

export const getRun = Effect.fn("Workflows.getRun")(function* (target: WorkflowRunTarget) {
  const supervisor = yield* WorkflowSupervisor;
  let live = (yield* SubscriptionRef.get(supervisor.state)).get(target.runId);
  if (!live) {
    const storage = yield* WorkflowRunStorage;
    const loaded = yield* storage.load(target.runId);
    if (Option.isNone(loaded))
      return yield* workflowError(
        "inspect",
        "not-found",
        "No checkpoint exists for this workflow; start a new run explicitly.",
      );
    if (loaded.value.run.ownerSessionId !== target.sessionId)
      return yield* workflowError(
        "inspect",
        "not-found",
        "Workflow belongs to another Project Session.",
      );
    const candidate = yield* makeLiveRun(loaded.value);
    live = yield* SubscriptionRef.modifyEffect(supervisor.state, (current) =>
      Effect.gen(function* () {
        const existing = current.get(target.runId);
        if (existing) return [existing, current] as const;
        const map = new Map(current);
        let checkpoint = loaded.value;
        if (["running", "paused", "stopping"].includes(checkpoint.run.status)) {
          checkpoint = {
            ...checkpoint,
            run: {
              ...checkpoint.run,
              status: "interrupted",
              revision: checkpoint.run.revision + 1,
              updatedAt: DateTime.formatIso(yield* DateTime.now),
              steps: checkpoint.run.steps.map((step) =>
                step.status === "running" || step.status === "queued"
                  ? { ...step, status: "aborted" as const }
                  : step,
              ),
              error: "Backend execution ended. Relaunch deliberately to reuse completed results.",
            },
          };
          yield* storage.save(checkpoint, loaded.value.run.revision);
        }
        const installed = { ...candidate, checkpoint };
        map.set(target.runId, installed);
        return [installed, map] as const;
      }),
    );
  }
  if (live.checkpoint.run.ownerSessionId !== target.sessionId)
    return yield* workflowError(
      "inspect",
      "not-found",
      "Workflow belongs to another Project Session.",
    );
  return live;
});
