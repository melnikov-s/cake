import { Effect, Layer } from "effect";
import { Electron } from "../electron/Electron";
import { ArtifactStorage } from "../storage/ArtifactStorage";
import { ReviewStorage } from "../storage/ReviewStorage";
import { RendererRequestCoordinator } from "../renderer-requests/RendererRequestCoordinator";
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
): Layer.Layer<
  ProjectSessionRuntimeHost,
  never,
  ArtifactStorage | Electron | RendererRequestCoordinator | ReviewStorage
> =>
  Layer.effect(
    ProjectSessionRuntimeHost,
    Effect.gen(function* () {
      const artifacts = yield* ArtifactStorage;
      const electron = yield* Electron;
      const reviews = yield* ReviewStorage;
      const rendererRequests = yield* RendererRequestCoordinator;
      const adapterContext = yield* Effect.context<ArtifactStorage | RendererRequestCoordinator>();
      const runAdapter = Effect.runPromiseWith(adapterContext);
      const sessions = new Map<string, SessionIntegration>();

      const disposeHost = (sessionId: string) => {
        const integration = sessions.get(sessionId);
        if (!integration) return;
        sessions.delete(sessionId);
        integration.host[Symbol.dispose]();
      };
      const release = Effect.fn("ProjectSessionRuntimeHost.release")(function* (sessionId: string) {
        disposeHost(sessionId);
        yield* rendererRequests.releaseSession({ _tag: "ProjectSession", sessionId });
      });
      const releaseWorkingDirectory = Effect.fn(
        "ProjectSessionRuntimeHost.releaseWorkingDirectory",
      )(function* (workingDirectory: string) {
        for (const integration of sessions.values())
          if (integration.workingDirectory === workingDirectory) disposeHost(integration.sessionId);
        yield* rendererRequests.releaseWorkingDirectory(workingDirectory);
      });
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
          requestUi: (request) => runAdapter(rendererRequests.requestUi(sessionId, request)),
          requestArtifact: (record, signal) =>
            runAdapter(rendererRequests.requestArtifact(sessionId, record, signal)),
          requestApplicationControl: (invocation, signal) =>
            runAdapter(rendererRequests.requestProjectControl(sessionId, invocation, signal)),
          artifactRepository: {
            // Pi's artifact hooks are Promise callbacks. Keep the only execution
            // adapter at this host boundary and provide only ArtifactStorage.
            upsert: (directory, artifact) => runAdapter(artifacts.upsert(directory, artifact)),
            get: (directory, targetSessionId, artifactId) =>
              runAdapter(artifacts.get(directory, targetSessionId, artifactId)),
            listSession: (directory, targetSessionId) =>
              runAdapter(artifacts.listSession(directory, targetSessionId)),
            linkSession: (record, targetSessionId) =>
              runAdapter(artifacts.linkSession(record, targetSessionId)),
          },
          reviewRepository: {
            reviewContextPath: reviews.reviewContextPath,
          },
        });
        const integration = { sessionId, workingDirectory, host } satisfies SessionIntegration;
        sessions.set(sessionId, integration);
        return integration;
      };
      yield* Effect.addFinalizer(() =>
        Effect.forEach([...sessions.keys()], release, { discard: true }),
      );

      return ProjectSessionRuntimeHost.of({
        stopWorkingDirectory: Effect.fn("ProjectSessionRuntimeHost.stopWorkingDirectory")(
          (workingDirectory) => releaseWorkingDirectory(workingDirectory),
        ),
        runtimeIntegrations: Effect.fn("ProjectSessionRuntimeHost.runtimeIntegrations")(
          (workingDirectory, sessionId) =>
            rendererRequests.registerProjectSession(sessionId, workingDirectory).pipe(
              Effect.andThen(
                Effect.try({
                  try: () =>
                    acquire(workingDirectory, sessionId).host.runtimeIntegrations(sessionId),
                  catch: (cause) => runtimeError("runtimeIntegrations", cause),
                }),
              ),
              Effect.mapError((cause) => runtimeError("runtimeIntegrations", cause)),
            ),
        ),
        releaseSession: Effect.fn("ProjectSessionRuntimeHost.releaseSession")(release),
      });
    }),
  );
