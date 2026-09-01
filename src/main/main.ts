import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { Effect, Schema } from "effect";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  nativeImage,
  nativeTheme,
  shell,
  webContents,
  type WebContents,
} from "electron";
import { nativeEventSchema, type NativeEvent } from "../ipc/native-protocol";
import { type Attachment } from "../ipc/session-contract";
import type { SourceLocation } from "../ipc/source-location";
import { jsonObjectSchema, jsonValueSchema } from "../ipc/json-contract";
import type { WorktreeRecord } from "../ipc/worktree-contract";
import {
  findSessionFile,
  forkWorkspaceSession,
  inspectWorkspace,
  listWorkspaceSessions,
  suggestProjectFiles,
} from "../services/pi/runtime/session-discovery";
import {
  loadReviewSessionProjection,
  reviewSidecarSystemPrompt,
  runInlineWidgetRepair,
  writeDiscussionParentContext,
} from "../services/pi/runtime/sidecar-runtime";
import { PiModels } from "../services/pi/PiModels";
import { PiSessions, type PiSessionAcquireOptions } from "../services/pi/PiSessions";
import type { CakeRuntimeOptions } from "../services/pi/runtime/cake-runtime";
import { ProjectSessionEnvironmentError } from "../services/project-sessions/ProjectSessionEnvironment";
import { CakeChatEnvironmentError } from "../services/cake-chats/CakeChatEnvironment";
import {
  DiscussionSessionEnvironmentError,
  type DiscussionSessionRecord,
} from "../services/discussion-sessions/DiscussionSessionEnvironment";
import { rewordSelectionWithProjectContext } from "../services/pi/runtime/rewording-agent";
import * as subagents from "../domain/subagents";
import {
  generateSessionTitle,
  generateWorktreeName,
  rewordSelection,
  utilityModelSelection,
} from "../domain/utilityWork";
import {
  forgetProjectSessions,
  reconcileResolvedSessions,
  removeProject,
  renameProject,
  setCakeChatSessionResolved,
  setSessionFastMode,
  setSessionUnread,
  setSessionsResolved,
  setUtilityModel,
  setVscodeServerPath,
  trustProject,
  upsertProject,
} from "../domain/application";
import type { ApplicationState as ApplicationStateOwner } from "../services/storage/ApplicationState";
import { shouldAllowNavigation } from "./navigation-policy";
import { resolveRewordingWorkspace } from "./rewording-workspace";
import { PiWorkspaceDriver, type PiWorkspaceCommand } from "./pi-workspace-driver";
import { VsCodeServerManager } from "./vscode-server-manager";
import { ArtifactRepository } from "./artifact-repository";
import { ReviewRepository } from "./review-repository";
import { WorktreeService } from "./worktree-service";
import { resolveCakePaths } from "./cake-paths";
import { SessionArchiveRepository } from "./session-archive-repository";
import { PluginBuildService } from "./plugin-build-service";
import { PluginActivationService } from "./plugin-activation-service";
import { PluginPersistenceRepository } from "./plugin-persistence-repository";
import { PluginBackendManager } from "./plugin-backend-manager";
import { compileInlineWidget, extractRepairedWidget } from "./inline-widget-service";
import {
  handleInlineWidgetScheme,
  publishInlineWidget,
  registerInlineWidgetScheme,
} from "./inline-widget-protocol";
import { PluginAgentHost } from "./plugin-agent-host";
import { TerminalManager } from "./terminal-manager";
import { launchMainApplication, runMainEffect } from "./MainLive";
import type { NativeServiceOperations } from "../services/native/NativeServices";
import cakeIconPath from "../assets/cake.png?asset";
import annotationMenuIconPath from "../assets/menu-annotation.png?asset";
import chatMenuIconPath from "../assets/menu-chat.png?asset";
// The manifest ships as a plain JSON module and is written out as the
// extension's package.json at install time. The extension main ships as an
// asset file so its `require(...)` calls are never inlined into this bundle
// (an inlined `require(` would trip electron-vite's ESM-shim detection and
// corrupt the bundle).
import companionManifest from "../assets/vscode-companion/companion-manifest.json";
import companionExtensionMain from "../assets/vscode-companion/extension.js?asset";
import cakeLightThemeSource from "../assets/vscode-companion/themes/cake-light-color-theme.json?raw";
import cakeDarkThemeSource from "../assets/vscode-companion/themes/cake-dark-color-theme.json?raw";

app.setName("Cake");

type IconMenuEntry = Omit<
  Electron.MenuItemConstructorOptions,
  "icon" | "label" | "role" | "type"
> & {
  label: string;
  icon: string;
};

function iconMenuEntry({ icon: iconPath, ...entry }: IconMenuEntry) {
  const icon = nativeImage.createFromPath(iconPath);
  icon.setTemplateImage(true);
  return { ...entry, icon } satisfies Electron.MenuItemConstructorOptions;
}
registerInlineWidgetScheme();

interface PiHost {
  path: string;
  driver: PiWorkspaceDriver;
  state: "starting" | "ready" | "stopped" | "failed";
}

const windows = new Map<number, BrowserWindow>();
const windowWorkspaces = new Map<number, string>();
const piHosts = new Map<string, PiHost>();
const sessionWorkspacePaths = new Map<string, string>();
const allowedProjectPaths = new Set<string>();
const pendingTrustRequests = new Map<string, string>();
const openSessionContextMenus = new Set<Menu>();
const windowCustomizationRevisions = new Map<number, string>();
const customizationHealthTimers = new Map<number, ReturnType<typeof setTimeout>>();
const fullscreenSurfaces = new Map<number, Set<string>>();
const composerRewordControllers = new Map<number, Set<AbortController>>();
let applicationStateOwner: ApplicationStateOwner["Service"] | undefined;

function applicationState() {
  if (!applicationStateOwner) throw new Error("Application state has not initialized");
  return applicationStateOwner.unsafeCurrent();
}

const isProjectTrusted = (path: string) => applicationState().trustedProjectPaths.includes(path);
const hasSessionFastMode = (sessionId: string) =>
  applicationState().fastModeSessionIds.includes(sessionId);
const modelPresetAgentProjection = () => {
  const state = applicationState();
  return {
    presets: state.modelPresets.map(({ id, name, modelId }) => ({ id, name, modelId })),
    defaultPresetId: state.defaultModelPresetId,
  };
};
const cakeChatRecoveryContext = () => {
  const state = pluginActivation.snapshot();
  if (!state.recoveryRequired && state.diagnostics.length === 0) return undefined;
  return JSON.stringify(
    {
      failedRevision: state.failedRevision,
      pendingRevision: state.pendingRevision,
      lastKnownGoodRevision: state.lastKnownGoodRevision,
      diagnostics: state.diagnostics,
    },
    null,
    2,
  );
};

function clearPendingTrustRequests(webContentsId: number) {
  for (const key of pendingTrustRequests.keys())
    if (key.startsWith(`${webContentsId}:`)) pendingTrustRequests.delete(key);
}

if (process.env.CAKE_ELECTRON_USER_DATA)
  app.setPath("userData", process.env.CAKE_ELECTRON_USER_DATA);
const cakePaths = resolveCakePaths();
const sessionArchive = new SessionArchiveRepository();
const applicationRoot = app.getAppPath();
const authoringRoot = resolve(
  process.env.CAKE_AUTHORING_ROOT ||
    (app.isPackaged
      ? join(applicationRoot, "out", "authoring")
      : join(import.meta.dirname, "../..")),
);
process.env.CAKE_AUTHORING_ROOT = authoringRoot;
const pluginActivation = new PluginActivationService(
  cakePaths,
  new PluginBuildService(cakePaths, authoringRoot, applicationRoot),
);
const pluginBackends = new PluginBackendManager(
  pluginActivation.builder,
  join(import.meta.dirname, "plugin-backend-host.js"),
  broadcast,
  (pluginId, message) => {
    const revision = pluginActivation.snapshot().activeRevision;
    void pluginActivation.fail(revision, { phase: "backend", pluginId, message }).then(async () => {
      await pluginBackends.stop();
      refreshCakeChatApplicationContext();
      broadcast({ type: "customization-state-changed", state: pluginActivation.snapshot() });
      reloadAllAfterResponse({ kind: "factory" });
    });
  },
);
const pluginPersistence = new PluginPersistenceRepository(
  cakePaths.state,
  () => pluginActivation.snapshot().activeRevision,
);
const pluginCompletionControllers = new Map<string, AbortController>();
interface PluginAgentResources {
  skills: string[];
  prompts: string[];
  extensions: string[];
}
let pluginAgentResources: PluginAgentResources = { skills: [], prompts: [], extensions: [] };
const artifactRepository = new ArtifactRepository(join(app.getPath("userData"), "artifacts"));
const worktrees = new WorktreeService(join(app.getPath("userData"), "worktrees.json"));
const reviewRepository = new ReviewRepository(
  join(app.getPath("userData"), "reviews"),
  cakePaths.piReviewSessions,
  (record) => loadReviewSessionProjection(record, cakePaths.piReviewSessions),
);

function discussionRecord(
  record: Awaited<ReturnType<ReviewRepository["get"]>>,
): DiscussionSessionRecord {
  if (!record) throw new Error("That Discussion Session no longer exists");
  const projected: DiscussionSessionRecord = {
    id: record.id,
    workingDirectory: record.workspacePath,
    parentSessionId: record.sessionId,
    anchor: record.anchor,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  if (record.agentSessionId !== undefined)
    Object.assign(projected, { sidecarSessionId: record.agentSessionId });
  if (record.agentSessionFile !== undefined)
    Object.assign(projected, { sidecarSessionFile: record.agentSessionFile });
  if (record.resolvedAt !== undefined) Object.assign(projected, { resolvedAt: record.resolvedAt });
  return projected;
}

const cakeChatEnvironmentError = (operation: string, cause: unknown) =>
  new CakeChatEnvironmentError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });
const discussionEnvironmentError = (operation: string, cause: unknown) =>
  new DiscussionSessionEnvironmentError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

let applicationQuitting = false;
const vscodeEditor = new VsCodeServerManager({
  root: join(app.getPath("userData"), "vscode-editor"),
  companionManifest,
  companionMain: companionExtensionMain,
  companionThemes: [
    { path: "./themes/cake-light-color-theme.json", content: cakeLightThemeSource },
    { path: "./themes/cake-dark-color-theme.json", content: cakeDarkThemeSource },
  ],
  customPath: () => applicationState().vscodeServerPath,
  preferredTheme: async () => (nativeTheme.shouldUseDarkColors ? "dark" : "light"),
  broadcast,
});
// The embedded editor follows Cake's appearance: push theme changes whenever the
// OS scheme flips (system preference) or the renderer persists a new preference.
nativeTheme.on("updated", () => {
  void vscodeEditor.updateTheme();
});
const pluginAgents = new PluginAgentHost({
  utilityModel: () => applicationState().utilityModel,
  completeModel: (input, signal) =>
    runMainEffect(
      Effect.flatMap(PiModels, (models) => models.complete(input)),
      signal,
    ),
  driver: (workspacePath) => launchPi(workspacePath).driver,
  resolveSessionWorkspacePath,
  emit: sendTo,
});

