import { homedir } from "node:os";
import { join } from "node:path";
import type { App } from "electron";
import { Effect, Layer } from "effect";
import type { CakePaths } from "../config/CakePaths";
import * as cakeChatLocations from "../domain/cakeChatLocations";
import * as scheduledMessages from "../domain/scheduledMessages";
import * as sessionFamilies from "../domain/sessionFamilies";
import { makeCakeIpcServerLive } from "../ipc/server/CakeIpcServer";
import { makeDiscussionSessionEnvironmentLive } from "../layers/DiscussionSessionEnvironmentLive";
import { makeSubagentEnvironmentLive } from "../layers/SubagentEnvironmentLive";
import { WorktreeLandingAgentLive } from "../layers/WorktreeLandingAgentLive";
import { WorktreeLandingCompletionLive } from "../layers/WorktreeLandingCompletionLive";
import { AgentAvailability } from "../services/pi/AgentAvailability";
import { makeElectronLive } from "../services/electron/ElectronLive";
import { makeWorkspaceFilesLive } from "../services/filesystem/WorkspaceFilesLive";
import { makeGitLive } from "../services/git/GitLive";
import { makePiAgentResourcesLive } from "../services/pi/live/PiAgentResourcesLive";
import { makePiModelsLive } from "../services/pi/live/PiModelsLive";
import { makePiSessionsLive } from "../services/pi/PiSessions";
import { makeProjectSessionRuntimeHostLive } from "../services/pi/ProjectSessionRuntimeHostLive";
import { ProjectSessionConfiguration } from "../services/project-sessions/ProjectSessionConfiguration";
import { makeProjectAccessLive } from "../services/projects/ProjectAccessLive";
import { ProjectConfiguration } from "../services/projects/ProjectConfiguration";
import { RewordingRequestsLive } from "../services/projects/RewordingRequestsLive";
import { RendererRequestCoordinatorLive } from "../services/renderer-requests/RendererRequestCoordinator";
import { ScheduledMessages } from "../services/scheduled-messages/ScheduledMessages";
import { SessionCatalogChanges } from "../services/session-catalogs/SessionCatalogChanges";
import { makeArtifactStorageLive } from "../services/storage/ArtifactStorageLive";
import { makeApplicationStorageLive } from "../services/storage/ApplicationStorage";
import { ApplicationState } from "../services/storage/ApplicationState";
import { makeReviewStorageLive } from "../services/storage/ReviewStorageLive";
import { makeScheduledMessageStorageLive } from "../services/storage/ScheduledMessageStorage";
import { makeSessionArchiveStorageLive } from "../services/storage/SessionArchiveStorageLive";
import { makeSessionFamilyStorageLive } from "../services/storage/SessionFamilyStorage";
import { makeWindowStateStorageLive } from "../services/storage/WindowStateStorage";
import { makeWorktreeStorageLive } from "../services/storage/WorktreeStorageLive";
import { SubagentCoordinatorLive } from "../services/subagents/SubagentCoordinator";
import { makeTerminalLive } from "../services/terminal/TerminalLive";
import type { CompanionManifest } from "../services/vscode/VsCodeServerManager";
import { makeVsCodeServerLive } from "../services/vscode/VsCodeServerLive";
import { makeInlineWidgetsLive } from "../services/widgets/InlineWidgetsLive";
import { publishInlineWidget } from "../services/widgets/inline-widget-protocol";
import { ManagedWorktreesLive } from "../services/worktrees/ManagedWorktreesLive";
import { WorktreeLandingCoordinatorLive } from "../services/worktrees/WorktreeLandingCoordinator";
import { loadReviewSessionProjection } from "../services/pi/runtime/sidecar-runtime";
import { BootstrapLive } from "./BootstrapLive";

export interface MainLiveOptions {
  readonly application: App;
  readonly paths: CakePaths;
  readonly userData: string;
  readonly cakeIconPath: string;
  readonly annotationMenuIconPath: string;
  readonly chatMenuIconPath: string;
  readonly companionManifest: CompanionManifest;
  readonly companionMain: string;
  readonly companionThemes: Array<{ readonly path: string; readonly content: string }>;
  readonly preferredTheme: () => Promise<"light" | "dark">;
  readonly onThemeUpdated: (listener: () => void) => () => void;
  readonly homeDirectory?: string;
}

