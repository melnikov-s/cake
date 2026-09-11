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
  "projectSessions.observe": (target) => Stream.unwrap(projectSessionOperations.observe(target)),
  "projectSessions.prompt": (input) =>
    withConnection((connectionId) =>
      bindRenderer(connectionId, input.sessionId).pipe(
        Effect.andThen(projectSessionOperations.prompt(input)),
      ),
    ),
  "projectSessions.steer": (input) =>
    withConnection((connectionId) =>
      bindRenderer(connectionId, input.sessionId).pipe(
        Effect.andThen(projectSessionOperations.steer(input)),
      ),
    ),
  "projectSessions.followUp": (input) =>
    withConnection((connectionId) =>
      bindRenderer(connectionId, input.sessionId).pipe(
        Effect.andThen(projectSessionOperations.followUp(input)),
      ),
    ),
  "projectSessions.abort": (target) => projectSessionOperations.abort(target),
  "projectSessions.listQueuedMessages": (target) =>
    projectSessionOperations.listQueuedMessages(target),
  "projectSessions.clearQueue": (target) => projectSessionOperations.clearQueue(target),
  "projectSessions.cancelSteering": (target) => projectSessionOperations.cancelSteering(target),
  "projectSessions.removeQueuedMessage": ({ partId, ...target }) =>
    projectSessionOperations.removeQueuedMessage(target, partId),
  "projectSessions.steerQueuedMessage": ({ partId, ...target }) =>
    projectSessionOperations.steerQueuedMessage(target, partId),
  "projectSessions.compact": ({ instructions, ...target }) =>
    projectSessionOperations.compact(target, instructions),
  "projectSessions.editMessage": (input) => projectSessionOperations.editMessage(input),
  "projectSessions.setUserMessageMarkdown": ({ entryId, renderAsMarkdown, ...target }) =>
    projectSessionOperations.setUserMessageMarkdown(target, entryId, renderAsMarkdown),
  "projectSessions.applyConfiguration": ({ configuration, ...target }) =>
    projectSessionOperations.applyConfiguration(target, configuration),
  "projectSessions.setModel": ({ provider, modelId, ...target }) =>
    projectSessionOperations.setModel(target, provider, modelId),
  "projectSessions.setThinkingLevel": ({ level, ...target }) =>
    projectSessionOperations.setThinkingLevel(target, level),
  "projectSessions.setFastMode": ({ enabled, ...target }) =>
    projectSessionOperations.setFastMode(target, enabled),
  "projectSessions.getChangelog": (target) => projectSessionOperations.getChangelog(target),
  "projectSessions.navigate": ({ entryId, summarize, customInstructions, ...target }) => {
    const options = { summarize };
    if (customInstructions !== undefined) Object.assign(options, { customInstructions });
    return projectSessionOperations.navigate(target, entryId, options);
  },
  "projectSessions.setPiSetting": ({ update, ...target }) =>
    projectSessionOperations.setPiSetting(target, update),
  "projectSessions.reload": (target) => projectSessionOperations.reload(target),
  "projectSessions.login": ({ provider, authType, ...target }) =>
    projectSessionOperations.login(target, provider, authType),
  "projectSessions.logout": ({ provider, ...target }) =>
    projectSessionOperations.logout(target, provider),
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