const nativeEventListeners = new Map<number, Set<(event: NativeEvent) => void>>();

function subscribeNativeEvents(
  connectionId: number,
  listener: (event: NativeEvent) => void,
): () => void {
  const listeners = nativeEventListeners.get(connectionId) ?? new Set();
  listeners.add(listener);
  nativeEventListeners.set(connectionId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) nativeEventListeners.delete(connectionId);
  };
}

function sendTo(target: WebContents, event: NativeEvent) {
  if (event.type === "session-snapshot")
    rememberSessionLocation(event.snapshot.workspacePath, event.snapshot.sessionId);
  if (target.isDestroyed()) return;
  for (const listener of nativeEventListeners.get(target.id) ?? []) listener(event);
}

function broadcast(event: NativeEvent) {
  if (event.type === "session-snapshot")
    rememberSessionLocation(event.snapshot.workspacePath, event.snapshot.sessionId);
  for (const window of windows.values()) sendTo(window.webContents, event);
}

const terminals = new TerminalManager((event) => {
  const target = webContents.fromId(event.ownerId);
  if (!target) return;
  sendTo(
    target,
    event.type === "data"
      ? { type: "terminal-data", terminalId: event.terminalId, data: event.data }
      : { type: "terminal-exited", terminalId: event.terminalId, exitCode: event.exitCode },
  );
});

function closeFullscreenSurfaceForWindow(window: BrowserWindow) {
  const surfaceIds = fullscreenSurfaces.get(window.webContents.id);
  const surfaceId = surfaceIds ? Array.from(surfaceIds).at(-1) : undefined;
  if (!surfaceId) return false;
  sendTo(window.webContents, { type: "fullscreen-surface-close-requested", surfaceId });
  return true;
}

async function setCakeChatSessionResolution(sessionId: string, resolved: boolean) {
  if (resolved) {
    terminals.closeSession("cake-chat", sessionId);
    await sessionArchive.resolve(sessionId, {
      cwd: homedir(),
      activeRoot: cakePaths.piGlobalChatSessions,
      resolvedRoot: cakePaths.piGlobalChatResolvedSessions,
      direct: true,
    });
  } else {
    await sessionArchive.restore(sessionId, {
      cwd: homedir(),
      activeRoot: cakePaths.piGlobalChatSessions,
      resolvedRoot: cakePaths.piGlobalChatResolvedSessions,
      direct: true,
    });
  }
  const state = await runMainEffect(setCakeChatSessionResolved(sessionId, resolved));
  broadcast({ type: "application-state-changed", state });
}

async function setProjectSessionResolution(
  sessionId: string,
  resolved: boolean,
  knownWorkspacePath?: string,
) {
  const workspacePath = knownWorkspacePath ?? (await resolveSessionWorkspacePath(sessionId));
  if (resolved) {
    terminals.closeSession("project", sessionId);
    await piHosts.get(workspacePath)?.driver.releaseSessionForArchive(sessionId);
    await sessionArchive.resolve(sessionId, {
      cwd: workspacePath,
      activeRoot: cakePaths.piSessions,
      resolvedRoot: cakePaths.piResolvedSessions,
    });
    if ((await listWorkspaceSessions(workspacePath, cakePaths.piSessions)).length === 0)
      await worktrees.cleanupResolved(workspacePath);
  } else {
    const restoredWorktree = await worktrees.restoreResolved(workspacePath);
    if (restoredWorktree) {
      allowedProjectPaths.add(restoredWorktree.worktreePath);
      if (isProjectTrusted(restoredWorktree.projectPath))
        await runMainEffect(trustProject(restoredWorktree.worktreePath));
    }
    await sessionArchive.restore(sessionId, {
      cwd: workspacePath,
      activeRoot: cakePaths.piSessions,
      resolvedRoot: cakePaths.piResolvedSessions,
    });
  }
  const state = await runMainEffect(setSessionsResolved([sessionId], resolved));
  broadcast({ type: "application-state-changed", state });
}

async function deleteProjectSession(sessionId: string) {
  if (!applicationState().resolvedSessionIds.includes(sessionId))
    throw new Error("Only resolved project sessions can be deleted");
  const workspacePath = await resolveSessionWorkspacePath(sessionId);
  await Promise.all([
    artifactRepository.deleteSession(workspacePath, sessionId),
    reviewRepository.deleteSession(workspacePath, sessionId),
  ]);
  await sessionArchive.deleteResolved(sessionId, {
    cwd: workspacePath,
    activeRoot: cakePaths.piSessions,
    resolvedRoot: cakePaths.piResolvedSessions,
  });
  forgetProjectSession(sessionId);
  const state = await runMainEffect(forgetProjectSessions([sessionId]));
  broadcast({ type: "application-state-changed", state });
}

function forgetProjectSession(sessionId: string) {
  sessionWorkspacePaths.delete(sessionId);
}

async function deleteProjectSessions(projectPath: string, records: readonly WorktreeRecord[]) {
  const forgottenSessionIds: string[] = [];
  const workspacePaths = [
    projectPath,
    ...records
      .filter((record) => record.projectPath === projectPath)
      .map((record) => record.worktreePath),
  ];
  const sessionsByWorkspace = await Promise.all(
    workspacePaths.map(async (workspacePath) => ({
      workspacePath,
      sessions: await listWorkspaceSessions(workspacePath, cakePaths.piSessions, {
        resolvedSessionDir: cakePaths.piResolvedSessions,
      }),
    })),
  );
  for (const { workspacePath, sessions } of sessionsByWorkspace) {
    for (const session of sessions) {
      await piHosts.get(workspacePath)?.driver.releaseSessionForArchive(session.id);
      await Promise.all([
        artifactRepository.deleteSession(workspacePath, session.id),
        reviewRepository.deleteSession(workspacePath, session.id),
      ]);
      await sessionArchive.delete(session.id, {
        cwd: workspacePath,
        activeRoot: cakePaths.piSessions,
        resolvedRoot: cakePaths.piResolvedSessions,
      });
      forgetProjectSession(session.id);
      forgottenSessionIds.push(session.id);
    }
  }
  if (forgottenSessionIds.length > 0)
    await runMainEffect(forgetProjectSessions(forgottenSessionIds));
}

function rememberSessionLocation(workspacePath: string, sessionId: string) {
  const existing = sessionWorkspacePaths.get(sessionId);
  if (existing && existing !== workspacePath)
    throw new Error(`Session ID collision detected: ${sessionId}`);
  sessionWorkspacePaths.set(sessionId, workspacePath);
}

async function resolveSessionWorkspacePath(sessionId: string) {
  const cached = sessionWorkspacePaths.get(sessionId);
  if (cached && allowedProjectPaths.has(cached)) return cached;
  const worktreePaths = (await worktrees.records()).map((record) => record.worktreePath);
  const workspacePaths = [
    ...new Set([...applicationState().projects.map((project) => project.path), ...worktreePaths]),
  ];
  const matches = (
    await Promise.all(
      workspacePaths.map(async (workspacePath) => {
        if (!allowedProjectPaths.has(workspacePath)) return undefined;
        try {
          const sessions = await listWorkspaceSessions(workspacePath, cakePaths.piSessions, {
            resolvedSessionDir: cakePaths.piResolvedSessions,
          });
          return sessions.some((session) => session.id === sessionId) ? workspacePath : undefined;
        } catch {
          return undefined;
        }
      }),
    )
  ).filter((path): path is string => path !== undefined);
  if (matches.length === 0) throw new Error(`Cake could not find session ${sessionId}`);
  if (new Set(matches).size > 1) throw new Error(`Session ID collision detected: ${sessionId}`);
  rememberSessionLocation(matches[0]!, sessionId);
  return matches[0]!;
}

async function requireWorktreeRecord(
  worktreePath: string,
  states: ReadonlySet<"active" | "landed"> = new Set(["active"]),
) {
  const record = (await worktrees.records()).find((entry) => {
    const state = entry.state ?? "active";
    return (
      entry.worktreePath === worktreePath &&
      (state === "active" || (state === "landed" && states.has("landed")))
    );
  });
  if (!record) throw new Error("Cake could not find that worktree");
  return record;
}

async function reconcileApplicationSessions() {
  const state = applicationState();
  const worktreeRecords = await worktrees.records();
  for (const project of state.projects) {
    allowedProjectPaths.add(project.path);
    // Worktree paths derive from registered projects, so re-allow them on boot.
    for (const record of worktreeRecords)
      if (record.projectPath === project.path) allowedProjectPaths.add(record.worktreePath);
  }
  const projectSessionLists = await Promise.all(
    [...allowedProjectPaths].map((workspacePath) =>
      listWorkspaceSessions(workspacePath, cakePaths.piSessions, {
        resolvedSessionDir: cakePaths.piResolvedSessions,
      }).catch(() => []),
    ),
  );
  const cakeChatSessions = await listWorkspaceSessions(homedir(), cakePaths.piGlobalChatSessions, {
    direct: true,
    resolvedSessionDir: cakePaths.piGlobalChatResolvedSessions,
  }).catch(() => []);
  const projectSessionIds = projectSessionLists
    .flat()
    .filter((session) => session.resolved)
    .map((session) => session.id);
  const cakeChatSessionIds = cakeChatSessions
    .filter((session) => session.resolved)
    .map((session) => session.id);
  const changed =
    [...state.resolvedSessionIds].sort().join("\n") !== [...projectSessionIds].sort().join("\n") ||
    [...state.resolvedCakeChatSessionIds].sort().join("\n") !==
      [...cakeChatSessionIds].sort().join("\n");
  if (changed)
    await runMainEffect(reconcileResolvedSessions(projectSessionIds, cakeChatSessionIds));
}

function setPiState(host: PiHost, state: PiHost["state"]) {
  host.state = state;
  broadcast({ type: "pi-state", state, workspacePath: host.path });
}

async function refreshPluginAgentResources() {
  pluginAgentResources = (await pluginActivation.builder.repository.inspect()).agentResources;
  for (const host of piHosts.values()) {
    host.driver[Symbol.dispose]();
    setPiState(host, "stopped");
  }
  piHosts.clear();
}

