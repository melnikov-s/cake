import { Effect, Layer, Schema } from "effect";
import {
  ArtifactLineageId,
  ArtifactRevisionNumber,
  ArtifactStableRef,
  artifactRevisionToRecord,
  parseArtifactRef,
} from "../../domain/artifacts/artifact-lineage";
import * as artifactWorkflows from "../../domain/artifacts/artifactWorkflows";
import { Electron } from "../electron/Electron";
import { ArtifactStorage } from "../storage/ArtifactStorage";
import { ReviewStorage } from "../storage/ReviewStorage";
import { SessionFamilyStorage } from "../storage/SessionFamilyStorage";
import { RendererRequestCoordinator } from "../renderer-requests/RendererRequestCoordinator";
import { ProjectSessionIntegrationHost } from "./ProjectSessionIntegrationHost";
import { PiModels } from "./PiModels";
import { RenderedWidgetCapture } from "../widgets/RenderedWidgetCapture";
import { generateReviewedWidget } from "../../domain/widgets/widgetGenerationReview";
import { importWorkspaceFile } from "../artifacts/importWorkspaceFile";
import { ArtifactProjection } from "../artifacts/ArtifactProjection";
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
  | ArtifactProjection
  | ArtifactStorage
  | Electron
  | PiModels
  | RenderedWidgetCapture
  | RendererRequestCoordinator
  | ReviewStorage
  | SessionFamilyStorage
