import { Effect, Option, Stream } from "effect";
import { AutomationRecords } from "../../services/automations/AutomationRecords";
import * as automationRuns from "../../domain/automations/automationRuns";
import type { ProjectSessionTarget } from "../../contracts/project-sessions/project-session-data";
import { ProjectSessionError } from "../../contracts/project-sessions/project-session-data";
import * as projects from "../../domain/projects/projects";
import { observeSignals } from "../../domain/project-sessions/projectSessionSignals";
import * as projectSessionMetadata from "../../domain/project-sessions/projectSessionMetadata";
import * as projectSessionOperations from "../../domain/project-sessions/projectSessionOperations";
import * as projectSessionContinuations from "../../domain/project-sessions/projectSessionContinuations";
import * as projectSessionUserLifecycle from "../../domain/project-sessions/projectSessionUserLifecycle";
import * as projectSessionLifecycle from "../../domain/project-sessions/projectSessionLifecycle";
import { ProjectSessionRpc } from "../protocol/ProjectSessionRpc";
import { RendererConnection } from "../protocol/RendererConnectionMiddleware";
import { RendererRequestCoordinator } from "../../services/renderer-requests/RendererRequestCoordinator";
import { admitTurnAttachments } from "./AttachmentUploadHandlers";

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

const setResolved = Effect.fn("SessionLifecycle.setResolved")(function* (
  target: ProjectSessionTarget,
  resolved: boolean,
  userInitiated: boolean,
) {
  const automations = yield* Effect.serviceOption(AutomationRecords);
  if (
    Option.isSome(automations) &&
    automations.value.snapshot().runs.some((run) => run.sessionId === target.sessionId)
  )
    return yield* automationRuns.setResolved(target.sessionId, resolved).pipe(
      Effect.provideService(AutomationRecords, automations.value),
      Effect.mapError(
        (error) => new ProjectSessionError({ operation: "setResolved", message: error.message }),
      ),
    );
  if (userInitiated)
    return yield* projectSessionUserLifecycle.setResolved(target, resolved).pipe(Effect.asVoid);
  return yield* (
    resolved ? projectSessionLifecycle.resolve(target) : projectSessionLifecycle.restore(target)
  ).pipe(Effect.asVoid);
});

export const projectSessionHandlers = ProjectSessionRpc.of({
  "projectSessions.observeSignals": () => Stream.unwrap(observeSignals()),
  "projectSessions.observeCatalog": (query) =>
    Stream.unwrap(projectSessionMetadata.observeCatalog(query)),
  "projectSessions.lookup": (target) => projectSessionMetadata.lookup(target),
  "projectSessions.inspect": (target) => projectSessionMetadata.inspect(target),
  "projectSessions.start": (input) =>
    withConnection((connectionId) =>
      activateWorkingDirectory(connectionId, input.workingDirectory).pipe(
        Effect.andThen(bindRenderer(connectionId, input.sessionId)),
        Effect.andThen(
          admitTurnAttachments(input).pipe(
            Effect.mapError(
              (error) => new ProjectSessionError({ operation: "start", message: error.message }),
            ),
            Effect.flatMap(projectSessionOperations.start),
          ),
        ),
      ),
    ),
  "projectSessions.open": (target) =>
    withConnection((connectionId) =>
      projectSessionMetadata.open(target).pipe(
        Effect.tap(() => bindRenderer(connectionId, target.sessionId)),
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
  "projectSessions.toolPrune": ({ entryId, prompt, ...target }) => {
    const input: Parameters<typeof projectSessionContinuations.toolPrune>[0] = {
      target,
      entryId,
    };
    if (prompt !== undefined) Object.assign(input, { prompt });
    return projectSessionContinuations.toolPrune(input);
  },
  "projectSessions.setPurpose": ({ purpose, ...target }) =>
    projectSessionOperations.setPurpose(target, purpose, { kind: "user" }).pipe(Effect.asVoid),
  "projectSessions.rename": ({ name, onlyIfUnnamed, ...target }) =>
    projectSessionOperations.rename(target, name, onlyIfUnnamed),
  "projectSessions.fork": ({ entryId, destinationWorkingDirectory, resolveSource, ...target }) => {
    const input: Parameters<typeof projectSessionContinuations.fork>[0] = { target, entryId };
    if (destinationWorkingDirectory !== undefined)
      Object.assign(input, { destinationWorkingDirectory });
    if (resolveSource !== undefined) Object.assign(input, { resolveSource });
    return projectSessionContinuations.fork(input);
  },
  "projectSessions.resolve": ({ userInitiated, ...target }) =>
    setResolved(target, true, userInitiated === true),
  "projectSessions.resolveWorkingDirectory": ({ workingDirectory }) =>
    projectSessionLifecycle.resolveWorkingDirectory(workingDirectory),
  "projectSessions.restore": ({ userInitiated, ...target }) =>
    setResolved(target, false, userInitiated === true).pipe(
      Effect.mapError(
        (error) => new ProjectSessionError({ operation: "restore", message: error.message }),
      ),
    ),
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