async function openProjectLocationInEditor(
  workspacePath: string,
  location: SourceLocation,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const candidates = [...windows.entries()].filter(
    ([webContentsId, window]) =>
      windowWorkspaces.get(webContentsId) === workspacePath && !window.isDestroyed(),
  );
  const selected = candidates.find(([, window]) => window.isFocused()) ?? candidates.at(0);
  if (!selected) throw new Error("No Cake window has this project open");
  const [webContentsId, window] = selected;
  const { workspace, target } = await resolveWorkspaceEditorTarget(workspacePath, location.path);
  const normalizedLocation = {
    ...location,
    path: relative(workspace, target).split(sep).join("/"),
  };
  signal.throwIfAborted();
  await vscodeEditor.open(webContentsId, () => window, workspace);
  signal.throwIfAborted();
  await vscodeEditor.reveal(workspace, normalizedLocation);
  signal.throwIfAborted();
  sendTo(window.webContents, {
    type: "embedded-editor-location-opened",
    workspacePath,
    location: normalizedLocation,
  });
  return normalizedLocation;
}

function subagentControl(
  options: () => PiSessionAcquireOptions,
  workingDirectory: string,
  remainingDepth = 1,
): NonNullable<CakeRuntimeOptions["agentControl"]> {
  const parent = (parentSessionId: string): subagents.SubagentParentRuntime => ({
    parentSessionId,
    workingDirectory,
    remainingDepth,
    options: options(),
  });
  return {
    run: (input, parentSessionId, signal, onUpdate, anchorPartId) =>
      runMainEffect(
        subagents.run(
          input,
          parent(parentSessionId),
          onUpdate
            ? (value) => onUpdate(Schema.decodeUnknownSync(jsonValueSchema)(value))
            : undefined,
          anchorPartId,
        ),
        signal,
      ).then((value) => Schema.decodeUnknownSync(jsonValueSchema)(value)),
    start: (input, parentSessionId, signal, anchorPartId) =>
      runMainEffect(subagents.start(input, parent(parentSessionId), anchorPartId), signal).then(
        (value) => Schema.decodeUnknownSync(jsonValueSchema)(value),
      ),
    parallel: (input, parentSessionId, signal, onUpdate, anchorPartId) =>
      runMainEffect(
        subagents.parallel(
          input,
          parent(parentSessionId),
          onUpdate
            ? (value) => onUpdate(Schema.decodeUnknownSync(jsonValueSchema)(value))
            : undefined,
          anchorPartId,
        ),
        signal,
      ).then((value) => Schema.decodeUnknownSync(jsonValueSchema)(value)),
    prompt: (input, parentSessionId, signal) =>
      runMainEffect(
        subagents.prompt(parentSessionId, input.handleId, input.text, input.delivery),
        signal,
      ).then((value) => Schema.decodeUnknownSync(jsonValueSchema)(value)),
    wait: (handleId, parentSessionId, signal, onUpdate) =>
      runMainEffect(
        subagents.wait(
          parentSessionId,
          handleId,
          onUpdate
            ? (value) => onUpdate(Schema.decodeUnknownSync(jsonValueSchema)(value))
            : undefined,
        ),
        signal,
      ).then((value) => Schema.decodeUnknownSync(jsonValueSchema)(value)),
    abort: (handleId, parentSessionId) =>
      runMainEffect(subagents.abort(parentSessionId, handleId)).then(() =>
        Schema.decodeUnknownSync(jsonValueSchema)({
          handleId,
          status: "aborted",
          streaming: false,
        }),
      ),
    close: (handleId, parentSessionId) =>
      runMainEffect(subagents.close(parentSessionId, handleId)).then((value) =>
        Schema.decodeUnknownSync(jsonValueSchema)(value),
      ),
  };
}

function launchPi(path: string) {
  const existing = piHosts.get(path);
  if (existing && existing.state !== "failed" && existing.state !== "stopped") return existing;
  if (existing) {
    existing.driver[Symbol.dispose]();
    piHosts.delete(path);
  }
  const driver = new PiWorkspaceDriver({
    workspacePath: path,
    agentDir: cakePaths.piAgent,
    sessionDir: cakePaths.piSessions,
    resolvedSessionDir: cakePaths.piResolvedSessions,
    widgetSessionDir: cakePaths.piWidgetSessions,
    pluginAgentSessionDir: cakePaths.piPluginAgentSessions,
    emit: broadcast,
    artifactRepository,
    reviewRepository,
    pluginResources: pluginAgentResources,
    isTrusted: () => isProjectTrusted(path),
    utilityModel: () => applicationState().utilityModel,
    generateSessionTitle: ({ utilityModel, firstUserMessage, signal }) =>
      runMainEffect(
        generateSessionTitle({
          selection: utilityModelSelection(utilityModel),
          firstUserMessage,
        }),
        signal,
      ),
    modelPresets: modelPresetAgentProjection,
    worktreeLanding: worktrees,
    fastMode: hasSessionFastMode,
    setFastMode: (sessionId, enabled) =>
      runMainEffect(setSessionFastMode(sessionId, enabled)).then(() => undefined),
    sessionResolved: (sessionId) => applicationState().resolvedSessionIds.includes(sessionId),
    setSessionResolved: (sessionId, resolved) =>
      setProjectSessionResolution(sessionId, resolved, path),
    openInEditor: (location, signal) => openProjectLocationInEditor(path, location, signal),
    openExternal: async (url) => {
      const protocol = new URL(url).protocol;
      if (protocol !== "https:" && protocol !== "http:")
        throw new Error("Authentication URL must use HTTP or HTTPS");
      await shell.openExternal(url);
    },
  });
  const host: PiHost = { path, driver, state: "starting" };
  piHosts.set(path, host);
  setPiState(host, "starting");
  setPiState(host, "ready");
  return host;
}

function dispatchToPi(path: string, command: PiWorkspaceCommand) {
  launchPi(path).driver.dispatch(command);
}

function refreshCakeChatApplicationContext() {
  void runMainEffect(
    Effect.flatMap(PiSessions, (sessions) => sessions.reloadCakeChatContext()),
  ).catch((error) => console.error("[cake] Cake Chat context refresh failed", error));
}

function configureApplicationBranding() {
  const windowMenuTail: Electron.MenuItemConstructorOptions[] =
    process.platform === "darwin"
      ? [{ type: "separator" }, { role: "front" }]
      : [{ role: "close" }];
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "Cake",
        submenu: [
          { role: "about", label: "About Cake" },
          { type: "separator" },
          { role: "services", submenu: [] },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { role: "fileMenu" },
      { role: "editMenu" },
      { role: "viewMenu" },
      ...(process.env.CAKE_MANUAL_RELOAD === "1"
        ? [
            {
              label: "Developer",
              submenu: [
                {
                  label: "Reload Cake",
                  click: () => BrowserWindow.getFocusedWindow()?.webContents.reload(),
                },
              ],
            },
          ]
        : []),
      // An explicit Window menu (not the `windowMenu` role) lets Cake own ⌘`:
      // macOS reserves that key equivalent for the system-added "Cycle Through
      // Windows" items of a windows menu, consuming it before it can reach the
      // renderer. A menu item with the same accelerator is matched first.
      {
        label: "Window",
        submenu: [
          { role: "minimize" },
          { role: "zoom" },
          { type: "separator" },
          {
            label: "Toggle Terminal",
            accelerator: "CommandOrControl+`",
            click: () => {
              const focused = BrowserWindow.getFocusedWindow();
              const target =
                focused && windows.has(focused.id) ? focused : [...windows.values()].at(-1);
              if (target) sendTo(target.webContents, { type: "terminal-toggle-requested" });
            },
          },
          ...windowMenuTail,
        ],
      },
    ]),
  );

  if (process.platform === "darwin" && app.dock) {
    const icon = nativeImage.createFromPath(cakeIconPath);
    if (!icon.isEmpty()) app.dock.setIcon(icon);
  }
}

const TRAFFIC_LIGHT_X = 18;
const TRAFFIC_LIGHT_DIAMETER = 14;
const CAKE_TITLE_BAR_HEIGHT = 46;
const VSCODE_TITLE_BAR_HEIGHT = 35;

function trafficLightPosition(titleBarHeight: number) {
  return {
    x: TRAFFIC_LIGHT_X,
    y: Math.round((titleBarHeight - TRAFFIC_LIGHT_DIAMETER) / 2),
  };
}

function centerTrafficLights(window: BrowserWindow, titleBarHeight: number) {
  if (process.platform === "darwin")
    window.setWindowButtonPosition(trafficLightPosition(titleBarHeight));
}

function createWindow() {
  const browserWindowOptions = {
    width: 1180,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: "#15191d",
    icon: cakeIconPath,
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Keep renderer IPC and React commits current while the window is occluded.
      // Otherwise Chromium throttles streaming updates and flushes a visible backlog on focus.
      backgroundThrottling: false,
    },
  } as const;
  const window = new BrowserWindow({
    ...(process.platform === "darwin"
      ? {
          ...browserWindowOptions,
          trafficLightPosition: trafficLightPosition(CAKE_TITLE_BAR_HEIGHT),
        }
      : browserWindowOptions),
    // Smoke tests drive the renderer over CDP, so the OS window never needs to
    // be on screen. Keeping it hidden stops test runs from stealing focus and
    // flashing windows while the machine is in use.
    ...(process.env.CAKE_ELECTRON_SMOKE === "1" ? { show: false } : null),
  });
  const webContentsId = window.webContents.id;
  windows.set(window.id, window);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("context-menu", (_event, params) => {
    // Context-specific application menus are requested by the renderer. This
    // fallback covers Chromium editing, selection, spelling, and link actions.
    if (!params.isEditable && !params.selectionText && !params.misspelledWord && !params.linkURL)
      return;
    const template: Electron.MenuItemConstructorOptions[] = [];
    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5))
        template.push({
          label: suggestion,
          click: () => window.webContents.replaceMisspelling(suggestion),
        });
      if (!params.dictionarySuggestions.length)
        template.push({ label: "No Suggestions", enabled: false });
      template.push({ type: "separator" });
    }
    if (params.linkURL) {
      template.push(
        {
          label: "Copy Link",
          click: () => clipboard.writeText(params.linkURL),
        },
        { type: "separator" },
      );
    }
    if (params.isEditable || params.selectionText) {
      template.push(
        { role: "cut", enabled: params.isEditable && params.editFlags.canCut },
        {
          role: "copy",
          enabled: params.isEditable ? params.editFlags.canCopy : Boolean(params.selectionText),
        },
        { role: "paste", enabled: params.isEditable && params.editFlags.canPaste },
      );
      template.push({ role: "selectAll" });
    }
    Menu.buildFromTemplate(template).popup({ window });
  });
  window.webContents.on("will-navigate", (event, url) => {
    // Vite sometimes falls back from a module update to a full-page reload. Blocking
    // that same-origin reload after Chromium has cleared the document leaves a blank
    // window, so keep dev-server navigation available while rejecting external URLs.
    if (!shouldAllowNavigation(window.webContents.getURL(), url, process.env.ELECTRON_RENDERER_URL))
      event.preventDefault();
  });
  window.webContents.on("did-finish-load", () =>
    sendTo(window.webContents, { type: "pi-state", state: "ready" }),
  );
  window.webContents.on("render-process-gone", (_event, details) => {
    fullscreenSurfaces.delete(webContentsId);
    const revision = windowCustomizationRevisions.get(webContentsId);
    if (!revision) return;
    const timer = customizationHealthTimers.get(webContentsId);
    if (timer) clearTimeout(timer);
    customizationHealthTimers.delete(webContentsId);
    void pluginActivation
      .fail(revision, {
        phase: "runtime",
        message: `Customization renderer process exited: ${details.reason}.`,
      })
      .then(() => {
        refreshCakeChatApplicationContext();
        broadcast({ type: "customization-state-changed", state: pluginActivation.snapshot() });
        if (!window.isDestroyed()) void loadSelectedRenderer(window, { kind: "factory" });
      });
  });
  window.on("close", (event) => {
    if (applicationQuitting) return;
    if (closeFullscreenSurfaceForWindow(window)) {
      event.preventDefault();
      return;
    }
    if (vscodeEditor.backToAgentForWindow(webContentsId)) {
      centerTrafficLights(window, CAKE_TITLE_BAR_HEIGHT);
      event.preventDefault();
    }
  });
  window.on("closed", () => {
    const path = windowWorkspaces.get(webContentsId);
    windows.delete(window.id);
    windowWorkspaces.delete(webContentsId);
    vscodeEditor.closeForWindow(webContentsId);
    terminals.closeOwner(webContentsId);
    clearPendingTrustRequests(webContentsId);
    pluginAgents.disposeOwner(webContentsId);
    windowCustomizationRevisions.delete(webContentsId);
    const healthTimer = customizationHealthTimers.get(webContentsId);
    if (healthTimer) clearTimeout(healthTimer);
    customizationHealthTimers.delete(webContentsId);
    fullscreenSurfaces.delete(webContentsId);
    for (const controller of composerRewordControllers.get(webContentsId) ?? []) controller.abort();
    composerRewordControllers.delete(webContentsId);
    if (path) piHosts.get(path)?.driver.cancelPendingRequests();
  });
  void loadSelectedRenderer(window, pluginActivation.startupRenderer());
  return window;
}

