import { Effect, Layer } from "effect";
import { Electron } from "../electron/Electron";
import { ArtifactStorage } from "../storage/ArtifactStorage";
import { ReviewStorage } from "../storage/ReviewStorage";
import { ProjectSessionIntegrationHost } from "./ProjectSessionIntegrationHost";
import { ProjectSessionRuntimeOptions } from "./ProjectSessionRuntimeOptions";
import {
  ProjectSessionIntegrations,
  ProjectSessionIntegrationsError,
} from "./ProjectSessionIntegrations";

interface SessionIntegration {
  readonly sessionId: string;
  readonly workingDirectory: string;
  readonly host: ProjectSessionIntegrationHost;
}

const runtimeError = (operation: string, cause: unknown) =>
  new ProjectSessionIntegrationsError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

export const ProjectSessionIntegrationsLive: Layer.Layer<
  ProjectSessionIntegrations,
  never,
  ArtifactStorage | Electron | ProjectSessionRuntimeOptions | ReviewStorage
> = Layer.effect(
  ProjectSessionIntegrations,
  Effect.gen(function* () {
    const artifacts = yield* ArtifactStorage;
    const electron = yield* Electron;
    const reviews = yield* ReviewStorage;
    const runtimeOptions = yield* ProjectSessionRuntimeOptions;
    const context = yield* Effect.context<ArtifactStorage>();
    const run = Effect.runPromiseWith(context);
    const sessions = new Map<string, SessionIntegration>();
    const rendererConnections = new Map<string, number>();

    const release = (sessionId: string) => {
      rendererConnections.delete(sessionId);
      const integration = sessions.get(sessionId);
      if (!integration) return;
      sessions.delete(sessionId);
      integration.host[Symbol.dispose]();
    };
    const releaseWorkingDirectory = (workingDirectory: string) => {
      for (const integration of sessions.values())
        if (integration.workingDirectory === workingDirectory) release(integration.sessionId);
    };
    const acquire = (workingDirectory: string, sessionId: string) => {
      const existing = sessions.get(sessionId);
      if (existing) {
        if (existing.workingDirectory !== workingDirectory)
          throw new Error(`Session ID collision detected: ${sessionId}`);
        return existing;
      }
      const options = runtimeOptions.forWorkingDirectory(workingDirectory);
      const host = new ProjectSessionIntegrationHost({
        ...options,
        workspacePath: workingDirectory,
        emit: electron.broadcast,
        emitApplicationControl: (event) => {
          const connectionId = rendererConnections.get(event.sessionId);
          if (connectionId === undefined)
            throw new Error("No renderer is associated with the calling Project Session");
          electron.sendTo(electron.requireRendererConnection(connectionId), event);
        },
        artifactRepository: {
          upsert: (directory, artifact) => run(artifacts.upsert(directory, artifact)),
          get: (directory, targetSessionId, artifactId) =>
            run(artifacts.get(directory, targetSessionId, artifactId)),
          listSession: (directory, targetSessionId) =>
            run(artifacts.listSession(directory, targetSessionId)),
          linkSession: (record, targetSessionId) =>
            run(artifacts.linkSession(record, targetSessionId)),
        },
        reviewRepository: {
          reviewContextPath: (directory, targetSessionId) =>
            Effect.runSync(reviews.reviewContextPath(directory, targetSessionId)),
        },
      });
      const integration = { sessionId, workingDirectory, host } satisfies SessionIntegration;
      sessions.set(sessionId, integration);
      return integration;
    };
    const requireSession = (sessionId: string) => {
      const integration = sessions.get(sessionId);
      if (!integration) throw new Error(`No live integrations exist for session ${sessionId}`);
      return integration;
    };
    const releaseAll = () => {
      for (const sessionId of sessions.keys()) release(sessionId);
    };
    yield* Effect.addFinalizer(() => Effect.sync(releaseAll));

    return ProjectSessionIntegrations.of({
      stopWorkingDirectory: Effect.fn("ProjectSessionIntegrations.stopWorkingDirectory")(
        (workingDirectory) => Effect.sync(() => releaseWorkingDirectory(workingDirectory)),
      ),
      cancelPendingRequests: Effect.fn("ProjectSessionIntegrations.cancelPendingRequests")(
        (workingDirectory) =>
          Effect.sync(() => {
            for (const integration of sessions.values())
              if (integration.workingDirectory === workingDirectory)
                integration.host.cancelPendingRequests();
          }),
      ),
      projectSessionRuntimeIntegrations: Effect.fn(
        "ProjectSessionIntegrations.projectSessionRuntimeIntegrations",
      )((workingDirectory, sessionId) =>
        Effect.try({
          try: () =>
            acquire(workingDirectory, sessionId).host.projectSessionRuntimeIntegrations(sessionId),
          catch: (cause) => runtimeError("projectSessionRuntimeIntegrations", cause),
        }),
      ),
      releaseSession: Effect.fn("ProjectSessionIntegrations.releaseSession")((sessionId) =>
        Effect.sync(() => release(sessionId)),
      ),
      bindRenderer: Effect.fn("ProjectSessionIntegrations.bindRenderer")(
        (sessionId, connectionId) =>
          Effect.sync(() => {
            rendererConnections.set(sessionId, connectionId);
          }),
      ),
      respondArtifact: Effect.fn("ProjectSessionIntegrations.respondArtifact")(
        (sessionId, response) =>
          Effect.try({
            try: () =>
              requireSession(sessionId).host.dispatch({ type: "respond-artifact", ...response }),
            catch: (cause) => runtimeError("respondArtifact", cause),
          }),
      ),
      respondUi: Effect.fn("ProjectSessionIntegrations.respondUi")((sessionId, response) =>
        Effect.try({
          try: () => requireSession(sessionId).host.dispatch({ type: "respond-ui", ...response }),
          catch: (cause) => runtimeError("respondUi", cause),
        }),
      ),
      respondControl: Effect.fn("ProjectSessionIntegrations.respondControl")(
        (sessionId, controlRequestId, result) =>
          Effect.try({
            try: () =>
              requireSession(sessionId).host.dispatch({
                type: "respond-project-session-control",
                controlRequestId,
                result,
              }),
            catch: (cause) => runtimeError("respondControl", cause),
          }),
      ),
    });
  }),
);
