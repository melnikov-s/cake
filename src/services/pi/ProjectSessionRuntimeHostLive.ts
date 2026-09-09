import { Effect, Layer } from "effect";
import { Electron } from "../electron/Electron";
import { ArtifactStorage } from "../storage/ArtifactStorage";
import { ReviewStorage } from "../storage/ReviewStorage";
import { ProjectSessionIntegrationHost } from "./ProjectSessionIntegrationHost";
import {
  ProjectSessionRuntimeHost,
  ProjectSessionRuntimeHostError,
} from "./ProjectSessionRuntimeHost";

interface SessionIntegration {
  readonly sessionId: string;
  readonly workingDirectory: string;
  readonly host: ProjectSessionIntegrationHost;
}

const runtimeError = (operation: string, cause: unknown) =>
  new ProjectSessionRuntimeHostError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

export interface ProjectSessionRuntimeHostLiveOptions {
  readonly agentDirectory: string;
  readonly sessionDirectory: string;
  readonly widgetSessionDirectory: string;
}

export const makeProjectSessionRuntimeHostLive = (
  options: ProjectSessionRuntimeHostLiveOptions,
): Layer.Layer<ProjectSessionRuntimeHost, never, ArtifactStorage | Electron | ReviewStorage> =>
  Layer.effect(
    ProjectSessionRuntimeHost,
    Effect.gen(function* () {
      const artifacts = yield* ArtifactStorage;
      const electron = yield* Electron;
      const reviews = yield* ReviewStorage;
      const artifactContext = yield* Effect.context<ArtifactStorage>();
      const runArtifact = Effect.runPromiseWith(artifactContext);
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
        const host = new ProjectSessionIntegrationHost({
          workspacePath: workingDirectory,
          agentDir: options.agentDirectory,
          sessionDir: options.sessionDirectory,
          widgetSessionDir: options.widgetSessionDirectory,
          emit: electron.broadcast,
          emitApplicationControl: (event) => {
            const connectionId = rendererConnections.get(event.sessionId);
            if (connectionId === undefined)
              throw new Error("No renderer is associated with the calling Project Session");
            electron.sendTo(electron.requireRendererConnection(connectionId), event);
          },
          artifactRepository: {
            // Pi's artifact hooks are Promise callbacks. Keep the only execution
            // adapter at this host boundary and provide only ArtifactStorage.
            upsert: (directory, artifact) => runArtifact(artifacts.upsert(directory, artifact)),
            get: (directory, targetSessionId, artifactId) =>
              runArtifact(artifacts.get(directory, targetSessionId, artifactId)),
            listSession: (directory, targetSessionId) =>
              runArtifact(artifacts.listSession(directory, targetSessionId)),
            linkSession: (record, targetSessionId) =>
              runArtifact(artifacts.linkSession(record, targetSessionId)),
          },
          reviewRepository: {
            reviewContextPath: reviews.reviewContextPath,
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

      return ProjectSessionRuntimeHost.of({
        stopWorkingDirectory: Effect.fn("ProjectSessionRuntimeHost.stopWorkingDirectory")(
          (workingDirectory) => Effect.sync(() => releaseWorkingDirectory(workingDirectory)),
        ),
        cancelPendingRequests: Effect.fn("ProjectSessionRuntimeHost.cancelPendingRequests")(
          (workingDirectory) =>
            Effect.sync(() => {
              for (const integration of sessions.values())
                if (integration.workingDirectory === workingDirectory)
                  integration.host.cancelPendingRequests();
            }),
        ),
        runtimeIntegrations: Effect.fn("ProjectSessionRuntimeHost.runtimeIntegrations")(
          (workingDirectory, sessionId) =>
            Effect.try({
              try: () => acquire(workingDirectory, sessionId).host.runtimeIntegrations(sessionId),
              catch: (cause) => runtimeError("runtimeIntegrations", cause),
            }),
        ),
        releaseSession: Effect.fn("ProjectSessionRuntimeHost.releaseSession")((sessionId) =>
          Effect.sync(() => release(sessionId)),
        ),
        bindRenderer: Effect.fn("ProjectSessionRuntimeHost.bindRenderer")(
          (sessionId, connectionId) =>
            Effect.sync(() => {
              rendererConnections.set(sessionId, connectionId);
            }),
        ),
        respondArtifact: Effect.fn("ProjectSessionRuntimeHost.respondArtifact")(
          (sessionId, response) =>
            Effect.try({
              try: () =>
                requireSession(sessionId).host.dispatch({ type: "respond-artifact", ...response }),
              catch: (cause) => runtimeError("respondArtifact", cause),
            }),
        ),
        respondUi: Effect.fn("ProjectSessionRuntimeHost.respondUi")((sessionId, response) =>
          Effect.try({
            try: () => requireSession(sessionId).host.dispatch({ type: "respond-ui", ...response }),
            catch: (cause) => runtimeError("respondUi", cause),
          }),
        ),
        respondControl: Effect.fn("ProjectSessionRuntimeHost.respondControl")(
          (sessionId, controlRequestId, result) =>
            Effect.try({
              try: () => {
                // Releasing a runtime settles its pending controls before a renderer
                // can finish an application mutation that stops the calling session.
                // Its eventual acknowledgement is therefore an expected late response.
                const integration = sessions.get(sessionId);
                if (!integration) return;
                integration.host.dispatch({
                  type: "respond-project-session-control",
                  controlRequestId,
                  result,
                });
              },
              catch: (cause) => runtimeError("respondControl", cause),
            }),
        ),
      });
    }),
  );