async function loadSelectedRenderer(
  window: BrowserWindow,
  renderer: ReturnType<PluginActivationService["startupRenderer"]>,
) {
  if (renderer.kind === "custom" && renderer.path && renderer.revision) {
    windowCustomizationRevisions.set(window.webContents.id, renderer.revision);
    await window.loadFile(renderer.path);
    const previous = customizationHealthTimers.get(window.webContents.id);
    if (previous) clearTimeout(previous);
    customizationHealthTimers.set(
      window.webContents.id,
      setTimeout(() => {
        if (windowCustomizationRevisions.get(window.webContents.id) !== renderer.revision) return;
        void pluginActivation
          .fail(renderer.revision, {
            phase: "render",
            message: "The custom interface did not finish loading within 10 seconds.",
          })
          .then(() => {
            refreshCakeChatApplicationContext();
            broadcast({ type: "customization-state-changed", state: pluginActivation.snapshot() });
            return loadSelectedRenderer(window, { kind: "factory" });
          });
      }, 10_000),
    );
    return;
  }
  windowCustomizationRevisions.delete(window.webContents.id);
  if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
}

function reloadAllWith(renderer: ReturnType<PluginActivationService["startupRenderer"]>) {
  for (const window of windows.values()) void loadSelectedRenderer(window, renderer);
}

function reloadAllAfterResponse(renderer: ReturnType<PluginActivationService["startupRenderer"]>) {
  setTimeout(() => reloadAllWith(renderer), 100);
}

async function rebuildAfterPluginConfigurationChange(request: string) {
  await pluginBackends.stop();
  const candidate = await pluginActivation.validate(undefined, request);
  if (candidate.diagnostics.length > 0) {
    await pluginActivation.recoverFromRejected(candidate.revision);
    refreshCakeChatApplicationContext();
    broadcast({ type: "customization-state-changed", state: pluginActivation.snapshot() });
    reloadAllAfterResponse({ kind: "factory" });
    return;
  }

  const activation = await pluginActivation.activateValidated(
    candidate.revision,
    candidate.sourceRevision,
    request,
  );
  try {
    await pluginBackends.activate(candidate.revision);
  } catch (error) {
    await pluginActivation.fail(candidate.revision, {
      phase: "backend",
      message: error instanceof Error ? error.message : String(error),
    });
    refreshCakeChatApplicationContext();
    broadcast({ type: "customization-state-changed", state: pluginActivation.snapshot() });
    reloadAllAfterResponse({ kind: "factory" });
    return;
  }

  broadcast({ type: "customization-state-changed", state: pluginActivation.snapshot() });
  reloadAllAfterResponse({
    kind: "custom",
    revision: candidate.revision,
    path: activation.indexHtml,
  });
}

const imageMimeTypes = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);
async function resolveWorkspaceEditorTarget(workspacePath: string, requestedPath: string) {
  if (!requestedPath.trim()) throw new Error("An editor path is required");
  const workspace = await realpath(workspacePath);
  const candidate = resolve(workspace, requestedPath);
  const ensureInsideWorkspace = (target: string) => {
    const relativePath = relative(workspace, target);
    if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath))
      throw new Error("File is outside the selected project");
    return target;
  };

  let target: string;
  try {
    target = await realpath(candidate);
  } catch {
    const parent = ensureInsideWorkspace(await realpath(dirname(candidate)));
    target = join(parent, basename(candidate));
  }
  return { workspace, target: ensureInsideWorkspace(target) };
}

async function chooseAttachments(window: BrowserWindow): Promise<Attachment[]> {
  const result = await dialog.showOpenDialog(window, {
    properties: ["openFile", "multiSelections"],
  });
  if (result.canceled) return [];
  return Promise.all(
    result.filePaths.slice(0, 20).map(async (path): Promise<Attachment> => {
      const mimeType = imageMimeTypes.get(extname(path).toLowerCase());
      return mimeType
        ? {
            kind: "image",
            name: basename(path),
            mimeType,
            data: (await readFile(path)).toString("base64"),
          }
        : { kind: "file", name: basename(path), path };
    }),
  );
}
function requireRendererConnection(connectionId: number): WebContents {
  const sender = webContents.fromId(connectionId);
  if (!sender || sender.isDestroyed()) throw new Error("Renderer connection is no longer active");
  return sender;
}

