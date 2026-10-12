import { Context, Schema, type Effect, type Option } from "effect";
import {
  WorkflowProgram,
  WorkflowRun,
  WorkflowStepId,
  WorkflowWorkerTarget,
  type WorkflowError,
  type WorkflowRunId,
  type WorkflowRunSummary,
} from "../../contracts/workflows/workflow-data";
import { ExplicitCakeModelSelection } from "../../contracts/model-presets/cake-model-selection";
import { WorkflowWorkerReference } from "../pi/WorkflowWorkers";

const WorkerAttemptReference = Schema.Struct({
  stepId: WorkflowStepId,
  execution: WorkflowWorkerTarget.fields.execution,
  attempt: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 })),
  reference: WorkflowWorkerReference,
});

/**
 * Cake's replay journal, not a copy of a Pi transcript. Run.steps holds ordered
 * inputs/results; these references permit details to be regenerated from Pi.
 * Live storage uses versioned, atomic per-run documents under Cake state/workflows.
 */
export const WorkflowCheckpoint = Schema.Struct({
  run: WorkflowRun,
  /** Prior frozen versions remain readable when a deliberate relaunch changes source. */
  previousPrograms: Schema.Array(WorkflowProgram),
  inheritedModel: ExplicitCakeModelSelection,
  commonInstructions: Schema.String.check(Schema.isMaxLength(262_144)),
  workers: Schema.Array(WorkerAttemptReference),
  /** Only executing assignments at launch own this run; queued turns never do. */
  completionTurnIds: Schema.Array(Schema.String),
  /** Final report handoff is separate from run execution and can be reconciled. */
  completionDelivery: Schema.Literals(["pending", "delivered"]),
});
export interface WorkflowCheckpoint extends Schema.Schema.Type<typeof WorkflowCheckpoint> {}

export class WorkflowRunStorage extends Context.Service<
  WorkflowRunStorage,
  {
    readonly load: (
      id: WorkflowRunId,
    ) => Effect.Effect<Option.Option<WorkflowCheckpoint>, WorkflowError>;
    readonly list: (
      ownerSessionId: string,
    ) => Effect.Effect<ReadonlyArray<WorkflowRunSummary>, WorkflowError>;
    /** null means create-only; an integer requires that exact stored revision. */
    readonly save: (
      checkpoint: WorkflowCheckpoint,
      expectedRevision: number | null,
    ) => Effect.Effect<void, WorkflowError>;
  }
>()("cake/services/storage/WorkflowRunStorage") {}
