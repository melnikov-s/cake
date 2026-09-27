import { homedir } from "node:os";
import { join } from "node:path";
import { makeVsCodeServerLive } from "../services/vscode/VsCodeServerLive";
import { companionAssets } from "../services/vscode/companion-assets";
import { Effect, Layer } from "effect";
import type { CakePaths } from "../config/CakePaths";
import * as scheduledMessages from "../domain/scheduled-messages/scheduledMessages";
import * as sessionFamilies from "../domain/session-families/sessionFamilies";
import { makeDiscussionSessionEnvironmentLive } from "../layers/DiscussionSessionEnvironmentLive";
import { makeSubagentEnvironmentLive } from "../layers/SubagentEnvironmentLive";
import { WorktreeLandingAgentLive } from "../layers/WorktreeLandingAgentLive";
import { WorktreeLandingCompletionLive } from "../layers/WorktreeLandingCompletionLive";
import { AgentAvailability } from "../services/pi/AgentAvailability";
import { ClientConnectionsLive } from "../services/clients/ClientConnections";
import { ClientEventsLive } from "../services/clients/ClientEventsLive";
import { ClientWorkspacesLive } from "../services/clients/ClientWorkspacesLive";
import { WorkspaceFileExportLive } from "../services/filesystem/WorkspaceFileExport";
import { makeWorkspaceFilesLive } from "../services/filesystem/WorkspaceFilesLive";
import { makeAttachmentUploadsLive } from "../services/filesystem/AttachmentUploadsLive";
import { makeGitLive } from "../services/git/GitLive";
import { makePiAgentResourcesLive } from "../services/pi/live/PiAgentResourcesLive";
import { makePiModelsLive } from "../services/pi/live/PiModelsLive";
import { makePiSettingsLive } from "../services/pi/live/PiSettingsLive";
import { makeCakeSessionRuntimesLive } from "../services/pi/CakeSessionRuntimes";
import { makeProjectSessionRuntimeHostLive } from "../services/pi/ProjectSessionRuntimeHostLive";
import { ProjectSessionConfiguration } from "../services/project-sessions/ProjectSessionConfiguration";
import { makeProjectAccessLive } from "../services/projects/ProjectAccessLive";
import { ProjectConfiguration } from "../services/projects/ProjectConfiguration";
import { RewordingRequestsLive } from "../services/projects/RewordingRequestsLive";
import { RendererRequestCoordinatorLive } from "../services/renderer-requests/RendererRequestCoordinator";
import { ScheduledMessages } from "../services/scheduled-messages/ScheduledMessages";
import { SessionCatalogChanges } from "../services/session-catalogs/SessionCatalogChanges";
import { makeArtifactStorageLive } from "../services/storage/ArtifactStorageLive";
import { makeDrawBoardStorageLive } from "../services/storage/DrawBoardStorageLive";
import { ArtifactGarbageCollectorLive } from "../services/artifacts/ArtifactGarbageCollectorLive";
import { makeArtifactProjectionLive } from "../services/artifacts/ArtifactProjectionLive";
import { makeApplicationStorageLive } from "../services/storage/ApplicationStorage";
import { ApplicationState } from "../services/storage/ApplicationState";
import { makeReviewStorageLive } from "../services/storage/ReviewStorageLive";
import { makeScheduledMessageStorageLive } from "../services/storage/ScheduledMessageStorage";
import { makeSavedDraftStorageLive } from "../services/storage/SavedDraftStorage";
import { makeSessionArchiveStorageLive } from "../services/storage/SessionArchiveStorageLive";
import { makeSessionFamilyStorageLive } from "../services/storage/SessionFamilyStorage";
import { makeWorktreeStorageLive } from "../services/storage/WorktreeStorageLive";
import { SubagentCoordinatorLive } from "../services/subagents/SubagentCoordinator";
import { makeTerminalLive } from "../services/terminal/TerminalLive";
import { makeInlineWidgetsLive } from "../services/widgets/InlineWidgetsLive";
import { RemoteRenderedWidgetCaptureLive } from "../services/widgets/RemoteRenderedWidgetCaptureLive";
import { RemoteBrowserLive } from "../services/browser/RemoteBrowserLive";
import { PreviewLeases, PreviewLeasesLive } from "../services/browser/PreviewLeases";
import { RendererRequestCoordinator } from "../services/renderer-requests/RendererRequestCoordinator";
import { publishInlineWidget } from "../services/widgets/inline-widget-document-registry";
import { ManagedWorktreesLive } from "../services/worktrees/ManagedWorktreesLive";
import { WorktreeLandingCoordinatorLive } from "../services/worktrees/WorktreeLandingCoordinator";
import { loadReviewSessionProjection } from "../services/pi/runtime/sidecar-runtime";
import { BootstrapLive } from "../main/BootstrapLive";
import { initializeBackend } from "./initializeBackend";