/** Builds the complete, memoized production capability graph for Electron main. */
export const makeMainLive = (options: MainLiveOptions) => {
  const paths = options.paths;
  const homeDirectory = options.homeDirectory ?? homedir();

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
    makeWindowStateStorageLive(options.userData),
    scheduledMessageStorage,
    ScheduledMessages.layer.pipe(Layer.provide(scheduledMessageStorage)),
    makeSessionFamilyStorageLive(paths.sessionFamilies),
    makeSessionArchiveStorageLive(paths.resolvedProjectMetadata),
    makeArtifactStorageLive(paths.artifacts),
    makeReviewStorageLive(paths.reviews, paths.piReviewSessions, (record) =>
      loadReviewSessionProjection(record, paths.piReviewSessions),
    ),
    makeWorktreeStorageLive(paths.worktrees),
    SessionCatalogChanges.layer,
  ).pipe(Layer.provide(BootstrapLive));

  const PiLive = Layer.mergeAll(
    makePiModelsLive(paths.piAgent),
    makePiAgentResourcesLive(paths.piAgent),
    makePiSessionsLive(),
    AgentAvailability.layer,
  );

  const GitLive = makeGitLive();
  const ManagedWorktreesCapabilityLive = ManagedWorktreesLive.pipe(
    Layer.provide(Layer.mergeAll(BootstrapLive, GitLive, StorageLive)),
  );
  const NativeFoundationLive = Layer.mergeAll(
    makeElectronLive({
      application: options.application,
      cakeIconPath: options.cakeIconPath,
      annotationMenuIconPath: options.annotationMenuIconPath,
      chatMenuIconPath: options.chatMenuIconPath,
      preloadPath: join(import.meta.dirname, "../preload/preload.cjs"),
      rendererPath: join(import.meta.dirname, "../renderer/index.html"),
    }),
    GitLive,
    ManagedWorktreesCapabilityLive,
    makeProjectAccessLive({
      projectSessionDirectory: paths.piSessions,
      resolvedProjectSessionDirectory: paths.piResolvedSessions,
    }).pipe(Layer.provide(Layer.merge(StorageLive, ManagedWorktreesCapabilityLive))),
  ).pipe(Layer.provide(Layer.merge(PlatformLive, StorageLive)));
  const NativeServicesLive = Layer.merge(
    NativeFoundationLive,
    Layer.mergeAll(
      makeTerminalLive(),
      makeVsCodeServerLive({
        root: join(options.userData, "vscode-editor"),
        companionManifest: options.companionManifest,
        companionMain: options.companionMain,
        companionThemes: options.companionThemes,
        preferredTheme: options.preferredTheme,
        onThemeUpdated: options.onThemeUpdated,
      }),
    ).pipe(Layer.provide(Layer.mergeAll(PlatformLive, StorageLive, NativeFoundationLive))),
  );

  const ApplicationCapabilitiesLive = Layer.mergeAll(
    PlatformLive,
    StorageLive,
    NativeServicesLive,
    PiLive,
  );

  const SessionCoreLive = Layer.mergeAll(
    RewordingRequestsLive,
    SubagentCoordinatorLive,
    WorktreeLandingCoordinatorLive,
    RendererRequestCoordinatorLive,
    makeInlineWidgetsLive({ paths, publish: publishInlineWidget }),
    makeSubagentEnvironmentLive({
      homeDirectory,
      agentDirectory: paths.piAgent,
      sessionDirectory: paths.piSubagentSessions,
    }),
    makeWorkspaceFilesLive(paths.piAgent),
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
  ).pipe(Layer.provide(SessionWorkflowsLive));

  const RpcLive = makeCakeIpcServerLive(homeDirectory, {
    location: cakeChatLocations.make({
      homeDirectory,
      sessionDirectory: paths.piGlobalChatSessions,
      resolvedSessionDirectory: paths.piGlobalChatResolvedSessions,
    }),
    agentDirectory: paths.piAgent,
  }).pipe(Layer.provide(SessionWorkflowsLive));

  const MainLive = Layer.mergeAll(SessionWorkflowsLive, BackgroundWorkersLive, RpcLive);
  return MainLive;
};
