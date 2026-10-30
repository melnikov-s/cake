import { homedir } from "node:os";
import * as projectTodoUpdates from "../domain/projects/projectTodoUpdates";
import { ProjectTodoReports } from "../services/projects/ProjectTodoReports";
import * as projectTodoResolution from "../domain/projects/projectTodoResolution";
import * as projectTodoSnoozes from "../domain/projects/projectTodoSnoozes";
import { join } from "node:path";
import { makeVsCodeServerLive } from "../services/vscode/VsCodeServerLive";
import { companionAssets } from "../services/vscode/companion-assets";
import { Effect, Layer } from "effect";
import type { CakePaths } from "../config/CakePaths";
import * as scheduledMessages from "../domain/scheduled-messages/scheduledMessages";
import * as sessionFamilies from "../domain/session-families/sessionFamilies";
import * as runtimeRecovery from "../domain/project-sessions/runtimeRecovery";
import * as workflows from "../domain/workflows/workflows";
import * as workflowLifecycle from "../domain/workflows/workflow-lifecycle";
import { WorkflowRunStorage } from "../services/storage/WorkflowRunStorage";
import * as subagentRecovery from "../domain/subagents/subagentRecovery";
import { SubagentStorage, makeSubagentStorageLive } from "../services/storage/SubagentStorage";
import {
  RuntimeRecoveryStorage,
  makeRuntimeRecoveryStorageLive,
} from "../services/storage/RuntimeRecoveryStorage";
import { makeSessionCoordinationStorageLive } from "../services/storage/SessionCoordinationStorage";
import { makeDiscussionSessionEnvironmentLive } from "../layers/DiscussionSessionEnvironmentLive";
import { makeSubagentEnvironmentLive } from "../layers/SubagentEnvironmentLive";
import { WorktreeLandingAgentLive } from "../layers/WorktreeLandingAgentLive";
import { WorktreeLandingCompletionLive } from "../layers/WorktreeLandingCompletionLive";
import { AgentAvailability } from "../services/pi/AgentAvailability";
import { ClientConnectionsLive } from "../services/clients/ClientConnections";
import { ClientEventsLive } from "../services/clients/ClientEventsLive";
import { ClientWorkspacesLive } from "../services/clients/ClientWorkspacesLive";
import { makeWorkspaceFilesLive } from "../services/filesystem/WorkspaceFilesLive";
import { makeAttachmentUploadsLive } from "../services/filesystem/AttachmentUploadsLive";
import { makeTaskInputStorageLive } from "../services/storage/TaskInputStorageLive";
import { makeGitLive } from "../services/git/GitLive";
import { makePiAgentResourcesLive } from "../services/pi/live/PiAgentResourcesLive";
import { makePiModelsLive } from "../services/pi/live/PiModelsLive";
import { makeMcpSettingsLayer } from "../services/pi/McpSettings";
import { makePiSettingsLive } from "../services/pi/live/PiSettingsLive";
import { makeWidgetPackagesLive } from "../services/widgets/WidgetPackagesLive";
import { makeCakeChatDurableLive } from "../services/pi-durable/CakeChatDurable";
import { makeCakeSessionRuntimesLive } from "../services/pi/CakeSessionRuntimes";
import {
  createProjectSessionRuntime,
  createCoordinatorRuntime,
  configureCakeSessionRuntime,
} from "../layers/CakeOperations";
import { makeProjectSessionRuntimeHostLive } from "../layers/ProjectSessionRuntimeHostLive";
import { ProjectSessionConfiguration } from "../services/project-sessions/ProjectSessionConfiguration";
import { makeProjectAccessLive } from "../services/projects/ProjectAccessLive";
import { ProjectConfiguration } from "../services/projects/ProjectConfiguration";
import { RewordingRequestsLive } from "../services/projects/RewordingRequestsLive";
import { RendererRequestCoordinatorLive } from "../services/renderer-requests/RendererRequestCoordinator";
import { ScheduledMessages } from "../services/scheduled-messages/ScheduledMessages";
import { SessionCatalogChanges } from "../services/session-catalogs/SessionCatalogChanges";
import { makeMessageBoardStorageLive } from "../services/storage/MessageBoardStorageLive";
import { makeArtifactStorageLive } from "../services/storage/ArtifactStorageLive";
import { ArtifactGarbageCollectorLive } from "../layers/ArtifactGarbageCollectorLive";
import { makeArtifactProjectionLive } from "../services/artifacts/ArtifactProjectionLive";
import { makeApplicationStorageLive } from "../services/storage/ApplicationStorage";
import { ApplicationState } from "../services/storage/ApplicationState";
import { makeReviewStorageLive } from "../services/storage/ReviewStorageLive";
import { makeScheduledMessageStorageLive } from "../services/storage/ScheduledMessageStorage";
import { makeSavedDraftStorageLive } from "../services/storage/SavedDraftStorage";
import { makeSessionArchiveStorageLive } from "../services/storage/SessionArchiveStorageLive";
import { makeSessionFamilyStorageLive } from "../services/storage/SessionFamilyStorage";
import { CakeChatComposerPresence } from "../services/session-catalogs/CakeChatComposerPresence";
import { makeWorktreeStorageLive } from "../services/storage/WorktreeStorageLive";
import { SubagentCoordinatorLive } from "../services/subagents/SubagentCoordinator";
import { makeTerminalLive } from "../services/terminal/TerminalLive";
import { makeInlineWidgetsLive } from "../services/widgets/InlineWidgetsLive";
import { makeWidgetBrowserOutputsLive } from "../services/widgets/WidgetBrowserOutputsLive";
import { RemoteRenderedWidgetCaptureLive } from "../services/widgets/RemoteRenderedWidgetCaptureLive";
import { RemoteBrowserLive } from "../services/browser/RemoteBrowserLive";
import { PreviewLeases, PreviewLeasesLive } from "../services/browser/PreviewLeases";
import { RendererRequestCoordinator } from "../services/renderer-requests/RendererRequestCoordinator";
import { SessionCoordination } from "../services/session-catalogs/SessionCoordination";
import {
  publishInlineWidget,
  revokeInlineWidget,
} from "../services/widgets/inline-widget-document-registry";
import { ManagedWorktreesLive } from "../services/worktrees/ManagedWorktreesLive";
import { makeWorktreeCommandsLive } from "../services/worktrees/WorktreeCommandsLive";
import { WorktreeLandingCoordinatorLive } from "../services/worktrees/WorktreeLandingCoordinator";
import { loadReviewSessionProjection } from "../services/pi/runtime/sidecar-runtime";
import { BootstrapLive } from "../main/BootstrapLive";
import { initializeBackend } from "./initializeBackend";
import { WorkflowSandboxLive } from "../services/pi/live/WorkflowSandboxLive";
import { makeWorkflowScriptsLive } from "../services/pi/live/WorkflowScriptsLive";
import { WorkflowWorkersLive } from "../services/pi/live/WorkflowWorkersLive";
import { makeWorkflowRunStorageLive } from "../services/storage/WorkflowRunStorageLive";
import { WorkflowSupervisorLive } from "../services/workflows/WorkflowSupervisorLive";