export interface BackendLiveOptions {
  readonly paths: CakePaths;
  readonly homeDirectory?: string;
  readonly remoteCapture?: boolean;
}

const makeBackendFoundationLive = (options: BackendLiveOptions) => {
  const paths = options.paths;
  const PlatformLive = Layer.mergeAll(
    BootstrapLive,
    Layer.succeed(ProjectConfiguration, { agentDirectory: paths.piAgent }),
    Layer.succeed(ProjectSessionConfiguration, {
      agentDirectory: paths.piAgent,
      sessionDirectory: paths.piSessions,
      resolvedSessionDirectory: paths.piResolvedSessions,
    }),
  );

  const applicationStorage = makeApplicationStorageLive(paths.state);
  const scheduledMessageStorage = makeScheduledMessageStorageLive(paths.state);
  const StorageLive = Layer.mergeAll(
    applicationStorage,
    ApplicationState.layer.pipe(Layer.provide(applicationStorage)),
    scheduledMessageStorage,
    makeSavedDraftStorageLive(paths.state),
    ScheduledMessages.layer.pipe(Layer.provide(scheduledMessageStorage)),
    makeSessionFamilyStorageLive(paths.sessionFamilies),
    makeSessionArchiveStorageLive(paths.resolvedProjectMetadata),
    makeArtifactStorageLive(paths.artifacts),
    makeDrawBoardStorageLive(paths.drawBoards),
    makeReviewStorageLive(paths.reviews, paths.piReviewSessions, (record) =>
      Effect.tryPromise(() => loadReviewSessionProjection(record, paths.piReviewSessions)),
    ),
    makeWorktreeStorageLive(paths.worktrees),
    SessionCatalogChanges.layer,
  ).pipe(Layer.provide(BootstrapLive));

  const PiLive = Layer.mergeAll(
    makePiModelsLive(paths.piAgent),
    makePiSettingsLive(paths.piAgent),
    makePiAgentResourcesLive(paths.piAgent),
    makeCakeSessionRuntimesLive(),
    AgentAvailability.layer,
  );

  const GitLive = makeGitLive();
  const ManagedWorktreesCapabilityLive = ManagedWorktreesLive.pipe(
    Layer.provide(Layer.mergeAll(BootstrapLive, GitLive, StorageLive)),
  );
  const ClientStateLive = Layer.mergeAll(
    ClientConnectionsLive,
    ClientEventsLive,
    ClientWorkspacesLive,
  );
  const FoundationLive = Layer.mergeAll(
    PlatformLive,
    StorageLive,
    PiLive,
    ClientStateLive,
    PreviewLeasesLive.pipe(Layer.provide(ClientStateLive)),
    GitLive,
    ManagedWorktreesCapabilityLive,
    makeProjectAccessLive({
      projectSessionDirectory: paths.piSessions,
      resolvedProjectSessionDirectory: paths.piResolvedSessions,
    }).pipe(Layer.provide(Layer.merge(StorageLive, ManagedWorktreesCapabilityLive))),
  );
  return Layer.merge(
    FoundationLive,
    Layer.mergeAll(
      makeTerminalLive(),
      makeVsCodeServerLive({ root: join(paths.cache, "vscode-editor"), ...companionAssets }),
      WorkspaceFileExportLive,
      makeWorkspaceFilesLive(paths.piAgent).pipe(Layer.provide(FoundationLive)),
      makeAttachmentUploadsLive(paths.cache, paths.state).pipe(Layer.provide(FoundationLive)),
      makeArtifactProjectionLive(paths.cache),
    ).pipe(Layer.provide(FoundationLive)),
  );
};

type BackendFoundationLive = ReturnType<typeof makeBackendFoundationLive>;

