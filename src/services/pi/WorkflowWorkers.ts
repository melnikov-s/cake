import { Context, Schema, type Effect } from "effect";
import type {
  WorkflowAgentInput,
  WorkflowError,
  WorkflowOutputSchema,
  WorkflowWorkerActivity,
  WorkflowWorkerTarget,
} from "../../contracts/workflows/workflow-data";
import type { ExplicitCakeModelSelection } from "../../ipc/cake-model-selection";
import type { JsonValue } from "../../ipc/json-contract";
import type { SessionUsage } from "../../ipc/session-contract";

/** Backend-only reference into Pi-owned private worker transcripts; never a sidebar session. */
export const WorkflowWorkerReference = Schema.Struct({
  sessionId: Schema.String.check(Schema.isUUID(4)),
  workingDirectory: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
});
export interface WorkflowWorkerReference extends Schema.Schema.Type<
  typeof WorkflowWorkerReference
> {}

export interface WorkflowWorkerRequest {
  readonly target: WorkflowWorkerTarget;
  readonly attempt: number;
  readonly input: WorkflowAgentInput;
  readonly workingDirectory: string;
  readonly model: ExplicitCakeModelSelection;
  readonly commonInstructions: string;
  /** Save the Pi reference before work starts; a persistence failure prevents execution. */
  readonly onCreated: (reference: WorkflowWorkerReference) => Effect.Effect<void, WorkflowError>;
  readonly onActivity: (activity: WorkflowWorkerActivity) => Effect.Effect<void, WorkflowError>;
}

export interface WorkflowWorkerResult {
  readonly result: JsonValue;
  readonly usage?: SessionUsage;
}

/**
 * Reuses Cake's Pi/SubagentSession runtime boundary. Each call owns one ephemeral
 * runtime, uses normal project context plus supplied common/task instructions,
 * and returns its answer to the script. No message_parent, parent completion
 * notification, Cake controls, or recursive delegation is exposed to the worker.
 * Pi retains the transcript after the runtime is released.
 */
export class WorkflowWorkers extends Context.Service<
  WorkflowWorkers,
  {
    /** Reject invalid/provably contradictory schemas before starting a billed worker. */
    readonly validateOutputSchema: (
      schema: WorkflowOutputSchema,
    ) => Effect.Effect<void, WorkflowError>;
    /** No inherited five-minute wait limit; interruption aborts and awaits cleanup. */
    readonly run: (
      request: WorkflowWorkerRequest,
    ) => Effect.Effect<WorkflowWorkerResult, WorkflowError>;
    readonly inspect: (
      reference: WorkflowWorkerReference,
      target: WorkflowWorkerTarget,
      attempt: number,
    ) => Effect.Effect<WorkflowWorkerActivity, WorkflowError>;
  }
>()("cake/services/pi/WorkflowWorkers") {}
