import { Effect, Schema } from "effect";
import {
  WorkflowOwner,
  WorkflowRelaunchInput,
  WorkflowRunTarget,
  WorkflowSaveInput,
  WorkflowStartInput,
  WorkflowWorkerTarget,
} from "../../contracts/workflows/workflow-data";
import type { JsonObject, JsonValue } from "../../ipc/json-contract";
import type { ApplicationState } from "../../services/storage/ApplicationState";
import type { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";
import type { SessionArchiveStorage } from "../../services/storage/SessionArchiveStorage";
import type { TaskInputStorage } from "../../services/storage/TaskInputStorage";
import type { CakeSessionRuntimes } from "../../services/pi/CakeSessionRuntimes";
import type { PiModels } from "../../services/pi/PiModels";
import type { ProjectSessionRuntimeHost } from "../../services/pi/ProjectSessionRuntimeHost";
import type { ProjectSessionConfiguration } from "../../services/project-sessions/ProjectSessionConfiguration";
import type { ProjectAccess } from "../../services/projects/ProjectAccess";
import type { SessionCatalogChanges } from "../../services/session-catalogs/SessionCatalogChanges";
import type { SubagentCoordinator } from "../../services/subagents/SubagentCoordinator";
import type { SubagentEnvironment } from "../../services/subagents/SubagentEnvironment";
import type { Terminal } from "../../services/terminal/Terminal";
import type { ManagedWorktrees } from "../../services/worktrees/ManagedWorktrees";
import type { WorkflowSandbox } from "../../services/pi/WorkflowSandbox";
import type { WorkflowScripts } from "../../services/pi/WorkflowScripts";
import type { WorkflowWorkers } from "../../services/pi/WorkflowWorkers";
import type { WorkflowRunStorage } from "../../services/storage/WorkflowRunStorage";
import type { WorkflowSupervisor } from "../../services/workflows/WorkflowSupervisor";
import type { WorkflowError } from "../../contracts/workflows/workflow-data";
import type { RendererRequestCoordinator } from "../../services/renderer-requests/RendererRequestCoordinator";
import * as workflows from "./workflows";
import { workflowError } from "./run-state";

/** Validated domain dispatch for the Pi adapter's narrow JSON callback. */
/** Explicit capability set breaks the type-inference cycle with Project runtime assembly. */
type WorkflowControlServices =
  | ApplicationState
  | SessionFamilyStorage
  | SessionArchiveStorage
  | TaskInputStorage
  | CakeSessionRuntimes
  | PiModels
  | ProjectSessionRuntimeHost
  | ProjectSessionConfiguration
  | ProjectAccess
  | SessionCatalogChanges
  | SubagentCoordinator
  | SubagentEnvironment
  | Terminal
  | ManagedWorktrees
  | WorkflowSandbox
  | WorkflowScripts
  | WorkflowWorkers
  | WorkflowRunStorage
  | WorkflowSupervisor
  | RendererRequestCoordinator;

export const invoke = Effect.fn("Workflows.invoke")(function* (
  command: string,
  input: JsonObject,
  caller: { readonly _tag: "ProjectSession" | "CakeChatSession"; readonly sessionId: string },
  signal: AbortSignal,
): Effect.fn.Return<JsonValue, WorkflowError, WorkflowControlServices> {
  const result = yield* Effect.gen(function* () {
    switch (command) {
      case "workflows.start":
        return yield* workflows.start(
          yield* Schema.decodeUnknownEffect(WorkflowStartInput)(input),
          caller._tag === "ProjectSession" ? caller.sessionId : undefined,
        );
      case "workflows.propose":
        return yield* workflows.propose(
          yield* Schema.decodeUnknownEffect(WorkflowStartInput)(input),
          caller,
          signal,
        );
      case "workflows.list":
        return yield* workflows.list(yield* Schema.decodeUnknownEffect(WorkflowOwner)(input));
      case "workflows.inspect":
        return yield* workflows.inspect(
          yield* Schema.decodeUnknownEffect(WorkflowRunTarget)(input),
        );
      case "workflows.pause":
        yield* workflows.pause(yield* Schema.decodeUnknownEffect(WorkflowRunTarget)(input));
        return { status: "paused" };
      case "workflows.resume":
        yield* workflows.resume(yield* Schema.decodeUnknownEffect(WorkflowRunTarget)(input));
        return { status: "running" };
      case "workflows.stop":
        yield* workflows.stop(yield* Schema.decodeUnknownEffect(WorkflowRunTarget)(input));
        return { status: "stopped" };
      case "workflows.relaunch":
        return yield* workflows.relaunch(
          yield* Schema.decodeUnknownEffect(WorkflowRelaunchInput)(input),
        );
      case "workflows.stopWorker":
        yield* workflows.stopWorker(yield* Schema.decodeUnknownEffect(WorkflowWorkerTarget)(input));
        return { status: "aborted" };
      case "workflows.restartWorker":
        yield* workflows.restartWorker(
          yield* Schema.decodeUnknownEffect(WorkflowWorkerTarget)(input),
        );
        return { status: "queued" };
      case "workflows.inspectWorker":
        return yield* workflows.inspectWorker(
          yield* Schema.decodeUnknownEffect(WorkflowWorkerTarget)(input),
        );
      case "workflows.saved":
        return yield* workflows.saved(yield* Schema.decodeUnknownEffect(WorkflowOwner)(input));
      case "workflows.save":
        return yield* workflows.save(yield* Schema.decodeUnknownEffect(WorkflowSaveInput)(input));
      default:
        return yield* workflowError("invoke", "invalid-input", "Unknown workflow operation.");
    }
  }).pipe(Effect.mapError((error) => workflowError("invoke", "invalid-input", error.message)));
  return yield* Schema.decodeUnknownEffect(Schema.Json)(result).pipe(
    Effect.mapError((error) => workflowError("invoke", "invalid-output", error.message)),
  );
});