> =>
  Layer.effect(
    ProjectSessionRuntimeHost,
    Effect.gen(function* () {
      const artifacts = yield* ArtifactStorage;
      const artifactProjection = yield* ArtifactProjection;
      const families = yield* SessionFamilyStorage;
      const electron = yield* Electron;
      const reviews = yield* ReviewStorage;
      const rendererRequests = yield* RendererRequestCoordinator;
      const models = yield* PiModels;
      const widgetCapture = yield* RenderedWidgetCapture;
      const adapterContext = yield* Effect.context<
        | ArtifactProjection
        | ArtifactStorage
        | PiModels
        | RenderedWidgetCapture
        | RendererRequestCoordinator
      >();
      const runAdapter = Effect.runPromiseWith(adapterContext);
      const provideArtifactServices = <A, E>(
        effect: Effect.Effect<A, E, ArtifactStorage | SessionFamilyStorage>,
      ): Effect.Effect<A, E> =>
        effect.pipe(
          Effect.provideService(ArtifactStorage, artifacts),
          Effect.provideService(SessionFamilyStorage, families),
        );
      const projectEffective = Effect.fn("ProjectSessionRuntimeHost.projectArtifact")(function* (
        sessionId: string,
        effective: artifactWorkflows.EffectiveArtifact,
        latestRevision: ArtifactRevisionNumber,
      ) {
        return yield* artifactProjection.materialize({
          sessionId,
          revision: effective.revision,
          latestRevision,
          linkMode: effective.link.selection.mode,
        });
      });
      const resolveForSession = Effect.fn("ProjectSessionRuntimeHost.resolveArtifact")(function* (
        sessionId: string,
        reference: string,
      ) {
        const stableRef = Schema.decodeUnknownSync(ArtifactStableRef)(reference);
        const effective = yield* provideArtifactServices(
          artifactWorkflows.resolveEffectiveReference(sessionId, stableRef),
        );
        const metadata = yield* artifactProjection.materialize({
          sessionId,
          revision: effective.revision,
          latestRevision: effective.latestRevision,
          linkMode: effective.link.selection.mode,
        });
        return { record: artifactRevisionToRecord(effective.revision), metadata };
      });
      const listMetadataForSession = Effect.fn("ProjectSessionRuntimeHost.listArtifactMetadata")(
        function* (sessionId: string) {
          const effective = yield* provideArtifactServices(
            artifactWorkflows.listEffectiveSessionArtifacts(sessionId),
          );
          const catalog = yield* artifacts.catalog();
          return yield* Effect.forEach(effective.slice(0, 100), (item) => {
            const lineage = catalog.lineages.find(
              (candidate) => candidate.id === item.revision.lineageId,
            );
            return projectEffective(
              sessionId,
              item,
              lineage?.latestRevision ?? item.revision.metadata.revision,
            );
          });
        },
      );
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
          execute: (effect, signal) => runAdapter(effect, signal ? { signal } : undefined),
          requestUi: (request) => runAdapter(rendererRequests.requestUi(sessionId, request)),
          requestArtifact: (record, signal) =>
            runAdapter(rendererRequests.requestArtifact(sessionId, record, signal)),
          requestApplicationControl: (invocation, signal) =>
            runAdapter(rendererRequests.requestProjectControl(sessionId, invocation, signal)),
          runReviewedWidget: generateReviewedWidget,
          captureWidget: (targetSessionId, widget, signal) =>
            runAdapter(widgetCapture.capture(targetSessionId, widget, signal), { signal }),
          requireVisionModel: async (model) => {
            if (!model)
              throw new Error(
                "widgets.present requires the active session to use a configured vision-capable model",
              );
            const catalog = await runAdapter(models.list());
            const selected = catalog.find(
              (candidate) => candidate.provider === model.provider && candidate.id === model.id,
            );
            if (!selected || !selected.authenticated || !selected.available)
              throw new Error(
                `widgets.present could not resolve the configured model ${model.provider}/${model.id}`,
              );
            if (!selected.input.includes("image"))
              throw new Error(
                `widgets.present requires image input, but ${model.provider}/${model.id} is text-only`,
              );
          },
          importWorkspaceFile: (input) => runAdapter(importWorkspaceFile(input)),
          artifactRepository: {
            upsert: (workingDirectory, artifact) =>
              Effect.gen(function* () {
                const lineageId = yield* Schema.decodeUnknownEffect(ArtifactLineageId)(artifact.id);
                const revision =
                  artifact.revision === 1
                    ? yield* provideArtifactServices(
                        artifactWorkflows.create({
                          sessionId: artifact.sessionId,
                          lineageId,
                          snapshot: artifact,
                          workingDirectory,
                        }),
                      )
                    : yield* provideArtifactServices(
                        artifactWorkflows.publish({
                          sessionId: artifact.sessionId,
                          lineageId,
                          expectedLatestRevision: artifact.revision - 1,
                          snapshot: artifact,
                          workingDirectory,
                        }),
                      );
                return artifactRevisionToRecord(revision);
              }),
            get: (_workingDirectory, sessionId, artifactId) =>
              Effect.gen(function* () {
                const lineageId = yield* Schema.decodeUnknownEffect(ArtifactLineageId)(artifactId);
                const linked = yield* provideArtifactServices(
                  artifactWorkflows.listEffectiveSessionArtifacts(sessionId),
                );
                const revision = linked.find(
                  (candidate) => candidate.revision.lineageId === lineageId,
                )?.revision;
                return revision ? artifactRevisionToRecord(revision) : undefined;
              }),
            listSession: (_workingDirectory, sessionId) =>
              provideArtifactServices(
                artifactWorkflows.listEffectiveSessionArtifacts(sessionId),
              ).pipe(
                Effect.map((items) =>
                  items.map(({ revision }) => artifactRevisionToRecord(revision)),
                ),
              ),
            linkSession: (record, sessionId) =>
              Effect.gen(function* () {
                const lineageId = yield* Schema.decodeUnknownEffect(ArtifactLineageId)(
                  record.artifact.id,
                );
                yield* provideArtifactServices(artifactWorkflows.linkSession(lineageId, sessionId));
              }),
            resolve: resolveForSession,
            hasAnyLinked: (targetSessionId) =>
              provideArtifactServices(
                artifactWorkflows.hasEffectiveSessionArtifacts(targetSessionId),
              ),
            listMetadata: listMetadataForSession,
            history: (targetSessionId, reference) =>
              Effect.gen(function* () {
                const parsed = parseArtifactRef(
                  Schema.decodeUnknownSync(ArtifactStableRef)(reference),
                );
                const revisions = yield* provideArtifactServices(
                  artifactWorkflows.historyForSession(targetSessionId, parsed.lineageId),
                );
                const effective = yield* provideArtifactServices(
                  artifactWorkflows.resolveEffectiveReference(
                    targetSessionId,
                    Schema.decodeUnknownSync(ArtifactStableRef)(
                      `cake://artifact/${parsed.lineageId}`,
                    ),
                  ),
                );
                const latest = revisions.at(-1)?.metadata.revision;
                if (latest === undefined) return [];
                return yield* Effect.forEach(revisions.slice(-100), (revision) =>
                  artifactProjection.materialize({
                    sessionId: targetSessionId,
                    revision,
                    latestRevision: latest,
                    linkMode: effective.link.selection.mode,
                  }),
                );
              }),
            restore: (workingDirectory, targetSessionId, input) =>
              Effect.gen(function* () {
                const lineageId = yield* Schema.decodeUnknownEffect(ArtifactLineageId)(
                  input.lineageId,
                );
                const sourceRevision = yield* Schema.decodeUnknownEffect(ArtifactRevisionNumber)(
                  input.sourceRevision,
                );
                const revision = yield* provideArtifactServices(
                  artifactWorkflows.restore({
                    sessionId: targetSessionId,
                    lineageId,
                    sourceRevision,
                    expectedLatestRevision: input.expectedRevision,
                    workingDirectory,
                  }),
                );
                return yield* resolveForSession(
                  targetSessionId,
                  `cake://artifact/${lineageId}@r${revision.metadata.revision}`,
                );
              }),
            link: (targetSessionId, reference) =>
              Effect.gen(function* () {
                const parsed = parseArtifactRef(
                  Schema.decodeUnknownSync(ArtifactStableRef)(reference),
                );
                yield* provideArtifactServices(
                  artifactWorkflows.resolveReferenceMetadata(
                    Schema.decodeUnknownSync(ArtifactStableRef)(reference),
                  ),
                );
                yield* provideArtifactServices(
                  artifactWorkflows.linkForSession(
                    parsed.lineageId,
                    targetSessionId,
                    parsed.revision === undefined
                      ? { mode: "follow-latest" }
                      : { mode: "pinned", revision: parsed.revision },
                  ),
                );
                electron.broadcast({
                  type: "artifact-catalog-invalidated",
                  lineageId: parsed.lineageId,
                });
                return (yield* resolveForSession(targetSessionId, reference)).metadata;
              }),
            unlink: (targetSessionId, lineageIdInput) =>
              Effect.gen(function* () {
                const lineageId =
                  yield* Schema.decodeUnknownEffect(ArtifactLineageId)(lineageIdInput);
                yield* provideArtifactServices(
                  artifactWorkflows.unlinkEffectiveSessionArtifact(targetSessionId, lineageId),
                );
                electron.broadcast({ type: "artifact-catalog-invalidated", lineageId });
                yield* artifactProjection.cleanupLineage(targetSessionId, lineageId);
              }),
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