const nativeOperations = {
  electron: {
    "choose-project": async (connectionId) => {
      const sender = requireRendererConnection(connectionId);
      const owner = BrowserWindow.fromWebContents(sender);
      if (!owner) return {};
      const result = await dialog.showOpenDialog(owner, { properties: ["openDirectory"] });
      const path = result.canceled ? undefined : result.filePaths[0];
      if (path) allowedProjectPaths.add(path);
      return { path };
    },
    "open-external-url": async (connectionId, request) => {
      const url = new URL(request.url);
      if (url.protocol !== "https:" && url.protocol !== "http:")
        throw new Error("External links must use HTTP or HTTPS");
      await shell.openExternal(url.href);
      return {};
    },
    "show-transcript-selection-context-menu": async (connectionId, request) => {
      const sender = requireRendererConnection(connectionId);
      const owner = BrowserWindow.fromWebContents(sender);
      if (!owner) return {};
      const action = await new Promise<"chat-about-selection" | "add-annotation" | undefined>(
        (resolve) => {
          let completed = false;
          const finish = (selected?: "chat-about-selection" | "add-annotation") => {
            if (completed) return;
            completed = true;
            resolve(selected);
          };
          const template: Electron.MenuItemConstructorOptions[] = [{ role: "copy" }];
          if (request.canAnnotate)
            template.push(
              iconMenuEntry({
                label: "Add annotation",
                icon: annotationMenuIconPath,
                click: () => finish("add-annotation"),
              }),
            );
          if (request.canChat)
            template.push(
              iconMenuEntry({
                label: "Chat about this",
                icon: chatMenuIconPath,
                click: () => finish("chat-about-selection"),
              }),
            );
          template.push({ role: "selectAll" });
          Menu.buildFromTemplate(template).popup({ window: owner, callback: () => finish() });
        },
      );
      return {
        action,
      };
    },
    "show-composer-context-menu": async (connectionId, request) => {
      const sender = requireRendererConnection(connectionId);
      const owner = BrowserWindow.fromWebContents(sender);
      if (!owner) return {};
      const action = await new Promise<"reword" | "reword-with-prompt" | undefined>((resolve) => {
        let completed = false;
        const finish = (selected?: "reword" | "reword-with-prompt") => {
          if (completed) return;
          completed = true;
          resolve(selected);
        };
        const canReword = Boolean(applicationState().utilityModel);
        Menu.buildFromTemplate([
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { type: "separator" },
          {
            label: "Reword",
            enabled: canReword,
            click: () => finish("reword"),
          },
          {
            label: "Reword with Prompt…",
            enabled: canReword,
            click: () => finish("reword-with-prompt"),
          },
          { type: "separator" },
          { role: "selectAll" },
        ]).popup({
          window: owner,
          x: request.x,
          y: request.y,
          callback: () => finish(),
        });
      });
      return {
        action,
      };
    },
    "show-session-context-menu": async (connectionId, request) => {
      const sender = requireRendererConnection(connectionId);
      const owner = BrowserWindow.fromWebContents(sender);
      if (!owner) return {};
      type SessionMenuAction = "rename" | "mark-unread" | "resolve" | "unresolve" | "delete";
      const action = await new Promise<SessionMenuAction | undefined>((resolve) => {
        let completed = false;
        const finish = (selected?: SessionMenuAction) => {
          if (completed) return;
          completed = true;
          resolve(selected);
        };
        const menu = Menu.buildFromTemplate(
          request.resolved
            ? [
                { label: "Unresolve", click: () => finish("unresolve") },
                {
                  label: "Copy Session ID",
                  click: () => clipboard.writeText(request.sessionId),
                },
                { type: "separator" },
                { label: "Delete", click: () => finish("delete") },
              ]
            : [
                { label: "Rename", click: () => finish("rename") },
                ...(request.unread === false
                  ? [
                      {
                        label: "Mark as Unread",
                        click: () => finish("mark-unread"),
                      } as const,
                    ]
                  : []),
                {
                  label: "Copy Session ID",
                  click: () => clipboard.writeText(request.sessionId),
                },
                { label: "Resolve", click: () => finish("resolve") },
              ],
        );
        openSessionContextMenus.add(menu);
        menu.popup({
          window: owner,
          x: request.x,
          y: request.y,
          callback: () => {
            openSessionContextMenus.delete(menu);
            finish();
          },
        });
      });
      return {
        action,
      };
    },
    "show-project-context-menu": async (connectionId, request) => {
      const sender = requireRendererConnection(connectionId);
      const owner = BrowserWindow.fromWebContents(sender);
      if (!owner) return {};
      type ProjectMenuAction = "remove-project" | "delete-resolved-worktrees";
      const action = await new Promise<ProjectMenuAction | undefined>((resolve) => {
        let completed = false;
        const finish = (selected?: ProjectMenuAction) => {
          if (completed) return;
          completed = true;
          resolve(selected);
        };
        Menu.buildFromTemplate([
          { label: "Copy Project Path", click: () => clipboard.writeText(request.path) },
          { type: "separator" },
          {
            label: `Delete Resolved Worktrees${request.resolvedWorktreeCount > 0 ? ` (${request.resolvedWorktreeCount})` : ""}`,
            enabled: request.resolvedWorktreeCount > 0,
            click: () => finish("delete-resolved-worktrees"),
          },
          { type: "separator" },
          { label: "Remove Project…", click: () => finish("remove-project") },
        ]).popup({
          window: owner,
          x: request.x,
          y: request.y,
          callback: () => finish(),
        });
      });
      return {
        action,
      };
    },
    "set-fullscreen-surface-open": async (connectionId, request) => {
      const sender = requireRendererConnection(connectionId);
      let surfaceIds = fullscreenSurfaces.get(sender.id);
      if (request.open) {
        if (!surfaceIds) {
          surfaceIds = new Set();
          fullscreenSurfaces.set(sender.id, surfaceIds);
        }
        surfaceIds.add(request.surfaceId);
      } else if (surfaceIds) {
        surfaceIds.delete(request.surfaceId);
        if (surfaceIds.size === 0) fullscreenSurfaces.delete(sender.id);
      }
      return {
        requestId: request.requestId,
      };
    },
  },
  filesystem: {
    "choose-attachments": async (connectionId) => {
      const sender = requireRendererConnection(connectionId);
      const owner = BrowserWindow.fromWebContents(sender);
      return {
        attachments: owner ? await chooseAttachments(owner) : [],
      };
    },
    "suggest-files": async (connectionId, request) => {
      if (!allowedProjectPaths.has(request.workspacePath))
        throw new Error("Project path was not selected by the user");
      return {
        suggestions: await suggestProjectFiles({
          cwd: request.workspacePath,
          prefix: request.prefix,
          agentDir: cakePaths.piAgent,
        }),
      };
    },
    "read-workspace-file": async (connectionId, request) => {
      if (!allowedProjectPaths.has(request.workspacePath))
        throw new Error("Project path was not selected by the user");
      if (isAbsolute(request.path)) throw new Error("Workspace file path must be relative");
      const workspace = await realpath(request.workspacePath);
      const target = await realpath(resolve(workspace, request.path));
      const relativePath = relative(workspace, target);
      if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath))
        throw new Error("File is outside the selected project");
      const content = await readFile(target, "utf8");
      if (content.length > 2_000_000) throw new Error("File is too large to display");
      return { content };
    },
  },
  workspaces: {
    "reword-composer-selection": async (connectionId, request) => {
      const sender = requireRendererConnection(connectionId);
      const utilityModel = applicationState().utilityModel;
      if (!utilityModel)
        throw new Error("Configure a utility model in Settings before rewording text");
      const controller = new AbortController();
      const controllers = composerRewordControllers.get(sender.id) ?? new Set();
      controllers.add(controller);
      composerRewordControllers.set(sender.id, controllers);
      const workspacePath = await resolveRewordingWorkspace({
        requestedWorkspace: request.workspacePath,
        activeWorkspace: windowWorkspaces.get(sender.id),
        allowedWorkspacePaths: allowedProjectPaths,
      });
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(workspacePath ? 60_000 : 30_000),
      ]);
      try {
        const text = workspacePath
          ? await rewordSelectionWithProjectContext({
              workspacePath,
              agentDir: cakePaths.piAgent,
              utilityModel,
              selection: request.selection,
              guidance: request.prompt,
              signal,
            })
          : await runMainEffect(
              rewordSelection({
                selection: utilityModelSelection(utilityModel),
                text: request.selection,
                guidance: request.prompt,
              }),
              signal,
            );
        return {
          text,
        };
      } finally {
        controllers.delete(controller);
        if (controllers.size === 0) composerRewordControllers.delete(sender.id);
      }
    },
    "generate-session-title": async (connectionId, request) => {
      const utilityModel = applicationState().utilityModel;
      if (!utilityModel) return {};
      const title = await runMainEffect(
        generateSessionTitle({
          selection: utilityModelSelection(utilityModel),
          firstUserMessage: request.firstUserMessage,
        }),
      );
      return {
        title,
      };
    },
    "set-utility-model": async (connectionId, request) => {
      const state = await runMainEffect(setUtilityModel(request.model));
      return {
        state,
      };
    },
    "register-project": async (connectionId, request) => {
      if (!allowedProjectPaths.has(request.path))
        throw new Error("Project path was not selected by the user");
      const worktreeRecords = await worktrees.records();
      // Managed worktrees belong to their parent project; never register them as projects.
      if (worktreeRecords.some((entry) => entry.worktreePath === request.path))
        return {
          state: applicationState(),
        };
      const state = await runMainEffect(upsertProject(request.path, request.name));
      for (const record of worktreeRecords)
        if (record.projectPath === request.path) allowedProjectPaths.add(record.worktreePath);
      return {
        state,
      };
    },
    "rename-project": async (connectionId, request) => {
      if (!allowedProjectPaths.has(request.path))
        throw new Error("Project path was not selected by the user");
      const state = await runMainEffect(renameProject(request.path, request.name));
      return {
        state,
      };
    },
    "remove-project": async (connectionId, request) => {
      if (!allowedProjectPaths.has(request.path))
        throw new Error("Project path was not selected by the user");
      const projectWorktrees = (await worktrees.records()).filter(
        (record) => record.projectPath === request.path,
      );
      if (request.deleteSessions) await deleteProjectSessions(request.path, projectWorktrees);
      const projectWorkspacePaths = new Set([
        request.path,
        ...projectWorktrees.map((record) => record.worktreePath),
      ]);
      for (const workspacePath of projectWorkspacePaths) {
        allowedProjectPaths.delete(workspacePath);
        const host = piHosts.get(workspacePath);
        if (host) {
          piHosts.delete(workspacePath);
          host.driver[Symbol.dispose]();
          setPiState(host, "stopped");
        }
      }
      for (const [sessionId, workspacePath] of sessionWorkspacePaths)
        if (projectWorkspacePaths.has(workspacePath)) sessionWorkspacePaths.delete(sessionId);
      for (const [webContentsId, workspacePath] of windowWorkspaces)
        if (projectWorkspacePaths.has(workspacePath)) windowWorkspaces.delete(webContentsId);
      const state = await runMainEffect(removeProject(request.path));
      return {
        state,
      };
    },
    "delete-session": async (connectionId, request) => {
      await deleteProjectSession(request.sessionId);
      return {
        state: applicationState(),
      };
    },
    "set-session-unread": async (connectionId, request) => {
      const state = await runMainEffect(setSessionUnread(request.sessionId, request.unread));
      broadcast({ type: "application-state-changed", state });
      return {
        state,
      };
    },
    "restart-pi": async (connectionId, request) => {
      if (!allowedProjectPaths.has(request.path))
        throw new Error("Project path was not selected by the user");
      const old = piHosts.get(request.path);
      if (old) {
        piHosts.delete(request.path);
        old.driver[Symbol.dispose]();
        setPiState(old, "stopped");
      }
      launchPi(request.path);
      return {
        requestId: crypto.randomUUID(),
      };
    },
    "inspect-workspace": async (connectionId, request) => {
      const sender = requireRendererConnection(connectionId);
      const path = request.path;
      if (!allowedProjectPaths.has(path))
        throw new Error("Project path was not selected by the user");
      const inspection = inspectWorkspace(path);
      const trustRequired = inspection.trustRequired && !isProjectTrusted(path);
      const key = `${sender.id}:${request.requestId}`;
      clearPendingTrustRequests(sender.id);
      windowWorkspaces.set(sender.id, path);
      if (trustRequired) pendingTrustRequests.set(key, path);
      sendTo(sender, {
        type: "workspace-inspected",
        requestId: request.requestId,
        path,
        trustRequired,
      });
      return {
        requestId: request.requestId,
      };
    },
    "respond-workspace-trust": async (connectionId, request) => {
      const sender = requireRendererConnection(connectionId);
      if (!allowedProjectPaths.has(request.path))
        throw new Error("Project path was not selected by the user");
      const key = `${sender.id}:${request.requestId}`;
      if (pendingTrustRequests.get(key) !== request.path)
        throw new Error("Workspace trust request is no longer pending");
      pendingTrustRequests.delete(key);
      if (request.approved) await runMainEffect(trustProject(request.path));
      return {
        requestId: request.requestId,
      };
    },
  },
  managedWorktrees: {
    "create-worktree": async (connectionId, request) => {
      if (!allowedProjectPaths.has(request.path))
        throw new Error("Project path was not selected by the user");
      let worktreeName = request.worktreeName;
      const utilityModel = applicationState().utilityModel;
      if (!worktreeName && request.firstUserMessage && utilityModel) {
        const signal = AbortSignal.timeout(15_000);
        try {
          worktreeName = await runMainEffect(
            generateWorktreeName({
              selection: utilityModelSelection(utilityModel),
              firstUserMessage: request.firstUserMessage,
            }),
            signal,
          );
        } catch {
          // Worktree naming is advisory. The service's random name remains the fallback.
        }
      }
      const record = await worktrees.create(request.path, request.baseWorktreePath, worktreeName);
      allowedProjectPaths.add(record.worktreePath);
      if (isProjectTrusted(record.projectPath))
        await runMainEffect(trustProject(record.worktreePath));
      return {
        requestId: request.requestId,
        record,
      };
    },
    "get-worktree-status": async (connectionId, request) => {
      return {
        status: await worktrees.status(request.workspacePath),
      };
    },
    "land-worktree": async (connectionId, request) => {
      await requireWorktreeRecord(request.workspacePath);
      const result = await worktrees.land(request.workspacePath, { request: request.request });
      return {
        requestId: request.requestId,
        result,
      };
    },
    "discard-worktree": async (connectionId, request) => {
      await requireWorktreeRecord(request.workspacePath, new Set(["active", "landed"]));
      await worktrees.discard(request.workspacePath, request.keepBranch);
      return {
        requestId: request.requestId,
      };
    },
  },
  terminals: {
    "open-terminal": async (connectionId, request) => {
      const sender = requireRendererConnection(connectionId);
      if (
        request.target.kind === "project" &&
        !allowedProjectPaths.has(request.target.workspacePath)
      )
        throw new Error("Project path was not selected by the user");
      const cwd =
        request.target.kind === "project"
          ? await realpath(request.target.workspacePath)
          : homedir();
      const opened = terminals.open(
        sender.id,
        { kind: request.target.kind, sessionId: request.target.sessionId },
        cwd,
        request.cols,
        request.rows,
      );
      return {
        requestId: request.requestId,
        ...opened,
      };
    },
    "write-terminal": async (connectionId, request) => {
      const sender = requireRendererConnection(connectionId);
      terminals.write(sender.id, request.terminalId, request.data);
      return {
        requestId: request.requestId,
      };
    },
    "resize-terminal": async (connectionId, request) => {
      const sender = requireRendererConnection(connectionId);
      terminals.resize(sender.id, request.terminalId, request.cols, request.rows);
      return {
        requestId: request.requestId,
      };
    },
    "get-terminal-status": async (connectionId, request) => {
      const sender = requireRendererConnection(connectionId);
      return {
        requestId: request.requestId,
        runningProgram: terminals.hasRunningProgram(sender.id, request.terminalId),
      };
    },
    "close-terminal": async (connectionId, request) => {
      const sender = requireRendererConnection(connectionId);
      terminals.close(sender.id, request.terminalId);
      return {
        requestId: request.requestId,
      };
    },
  },
  vscode: {
    "get-embedded-editor-state": async () => {
      return {
        ...vscodeEditor.snapshotState(),
      };
    },
    "set-vscode-server-path": async (connectionId, request) => {
      const state = await runMainEffect(setVscodeServerPath(request.path));
      await vscodeEditor.refreshStatus();
      return {
        state,
      };
    },
    "install-embedded-editor": async (connectionId, request) => {
      await vscodeEditor.install();
      return {
        requestId: request.requestId,
      };
    },
    "open-embedded-editor": async (connectionId, request) => {
      const sender = requireRendererConnection(connectionId);
      if (!allowedProjectPaths.has(request.workspacePath))
        throw new Error("Project path was not selected by the user");
      await vscodeEditor.open(
        sender.id,
        () => BrowserWindow.fromWebContents(sender),
        request.workspacePath,
      );
      return {
        requestId: request.requestId,
      };
    },
    "update-embedded-editor-bounds": async (connectionId, request) => {
      const sender = requireRendererConnection(connectionId);
      const window = BrowserWindow.fromWebContents(sender);
      if (window)
        centerTrafficLights(
          window,
          request.visible ? VSCODE_TITLE_BAR_HEIGHT : CAKE_TITLE_BAR_HEIGHT,
        );
      vscodeEditor.updateBounds(sender.id, request);
      return {
        requestId: request.requestId,
      };
    },
    "reveal-in-embedded-editor": async (connectionId, request) => {
      if (!allowedProjectPaths.has(request.workspacePath))
        throw new Error("Project path was not selected by the user");
      const { workspace, target } = await resolveWorkspaceEditorTarget(
        request.workspacePath,
        request.location.path,
      );
      await vscodeEditor.reveal(workspace, {
        ...request.location,
        path: relative(workspace, target),
      });
      return {
        requestId: request.requestId,
      };
    },
    "open-embedded-editor-source-control": async (connectionId, request) => {
      if (!allowedProjectPaths.has(request.workspacePath))
        throw new Error("Project path was not selected by the user");
      await vscodeEditor.openSourceControl(request.workspacePath);
      return {
        requestId: request.requestId,
      };
    },
    "update-embedded-editor-annotations": async (connectionId, request) => {
      if (!allowedProjectPaths.has(request.workspacePath))
        throw new Error("Project path was not selected by the user");
      const workspace = await realpath(request.workspacePath);
      const normalized = await Promise.allSettled(
        request.snapshot.annotations.map(async (annotation) => {
          const { target } = await resolveWorkspaceEditorTarget(
            workspace,
            annotation.location.path,
          );
          return {
            ...annotation,
            location: {
              ...annotation.location,
              path: relative(workspace, target).split(sep).join("/"),
            },
          };
        }),
      );
      await vscodeEditor.updateAnnotations(workspace, {
        sessionId: request.snapshot.sessionId,
        annotations: normalized.flatMap((item) =>
          item.status === "fulfilled" ? [item.value] : [],
        ),
      });
      return {
        requestId: request.requestId,
      };
    },
  },
  artifacts: {
    "respond-artifact": async (connectionId, request) => {
      const path = await resolveSessionWorkspacePath(request.sessionId);
      if (!allowedProjectPaths.has(path))
        throw new Error("Project path was not selected by the user");
      dispatchToPi(path, { type: "respond-artifact", ...request });
      return {
        artifactRequestId: request.artifactRequestId,
      };
    },
    "respond-ui": async (connectionId, request) => {
      const path = await resolveSessionWorkspacePath(request.sessionId);
      if (!allowedProjectPaths.has(path))
        throw new Error("Project path was not selected by the user");
      dispatchToPi(path, { type: "respond-ui", ...request });
      return {
        uiRequestId: request.uiRequestId,
      };
    },
    "export-artifacts": async (connectionId, request) => {
      const path = await resolveSessionWorkspacePath(request.sessionId);
      if (!allowedProjectPaths.has(path))
        throw new Error("Project path was not selected by the user");
      return {
        markdown: await artifactRepository.exportMarkdown(path, request.sessionId),
      };
    },
  },
  plugins: {
    "get-customization-state": async () => {
      return {
        state: pluginActivation.snapshot(),
      };
    },
    "get-plugin-authoring-reference": async () => {
      return {
        reference: await pluginActivation.builder.authoringReference(),
      };
    },
    "list-plugin-files": async () => {
      return {
        ...(await pluginActivation.builder.repository.authoringSnapshot()),
      };
    },
    "create-plugin": async (connectionId, request) => {
      return {
        ...(await pluginActivation.builder.repository.createPlugin(
          {
            id: request.pluginId,
            name: request.name,
            renderer: request.renderer,
            backend: request.backend,
            scene: request.scene,
          },
          request.expectedWorkingRevision,
        )),
      };
    },
    "read-plugin-file": async (connectionId, request) => {
      return {
        pluginId: request.pluginId,
        path: request.path,
        content: await pluginActivation.builder.repository.readPluginFile(
          request.pluginId,
          request.path,
        ),
      };
    },
    "write-plugin-file": async (connectionId, request) => {
      return {
        ...(await pluginActivation.builder.repository.writePluginFile(
          request.pluginId,
          request.path,
          request.content,
          request.expectedWorkingRevision,
        )),
      };
    },
    "validate-customization": async (connectionId, request) => {
      const candidate = await pluginActivation.validate(
        request.expectedBaseRevision,
        request.request,
        request.expectedSourceRevision,
      );
      const response = {
        type: "customization-validation" as const,
        revision: candidate.revision,
        sourceRevision: candidate.sourceRevision,
        diagnostics: candidate.diagnostics,
        valid: candidate.diagnostics.length === 0,
      };
      broadcast({ type: "customization-state-changed", state: pluginActivation.snapshot() });
      if (candidate.diagnostics.length) refreshCakeChatApplicationContext();
      return response;
    },
    "activate-customization": async (connectionId, request) => {
      const candidate = await pluginActivation.activateValidated(
        request.revision,
        request.expectedSourceRevision,
        request.request,
      );
      try {
        await pluginBackends.activate(candidate.revision);
      } catch (error) {
        const diagnostic = {
          phase: "backend" as const,
          message: error instanceof Error ? error.message : String(error),
        };
        await pluginActivation.fail(candidate.revision, diagnostic);
        broadcast({ type: "customization-state-changed", state: pluginActivation.snapshot() });
        refreshCakeChatApplicationContext();
        throw error;
      }
      const response = {
        type: "customization-activation" as const,
        revision: candidate.revision,
        activating: true as const,
      };
      broadcast({ type: "customization-state-changed", state: pluginActivation.snapshot() });
      await refreshPluginAgentResources();
      reloadAllAfterResponse({
        kind: "custom",
        revision: candidate.revision,
        path: candidate.indexHtml,
      });
      return response;
    },
    "rollback-customization": async () => {
      const revision = await pluginActivation.rollback();
      try {
        await pluginBackends.activate(revision);
      } catch (error) {
        await pluginActivation.fail(revision, {
          phase: "backend",
          message: error instanceof Error ? error.message : String(error),
        });
        refreshCakeChatApplicationContext();
        reloadAllAfterResponse({ kind: "factory" });
        return {
          state: pluginActivation.snapshot(),
        };
      }
      refreshCakeChatApplicationContext();
      const renderer = revision
        ? { kind: "custom" as const, revision, path: pluginActivation.buildPath(revision) }
        : { kind: "factory" as const };
      reloadAllAfterResponse(renderer);
      return {
        state: pluginActivation.snapshot(),
      };
    },
    "use-factory-customization": async () => {
      await pluginActivation.useFactory();
      await pluginBackends.stop();
      refreshCakeChatApplicationContext();
      reloadAllAfterResponse({ kind: "factory" });
      return {
        state: pluginActivation.snapshot(),
      };
    },
    "list-plugins": async () => {
      return {
        plugins: await pluginActivation.builder.repository.listPluginStatuses(),
      };
    },
    "set-plugin-enabled": async (connectionId, request) => {
      const plugins = await pluginActivation.builder.repository.setEnabled(
        request.pluginId,
        request.enabled,
      );
      await refreshPluginAgentResources();
      await rebuildAfterPluginConfigurationChange(
        `${request.enabled ? "Enable" : "Disable"} plugin ${request.pluginId}`,
      );
      return { plugins };
    },
    "set-active-scene": async (connectionId, request) => {
      return {
        plugins: await pluginActivation.builder.repository.setActiveScene(request.pluginId),
      };
    },
    "delete-plugin": async (connectionId, request) => {
      const { wasEnabled, plugins } = await pluginActivation.builder.repository.deletePlugin(
        request.pluginId,
      );
      await refreshPluginAgentResources();
      if (wasEnabled) {
        await pluginBackends.stop();
        await pluginActivation.fail(pluginActivation.snapshot().activeRevision, {
          phase: "discovery",
          pluginId: request.pluginId,
          message: `Plugin ${request.pluginId} was deleted. Rebuild the customization to activate the remaining plugins.`,
        });
        refreshCakeChatApplicationContext();
        reloadAllAfterResponse({ kind: "factory" });
      }
      return { plugins };
    },
    "compile-inline-widget": async (connectionId, request) => {
      const compiled = await compileInlineWidget(
        request.language,
        request.source,
        request.capability,
      );
      return {
        widget: publishInlineWidget(compiled),
      };
    },
    "repair-inline-widget": async (connectionId, request) => {
      const path = await resolveSessionWorkspacePath(request.sessionId);
      if (!allowedProjectPaths.has(path))
        throw new Error("Project path was not selected by the user");
      const repaired = await runInlineWidgetRepair({
        cwd: path,
        agentDir: cakePaths.piAgent,
        sessionDir: cakePaths.piWidgetSessions,
        language: request.language,
        capability: request.capability,
        source: request.source,
        context: request.context,
        diagnostic: request.diagnostic,
        model: request.model,
      });
      return {
        widget: {
          source: extractRepairedWidget(repaired.response, request.language),
          repairSessionId: repaired.sessionId,
        },
      };
    },
    "open-plugin-agent": async (connectionId, request) => {
      const sender = requireRendererConnection(connectionId);
      const owner = BrowserWindow.fromWebContents(sender);
      if (!owner) throw new Error("Plugin agents require an application window");
      return {
        snapshot: await pluginAgents.open(
          sender,
          request.pluginId,
          request.options,
          request.implicitSession,
        ),
      };
    },
    "prompt-plugin-agent": async (connectionId, request) => {
      const sender = requireRendererConnection(connectionId);
      const owner = BrowserWindow.fromWebContents(sender);
      if (!owner) throw new Error("Plugin agents require an application window");
      return {
        snapshot: await pluginAgents.command(
          sender,
          request.pluginId,
          request.handleId,
          request.delivery,
          request.text,
        ),
      };
    },
    "abort-plugin-agent": async (connectionId, request) => {
      const sender = requireRendererConnection(connectionId);
      const owner = BrowserWindow.fromWebContents(sender);
      if (!owner) throw new Error("Plugin agents require an application window");
      return {
        snapshot: await pluginAgents.abort(sender, request.pluginId, request.handleId),
      };
    },
    "detach-plugin-agent": async (connectionId, request) => {
      const sender = requireRendererConnection(connectionId);
      const owner = BrowserWindow.fromWebContents(sender);
      if (!owner) throw new Error("Plugin agents require an application window");
      pluginAgents.detach(sender, request.pluginId, request.handleId);
      return {
        handleId: request.handleId,
      };
    },
    "run-plugin-completion": async (connectionId, request) => {
      const sender = requireRendererConnection(connectionId);
      const key = `${sender.id}:${request.pluginId}:${request.requestId}`;
      const controller = new AbortController();
      pluginCompletionControllers.set(key, controller);
      try {
        const result = await pluginAgents.complete(
          request.pluginId,
          request.request,
          request.implicitSession,
          controller.signal,
        );
        return {
          requestId: request.requestId,
          result,
        };
      } finally {
        if (pluginCompletionControllers.get(key) === controller)
          pluginCompletionControllers.delete(key);
      }
    },
    "cancel-plugin-completion": async (connectionId, request) => {
      const sender = requireRendererConnection(connectionId);
      pluginCompletionControllers
        .get(`${sender.id}:${request.pluginId}:${request.requestId}`)
        ?.abort();
      return {
        requestId: request.requestId,
      };
    },
    "load-plugin-state": async (connectionId, request) => {
      return {
        record: await pluginPersistence.read(request.pluginId, request.key, request.scope),
      };
    },
    "save-plugin-state": async (connectionId, request) => {
      const sender = requireRendererConnection(connectionId);
      const rendererRevision =
        windowCustomizationRevisions.get(sender.id) ?? pluginActivation.snapshot().activeRevision;
      return {
        record: await pluginPersistence.write(
          request.pluginId,
          request.key,
          request.scope,
          request.value,
          request.expectedVersion,
          rendererRevision,
        ),
      };
    },
    "call-plugin-backend": async (connectionId, request) => {
      try {
        const value = await pluginBackends.call(
          request.pluginId,
          request.callId,
          request.method,
          request.input,
        );
        return {
          callId: request.callId,
          ok: true,
          value,
        };
      } catch (error) {
        return {
          callId: request.callId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    "cancel-plugin-backend-call": async (connectionId, request) => {
      pluginBackends.cancel(request.pluginId, request.callId);
      return {
        requestId: request.callId,
      };
    },
    "customization-rendered": async (connectionId, request) => {
      const sender = requireRendererConnection(connectionId);
      if (windowCustomizationRevisions.get(sender.id) !== request.revision)
        throw new Error("Customization health report does not match this window");
      const current = pluginActivation.snapshot();
      const activating = current.pendingRevision === request.revision;
      if (activating) await pluginActivation.markHealthy(request.revision);
      else if (current.activeRevision !== request.revision)
        throw new Error("Customization revision is not active");
      const healthTimer = customizationHealthTimers.get(sender.id);
      if (healthTimer) clearTimeout(healthTimer);
      customizationHealthTimers.delete(sender.id);
      if (activating) refreshCakeChatApplicationContext();
      broadcast({ type: "customization-state-changed", state: pluginActivation.snapshot() });
      return {
        state: pluginActivation.snapshot(),
      };
    },
    "customization-runtime-failed": async (connectionId, request) => {
      await pluginBackends.stop();
      await pluginActivation.fail(request.revision, { phase: "runtime", message: request.message });
      refreshCakeChatApplicationContext();
      broadcast({ type: "customization-state-changed", state: pluginActivation.snapshot() });
      reloadAllAfterResponse({ kind: "factory" });
      return {
        state: pluginActivation.snapshot(),
      };
    },
  },
  subscribe: (connectionId, listener) => subscribeNativeEvents(connectionId, listener),
} satisfies NativeServiceOperations;

async function startApplicationCapabilities(owner: ApplicationStateOwner["Service"]) {
  applicationStateOwner = owner;
  if (process.env.CAKE_ELECTRON_SMOKE === "1" && process.platform === "darwin" && app.dock)
    app.dock.hide();
  configureApplicationBranding();
  handleInlineWidgetScheme();
  await pluginActivation.load();
  const startupRenderer = pluginActivation.startupRenderer();
  if (startupRenderer.kind === "custom") {
    try {
      await pluginBackends.activate(startupRenderer.revision);
    } catch (error) {
      await pluginActivation.fail(startupRenderer.revision, {
        phase: "backend",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  await refreshPluginAgentResources();
  await reconcileApplicationSessions();
  createWindow();
}

function stopApplicationCapabilities() {
  applicationQuitting = true;
  for (const menu of openSessionContextMenus) menu.closePopup();
  openSessionContextMenus.clear();
  applicationStateOwner = undefined;
  pluginBackends[Symbol.dispose]();
  vscodeEditor.disposeAll();
  terminals.disposeAll();
  nativeEventListeners.clear();
  for (const host of piHosts.values()) host.driver[Symbol.dispose]();
  piHosts.clear();
}

launchMainApplication({
  application: app,
  piAgentDirectory: cakePaths.piAgent,
  nativeOperations,
  rpcOperations: {
    getHomeDirectory() {
      const path = homedir();
      allowedProjectPaths.add(path);
      return path;
    },
    cakeChats: {
      location: Effect.fn("CakeChatEnvironment.location")(() =>
        Effect.succeed({
          workingDirectory: homedir(),
          sessionDirectory: cakePaths.piGlobalChatSessions,
          resolvedSessionDirectory: cakePaths.piGlobalChatResolvedSessions,
        }),
      ),
      runtimeOptions: Effect.fn("CakeChatEnvironment.runtimeOptions")((input, invoke) =>
        Effect.sync(() => {
          const getOptions = () => options;
          const options: PiSessionAcquireOptions = {
            profile: { _tag: "CakeChatSession" as const },
            runtime: {
              cwd: homedir(),
              trusted: true,
              agentDir: cakePaths.piAgent,
              sessionDir: cakePaths.piGlobalChatSessions,
              resolvedSessionDir: cakePaths.piGlobalChatResolvedSessions,
              newSession: input.newSession,
              sessionId: input.sessionId,
              slashCommands: ["compact", "model", "handoff", "handoffandresolve"],
              requestUi: async () => undefined,
              modelPresets: modelPresetAgentProjection,
              fastMode: {
                get: () => hasSessionFastMode(input.sessionId),
                set: (enabled) =>
                  runMainEffect(setSessionFastMode(input.sessionId, enabled)).then(() => undefined),
              },
              currentSessionControl: {
                resolved: () =>
                  applicationState().resolvedCakeChatSessionIds.includes(input.sessionId),
                setResolved: (resolved) => setCakeChatSessionResolution(input.sessionId, resolved),
              },
              agentControl: subagentControl(getOptions, homedir()),
              globalControl: {
                tools: input.tools.map((tool) => ({
                  ...tool,
                  parameters: Schema.decodeUnknownSync(jsonObjectSchema)(tool.parameters),
                  examples: tool.examples?.map((example) => ({
                    ...example,
                    input:
                      example.input === undefined
                        ? undefined
                        : Schema.decodeUnknownSync(jsonObjectSchema)(example.input),
                  })),
                })),
                recoveryContext: cakeChatRecoveryContext(),
                invoke: (invocation, signal) => invoke(input.sessionId, invocation, signal),
              },
            },
          };
          return options;
        }),
      ),
      archive: Effect.fn("CakeChatEnvironment.archive")(function* (sessionId) {
        yield* Effect.tryPromise({
          try: async () => {
            terminals.closeSession("cake-chat", sessionId);
            await sessionArchive.resolve(sessionId, {
              cwd: homedir(),
              activeRoot: cakePaths.piGlobalChatSessions,
              resolvedRoot: cakePaths.piGlobalChatResolvedSessions,
              direct: true,
            });
          },
          catch: (cause) => cakeChatEnvironmentError("archive", cause),
        });
      }),
      restore: Effect.fn("CakeChatEnvironment.restore")(function* (sessionId) {
        yield* Effect.tryPromise({
          try: () =>
            sessionArchive.restore(sessionId, {
              cwd: homedir(),
              activeRoot: cakePaths.piGlobalChatSessions,
              resolvedRoot: cakePaths.piGlobalChatResolvedSessions,
              direct: true,
            }),
          catch: (cause) => cakeChatEnvironmentError("restore", cause),
        });
      }),
      deleteResolved: Effect.fn("CakeChatEnvironment.deleteResolved")(function* (sessionId) {
        yield* Effect.tryPromise({
          try: () =>
            sessionArchive.deleteResolved(sessionId, {
              cwd: homedir(),
              activeRoot: cakePaths.piGlobalChatSessions,
              resolvedRoot: cakePaths.piGlobalChatResolvedSessions,
              direct: true,
            }),
          catch: (cause) => cakeChatEnvironmentError("deleteResolved", cause),
        });
      }),
    },
    discussionSessions: {
      list: Effect.fn("DiscussionSessionEnvironment.list")(
        function* (workingDirectory, parentSessionId) {
          return yield* Effect.tryPromise({
            try: async () =>
              (await reviewRepository.listDiscussionRecords(workingDirectory, parentSessionId)).map(
                (record) => discussionRecord(record),
              ),
            catch: (cause) => discussionEnvironmentError("list", cause),
          });
        },
      ),
      get: Effect.fn("DiscussionSessionEnvironment.get")(
        function* (workingDirectory, parentSessionId, threadId) {
          return yield* Effect.tryPromise({
            try: async () =>
              discussionRecord(
                await reviewRepository.get(workingDirectory, parentSessionId, threadId),
              ),
            catch: (cause) => discussionEnvironmentError("get", cause),
          });
        },
      ),
      create: Effect.fn("DiscussionSessionEnvironment.create")(
        function* (workingDirectory, parentSessionId, anchor) {
          return yield* Effect.tryPromise({
            try: async () =>
              discussionRecord(
                await reviewRepository.createDiscussion(workingDirectory, parentSessionId, anchor),
              ),
            catch: (cause) => discussionEnvironmentError("create", cause),
          });
        },
      ),
      linkSidecar: Effect.fn("DiscussionSessionEnvironment.linkSidecar")(
        function* (record, sidecar) {
          return yield* Effect.tryPromise({
            try: async () =>
              discussionRecord(
                await reviewRepository.linkDiscussionSidecar(
                  record.workingDirectory,
                  record.parentSessionId,
                  record.id,
                  sidecar,
                ),
              ),
            catch: (cause) => discussionEnvironmentError("linkSidecar", cause),
          });
        },
      ),
      setResolved: Effect.fn("DiscussionSessionEnvironment.setResolved")(
        function* (record, resolved) {
          return yield* Effect.tryPromise({
            try: async () => {
              await reviewRepository.resolve(
                record.workingDirectory,
                record.parentSessionId,
                record.id,
                resolved,
              );
              return discussionRecord(
                await reviewRepository.get(
                  record.workingDirectory,
                  record.parentSessionId,
                  record.id,
                ),
              );
            },
            catch: (cause) => discussionEnvironmentError("setResolved", cause),
          });
        },
      ),
      location: Effect.fn("DiscussionSessionEnvironment.location")((record) =>
        Effect.succeed({
          agentDirectory: cakePaths.piAgent,
          sessionDirectory: reviewRepository.agentSessionDirectory(
            record.workingDirectory,
            record.parentSessionId,
            record.id,
          ),
          parentSessionDirectory: cakePaths.piSessions,
          trusted: isProjectTrusted(record.workingDirectory),
        }),
      ),
      prepareParentContext: Effect.fn("DiscussionSessionEnvironment.prepareParentContext")(
        function* (record, parent) {
          return yield* Effect.tryPromise({
            try: async () => {
              const stored = await reviewRepository.get(
                record.workingDirectory,
                record.parentSessionId,
                record.id,
              );
              if (!stored) throw new Error("That Discussion Session no longer exists");
              const target = reviewRepository.discussionParentContextPath(
                record.workingDirectory,
                record.parentSessionId,
                record.id,
              );
              const path = await writeDiscussionParentContext({
                cwd: record.workingDirectory,
                parentSessionRoot: cakePaths.piSessions,
                parent,
                target,
              });
              return reviewSidecarSystemPrompt(stored, path);
            },
            catch: (cause) => discussionEnvironmentError("prepareParentContext", cause),
          });
        },
      ),
      refreshParentIndex: Effect.fn("DiscussionSessionEnvironment.refreshParentIndex")(
        function* (record) {
          yield* Effect.tryPromise({
            try: () =>
              reviewRepository.refreshDiscussionContext(
                record.workingDirectory,
                record.parentSessionId,
              ),
            catch: (cause) => discussionEnvironmentError("refreshParentIndex", cause),
          });
        },
      ),
    },
    subagents: {
      location: Effect.fn("SubagentEnvironment.location")((workingDirectory) =>
        Effect.succeed({
          workingDirectory,
          agentDirectory: cakePaths.piAgent,
          sessionDirectory: cakePaths.piPluginAgentSessions,
          trusted: isProjectTrusted(workingDirectory) || workingDirectory === homedir(),
        }),
      ),
    },
    projectSessions: {
      locations: Effect.fn("ProjectSessionEnvironment.locations")(function* () {
        const records = yield* Effect.tryPromise({
          try: () => worktrees.records(),
          catch: (cause) =>
            new ProjectSessionEnvironmentError({
              operation: "locations",
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        });
        const state = applicationState();
        return [
          ...state.projects.map((project) => ({
            projectPath: project.path,
            projectName: project.name,
            workingDirectory: project.path,
            sessionDirectory: cakePaths.piSessions,
            resolvedSessionDirectory: cakePaths.piResolvedSessions,
          })),
          ...records.flatMap((record) => {
            const project = state.projects.find((item) => item.path === record.projectPath);
            return project
              ? [
                  {
                    projectPath: project.path,
                    projectName: project.name,
                    workingDirectory: record.worktreePath,
                    sessionDirectory: cakePaths.piSessions,
                    resolvedSessionDirectory: cakePaths.piResolvedSessions,
                    managedWorktree: record,
                  },
                ]
              : [];
          }),
        ];
      }),
      runtimeOptions: Effect.fn("ProjectSessionEnvironment.runtimeOptions")(function* ({
        location,
        sessionId,
        newSession,
      }) {
        yield* Effect.sync(() => rememberSessionLocation(location.workingDirectory, sessionId));
        const openedSessionId = sessionId;
        const integrations = launchPi(
          location.workingDirectory,
        ).driver.projectSessionRuntimeIntegrations(sessionId);
        const getOptions = () => options;
        const options: PiSessionAcquireOptions = {
          profile: { _tag: "ProjectSession" as const },
          runtime: {
            ...integrations,
            agentControl: subagentControl(getOptions, location.workingDirectory),
            cwd: location.workingDirectory,
            trusted: isProjectTrusted(location.workingDirectory),
            agentDir: cakePaths.piAgent,
            sessionDir: cakePaths.piSessions,
            resolvedSessionDir: cakePaths.piResolvedSessions,
            newSession,
            sessionId,
            pluginResources: pluginAgentResources,
            utilityModel: () => applicationState().utilityModel,
            generateSessionTitle: ({ utilityModel, firstUserMessage, signal }) =>
              runMainEffect(
                generateSessionTitle({
                  selection: utilityModelSelection(utilityModel),
                  firstUserMessage,
                }),
                signal,
              ),
            modelPresets: modelPresetAgentProjection,
            fastMode: {
              get: () => hasSessionFastMode(openedSessionId),
              set: (enabled) =>
                runMainEffect(setSessionFastMode(openedSessionId, enabled)).then(() => undefined),
            },
            currentSessionControl: {
              resolved: () => applicationState().resolvedSessionIds.includes(openedSessionId),
              setResolved: (resolved) =>
                setProjectSessionResolution(openedSessionId, resolved, location.workingDirectory),
            },
            worktreeLandingControl: location.managedWorktree
              ? {
                  proposeSquashMessage: (message) =>
                    worktrees.proposeSquashMessage({
                      workspacePath: location.workingDirectory,
                      ...message,
                    }),
                }
              : undefined,
            vscodeControl: {
              open: (sourceLocation, signal) =>
                openProjectLocationInEditor(location.workingDirectory, sourceLocation, signal),
            },
            openExternal: async (url) => {
              const protocol = new URL(url).protocol;
              if (protocol !== "https:" && protocol !== "http:")
                throw new Error("Authentication URL must use HTTP or HTTPS");
              await shell.openExternal(url);
            },
          },
        };
        return options;
      }),
      archive: Effect.fn("ProjectSessionEnvironment.archive")(function* (sessionId, location) {
        yield* Effect.tryPromise({
          try: async () => {
            terminals.closeSession("project", sessionId);
            await piHosts
              .get(location.workingDirectory)
              ?.driver.releaseSessionForArchive(sessionId);
            await sessionArchive.resolve(sessionId, {
              cwd: location.workingDirectory,
              activeRoot: cakePaths.piSessions,
              resolvedRoot: cakePaths.piResolvedSessions,
            });
            if (
              (await listWorkspaceSessions(location.workingDirectory, cakePaths.piSessions))
                .length === 0
            )
              await worktrees.cleanupResolved(location.workingDirectory);
          },
          catch: (cause) =>
            new ProjectSessionEnvironmentError({
              operation: "archive",
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        });
      }),
      restore: Effect.fn("ProjectSessionEnvironment.restore")(function* (sessionId, location) {
        return yield* Effect.tryPromise({
          try: async () => {
            const restoredWorktree = await worktrees.restoreResolved(location.workingDirectory);
            const workingDirectory = restoredWorktree?.worktreePath ?? location.workingDirectory;
            if (restoredWorktree) allowedProjectPaths.add(workingDirectory);
            await sessionArchive.restore(sessionId, {
              cwd: workingDirectory,
              activeRoot: cakePaths.piSessions,
              resolvedRoot: cakePaths.piResolvedSessions,
            });
            const restored = { ...location, workingDirectory };
            if (restoredWorktree !== undefined)
              Object.assign(restored, { managedWorktree: restoredWorktree });
            return restored;
          },
          catch: (cause) =>
            new ProjectSessionEnvironmentError({
              operation: "restore",
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        });
      }),
      forkToWorkingDirectory: Effect.fn("ProjectSessionEnvironment.forkToWorkingDirectory")(
        function* ({ sessionId, source, destination }) {
          return yield* Effect.tryPromise({
            try: async () => {
              const sourceFile = await findSessionFile(
                source.workingDirectory,
                sessionId,
                cakePaths.piSessions,
              );
              if (!sourceFile) throw new Error("Cake could not find the Project Session to fork");
              const forked = forkWorkspaceSession(
                sourceFile,
                destination.workingDirectory,
                cakePaths.piSessions,
              );
              rememberSessionLocation(destination.workingDirectory, forked.sessionId);
              return forked.sessionId;
            },
            catch: (cause) =>
              new ProjectSessionEnvironmentError({
                operation: "forkToWorkingDirectory",
                message: cause instanceof Error ? cause.message : String(cause),
              }),
          });
        },
      ),
    },
  },
  start: startApplicationCapabilities,
  stop: stopApplicationCapabilities,
});

if (process.env.CAKE_ELECTRON_SMOKE === "1") {
  Object.assign(globalThis, {
    cakeSmokeEmitRendererEvent(input: NativeEvent) {
      broadcast(Schema.decodeUnknownSync(nativeEventSchema)(input));
    },
    cakeSmokeResetPi() {
      const host = [...piHosts.values()][0];
      if (!host) throw new Error("Pi runtime is unavailable");
      piHosts.delete(host.path);
      host.driver[Symbol.dispose]();
      setPiState(host, "stopped");
    },
  });
}
