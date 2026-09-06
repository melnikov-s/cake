import * as sessionFamilies from "../domain/sessionFamilies";
import { join } from "node:path";
import { homedir } from "node:os";
import { Cause, Effect, Exit, Layer, ManagedRuntime, Schema } from "effect";
import { app, nativeTheme } from "electron";
import { cakeEventSchema, type CakeEvent } from "../ipc/cake-rpc-contract";
import { makeCakeIpcServerLive } from "../ipc/server/CakeIpcServer";
import { makePiAgentResourcesLive } from "../services/pi/live/PiAgentResourcesLive";
import { makePiModelsLive } from "../services/pi/live/PiModelsLive";
import { makePiSessionsLive } from "../services/pi/PiSessions";
import { makeSessionMetadataStorageLive } from "../services/storage/SessionMetadataStorage";
import { makeSessionFamilyStorageLive } from "../services/storage/SessionFamilyStorage";
import { AgentAvailability } from "../services/pi/AgentAvailability";
import { ProjectSessionIntegrationsLive } from "../services/pi/ProjectSessionIntegrationsLive";
import { makeProjectSessionRuntimeOptionsLive } from "../layers/ProjectSessionRuntimeOptionsLive";
import { makeProjectSessionEnvironmentLive } from "../layers/ProjectSessionEnvironmentLive";
import { makeProjectSessionLifecycleLive } from "../layers/ProjectSessionLifecycleLive";
import { makeProjectAccessLive } from "../services/projects/ProjectAccessLive";
import { ProjectConfiguration } from "../services/projects/ProjectConfiguration";
import { RewordingRequestsLive } from "../services/projects/RewordingRequestsLive";
import { makeCakeChatEnvironmentLive } from "../layers/CakeChatEnvironmentLive";
import { makeDiscussionSessionEnvironmentLive } from "../layers/DiscussionSessionEnvironmentLive";
import { SubagentCoordinatorLive } from "../services/subagents/SubagentCoordinator";
import { makeSubagentEnvironmentLive } from "../layers/SubagentEnvironmentLive";
import { makeApplicationStorageLive } from "../services/storage/ApplicationStorage";
import { ApplicationState } from "../services/storage/ApplicationState";
import { makeWindowStateStorageLive } from "../services/storage/WindowStateStorage";
import { makeScheduledMessageStorageLive } from "../services/storage/ScheduledMessageStorage";
import { ScheduledMessages } from "../services/scheduled-messages/ScheduledMessages";
import { makeWorkspaceFilesLive } from "../services/filesystem/WorkspaceFilesLive";
import { Electron } from "../services/electron/Electron";
import { makeElectronLive } from "../services/electron/ElectronLive";
import { makeTerminalLive } from "../services/terminal/TerminalLive";
import { makeVsCodeServerLive } from "../services/vscode/VsCodeServerLive";
import { makeArtifactStorageLive } from "../services/storage/ArtifactStorageLive";
import { makeReviewStorageLive } from "../services/storage/ReviewStorageLive";
import { ManagedWorktreesLive } from "../services/worktrees/ManagedWorktreesLive";
import { makeGitLive } from "../services/git/GitLive";
import { makeWorktreeStorageLive } from "../services/storage/WorktreeStorageLive";
import { makeSessionArchiveStorageLive } from "../services/storage/SessionArchiveStorageLive";
import { SessionCatalogChanges } from "../services/session-catalogs/SessionCatalogChanges";
import { loadReviewSessionProjection } from "../services/pi/runtime/sidecar-runtime";
import { makeInlineWidgetsLive } from "../services/widgets/InlineWidgetsLive";
import {
  publishInlineWidget,
  registerInlineWidgetScheme,
} from "../services/widgets/inline-widget-protocol";
import { resolveCakePaths } from "../config/CakePaths";
import { BootstrapLive } from "./BootstrapLive";
import { MainApplication } from "./MainApplication";
import * as scheduledMessages from "../domain/scheduledMessages";
import cakeIconPath from "../assets/cake.png?asset";
import annotationMenuIconPath from "../assets/menu-annotation.png?asset";
import chatMenuIconPath from "../assets/menu-chat.png?asset";
import companionManifest from "../assets/vscode-companion/companion-manifest.json";
import companionExtensionMain from "../assets/vscode-companion/extension.js?asset";
import cakeLightThemeSource from "../assets/vscode-companion/themes/cake-light-color-theme.json?raw";
import cakeDarkThemeSource from "../assets/vscode-companion/themes/cake-dark-color-theme.json?raw";

app.setName("Cake");
registerInlineWidgetScheme();
if (process.env.CAKE_ELECTRON_USER_DATA)
  app.setPath("userData", process.env.CAKE_ELECTRON_USER_DATA);

const cakePaths = resolveCakePaths();
const userData = app.getPath("userData");

