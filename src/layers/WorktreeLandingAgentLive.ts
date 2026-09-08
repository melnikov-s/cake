import { Context, Effect, Layer, Scope } from "effect";
import * as projectSessions from "../domain/projectSessions";
import type { ProjectSessionEnvironment } from "../services/project-sessions/ProjectSessionEnvironment";
import type { PiSessions } from "../services/pi/PiSessions";
import type { SessionCatalogChanges } from "../services/session-catalogs/SessionCatalogChanges";
import type { ApplicationState } from "../services/storage/ApplicationState";
import type { SessionArchiveStorage } from "../services/storage/SessionArchiveStorage";
import type { SessionFamilyStorage } from "../services/storage/SessionFamilyStorage";
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
      | PiSessions
      | ProjectSessionEnvironment
      | SessionArchiveStorage
      | SessionCatalogChanges
      | SessionFamilyStorage
    >();
    const dependencies = Context.omit(Scope.Scope)(context);
    return WorktreeLandingAgent.of({
      promptAndWait: Effect.fn("WorktreeLandingAgent.promptAndWait")(function* (input) {
        yield* Effect.gen(function* () {
          const turnId = yield* projectSessions
            .prompt({
              sessionId: input.sessionId,
              text: input.text,
              attachments: [],
              renderUserMessageAsMarkdown: false,
            })
            .pipe(asError("prompt"));
          yield* projectSessions
            .awaitTurnSettled({ sessionId: input.sessionId }, turnId)
            .pipe(asError("awaitTurnSettled"));
        }).pipe(Effect.provide(dependencies), Effect.scoped);
      }),
    });
  }),
);
