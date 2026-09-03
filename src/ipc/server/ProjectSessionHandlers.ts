import { Effect, Stream } from "effect";
import { ProjectSessionError } from "../../domain/project-session-data";
import * as projects from "../../domain/projects";
import * as projectSessions from "../../domain/projectSessions";
import { ProjectSessionRpc } from "../protocol/ProjectSessionRpc";
import { RendererConnection } from "../protocol/RendererConnectionMiddleware";
import { ProjectSessionIntegrations } from "../../services/pi/ProjectSessionIntegrations";

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
  Effect.flatMap(ProjectSessionIntegrations, (integrations) =>
    integrations.bindRenderer(sessionId, connectionId),
  ).pipe(
    Effect.mapError(
      (error) => new ProjectSessionError({ operation: "bindRenderer", message: error.message }),
    ),
  );

export const projectSessionHandlers = ProjectSessionRpc.of({
  "projectSessions.observeCatalog": (query) => Stream.unwrap(projectSessions.observeCatalog(query)),
  "projectSessions.inspect": (target) => projectSessions.inspect(target),
  "projectSessions.start": (input) =>
    withConnection((connectionId) =>
      activateWorkingDirectory(connectionId, input.workingDirectory).pipe(
        Effect.andThen(bindRenderer(connectionId, input.sessionId)),
        Effect.andThen(projectSessions.start(input)),
      ),
    ),
  "projectSessions.open": (target) =>
    withConnection((connectionId) =>
      bindRenderer(connectionId, target.sessionId).pipe(
        Effect.andThen(projectSessions.open(target)),
        Effect.tap(() =>
          target.workingDirectory
            ? activateWorkingDirectory(connectionId, target.workingDirectory)
            : Effect.void,
        ),
      ),
    ),
  "projectSessions.observe": (target) => Stream.unwrap(projectSessions.observe(target)),
  "projectSessions.prompt": (input) =>
    withConnection((connectionId) =>
      bindRenderer(connectionId, input.sessionId).pipe(
        Effect.andThen(projectSessions.prompt(input)),
      ),
    ),
  "projectSessions.steer": (input) =>
    withConnection((connectionId) =>
      bindRenderer(connectionId, input.sessionId).pipe(
        Effect.andThen(projectSessions.steer(input)),
      ),
    ),
  "projectSessions.followUp": (input) =>
    withConnection((connectionId) =>
      bindRenderer(connectionId, input.sessionId).pipe(
        Effect.andThen(projectSessions.followUp(input)),
      ),
    ),
  "projectSessions.abort": (target) => projectSessions.abort(target),
  "projectSessions.compact": ({ instructions, ...target }) =>
    projectSessions.compact(target, instructions),
  "projectSessions.editMessage": (input) => projectSessions.editMessage(input),
  "projectSessions.setUserMessageMarkdown": ({ entryId, renderAsMarkdown, ...target }) =>
    projectSessions.setUserMessageMarkdown(target, entryId, renderAsMarkdown),
  "projectSessions.applyConfiguration": ({ configuration, ...target }) =>
    projectSessions.applyConfiguration(target, configuration),
  "projectSessions.setModel": ({ provider, modelId, ...target }) =>
    projectSessions.setModel(target, provider, modelId),
  "projectSessions.setThinkingLevel": ({ level, ...target }) =>
    projectSessions.setThinkingLevel(target, level),
  "projectSessions.setFastMode": ({ enabled, ...target }) =>
    projectSessions.setFastMode(target, enabled),
  "projectSessions.getChangelog": (target) => projectSessions.getChangelog(target),
  "projectSessions.navigate": ({ entryId, ...target }) => projectSessions.navigate(target, entryId),
  "projectSessions.setPiSetting": ({ update, ...target }) =>
    projectSessions.setPiSetting(target, update),
  "projectSessions.reload": (target) => projectSessions.reload(target),
  "projectSessions.login": ({ provider, authType, ...target }) =>
    projectSessions.login(target, provider, authType),
  "projectSessions.logout": ({ provider, ...target }) => projectSessions.logout(target, provider),
  "projectSessions.handoff": ({ entryId, prompt, resolveSource, ...target }) => {
    const input: Parameters<typeof projectSessions.handoff>[0] = { target, entryId };
    if (prompt !== undefined) Object.assign(input, { prompt });
    if (resolveSource !== undefined) Object.assign(input, { resolveSource });
    return projectSessions.handoff(input);
  },
  "projectSessions.rename": ({ name, ...target }) => projectSessions.rename(target, name),
  "projectSessions.fork": ({ entryId, destinationWorkingDirectory, resolveSource, ...target }) => {
    const input: Parameters<typeof projectSessions.fork>[0] = { target, entryId };
    if (destinationWorkingDirectory !== undefined)
      Object.assign(input, { destinationWorkingDirectory });
    if (resolveSource !== undefined) Object.assign(input, { resolveSource });
    return projectSessions.fork(input);
  },
  "projectSessions.resolve": (target) => projectSessions.resolve(target).pipe(Effect.asVoid),
  "projectSessions.restore": (target) => projectSessions.restore(target).pipe(Effect.asVoid),
  "projectSessions.respondControl": ({ sessionId, controlRequestId, result }) =>
    Effect.flatMap(ProjectSessionIntegrations, (integrations) =>
      integrations.respondControl(sessionId, controlRequestId, result),
    ).pipe(
      Effect.mapError(
        (error) => new ProjectSessionError({ operation: "respondControl", message: error.message }),
      ),
    ),
});