import { CakeChatConfiguration } from "../services/pi-durable/CakeChatConfiguration";

export interface BackendLiveOptions {
  readonly paths: CakePaths;
  readonly homeDirectory?: string;
  readonly remoteCapture?: boolean;
}

const makeBackendFoundationLive = (options: BackendLiveOptions) => {
  const paths = options.paths;
  const PlatformLive = Layer.mergeAll(
    BootstrapLive,
    Layer.succeed(CakeChatConfiguration, {
      agentDirectory: paths.piAgent,
      location: {
        workingDirectory: options.homeDirectory ?? paths.home,
        sessionDirectory: paths.cakeChat,
      },
    }),
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
    ProjectTodoReports.layer,
    ApplicationState.layer.pipe(Layer.provide(applicationStorage)),
    scheduledMessageStorage,
    makeRuntimeRecoveryStorageLive(paths.state),
    makeSubagentStorageLive(paths.state),
    makeSessionCoordinationStorageLive(join(paths.state, "session-coordination.json")),
    makeSavedDraftStorageLive(paths.state),
    ScheduledMessages.layer.pipe(Layer.provide(scheduledMessageStorage)),
    makeSessionFamilyStorageLive(paths.sessionFamilies),
    makeSessionArchiveStorageLive(paths.resolvedProjectMetadata, {
      activeRoot: paths.piSessions,
      resolvedRoot: paths.piResolvedSessions,
    }),
    makeArtifactStorageLive(paths.artifacts),
    makeWidgetBrowserOutputsLive(join(paths.artifacts, "browser-outputs")),
    makeMessageBoardStorageLive(paths.artifacts),
    makeReviewStorageLive(paths.reviews, paths.piReviewSessions, (record) =>
      Effect.tryPromise(() => loadReviewSessionProjection(record, paths.piReviewSessions)),
    ),
    makeWorktreeStorageLive(paths.worktrees),
    makeWorkflowRunStorageLive(join(paths.state, "workflows")),
    makeWorkflowScriptsLive(join(paths.home, "workflows")),
    WorkflowSandboxLive,
    WorkflowSupervisorLive,
    SessionCatalogChanges.layer,
    CakeChatComposerPresence.layer,
  ).pipe(Layer.provide(BootstrapLive));

  const PiLive = Layer.mergeAll(
    makePiModelsLive(paths.piAgent),
    makeWidgetPackagesLive({ directory: join(paths.home, "widget-packages") }).pipe(
      Layer.provide(BootstrapLive),
    ),
    makePiSettingsLive(paths.piAgent).pipe(Layer.provide(BootstrapLive)),
    makeMcpSettingsLayer(paths.piAgent),
    makePiAgentResourcesLive(paths.piAgent),
    makeCakeSessionRuntimesLive(createProjectSessionRuntime).pipe(
      Layer.provideMerge(
        makeCakeChatDurableLive(createCoordinatorRuntime, configureCakeSessionRuntime),
      ),
      Layer.provide(StorageLive),
    ),
    AgentAvailability.layer,
  );

  const GitLive = makeGitLive();
  const ManagedWorktreesCapabilityLive = ManagedWorktreesLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        BootstrapLive,
        GitLive,
        StorageLive,
        makeWorktreeCommandsLive(paths.worktreeLogs).pipe(Layer.provide(BootstrapLive)),
      ),
    ),
  );
  const ClientStateLive = Layer.mergeAll(
    ClientConnectionsLive,
    ClientEventsLive,
    ClientWorkspacesLive,
  );
  // Shared composites need their own memoization boundary: leaf Services alone
  // do not prevent repeated traversal and retained Scope bookkeeping in a diamond graph.
  const FoundationLive = Layer.suspend(() =>
    Layer.mergeAll(
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
    ),
  );
  return Layer.suspend(() =>
    Layer.merge(
      FoundationLive,
      Layer.mergeAll(
        makeTerminalLive(),
        makeVsCodeServerLive({ root: join(paths.cache, "vscode-editor"), ...companionAssets }),
        makeWorkspaceFilesLive(paths.piAgent).pipe(Layer.provide(FoundationLive)),
        makeAttachmentUploadsLive(paths.cache, paths.state).pipe(Layer.provide(FoundationLive)),
        makeTaskInputStorageLive(paths.state),
        makeArtifactProjectionLive(paths.cache),
      ).pipe(Layer.provide(FoundationLive)),
    ),
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
  const HostLive = Layer.suspend(() => makeHostLive(FoundationLive));
  const ApplicationCapabilitiesLive = Layer.suspend(() => Layer.merge(FoundationLive, HostLive));
  const RendererRequestsLive = RendererRequestCoordinatorLive.pipe(
    Layer.provide(ApplicationCapabilitiesLive),
  );
  const SubagentEnvironmentLive = makeSubagentEnvironmentLive({
    homeDirectory,
    agentDirectory: paths.piAgent,
    sessionDirectory: paths.piSubagentSessions,
  });
  const SessionCoreLive = Layer.mergeAll(
    RewordingRequestsLive,
    SessionCoordination.layer,
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
    makeInlineWidgetsLive({ publish: publishInlineWidget, revoke: revokeInlineWidget }),
    SubagentEnvironmentLive,
    WorkflowWorkersLive.pipe(
      Layer.provide(Layer.merge(ApplicationCapabilitiesLive, SubagentEnvironmentLive)),
    ),
    ArtifactGarbageCollectorLive,
  ).pipe(Layer.provide(ApplicationCapabilitiesLive));

  const SessionFoundationLive = Layer.suspend(() =>
    Layer.merge(ApplicationCapabilitiesLive, SessionCoreLive),
  );
  const RuntimeHostLive = makeProjectSessionRuntimeHostLive({
    agentDirectory: paths.piAgent,
    sessionDirectory: paths.piSessions,
    widgetSessionDirectory: paths.piWidgetSessions,
  }).pipe(Layer.provide(SessionFoundationLive));
  const SessionRuntimeLive = Layer.suspend(() =>
    Layer.merge(SessionFoundationLive, RuntimeHostLive),
  );

  const SessionEnvironmentsLive = makeDiscussionSessionEnvironmentLive({
    agentDirectory: paths.piAgent,
    parentSessionDirectory: paths.piSessions,
  }).pipe(Layer.provide(SessionRuntimeLive));
  const SessionWorkflowsLive = Layer.suspend(() =>
    Layer.mergeAll(
      SessionRuntimeLive,
      SessionEnvironmentsLive,
      WorktreeLandingAgentLive.pipe(Layer.provide(SessionRuntimeLive)),
      WorktreeLandingCompletionLive.pipe(Layer.provide(SessionRuntimeLive)),
    ),
  );

  const InitializedLive = Layer.effectDiscard(initializeBackend()).pipe(
    Layer.provide(SessionWorkflowsLive),
  );
  const BackgroundWorkersLive = Layer.mergeAll(
    Layer.effectDiscard(projectTodoResolution.initialize()),
    Layer.effectDiscard(projectTodoSnoozes.initialize()),
    Layer.effectDiscard(projectTodoUpdates.initialize()),
    Layer.effectDiscard(
      Effect.gen(function* () {
        yield* scheduledMessages.initialize().pipe(Effect.orDie);
        yield* scheduledMessages.runWorker.pipe(Effect.forkScoped);
      }),
    ),
    Layer.effectDiscard(
      Effect.gen(function* () {
        const recovery = yield* RuntimeRecoveryStorage;
        const coordination = yield* SessionCoordination;
        const workers = yield* SubagentStorage;
        // Missing/corrupt recovery evidence must never be interpreted as no
        // unfinished work. Keep the app usable, but start no automatic work or
        // orphan-abort reconciliation until all recovery authorities can be read.
        const ready = yield* Effect.all([
          coordination.checkStorage(),
          recovery.list(),
          workers.list(),
          (yield* WorkflowRunStorage).list(),
        ]).pipe(Effect.result);
        if (ready._tag === "Failure") {
          yield* Effect.logWarning(
            "Automatic restart recovery is paused. Repair the reported metadata file and restart; saved conversations remain available.",
            ready.failure,
          );
          return;
        }
        yield* workflows.reconcile().pipe(Effect.orDie);
        const recoverable = (sessionId: string, turnId?: string) =>
          recovery.get(sessionId).pipe(
            Effect.map(
              (record) =>
                record?.inputs.some((input) => turnId === undefined || input.turnId === turnId) ??
                false,
            ),
            Effect.flatMap((pending) =>
              pending
                ? Effect.succeed(true)
                : workflowLifecycle.holdsTurnCompletion(sessionId, turnId),
            ),
          );
        yield* sessionFamilies
          .initialize(paths.piSessions, paths.piResolvedSessions, recoverable)
          .pipe(Effect.orDie);
        const resumeWorkers = yield* subagentRecovery.initialize().pipe(Effect.orDie);
        yield* runtimeRecovery.initialize().pipe(Effect.orDie);
        yield* resumeWorkers;
        yield* workflows.recoverReports().pipe(Effect.orDie);
        yield* sessionFamilies.runWorker.pipe(Effect.forkScoped);
      }),
    ),
  ).pipe(Layer.provide(Layer.merge(SessionWorkflowsLive, InitializedLive)));

  return Layer.suspend(() =>
    Layer.mergeAll(SessionWorkflowsLive, InitializedLive, BackgroundWorkersLive),
  );
};
