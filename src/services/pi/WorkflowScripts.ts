import { Context, type Effect } from "effect";
import type {
  SavedWorkflow,
  WorkflowError,
  WorkflowProgram,
} from "../../contracts/workflows/workflow-data";
import type { JsonValue } from "../../contracts/serialization/json-contract";

export interface WorkflowScriptLocation {
  readonly projectPath: string;
  readonly workingDirectory: string;
}

/** Filesystem and JavaScript syntax boundary; never evaluate metadata on the host. */
export class WorkflowScripts extends Context.Service<
  WorkflowScripts,
  {
    /** Read and freeze source; parse a first-statement literal export const meta. */
    readonly read: (
      location: WorkflowScriptLocation,
      scriptPath: string,
      args?: JsonValue,
    ) => Effect.Effect<WorkflowProgram, WorkflowError>;
    /** Closest project definition wins; project definitions shadow personal ones. */
    readonly list: (
      location: WorkflowScriptLocation,
    ) => Effect.Effect<ReadonlyArray<SavedWorkflow>, WorkflowError>;
    /** Snapshot the run's source into .cake/workflows or Cake's personal workflows directory. */
    readonly save: (
      location: WorkflowScriptLocation,
      program: WorkflowProgram,
      name: string,
      destination: "project" | "personal",
    ) => Effect.Effect<SavedWorkflow, WorkflowError>;
  }
>()("cake/services/pi/WorkflowScripts") {}