const applicationStorageLive = makeApplicationStorageLive(cakePaths.state).pipe(
  Layer.provide(BootstrapLive),
);
const applicationStateLive = ApplicationState.layer.pipe(Layer.provide(applicationStorageLive));
const windowStateLive = makeWindowStateStorageLive(userData).pipe(Layer.provide(BootstrapLive));
const scheduledMessageStorageLive = makeScheduledMessageStorageLive(cakePaths.state).pipe(
  Layer.provide(BootstrapLive),
);
const scheduledMessagesLive = ScheduledMessages.layer.pipe(
  Layer.provide(scheduledMessageStorageLive),
);
const sessionMetadataStorageLive = makeSessionMetadataStorageLive(cakePaths.sessionMetadata);
const sessionFamilyStorageLive = makeSessionFamilyStorageLive(cakePaths.sessionFamilies).pipe(
  Layer.provide(BootstrapLive),
);
const sessionArchiveStorageLive = makeSessionArchiveStorageLive(
  cakePaths.resolvedProjectMetadata,
).pipe(Layer.provide(sessionMetadataStorageLive));
const artifactStorageLive = makeArtifactStorageLive(cakePaths.artifacts);
const reviewStorageLive = makeReviewStorageLive(
  cakePaths.reviews,
  cakePaths.piReviewSessions,
  (record) => loadReviewSessionProjection(record, cakePaths.piReviewSessions),
);
const gitLive = makeGitLive();
const worktreeStorageLive = makeWorktreeStorageLive(cakePaths.worktrees);
const managedWorktreesLive = ManagedWorktreesLive.pipe(
  Layer.provide(Layer.mergeAll(gitLive, worktreeStorageLive, BootstrapLive)),
);
const piModelsLive = makePiModelsLive(cakePaths.piAgent);
const piSessionsLive = makePiSessionsLive().pipe(Layer.provide(sessionMetadataStorageLive));
const agentAvailabilityLive = AgentAvailability.layer;
const electronLive = makeElectronLive({
  application: app,
  cakeIconPath,
  annotationMenuIconPath,
  chatMenuIconPath,
  preloadPath: join(import.meta.dirname, "../preload/preload.cjs"),
  rendererPath: join(import.meta.dirname, "../renderer/index.html"),
});

const baseLive = Layer.mergeAll(
  applicationStateLive,
  windowStateLive,
  scheduledMessagesLive,
  artifactStorageLive,
  reviewStorageLive,
  gitLive,
  worktreeStorageLive,
  managedWorktreesLive,
  sessionArchiveStorageLive,
  SessionCatalogChanges.layer,
  sessionMetadataStorageLive,
  sessionFamilyStorageLive,
  piModelsLive,
  makePiAgentResourcesLive(cakePaths.piAgent),
  piSessionsLive,
  agentAvailabilityLive,
  electronLive,
  SubagentCoordinatorLive,
  Layer.succeed(ProjectConfiguration, { agentDirectory: cakePaths.piAgent }),
  RewordingRequestsLive,
);
const projectAccessLive = makeProjectAccessLive({
  projectSessionDirectory: cakePaths.piSessions,
  resolvedProjectSessionDirectory: cakePaths.piResolvedSessions,
}).pipe(Layer.provide(baseLive));
const accessLive = Layer.merge(baseLive, projectAccessLive);
const terminalLive = makeTerminalLive().pipe(Layer.provide(accessLive));
const vscodeLive = makeVsCodeServerLive({
  root: join(userData, "vscode-editor"),
  companionManifest,
  companionMain: companionExtensionMain,
  companionThemes: [
    { path: "./themes/cake-light-color-theme.json", content: cakeLightThemeSource },
    { path: "./themes/cake-dark-color-theme.json", content: cakeDarkThemeSource },
  ],
  preferredTheme: async () => (nativeTheme.shouldUseDarkColors ? "dark" : "light"),
  onThemeUpdated: (listener) => {
    nativeTheme.on("updated", listener);
    return () => nativeTheme.off("updated", listener);
  },
}).pipe(Layer.provide(accessLive));
const nativeLive = Layer.mergeAll(accessLive, terminalLive, vscodeLive);
const lifecycleLive = makeProjectSessionLifecycleLive({
  homeDirectory: homedir(),
  projectSessionDirectory: cakePaths.piSessions,
  resolvedProjectSessionDirectory: cakePaths.piResolvedSessions,
  cakeChatSessionDirectory: cakePaths.piGlobalChatSessions,
  resolvedCakeChatSessionDirectory: cakePaths.piGlobalChatResolvedSessions,
}).pipe(Layer.provide(nativeLive));
const sessionFoundationLive = Layer.merge(nativeLive, lifecycleLive);
const projectSessionRuntimeOptionsLive = makeProjectSessionRuntimeOptionsLive({
  agentDirectory: cakePaths.piAgent,
  sessionDirectory: cakePaths.piSessions,
  resolvedSessionDirectory: cakePaths.piResolvedSessions,
  widgetSessionDirectory: cakePaths.piWidgetSessions,
}).pipe(Layer.provide(sessionFoundationLive));
const runtimeOptionsGraphLive = Layer.merge(
  sessionFoundationLive,
  projectSessionRuntimeOptionsLive,
);
const integrationsLive = ProjectSessionIntegrationsLive.pipe(
  Layer.provide(runtimeOptionsGraphLive),
);
const integrationGraphLive = Layer.merge(runtimeOptionsGraphLive, integrationsLive);
const inlineWidgetsLive = makeInlineWidgetsLive({
  paths: cakePaths,
  publish: publishInlineWidget,
}).pipe(Layer.provide(integrationGraphLive));
const runtimeLive = Layer.merge(integrationGraphLive, inlineWidgetsLive);

