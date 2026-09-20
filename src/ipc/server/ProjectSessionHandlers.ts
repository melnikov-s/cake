import { Effect, Stream } from "effect";
import { ProjectSessionError } from "../../domain/project-sessions/project-session-data";
import * as projects from "../../domain/projects/projects";
import * as projectSessionMetadata from "../../domain/project-sessions/projectSessionMetadata";
import * as projectSessionOperations from "../../domain/project-sessions/projectSessionOperations";
import * as projectSessionContinuations from "../../domain/project-sessions/projectSessionContinuations";
import * as projectSessionLifecycle from "../../domain/project-sessions/projectSessionLifecycle";
import { ProjectSessionRpc } from "../protocol/ProjectSessionRpc";
import { RendererConnection } from "../protocol/RendererConnectionMiddleware";
import { RendererRequestCoordinator } from "../../services/renderer-requests/RendererRequestCoordinator";

const withConnection = <A, E, R>(operation: (connectionId: number) => Effect.Effect<A, E, R>) =>
  Effect.flatMap(RendererConnection, ({ connectionId }) => operation(connectionId));

const activateWorkingDirectory = (connectionId: number, workingDirectory: string) =>
  projects.activateWorkingDirectory(connectionId, workingDirectory).pipe(
    Effect.mapError(
      (error) =>
        new ProjectSessionError({
          operation: "activateWorkingDirectory",
          message: error.message,
        }),
    ),
  );

const bindRenderer = (connectionId: number, sessionId: string) =>
  Effect.flatMap(RendererRequestCoordinator, (coordinator) =>
    coordinator.bind({ _tag: "ProjectSession", sessionId }, connectionId),
  ).pipe(
    Effect.mapError(
      (error) => new ProjectSessionError({ operation: "bindRenderer", message: error.message }),
    ),
  );

export const projectSessionHandlers = ProjectSessionRpc.of({
  "projectSessions.observeCatalog": (query) =>
    Stream.unwrap(projectSessionMetadata.observeCatalog(query)),
  "projectSessions.inspect": (target) => projectSessionMetadata.inspect(target),
  "projectSessions.readProjection": (target) => projectSessionOperations.readProjection(target),
  "projectSessions.start": (input) =>
    withConnection((connectionId) =>
      activateWorkingDirectory(connectionId, input.workingDirectory).pipe(
        Effect.andThen(bindRenderer(connectionId, input.sessionId)),
        Effect.andThen(projectSessionOperations.start(input)),
      ),
    ),
  "projectSessions.open": (target) =>
    withConnection((connectionId) =>
      bindRenderer(connectionId, target.sessionId).pipe(
        Effect.andThen(projectSessionMetadata.open(target)),
        Effect.tap(() =>
          target.workingDirectory
            ? activateWorkingDirectory(connectionId, target.workingDirectory)
            : Effect.void,
        ),
      ),
    ),
  "projectSessions.getChangelog": (target) => projectSessionOperations.getChangelog(target),
  "projectSessions.navigate": ({ entryId, summarize, customInstructions, ...target }) => {
    const options = { summarize };
    if (customInstructions !== undefined) Object.assign(options, { customInstructions });
    return projectSessionOperations.navigate(target, entryId, options);
  },
  "projectSessions.dispatchExtensionCompanionAction": (input) =>
    projectSessionOperations.dispatchExtensionCompanionAction(input),
  "projectSessions.callCakeOperation": ({ command, input, ...target }) =>
    projectSessionOperations.callCakeOperation(target, command, input),
  "projectSessions.toolCompact": ({ entryId, prompt, ...target }) => {
    const input: Parameters<typeof projectSessionContinuations.toolCompact>[0] = {
      target,
      entryId,
    };
    if (prompt !== undefined) Object.assign(input, { prompt });
    return projectSessionContinuations.toolCompact(input);
  },
  "projectSessions.rename": ({ name, ...target }) => projectSessionOperations.rename(target, name),
  "projectSessions.fork": ({ entryId, destinationWorkingDirectory, resolveSource, ...target }) => {
    const input: Parameters<typeof projectSessionContinuations.fork>[0] = { target, entryId };
    if (destinationWorkingDirectory !== undefined)
      Object.assign(input, { destinationWorkingDirectory });
    if (resolveSource !== undefined) Object.assign(input, { resolveSource });
    return projectSessionContinuations.fork(input);
  },
  "projectSessions.resolve": (target) =>
    projectSessionLifecycle.resolve(target).pipe(Effect.asVoid),
  "projectSessions.resolveWorkingDirectory": ({ workingDirectory }) =>
    projectSessionLifecycle.resolveWorkingDirectory(workingDirectory),
  "projectSessions.restore": (target) =>
    projectSessionLifecycle.restore(target).pipe(Effect.asVoid),
  "projectSessions.respondControl": ({ sessionId, controlRequestId, result }) =>
    withConnection((connectionId) =>
      Effect.flatMap(RendererRequestCoordinator, (coordinator) =>
        coordinator.respondProjectControl(connectionId, sessionId, controlRequestId, result),
      ),
    ).pipe(
      Effect.mapError(
        (error) => new ProjectSessionError({ operation: "respondControl", message: error.message }),
      ),
    ),
});
