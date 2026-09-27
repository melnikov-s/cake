import { Effect } from "effect";
import { VsCodeServer } from "../services/vscode/VsCodeServer";
import { initialize } from "../domain/application/application";
import { initializeRegisteredProjectAccess } from "../domain/projects/projects";
import { reconcileInterrupted } from "../domain/project-sessions/savedDrafts";

/** Runs once before workers or host endpoints can use the acquired backend. */
export const initializeBackend = Effect.fn("Backend.initialize")(function* () {
  yield* initialize();
  yield* initializeRegisteredProjectAccess();
  yield* reconcileInterrupted();
  yield* (yield* VsCodeServer).refreshStatus();
});
