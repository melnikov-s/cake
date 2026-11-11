import { Clock, Context, Effect, Layer, Scope } from "effect";
import { cakeChatSideChatConversationId } from "../contracts/cake-chats/cake-chat-identity";
import * as projectSessionMetadata from "../domain/project-sessions/projectSessionMetadata";
import * as projectSessionOperations from "../domain/project-sessions/projectSessionOperations";
import type { PiModels } from "../services/pi/PiModels";
import { promptCachePrediction } from "../utils/prompt-cache-prediction";
import { CakeSessionRuntimes } from "../services/pi/CakeSessionRuntimes";
import type { ProjectSessionRuntimeHost } from "../services/pi/ProjectSessionRuntimeHost";
import type { ProjectAccess } from "../services/projects/ProjectAccess";
import type { ProjectSessionConfiguration } from "../services/project-sessions/ProjectSessionConfiguration";
import type { SessionCatalogChanges } from "../services/session-catalogs/SessionCatalogChanges";
import type { ApplicationState } from "../services/storage/ApplicationState";
import type { SessionArchiveStorage } from "../services/storage/SessionArchiveStorage";
import type { SessionFamilyStorage } from "../services/storage/SessionFamilyStorage";
import type { SubagentCoordinator } from "../services/subagents/SubagentCoordinator";
import type { SubagentEnvironment } from "../services/subagents/SubagentEnvironment";
import type { ManagedWorktrees } from "../services/worktrees/ManagedWorktrees";
import type { Terminal } from "../services/terminal/Terminal";
import type { TaskInputStorage } from "../services/storage/TaskInputStorage";
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
      | ManagedWorktrees
      | PiModels
      | CakeSessionRuntimes
      | ProjectAccess
      | ProjectSessionConfiguration
      | ProjectSessionRuntimeHost
      | SessionArchiveStorage
      | SessionCatalogChanges
      | SessionFamilyStorage
      | SubagentCoordinator
      | SubagentEnvironment
      | Terminal
      | TaskInputStorage
      | Effect.Services<ReturnType<typeof projectSessionOperations.sendAutomatically>>
    >();
    const dependencies = Context.omit(Scope.Scope)(context);
    return WorktreeLandingAgent.of({
      promptContext: Effect.fn("WorktreeLandingAgent.promptContext")((sessionId) =>
        Effect.gen(function* () {
          const location = yield* projectSessionMetadata.findLocation({ sessionId });
          const preview = yield* (yield* CakeSessionRuntimes).inspect({ ...location, sessionId });
          const prediction = promptCachePrediction(
            preview.parts,
            preview.currentModel,
            yield* Clock.currentTimeMillis,
          );
          return {
            estimatedTokens: preview.contextMetadata?.estimatedTokens,
            cacheWarm: prediction?.state === "likely-warm",
          };
        }).pipe(Effect.provide(dependencies), asError("promptContext")),
      ),
      toolPrune: Effect.fn("WorktreeLandingAgent.toolPrune")((sessionId) =>
        Effect.gen(function* () {
          const { location } = yield* projectSessionMetadata.lookupWithLocation({ sessionId });
          const handle = yield* projectSessionOperations.acquireMaintenanceTarget(
            location,
            sessionId,
          );
          return yield* handle.toolPruneIfIdle();
        }).pipe(Effect.provide(dependencies), Effect.scoped, asError("toolPrune")),
      ),
      promptAndWait: Effect.fn("WorktreeLandingAgent.promptAndWait")(function* (input) {
        if (cakeChatSideChatConversationId(input.sessionId) !== undefined)
          return yield* new WorktreeLandingAgentError({
            operation: "prompt",
            message:
              "This Side Chat is read-only. Recover its work in an independent Project Session before requesting commits or conflict resolution; the worktree has been preserved.",
          });
        return yield* Effect.gen(function* () {
          const turnId = yield* projectSessionOperations
            .sendAutomatically({
              sessionId: input.sessionId,
              text: input.text,
              attachments: [],
              renderUserMessageAsMarkdown: false,
            })
            .pipe(asError("prompt"));
          return yield* projectSessionOperations
            .awaitTurnSettled({ sessionId: input.sessionId }, turnId)
            .pipe(asError("awaitTurnSettled"));
        }).pipe(Effect.provide(dependencies), Effect.scoped);
      }),
    });
  }),
);
