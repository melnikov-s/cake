import { Context, Effect, Layer, Scope } from "effect";
import * as projectSessionOperations from "../domain/project-sessions/projectSessionOperations";
import type { Electron } from "../services/electron/Electron";
import type { PiModels } from "../services/pi/PiModels";
import type { PiSessions } from "../services/pi/PiSessions";
import type { ProjectSessionRuntimeHost } from "../services/pi/ProjectSessionRuntimeHost";
import type { ProjectAccess } from "../services/projects/ProjectAccess";
import type { ProjectSessionConfiguration } from "../services/project-sessions/ProjectSessionConfiguration";
import type { SessionCatalogChanges } from "../services/session-catalogs/SessionCatalogChanges";
import type { ApplicationState } from "../services/storage/ApplicationState";
import type { SessionArchiveStorage } from "../services/storage/SessionArchiveStorage";
import type { SessionFamilyStorage } from "../services/storage/SessionFamilyStorage";
import type { SubagentCoordinator } from "../services/subagents/SubagentCoordinator";
import type { SubagentEnvironment } from "../services/subagents/SubagentEnvironment";
import type { VsCodeServer } from "../services/vscode/VsCodeServer";
import type { ManagedWorktrees } from "../services/worktrees/ManagedWorktrees";
import type { Terminal } from "../services/terminal/Terminal";
import {
  WorktreeLandingAgent,
  WorktreeLandingAgentError,
} from "../services/worktrees/WorktreeLandingAgent";

const asError = (operation: string) =>
  Effect.mapError(
    (cause: unknown) =>
      new WorktreeLandingAgentError({
        operation,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  );

export const WorktreeLandingAgentLive = Layer.effect(
  WorktreeLandingAgent,
  Effect.gen(function* () {
    const context = yield* Effect.context<
      | Scope.Scope
      | ApplicationState
      | Electron
      | ManagedWorktrees
      | PiModels
      | PiSessions
      | ProjectAccess
      | ProjectSessionConfiguration
      | ProjectSessionRuntimeHost
      | SessionArchiveStorage
      | SessionCatalogChanges
      | SessionFamilyStorage
      | SubagentCoordinator
      | SubagentEnvironment
      | Terminal
      | VsCodeServer
    >();
    const dependencies = Context.omit(Scope.Scope)(context);
    return WorktreeLandingAgent.of({
      promptAndWait: Effect.fn("WorktreeLandingAgent.promptAndWait")(function* (input) {
        yield* Effect.gen(function* () {
          const turnId = yield* projectSessionOperations
            .prompt({
              sessionId: input.sessionId,
              text: input.text,
              attachments: [],
              renderUserMessageAsMarkdown: false,
            })
            .pipe(asError("prompt"));
          yield* projectSessionOperations
            .awaitTurnSettled({ sessionId: input.sessionId }, turnId)
            .pipe(asError("awaitTurnSettled"));
        }).pipe(Effect.provide(dependencies), Effect.scoped);
      }),
    });
  }),
);