/** One process-scoped authority graph. Hosts may add actual native capabilities;
 * no host is required, and no endpoint or native implementation is imported here.
 * Reuse this Layer value for every endpoint in the hosting process.
 */
export const makeBackendLive = <HostServices, HostError>(
  options: BackendLiveOptions,
  makeHostLive: (foundation: BackendFoundationLive) => Layer.Layer<HostServices, HostError>,
) => {
  const paths = options.paths;
  const homeDirectory = options.homeDirectory ?? homedir();
  const FoundationLive = makeBackendFoundationLive(options);
  const HostLive = makeHostLive(FoundationLive);
  const ApplicationCapabilitiesLive = Layer.merge(FoundationLive, HostLive);
  const RendererRequestsLive = RendererRequestCoordinatorLive.pipe(
    Layer.provide(ApplicationCapabilitiesLive),
  );
  const SessionCoreLive = Layer.mergeAll(
    RewordingRequestsLive,
    SubagentCoordinatorLive,
    WorktreeLandingCoordinatorLive,
    RendererRequestsLive,
    Layer.effectDiscard(
      Effect.gen(function* () {
        const requests = yield* RendererRequestCoordinator;
        const previews = yield* PreviewLeases;
        yield* requests.setPreviewBridge(previews);
      }),
    ).pipe(Layer.provide(Layer.merge(ApplicationCapabilitiesLive, RendererRequestsLive))),
    ...(options.remoteCapture
      ? [
          RemoteRenderedWidgetCaptureLive.pipe(
            Layer.provide(Layer.merge(ApplicationCapabilitiesLive, RendererRequestsLive)),
          ),
          RemoteBrowserLive.pipe(
            Layer.provide(Layer.merge(ApplicationCapabilitiesLive, RendererRequestsLive)),
          ),
        ]
      : []),
    makeInlineWidgetsLive({ publish: publishInlineWidget }),
    makeSubagentEnvironmentLive({
      homeDirectory,
      agentDirectory: paths.piAgent,
      sessionDirectory: paths.piSubagentSessions,
    }),
    ArtifactGarbageCollectorLive,
  ).pipe(Layer.provide(ApplicationCapabilitiesLive));

  const SessionFoundationLive = Layer.merge(ApplicationCapabilitiesLive, SessionCoreLive);
  const RuntimeHostLive = makeProjectSessionRuntimeHostLive({
    agentDirectory: paths.piAgent,
    sessionDirectory: paths.piSessions,
    widgetSessionDirectory: paths.piWidgetSessions,
  }).pipe(Layer.provide(SessionFoundationLive));
  const SessionRuntimeLive = Layer.merge(SessionFoundationLive, RuntimeHostLive);

  const SessionEnvironmentsLive = makeDiscussionSessionEnvironmentLive({
    agentDirectory: paths.piAgent,
    parentSessionDirectory: paths.piSessions,
  }).pipe(Layer.provide(SessionRuntimeLive));
  const SessionWorkflowsLive = Layer.mergeAll(
    SessionRuntimeLive,
    SessionEnvironmentsLive,
    WorktreeLandingAgentLive.pipe(Layer.provide(SessionRuntimeLive)),
    WorktreeLandingCompletionLive.pipe(Layer.provide(SessionRuntimeLive)),
  );

  const InitializedLive = Layer.effectDiscard(initializeBackend()).pipe(
    Layer.provide(SessionWorkflowsLive),
  );
  const BackgroundWorkersLive = Layer.mergeAll(
    Layer.effectDiscard(
      Effect.gen(function* () {
        yield* scheduledMessages.initialize().pipe(Effect.orDie);
        yield* scheduledMessages.runWorker.pipe(Effect.forkScoped);
      }),
    ),
    Layer.effectDiscard(
      Effect.gen(function* () {
        yield* sessionFamilies
          .initialize(paths.piSessions, paths.piResolvedSessions)
          .pipe(Effect.orDie);
        yield* sessionFamilies.runWorker.pipe(Effect.forkScoped);
      }),
    ),
  ).pipe(Layer.provide(Layer.merge(SessionWorkflowsLive, InitializedLive)));

  return Layer.mergeAll(SessionWorkflowsLive, InitializedLive, BackgroundWorkersLive);
};
