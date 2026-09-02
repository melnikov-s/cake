import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { Cause, Effect, Exit, Layer, ManagedRuntime, Schema } from "effect";
import { app, nativeTheme } from "electron";
import { cakeEventSchema, type CakeEvent } from "../ipc/cake-rpc-contract";
import { makeCakeIpcServerLive } from "../ipc/server/CakeIpcServer";
import { makePiAgentResourcesLive } from "../services/pi/live/PiAgentResourcesLive";
import { makePiModelsLive } from "../services/pi/live/PiModelsLive";
import { makePiSessionsLive } from "../services/pi/PiSessions";
import { AgentAvailability } from "../services/pi/AgentAvailability";
import { ProjectSessionIntegrationsLive } from "../services/pi/ProjectSessionIntegrationsLive";
import { makeProjectSessionRuntimeOptionsLive } from "../layers/ProjectSessionRuntimeOptionsLive";
import { makePiPluginAgentsProductionLive } from "../services/pi/PiPluginAgentsProductionLive";
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
import { SessionArchiveStorageLive } from "../services/storage/SessionArchiveStorageLive";
import { PluginResources } from "../services/plugins/PluginResources";
import { makePluginRuntimeLive } from "../layers/PluginRuntimeLive";
import { loadReviewSessionProjection } from "../services/pi/runtime/sidecar-runtime";
import {
  publishInlineWidget,
  registerInlineWidgetScheme,
} from "../services/widgets/inline-widget-protocol";
import { resolveCakePaths } from "../config/CakePaths";
import { BootstrapLive } from "./BootstrapLive";
import { MainApplication } from "./MainApplication";
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
const applicationRoot = app.getAppPath();
const authoringRoot = resolve(
  process.env.CAKE_AUTHORING_ROOT ||
    (app.isPackaged
      ? join(applicationRoot, "out", "authoring")
      : join(import.meta.dirname, "../..")),
);
process.env.CAKE_AUTHORING_ROOT = authoringRoot;
const userData = app.getPath("userData");

const applicationStorageLive = makeApplicationStorageLive(userData).pipe(
  Layer.provide(BootstrapLive),
);
const applicationStateLive = ApplicationState.layer.pipe(Layer.provide(applicationStorageLive));
const windowStateLive = makeWindowStateStorageLive(userData).pipe(Layer.provide(BootstrapLive));
const artifactStorageLive = makeArtifactStorageLive(join(userData, "artifacts"));
const reviewStorageLive = makeReviewStorageLive(
  join(userData, "reviews"),
  cakePaths.piReviewSessions,
  (record) => loadReviewSessionProjection(record, cakePaths.piReviewSessions),
);
const gitLive = makeGitLive();
const worktreeStorageLive = makeWorktreeStorageLive(join(userData, "worktrees.json"));
const managedWorktreesLive = ManagedWorktreesLive.pipe(
  Layer.provide(Layer.merge(gitLive, worktreeStorageLive)),
);
const pluginResourcesLive = PluginResources.layer;
const piModelsLive = makePiModelsLive(cakePaths.piAgent);
const piSessionsLive = makePiSessionsLive();
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
  artifactStorageLive,
  reviewStorageLive,
  gitLive,
  worktreeStorageLive,
  managedWorktreesLive,
  SessionArchiveStorageLive,
  pluginResourcesLive,
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
const terminalLive = makeTerminalLive({ homeDirectory: homedir() }).pipe(Layer.provide(accessLive));
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
  pluginAgentSessionDirectory: cakePaths.piPluginAgentSessions,
}).pipe(Layer.provide(sessionFoundationLive));
const runtimeOptionsGraphLive = Layer.merge(
  sessionFoundationLive,
  projectSessionRuntimeOptionsLive,
);
const integrationsLive = ProjectSessionIntegrationsLive.pipe(
  Layer.provide(runtimeOptionsGraphLive),
);
const integrationGraphLive = Layer.merge(runtimeOptionsGraphLive, integrationsLive);
const piPluginAgentsLive = makePiPluginAgentsProductionLive({
  projectSessionDirectory: cakePaths.piSessions,
  privateSessionDirectory: cakePaths.piPluginAgentSessions,
}).pipe(Layer.provide(integrationGraphLive));
const pluginRuntimeLive = makePluginRuntimeLive({
  paths: cakePaths,
  authoringRoot,
  applicationRoot,
  backendHostPath: join(import.meta.dirname, "plugin-backend-host.js"),
  publishInlineWidget,
}).pipe(Layer.provide(Layer.merge(integrationGraphLive, piPluginAgentsLive)));
const runtimeLive = Layer.mergeAll(integrationGraphLive, piPluginAgentsLive, pluginRuntimeLive);

const subagentEnvironmentLive = makeSubagentEnvironmentLive({
  homeDirectory: homedir(),
  agentDirectory: cakePaths.piAgent,
  sessionDirectory: cakePaths.piPluginAgentSessions,
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
const servicesLive = Layer.mergeAll(
  runtimeLive,
  subagentEnvironmentLive,
  cakeSessionLive,
  workspaceFilesLive,
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
  Object.assign(globalThis, {
    cakeSmokeEmitRendererEvent(input: CakeEvent) {
      void mainRuntime.runPromise(
        Effect.flatMap(Electron, (electron) =>
          Effect.sync(() => electron.broadcast(Schema.decodeUnknownSync(cakeEventSchema)(input))),
        ),
      );
    },
    cakeSmokeResetPi() {
      void mainRuntime.runPromise(
        Effect.flatMap(AgentAvailability, (availability) =>
          availability.setGlobal({ state: "unavailable", reason: "Pi runtime stopped" }),
        ),
      );
    },
  });
}
