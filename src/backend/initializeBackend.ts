import { Effect } from "effect";
import { VsCodeServer } from "../services/vscode/VsCodeServer";
import { initialize } from "../domain/application/application";
import { initializeRegisteredProjectAccess } from "../domain/projects/projects";
import { reconcileInterrupted } from "../domain/project-sessions/savedDrafts";
import { startupDiagnostics } from "../services/diagnostics/startup-diagnostics";

/** Runs once before workers or host endpoints can use the acquired backend. */
export const initializeBackend = Effect.fn("Backend.initialize")(function* () {
  yield* startupDiagnostics.measure("application-initialize", initialize());
  yield* startupDiagnostics.measure(
    "project-access-initialize",
    initializeRegisteredProjectAccess(),
  );
  yield* startupDiagnostics.measure("saved-drafts-reconcile", reconcileInterrupted());
  yield* startupDiagnostics.measure("vscode-status-refresh", (yield* VsCodeServer).refreshStatus());
});
