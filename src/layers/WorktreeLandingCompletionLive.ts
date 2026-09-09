import { Effect, Layer } from "effect";
import type { ApplicationState } from "../services/storage/ApplicationState";
import type { PiSessions } from "../services/pi/PiSessions";
import type { SubagentCoordinator } from "../services/subagents/SubagentCoordinator";
import type { SessionArchiveStorage } from "../services/storage/SessionArchiveStorage";
import type { SessionCatalogChanges } from "../services/session-catalogs/SessionCatalogChanges";
import type { Terminal } from "../services/terminal/Terminal";
import type { ProjectSessionConfiguration } from "../services/project-sessions/ProjectSessionConfiguration";
import type { SessionFamilyStorage } from "../services/storage/SessionFamilyStorage";
import type { ManagedWorktrees } from "../services/worktrees/ManagedWorktrees";
import * as projectSessionLifecycle from "../domain/projectSessionLifecycle";
import { WorktreeLandingError } from "../domain/worktree-landing-data";
import { WorktreeLandingCompletion } from "../services/worktrees/WorktreeLandingCompletion";

type Dependencies =
  | ApplicationState
  | PiSessions
  | SubagentCoordinator
  | SessionArchiveStorage
  | SessionCatalogChanges
  | Terminal
  | ProjectSessionConfiguration
  | SessionFamilyStorage
  | ManagedWorktrees;

export const WorktreeLandingCompletionLive = Layer.effect(
  WorktreeLandingCompletion,
  Effect.gen(function* () {
    const context = yield* Effect.context<Dependencies>();
    return WorktreeLandingCompletion.of({
      resolveWorkingDirectory: Effect.fn("WorktreeLandingCompletion.resolveWorkingDirectory")(
        (workingDirectory) =>
          projectSessionLifecycle.resolveWorkingDirectory(workingDirectory).pipe(
            Effect.mapError(
              (error) =>
                new WorktreeLandingError({
                  operation: "resolveWorkingDirectory",
                  message: error.message,
                }),
            ),
            Effect.provide(context),
          ),
      ),
    });
  }),
);