const subagentEnvironmentLive = makeSubagentEnvironmentLive({
  homeDirectory: homedir(),
  agentDirectory: cakePaths.piAgent,
  sessionDirectory: cakePaths.piSubagentSessions,
}).pipe(Layer.provide(runtimeLive));
const environmentDependenciesLive = Layer.merge(runtimeLive, subagentEnvironmentLive);
const cakeSessionLive = Layer.mergeAll(
  makeProjectSessionEnvironmentLive({
    agentDirectory: cakePaths.piAgent,
    sessionDirectory: cakePaths.piSessions,
    resolvedSessionDirectory: cakePaths.piResolvedSessions,
  }).pipe(Layer.provide(environmentDependenciesLive)),
  makeCakeChatEnvironmentLive({
    homeDirectory: homedir(),
    agentDirectory: cakePaths.piAgent,
    sessionDirectory: cakePaths.piGlobalChatSessions,
    resolvedSessionDirectory: cakePaths.piGlobalChatResolvedSessions,
  }).pipe(Layer.provide(environmentDependenciesLive)),
  makeDiscussionSessionEnvironmentLive({
    agentDirectory: cakePaths.piAgent,
    parentSessionDirectory: cakePaths.piSessions,
  }).pipe(Layer.provide(environmentDependenciesLive)),
);
const workspaceFilesLive = makeWorkspaceFilesLive(cakePaths.piAgent).pipe(
  Layer.provide(runtimeLive),
);
const servicesWithoutScheduledWorkerLive = Layer.mergeAll(
  runtimeLive,
  subagentEnvironmentLive,
  cakeSessionLive,
  workspaceFilesLive,
);
const scheduledMessageWorkerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* scheduledMessages.initialize().pipe(Effect.orDie);
    yield* scheduledMessages.runWorker.pipe(Effect.forkScoped);
  }),
).pipe(Layer.provide(servicesWithoutScheduledWorkerLive));
const familyRecoveryLive = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* sessionFamilies
      .initialize(cakePaths.piSessions, cakePaths.piResolvedSessions)
      .pipe(Effect.orDie);
    yield* sessionFamilies.runWorker.pipe(Effect.forkScoped);
  }),
).pipe(Layer.provide(servicesWithoutScheduledWorkerLive));
const servicesLive = Layer.mergeAll(
  servicesWithoutScheduledWorkerLive,
  scheduledMessageWorkerLive,
  familyRecoveryLive,
);
const serverLive = makeCakeIpcServerLive(homedir()).pipe(Layer.provide(servicesLive));
const MainLive: Layer.Layer<Layer.Success<typeof servicesLive>, never, never> = Layer.merge(
  servicesLive,
  serverLive,
);

const mainRuntime = ManagedRuntime.make(MainLive);
const mainProgram = MainApplication({ application: app });
void mainRuntime
  .runPromiseExit(
    mainProgram.pipe(
      Effect.tapCause((cause) =>
        Effect.logFatal(
          "Main application terminated with an unhandled defect",
          Cause.pretty(cause),
        ),
      ),
    ),
  )
  .then(async (exit) => {
    let exitCode = Exit.isFailure(exit) ? 1 : 0;
    try {
      await mainRuntime.dispose();
    } catch (defect) {
      exitCode = 1;
      console.error("[cake.main] ManagedRuntime finalization failed", defect);
    } finally {
      app.exit(exitCode);
    }
  });

if (process.env.CAKE_ELECTRON_SMOKE === "1") {
  const reportSmokeFailure = (operation: string, defect: Error) => {
    console.error(`[cake.smoke] ${operation} failed`, defect);
  };
  Object.assign(globalThis, {
    cakeSmokeEmitRendererEvent(input: CakeEvent) {
      void mainRuntime
        .runPromise(
          Effect.flatMap(Electron, (electron) =>
            Effect.sync(() => electron.broadcast(Schema.decodeUnknownSync(cakeEventSchema)(input))),
          ),
        )
        .catch((defect) => reportSmokeFailure("emit renderer event", defect));
    },
    cakeSmokeResetPi() {
      void mainRuntime
        .runPromise(
          Effect.flatMap(AgentAvailability, (availability) =>
            availability.setGlobal({ state: "unavailable", reason: "Pi runtime stopped" }),
          ),
        )
        .catch((defect) => reportSmokeFailure("reset Pi availability", defect));
    },
  });
}
