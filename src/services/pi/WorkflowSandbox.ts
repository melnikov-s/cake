import { Context, type Effect, type Scope } from "effect";
import type {
  WorkflowAgentInput,
  WorkflowError,
  WorkflowProgram,
} from "../../contracts/workflows/workflow-data";
import type { JsonValue } from "../../contracts/serialization/json-contract";

/** Cake-owned capabilities injected into the standalone pi-codemode QuickJS VM. */
export interface WorkflowScriptHost {
  readonly agent: (
    input: WorkflowAgentInput,
    failureMode: "throw" | "null",
  ) => Effect.Effect<JsonValue, WorkflowError>;
  readonly phase: (title: string) => Effect.Effect<void, WorkflowError>;
  readonly log: (message: string) => Effect.Effect<void, WorkflowError>;
}

/**
 * Owns the external worker-thread/QuickJS boundary, not workflow scheduling policy.
 * Live implementation will use @earendil-works/pi-codemode directly, not Pi's
 * session codemode tool. Effect interruption aborts host calls and closes the VM.
 */
export class WorkflowSandbox extends Context.Service<
  WorkflowSandbox,
  {
    readonly execute: (
      program: WorkflowProgram,
      host: WorkflowScriptHost,
    ) => Effect.Effect<JsonValue | undefined, WorkflowError, Scope.Scope>;
  }
>()("cake/services/pi/WorkflowSandbox") {}
