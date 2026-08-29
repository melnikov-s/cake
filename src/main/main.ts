import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  shell,
  type WebContents,
} from "electron";
import {
  desktopRequestSchema,
  desktopResponseSchema,
  type DesktopEvent,
  type DesktopResponse,
} from "../ipc/desktop-ipc";
import {
  windowViewStateSchema,
  type Attachment,
  type WindowViewState,
} from "../ipc/session-contract";
import type { SourceLocation } from "../ipc/source-location";
import {
  cakeWorkspaceSessionDirectory,
  findSessionFile,
  forkWorkspaceSession,
  inspectWorkspace,
  listWorkspaceSessions,
  loadWorkspaceSessionPreview,
  suggestProjectFiles,
} from "../agent/session-discovery";
import { loadReviewSessionProjection, runInlineWidgetRepair } from "../agent/sidecar-runtime";
import { listAgentCatalogModels, refreshAgentCatalogModels } from "../agent/model-catalog";
import { Application } from "../models/Application";
import { shouldAllowNavigation } from "./navigation-policy";
import {
  PiWorkspaceDriver,
  describeOperationError,
  type PiWorkspaceCommand,
} from "./pi-workspace-driver";
import { VsCodeServerManager } from "./vscode-server-manager";
import { ArtifactRepository } from "./artifact-repository";
import { ReviewRepository } from "./review-repository";
import { AtomicFileWriter } from "./atomic-file-writer";
import { WorktreeService } from "./worktree-service";
import { GlobalChatDriver } from "./global-chat-driver";
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
import { PluginAgentHost, resolveAgentModel } from "./plugin-agent-host";
import cakeIconPath from "../assets/cake.png?asset";
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
const windowCustomizationRevisions = new Map<number, string>();
const customizationHealthTimers = new Map<number, ReturnType<typeof setTimeout>>();
const fullscreenSurfaces = new Map<number, Set<string>>();
let applicationModel = Application.from({});
const stateFileWriter = new AtomicFileWriter();

function replaceApplicationModel(next: Application) {
  const previous = applicationModel;
  applicationModel = next;
  previous[Symbol.dispose]();
}

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
      globalChatDriver.refreshRecoveryContext();
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
let applicationQuitting = false;
const vscodeEditor = new VsCodeServerManager({
  root: join(app.getPath("userData"), "vscode-editor"),
  companionManifest,
  companionMain: companionExtensionMain,
  companionThemes: [
    { path: "./themes/cake-light-color-theme.json", content: cakeLightThemeSource },
    { path: "./themes/cake-dark-color-theme.json", content: cakeDarkThemeSource },
  ],
  customPath: () => applicationModel.vscodeServerPath,
  preferredTheme: async () => {
    const preference = (await loadWindowState()).theme;
    if (preference === "dark" || preference === "light") return preference;
    return nativeTheme.shouldUseDarkColors ? "dark" : "light";
  },
  broadcast,
});
// The embedded editor follows Cake's appearance: push theme changes whenever the
// OS scheme flips (system preference) or the renderer persists a new preference.
nativeTheme.on("updated", () => {
  void vscodeEditor.updateTheme();
});
let globalChatController: WebContents | undefined;
const globalChatDriver = new GlobalChatDriver({
  agentDir: cakePaths.piAgent,
  sessionDir: cakePaths.piGlobalChatSessions,
  resolvedSessionDir: cakePaths.piGlobalChatResolvedSessions,
  recoveryContext: () => {
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
  },
  fastMode: (sessionId) => applicationModel.hasSessionFastMode(sessionId),
  setFastMode: async (sessionId, enabled) => {
    applicationModel.setSessionFastMode(sessionId, enabled);
    await persistApplicationState();
  },
  sessionResolved: (sessionId) => applicationModel.resolvedCakeChatSessionIds.includes(sessionId),
  setSessionResolved: (sessionId, resolved) => setCakeChatSessionResolution(sessionId, resolved),
  emit: (event) => {
    if (
      event.type === "global-chat-control-request" &&
      globalChatController &&
      !globalChatController.isDestroyed()
    )
      sendTo(globalChatController, event);
    else broadcast(event);
  },
});
const pluginAgents = new PluginAgentHost({
  agentDir: cakePaths.piAgent,
  utilityModel: () => applicationModel.utilityModel,
  driver: (workspacePath) => launchPi(workspacePath).driver,
  resolveSessionWorkspacePath,
  emit: sendTo,
});

function sendTo(target: WebContents, event: DesktopEvent) {
  if (event.type === "session-snapshot")
    rememberSessionLocation(event.snapshot.workspacePath, event.snapshot.sessionId);
  if (!target.isDestroyed()) target.send("cake:event", event);
}

function broadcast(event: DesktopEvent) {
  if (event.type === "session-snapshot")
    rememberSessionLocation(event.snapshot.workspacePath, event.snapshot.sessionId);
  for (const window of windows.values()) sendTo(window.webContents, event);
}

function closeFullscreenSurfaceForWindow(window: BrowserWindow) {
  const surfaceIds = fullscreenSurfaces.get(window.webContents.id);
  const surfaceId = surfaceIds ? Array.from(surfaceIds).at(-1) : undefined;
  if (!surfaceId) return false;
  sendTo(window.webContents, { type: "fullscreen-surface-close-requested", surfaceId });
  return true;
}

async function setCakeChatSessionResolution(sessionId: string, resolved: boolean) {
  if (resolved) {
    await globalChatDriver.releaseSessionForArchive(sessionId);
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
  applicationModel.setCakeChatSessionResolved(sessionId, resolved);
  await persistApplicationState();
  broadcast({ type: "application-state-changed", state: applicationModel.snapshot() });
}

async function setProjectSessionResolution(
  sessionId: string,
  resolved: boolean,
  knownWorkspacePath?: string,
) {
  const workspacePath = knownWorkspacePath ?? (await resolveSessionWorkspacePath(sessionId));
  if (resolved) {
    await piHosts.get(workspacePath)?.driver.releaseSessionForArchive(sessionId);
    await sessionArchive.resolve(sessionId, {
      cwd: workspacePath,
      activeRoot: cakePaths.piSessions,
      resolvedRoot: cakePaths.piResolvedSessions,
    });
  } else {
    await sessionArchive.restore(sessionId, {
      cwd: workspacePath,
      activeRoot: cakePaths.piSessions,
      resolvedRoot: cakePaths.piResolvedSessions,
    });
  }
  applicationModel.setSessionsResolved([sessionId], resolved);
  await persistApplicationState();
  broadcast({ type: "application-state-changed", state: applicationModel.snapshot() });
}

async function restoreCakeChatSessionForUse(sessionId: string) {
  if (applicationModel.resolvedCakeChatSessionIds.includes(sessionId))
    await setCakeChatSessionResolution(sessionId, false);
}

async function restoreProjectSessionForUse(workspacePath: string, sessionId: string) {
  if (applicationModel.resolvedSessionIds.includes(sessionId))
    await setProjectSessionResolution(sessionId, false, workspacePath);
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
    ...new Set([...applicationModel.projects.map((project) => project.path), ...worktreePaths]),
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

async function requireWorktreeRecord(worktreePath: string) {
  const record = (await worktrees.records()).find(
    (entry) => entry.worktreePath === worktreePath && (entry.state ?? "active") === "active",
  );
  if (!record) throw new Error("Cake could not find that worktree");
  return record;
}

function appStatePath() {
  return join(app.getPath("userData"), "application.json");
}

async function loadApplicationState() {
  try {
    replaceApplicationModel(Application.from(JSON.parse(await readFile(appStatePath(), "utf8"))));
  } catch {
    replaceApplicationModel(Application.from({}));
  }
  const worktreeRecords = await worktrees.records();
  for (const project of applicationModel.projects) {
    allowedProjectPaths.add(project.path);
    // Worktree paths derive from registered projects, so re-allow them on boot.
    for (const record of worktreeRecords)
      if (record.projectPath === project.path) allowedProjectPaths.add(record.worktreePath);
  }
  const previousResolvedIds = [...applicationModel.resolvedSessionIds].sort();
  const previousResolvedCakeChatIds = [...applicationModel.resolvedCakeChatSessionIds].sort();
  const projectSessionLists = await Promise.all(
    [...allowedProjectPaths].map((workspacePath) =>
      listWorkspaceSessions(workspacePath, cakePaths.piSessions, {
        resolvedSessionDir: cakePaths.piResolvedSessions,
      }).catch(() => []),
    ),
  );
  applicationModel.replaceResolvedSessions(
    projectSessionLists
      .flat()
      .filter((session) => session.resolved)
      .map((session) => session.id),
  );
  const cakeChatSessions = await listWorkspaceSessions(homedir(), cakePaths.piGlobalChatSessions, {
    direct: true,
    resolvedSessionDir: cakePaths.piGlobalChatResolvedSessions,
  }).catch(() => []);
  applicationModel.replaceResolvedCakeChatSessions(
    cakeChatSessions.filter((session) => session.resolved).map((session) => session.id),
  );
  const changed =
    previousResolvedIds.join("\n") !== [...applicationModel.resolvedSessionIds].sort().join("\n") ||
    previousResolvedCakeChatIds.join("\n") !==
      [...applicationModel.resolvedCakeChatSessionIds].sort().join("\n");
  if (changed) await persistApplicationState();
}

async function persistApplicationState() {
  await stateFileWriter.write(
    appStatePath(),
    `${JSON.stringify(applicationModel.snapshot(), null, 2)}\n`,
  );
}

function statePath() {
  return join(app.getPath("userData"), "window-state.json");
}

async function loadWindowState(): Promise<WindowViewState> {
  try {
    return windowViewStateSchema.parse(JSON.parse(await readFile(statePath(), "utf8")));
  } catch {
    return windowViewStateSchema.parse({});
  }
}

async function saveWindowState(state: WindowViewState) {
  const parsed = windowViewStateSchema.parse(state);
  await stateFileWriter.write(statePath(), `${JSON.stringify(parsed, null, 2)}\n`);
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
    isTrusted: () => applicationModel.isProjectTrusted(path),
    utilityModel: () => applicationModel.utilityModel,
    worktreeLanding: worktrees,
    fastMode: (sessionId) => applicationModel.hasSessionFastMode(sessionId),
    setFastMode: async (sessionId, enabled) => {
      applicationModel.setSessionFastMode(sessionId, enabled);
      await persistApplicationState();
    },
    sessionResolved: (sessionId) => applicationModel.resolvedSessionIds.includes(sessionId),
    setSessionResolved: (sessionId, resolved) =>
      setProjectSessionResolution(sessionId, resolved, path),
    resolveAgentModel: (preference, snapshot) =>
      resolveAgentModel(preference, snapshot, applicationModel.utilityModel),
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

/**
 * Refreshes the model catalog everywhere without a restart. The shared
 * agent-directory catalog performs the single network pass and writes the
 * refreshed catalogs to the shared models store on disk; every live runtime —
 * project sessions in any open workspace and Cake Chat — then syncs its
 * in-memory catalog from that store so all sources agree immediately. Completion
 * is reported with the same complete/fatal events a driver operation emits.
 */
function refreshModelsEverywhere(requestId: string) {
  void (async () => {
    try {
      await refreshAgentCatalogModels(cakePaths.piAgent);
      await Promise.all([
        ...[...piHosts.values()].map((host) => host.driver.refreshModels()),
        globalChatDriver.refreshModels(),
      ]);
      broadcast({ type: "complete", requestId });
    } catch (error) {
      const described = describeOperationError(error);
      console.error("[cake] Model refresh failed:", described.details ?? described.message);
      broadcast({
        type: "fatal",
        requestId,
        message: described.message,
        details: described.details,
      });
    }
  })();
}

function configureApplicationBranding() {
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
      { role: "windowMenu" },
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
        globalChatDriver.refreshRecoveryContext();
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
    clearPendingTrustRequests(webContentsId);
    pluginAgents.disposeOwner(webContentsId);
    windowCustomizationRevisions.delete(webContentsId);
    const healthTimer = customizationHealthTimers.get(webContentsId);
    if (healthTimer) clearTimeout(healthTimer);
    customizationHealthTimers.delete(webContentsId);
    fullscreenSurfaces.delete(webContentsId);
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
            globalChatDriver.refreshRecoveryContext();
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
    globalChatDriver.refreshRecoveryContext();
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
    globalChatDriver.refreshRecoveryContext();
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

ipcMain.handle("cake:request", async (event, untrustedInput: unknown) => {
  try {
    return await handleCakeRequest(event, untrustedInput);
  } catch (error) {
    console.error("[cake] Renderer request failed:", error);
    throw error;
  }
});

async function handleCakeRequest(
  event: Electron.IpcMainInvokeEvent,
  untrustedInput: unknown,
): Promise<DesktopResponse> {
  const request = desktopRequestSchema.parse(untrustedInput);
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (request.type === "show-transcript-selection-context-menu") {
    if (!owner)
      return desktopResponseSchema.parse({
        type: "transcript-selection-context-menu-closed",
      });
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
          template.push({ label: "Add annotation", click: () => finish("add-annotation") });
        if (request.canChat)
          template.push({ label: "Chat about this", click: () => finish("chat-about-selection") });
        template.push({ role: "selectAll" });
        Menu.buildFromTemplate(template).popup({ window: owner, callback: () => finish() });
      },
    );
    return desktopResponseSchema.parse({
      type: "transcript-selection-context-menu-closed",
      action,
    });
  }
  if (request.type === "set-fullscreen-surface-open") {
    let surfaceIds = fullscreenSurfaces.get(event.sender.id);
    if (request.open) {
      if (!surfaceIds) {
        surfaceIds = new Set();
        fullscreenSurfaces.set(event.sender.id, surfaceIds);
      }
      surfaceIds.add(request.surfaceId);
    } else if (surfaceIds) {
      surfaceIds.delete(request.surfaceId);
      if (surfaceIds.size === 0) fullscreenSurfaces.delete(event.sender.id);
    }
    return desktopResponseSchema.parse({ type: "accepted", requestId: request.requestId });
  }
  if (request.type === "show-session-context-menu") {
    if (!owner) return desktopResponseSchema.parse({ type: "session-context-menu-closed" });
    const action = await new Promise<"rename" | undefined>((resolve) => {
      let completed = false;
      const finish = (selected?: "rename") => {
        if (completed) return;
        completed = true;
        resolve(selected);
      };
      Menu.buildFromTemplate([
        { label: "Rename", click: () => finish("rename") },
        {
          label: "Copy Session ID",
          click: () => clipboard.writeText(request.sessionId),
        },
      ]).popup({
        window: owner,
        x: request.x,
        y: request.y,
        callback: () => finish(),
      });
    });
    return desktopResponseSchema.parse({ type: "session-context-menu-closed", action });
  }
  if (request.type === "set-vscode-server-path") {
    applicationModel.setVscodeServerPath(request.path);
    await persistApplicationState();
    await vscodeEditor.refreshStatus();
    return desktopResponseSchema.parse({
      type: "application-state-updated",
      state: applicationModel.snapshot(),
    });
  }
  if (request.type === "get-embedded-editor-state")
    return desktopResponseSchema.parse({
      type: "embedded-editor-state-loaded",
      ...vscodeEditor.snapshotState(),
    });
  if (request.type === "install-embedded-editor") {
    await vscodeEditor.install();
    return desktopResponseSchema.parse({ type: "accepted", requestId: request.requestId });
  }
  if (request.type === "open-embedded-editor") {
    if (!allowedProjectPaths.has(request.workspacePath))
      throw new Error("Project path was not selected by the user");
    await vscodeEditor.open(
      event.sender.id,
      () => BrowserWindow.fromWebContents(event.sender),
      request.workspacePath,
    );
    return desktopResponseSchema.parse({ type: "accepted", requestId: request.requestId });
  }
  if (request.type === "update-embedded-editor-bounds") {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window)
      centerTrafficLights(
        window,
        request.visible ? VSCODE_TITLE_BAR_HEIGHT : CAKE_TITLE_BAR_HEIGHT,
      );
    vscodeEditor.updateBounds(event.sender.id, request);
    return desktopResponseSchema.parse({ type: "accepted", requestId: request.requestId });
  }
  if (request.type === "reveal-in-embedded-editor") {
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
    return desktopResponseSchema.parse({ type: "accepted", requestId: request.requestId });
  }
  if (request.type === "open-embedded-editor-source-control") {
    if (!allowedProjectPaths.has(request.workspacePath))
      throw new Error("Project path was not selected by the user");
    await vscodeEditor.openSourceControl(request.workspacePath);
    return desktopResponseSchema.parse({ type: "accepted", requestId: request.requestId });
  }
  if (request.type === "update-embedded-editor-annotations") {
    if (!allowedProjectPaths.has(request.workspacePath))
      throw new Error("Project path was not selected by the user");
    const workspace = await realpath(request.workspacePath);
    const normalized = await Promise.allSettled(
      request.snapshot.annotations.map(async (annotation) => {
        const { target } = await resolveWorkspaceEditorTarget(workspace, annotation.location.path);
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
      annotations: normalized.flatMap((item) => (item.status === "fulfilled" ? [item.value] : [])),
    });
    return desktopResponseSchema.parse({ type: "accepted", requestId: request.requestId });
  }
  if (request.type === "get-customization-state")
    return desktopResponseSchema.parse({
      type: "customization-state",
      state: pluginActivation.snapshot(),
    });
  if (request.type === "get-plugin-authoring-reference")
    return desktopResponseSchema.parse({
      type: "plugin-authoring-reference",
      reference: await pluginActivation.builder.authoringReference(),
    });
  if (request.type === "list-plugin-files")
    return desktopResponseSchema.parse({
      type: "plugin-files",
      ...(await pluginActivation.builder.repository.authoringSnapshot()),
    });
  if (request.type === "create-plugin")
    return desktopResponseSchema.parse({
      type: "plugin-files",
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
    });
  if (request.type === "read-plugin-file")
    return desktopResponseSchema.parse({
      type: "plugin-file",
      pluginId: request.pluginId,
      path: request.path,
      content: await pluginActivation.builder.repository.readPluginFile(
        request.pluginId,
        request.path,
      ),
    });
  if (request.type === "write-plugin-file")
    return desktopResponseSchema.parse({
      type: "plugin-files",
      ...(await pluginActivation.builder.repository.writePluginFile(
        request.pluginId,
        request.path,
        request.content,
        request.expectedWorkingRevision,
      )),
    });
  if (request.type === "validate-customization") {
    const candidate = await pluginActivation.validate(
      request.expectedBaseRevision,
      request.request,
      request.expectedSourceRevision,
    );
    const response = desktopResponseSchema.parse({
      type: "customization-validation",
      revision: candidate.revision,
      sourceRevision: candidate.sourceRevision,
      diagnostics: candidate.diagnostics,
      valid: candidate.diagnostics.length === 0,
    });
    broadcast({ type: "customization-state-changed", state: pluginActivation.snapshot() });
    if (candidate.diagnostics.length) globalChatDriver.refreshRecoveryContext();
    return response;
  }
  if (request.type === "activate-customization") {
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
      globalChatDriver.refreshRecoveryContext();
      throw error;
    }
    const response = desktopResponseSchema.parse({
      type: "customization-activation",
      revision: candidate.revision,
      activating: true,
    });
    broadcast({ type: "customization-state-changed", state: pluginActivation.snapshot() });
    await refreshPluginAgentResources();
    reloadAllAfterResponse({
      kind: "custom",
      revision: candidate.revision,
      path: candidate.indexHtml,
    });
    return response;
  }
  if (request.type === "customization-rendered") {
    if (windowCustomizationRevisions.get(event.sender.id) !== request.revision)
      throw new Error("Customization health report does not match this window");
    const current = pluginActivation.snapshot();
    const activating = current.pendingRevision === request.revision;
    if (activating) await pluginActivation.markHealthy(request.revision);
    else if (current.activeRevision !== request.revision)
      throw new Error("Customization revision is not active");
    const healthTimer = customizationHealthTimers.get(event.sender.id);
    if (healthTimer) clearTimeout(healthTimer);
    customizationHealthTimers.delete(event.sender.id);
    if (activating) globalChatDriver.refreshRecoveryContext();
    broadcast({ type: "customization-state-changed", state: pluginActivation.snapshot() });
    return desktopResponseSchema.parse({
      type: "customization-state",
      state: pluginActivation.snapshot(),
    });
  }
  if (request.type === "customization-runtime-failed") {
    await pluginBackends.stop();
    await pluginActivation.fail(request.revision, { phase: "runtime", message: request.message });
    globalChatDriver.refreshRecoveryContext();
    broadcast({ type: "customization-state-changed", state: pluginActivation.snapshot() });
    reloadAllAfterResponse({ kind: "factory" });
    return desktopResponseSchema.parse({
      type: "customization-state",
      state: pluginActivation.snapshot(),
    });
  }
  if (request.type === "rollback-customization") {
    const revision = await pluginActivation.rollback();
    try {
      await pluginBackends.activate(revision);
    } catch (error) {
      await pluginActivation.fail(revision, {
        phase: "backend",
        message: error instanceof Error ? error.message : String(error),
      });
      globalChatDriver.refreshRecoveryContext();
      reloadAllAfterResponse({ kind: "factory" });
      return desktopResponseSchema.parse({
        type: "customization-state",
        state: pluginActivation.snapshot(),
      });
    }
    globalChatDriver.refreshRecoveryContext();
    const renderer = revision
      ? { kind: "custom" as const, revision, path: pluginActivation.buildPath(revision) }
      : { kind: "factory" as const };
    reloadAllAfterResponse(renderer);
    return desktopResponseSchema.parse({
      type: "customization-state",
      state: pluginActivation.snapshot(),
    });
  }
  if (request.type === "use-factory-customization") {
    await pluginActivation.useFactory();
    await pluginBackends.stop();
    globalChatDriver.refreshRecoveryContext();
    reloadAllAfterResponse({ kind: "factory" });
    return desktopResponseSchema.parse({
      type: "customization-state",
      state: pluginActivation.snapshot(),
    });
  }
  if (request.type === "list-plugins")
    return desktopResponseSchema.parse({
      type: "plugins-listed",
      plugins: await pluginActivation.builder.repository.listPluginStatuses(),
    });
  if (request.type === "set-active-scene")
    return desktopResponseSchema.parse({
      type: "plugins-listed",
      plugins: await pluginActivation.builder.repository.setActiveScene(request.pluginId),
    });
  if (request.type === "set-plugin-enabled") {
    const plugins = await pluginActivation.builder.repository.setEnabled(
      request.pluginId,
      request.enabled,
    );
    await refreshPluginAgentResources();
    await rebuildAfterPluginConfigurationChange(
      `${request.enabled ? "Enable" : "Disable"} plugin ${request.pluginId}`,
    );
    return desktopResponseSchema.parse({ type: "plugins-listed", plugins });
  }
  if (request.type === "delete-plugin") {
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
      globalChatDriver.refreshRecoveryContext();
      reloadAllAfterResponse({ kind: "factory" });
    }
    return desktopResponseSchema.parse({ type: "plugins-listed", plugins });
  }
  if (request.type === "load-plugin-state") {
    return desktopResponseSchema.parse({
      type: "plugin-state",
      record: await pluginPersistence.read(request.pluginId, request.key, request.scope),
    });
  }
  if (request.type === "save-plugin-state") {
    const rendererRevision =
      windowCustomizationRevisions.get(event.sender.id) ??
      pluginActivation.snapshot().activeRevision;
    return desktopResponseSchema.parse({
      type: "plugin-state",
      record: await pluginPersistence.write(
        request.pluginId,
        request.key,
        request.scope,
        request.value,
        request.expectedVersion,
        rendererRevision,
      ),
    });
  }
  if (request.type === "call-plugin-backend") {
    try {
      const value = await pluginBackends.call(
        request.pluginId,
        request.callId,
        request.method,
        request.input,
      );
      return desktopResponseSchema.parse({
        type: "plugin-backend-result",
        callId: request.callId,
        ok: true,
        value,
      });
    } catch (error) {
      return desktopResponseSchema.parse({
        type: "plugin-backend-result",
        callId: request.callId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (request.type === "cancel-plugin-backend-call") {
    pluginBackends.cancel(request.pluginId, request.callId);
    return desktopResponseSchema.parse({ type: "accepted", requestId: request.callId });
  }
  if (request.type === "open-plugin-agent") {
    if (!owner) throw new Error("Plugin agents require an application window");
    return desktopResponseSchema.parse({
      type: "plugin-agent-snapshot",
      snapshot: await pluginAgents.open(
        event.sender,
        request.pluginId,
        request.options,
        request.implicitSession,
      ),
    });
  }
  if (request.type === "prompt-plugin-agent") {
    if (!owner) throw new Error("Plugin agents require an application window");
    return desktopResponseSchema.parse({
      type: "plugin-agent-snapshot",
      snapshot: await pluginAgents.command(
        event.sender,
        request.pluginId,
        request.handleId,
        request.delivery,
        request.text,
      ),
    });
  }
  if (request.type === "abort-plugin-agent") {
    if (!owner) throw new Error("Plugin agents require an application window");
    return desktopResponseSchema.parse({
      type: "plugin-agent-snapshot",
      snapshot: await pluginAgents.abort(event.sender, request.pluginId, request.handleId),
    });
  }
  if (request.type === "detach-plugin-agent") {
    if (!owner) throw new Error("Plugin agents require an application window");
    pluginAgents.detach(event.sender, request.pluginId, request.handleId);
    return desktopResponseSchema.parse({
      type: "plugin-agent-detached",
      handleId: request.handleId,
    });
  }
  if (request.type === "run-plugin-completion") {
    const key = `${event.sender.id}:${request.pluginId}:${request.requestId}`;
    const controller = new AbortController();
    pluginCompletionControllers.set(key, controller);
    try {
      const result = await pluginAgents.complete(
        request.pluginId,
        request.request,
        request.implicitSession,
        controller.signal,
      );
      return desktopResponseSchema.parse({
        type: "plugin-completion-result",
        requestId: request.requestId,
        result,
      });
    } finally {
      if (pluginCompletionControllers.get(key) === controller)
        pluginCompletionControllers.delete(key);
    }
  }
  if (request.type === "cancel-plugin-completion") {
    pluginCompletionControllers
      .get(`${event.sender.id}:${request.pluginId}:${request.requestId}`)
      ?.abort();
    return desktopResponseSchema.parse({ type: "accepted", requestId: request.requestId });
  }
  if (request.type === "open-global-chat") {
    globalChatController = event.sender;
    if (request.sessionId) await restoreCakeChatSessionForUse(request.sessionId);
    globalChatDriver.open(request.requestId, request.tools, { sessionId: request.sessionId });
    return desktopResponseSchema.parse({ type: "accepted", requestId: request.requestId });
  }
  if (request.type === "prompt-global-chat") {
    globalChatController = event.sender;
    if (!request.newSession) await restoreCakeChatSessionForUse(request.sessionId);
    globalChatDriver.prompt(
      request.requestId,
      request.sessionId,
      request.text,
      request.attachments,
      request.newSession,
    );
    return desktopResponseSchema.parse({ type: "accepted", requestId: request.requestId });
  }
  if (request.type === "abort-global-chat") {
    globalChatController = event.sender;
    globalChatDriver.abort(request.requestId, request.sessionId);
    return desktopResponseSchema.parse({ type: "accepted", requestId: request.requestId });
  }
  if (request.type === "compact-global-chat") {
    globalChatController = event.sender;
    globalChatDriver.compact(request.requestId, request.sessionId, request.instructions);
    return desktopResponseSchema.parse({ type: "accepted", requestId: request.requestId });
  }
  if (request.type === "set-global-chat-model") {
    globalChatController = event.sender;
    globalChatDriver.setModel(
      request.requestId,
      request.sessionId,
      request.provider,
      request.modelId,
    );
    return desktopResponseSchema.parse({ type: "accepted", requestId: request.requestId });
  }
  if (request.type === "set-global-chat-thinking") {
    globalChatController = event.sender;
    globalChatDriver.setThinkingLevel(request.requestId, request.sessionId, request.level);
    return desktopResponseSchema.parse({ type: "accepted", requestId: request.requestId });
  }
  if (request.type === "set-global-chat-configuration") {
    globalChatController = event.sender;
    globalChatDriver.setConfiguration(request.requestId, request.sessionId, request.configuration);
    return desktopResponseSchema.parse({ type: "accepted", requestId: request.requestId });
  }
  if (request.type === "set-global-chat-fast-mode") {
    globalChatController = event.sender;
    globalChatDriver.setFastMode(request.requestId, request.sessionId, request.enabled);
    return desktopResponseSchema.parse({ type: "accepted", requestId: request.requestId });
  }
  if (request.type === "rename-global-chat") {
    globalChatController = event.sender;
    await restoreCakeChatSessionForUse(request.sessionId);
    globalChatDriver.rename(request.requestId, request.sessionId, request.name);
    return desktopResponseSchema.parse({ type: "accepted", requestId: request.requestId });
  }
  if (request.type === "handoff-global-chat") {
    globalChatController = event.sender;
    await restoreCakeChatSessionForUse(request.sessionId);
    globalChatDriver.handoff(
      request.requestId,
      request.sessionId,
      request.entryId,
      request.prompt,
      request.resolveSource,
    );
    return desktopResponseSchema.parse({ type: "accepted", requestId: request.requestId });
  }
  if (request.type === "respond-global-chat-control") {
    globalChatDriver.respond(request.controlRequestId, request.result);
    return desktopResponseSchema.parse({ type: "accepted", requestId: request.controlRequestId });
  }
  if (request.type === "choose-project") {
    if (!owner) return desktopResponseSchema.parse({ type: "project-chosen" });
    const result = await dialog.showOpenDialog(owner, { properties: ["openDirectory"] });
    const path = result.canceled ? undefined : result.filePaths[0];
    if (path) allowedProjectPaths.add(path);
    return desktopResponseSchema.parse({ type: "project-chosen", path });
  }
  if (request.type === "get-home-directory") {
    const path = homedir();
    allowedProjectPaths.add(path);
    return desktopResponseSchema.parse({ type: "home-directory", path });
  }
  if (request.type === "choose-attachments")
    return desktopResponseSchema.parse({
      type: "attachments-chosen",
      attachments: owner ? await chooseAttachments(owner) : [],
    });
  if (request.type === "suggest-files") {
    if (!allowedProjectPaths.has(request.workspacePath))
      throw new Error("Project path was not selected by the user");
    return desktopResponseSchema.parse({
      type: "file-suggestions",
      suggestions: await suggestProjectFiles({
        cwd: request.workspacePath,
        prefix: request.prefix,
        agentDir: cakePaths.piAgent,
      }),
    });
  }
  if (request.type === "read-workspace-file") {
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
    return desktopResponseSchema.parse({ type: "workspace-file", content });
  }
  if (request.type === "compile-inline-widget") {
    const compiled = await compileInlineWidget(
      request.language,
      request.source,
      request.capability,
    );
    return desktopResponseSchema.parse({
      type: "inline-widget-compiled",
      widget: publishInlineWidget(compiled),
    });
  }
  if (request.type === "load-window-state")
    return desktopResponseSchema.parse({
      type: "window-state-loaded",
      state: await loadWindowState(),
    });
  if (request.type === "save-window-state") {
    await saveWindowState(request.state);
    void vscodeEditor.updateTheme();
    return desktopResponseSchema.parse({ type: "window-state-saved" });
  }
  if (request.type === "load-application-state")
    return desktopResponseSchema.parse({
      type: "application-state-loaded",
      state: applicationModel.snapshot(),
    });
  if (request.type === "set-utility-model") {
    applicationModel.setUtilityModel(request.model);
    await persistApplicationState();
    return desktopResponseSchema.parse({
      type: "application-state-updated",
      state: applicationModel.snapshot(),
    });
  }
  if (request.type === "set-model-presets") {
    applicationModel.setModelPresets(request.presets, request.defaultPresetId);
    await persistApplicationState();
    return desktopResponseSchema.parse({
      type: "application-state-updated",
      state: applicationModel.snapshot(),
    });
  }
  if (request.type === "list-cake-chat-sessions") {
    const resolvedSessionIds = new Set(applicationModel.resolvedCakeChatSessionIds);
    const sessions = (
      await listWorkspaceSessions(homedir(), cakePaths.piGlobalChatSessions, {
        resolvedSessionDir: cakePaths.piGlobalChatResolvedSessions,
        direct: true,
      })
    )
      .map((session) => ({ ...session, resolved: resolvedSessionIds.has(session.id) }))
      .sort((left, right) => right.modified.localeCompare(left.modified));
    return desktopResponseSchema.parse({ type: "cake-chat-sessions-listed", sessions });
  }
  if (request.type === "list-sessions") {
    const resolvedSessionIds = new Set(applicationModel.resolvedSessionIds);
    const projectSessions = (
      await Promise.all(
        applicationModel.projects.map(async (project) => {
          try {
            return (
              await listWorkspaceSessions(project.path, cakePaths.piSessions, {
                resolvedSessionDir: cakePaths.piResolvedSessions,
              })
            ).map((session) => {
              rememberSessionLocation(project.path, session.id);
              return {
                ...session,
                resolved: resolvedSessionIds.has(session.id),
                workspacePath: project.path,
                workspaceName: project.name,
              };
            });
          } catch {
            return [];
          }
        }),
      )
    ).flat();
    const worktreeSessions = (
      await Promise.all(
        (await worktrees.records()).map(async (record) => {
          const project = applicationModel.projects.find(
            (entry) => entry.path === record.projectPath,
          );
          if (!project || !allowedProjectPaths.has(record.worktreePath)) return [];
          try {
            return (
              await listWorkspaceSessions(record.worktreePath, cakePaths.piSessions, {
                resolvedSessionDir: cakePaths.piResolvedSessions,
              })
            ).map((session) => {
              rememberSessionLocation(record.worktreePath, session.id);
              return {
                ...session,
                resolved: resolvedSessionIds.has(session.id),
                workspacePath: record.worktreePath,
                projectPath: project.path,
                managedWorktree: record,
                workspaceName: project.name,
              };
            });
          } catch {
            return [];
          }
        }),
      )
    ).flat();
    const sessions = [...projectSessions, ...worktreeSessions].sort((left, right) =>
      right.modified.localeCompare(left.modified),
    );
    const reviewThreads = (
      await Promise.all(
        sessions.map((session) => reviewRepository.listSession(session.workspacePath, session.id)),
      )
    ).flat();
    return desktopResponseSchema.parse({ type: "sessions-listed", sessions, reviewThreads });
  }
  if (request.type === "fork-session-to-worktree") {
    const sourceFile = await findSessionFile(
      request.workspacePath,
      request.sessionId,
      cakePaths.piSessions,
    );
    if (!sourceFile) throw new Error("Cake could not find the session to fork");
    const record = (await worktrees.records()).find(
      (entry) =>
        (entry.state ?? "active") === "active" &&
        resolve(entry.worktreePath) === resolve(request.workspacePath),
    );
    const branchOff = record
      ? await worktrees.createBranchOff(request.workspacePath, request.worktreeName)
      : await worktrees.create(request.workspacePath, undefined, request.worktreeName);
    allowedProjectPaths.add(branchOff.worktreePath);
    if (applicationModel.isProjectTrusted(branchOff.projectPath))
      applicationModel.trustProject(branchOff.worktreePath);
    const forked = forkWorkspaceSession(
      sourceFile,
      branchOff.worktreePath,
      cakeWorkspaceSessionDirectory(branchOff.worktreePath, cakePaths.piSessions),
    );
    rememberSessionLocation(branchOff.worktreePath, forked.sessionId);
    if (request.resolveSource)
      await setProjectSessionResolution(request.sessionId, true, request.workspacePath);
    return desktopResponseSchema.parse({
      type: "session-forked-to-worktree",
      requestId: request.requestId,
      sessionId: forked.sessionId,
      workspacePath: branchOff.worktreePath,
    });
  }
  if (request.type === "register-project") {
    if (!allowedProjectPaths.has(request.path))
      throw new Error("Project path was not selected by the user");
    // Managed worktrees belong to their parent project; never register them as projects.
    if ((await worktrees.records()).some((entry) => entry.worktreePath === request.path))
      return desktopResponseSchema.parse({
        type: "application-state-updated",
        state: applicationModel.snapshot(),
      });
    applicationModel.upsertProject(request.path, request.name);
    await persistApplicationState();
    return desktopResponseSchema.parse({
      type: "application-state-updated",
      state: applicationModel.snapshot(),
    });
  }
  if (request.type === "rename-project") {
    if (!allowedProjectPaths.has(request.path))
      throw new Error("Project path was not selected by the user");
    applicationModel.projects
      .find((project) => project.path === request.path)
      ?.rename(request.name);
    await persistApplicationState();
    return desktopResponseSchema.parse({
      type: "application-state-updated",
      state: applicationModel.snapshot(),
    });
  }
  if (request.type === "remove-project") {
    if (!allowedProjectPaths.has(request.path))
      throw new Error("Project path was not selected by the user");
    applicationModel.removeProject(request.path);
    allowedProjectPaths.delete(request.path);
    for (const [sessionId, workspacePath] of sessionWorkspacePaths)
      if (workspacePath === request.path) sessionWorkspacePaths.delete(sessionId);
    const host = piHosts.get(request.path);
    if (host) {
      piHosts.delete(request.path);
      host.driver[Symbol.dispose]();
      setPiState(host, "stopped");
    }
    for (const [webContentsId, workspacePath] of windowWorkspaces)
      if (workspacePath === request.path) windowWorkspaces.delete(webContentsId);
    await persistApplicationState();
    return desktopResponseSchema.parse({
      type: "application-state-updated",
      state: applicationModel.snapshot(),
    });
  }
  if (request.type === "resolve-session") {
    await setProjectSessionResolution(request.sessionId, request.resolved);
    return desktopResponseSchema.parse({
      type: "application-state-updated",
      state: applicationModel.snapshot(),
    });
  }
  if (request.type === "resolve-sessions") {
    const outcomes = await Promise.allSettled(
      request.sessionIds.map((sessionId) =>
        setProjectSessionResolution(sessionId, request.resolved),
      ),
    );
    const failures = outcomes.filter((outcome) => outcome.status === "rejected");
    if (failures.length > 0) {
      const firstReason = failures[0]!.reason;
      const cause = firstReason instanceof Error ? firstReason.message : String(firstReason);
      throw new Error(
        `Cake could not update ${failures.length} of ${request.sessionIds.length} sessions: ${cause}`,
      );
    }
    return desktopResponseSchema.parse({
      type: "application-state-updated",
      state: applicationModel.snapshot(),
    });
  }
  if (request.type === "resolve-cake-chat-session") {
    await setCakeChatSessionResolution(request.sessionId, request.resolved);
    return desktopResponseSchema.parse({
      type: "application-state-updated",
      state: applicationModel.snapshot(),
    });
  }
  if (request.type === "restart-pi") {
    if (!allowedProjectPaths.has(request.path))
      throw new Error("Project path was not selected by the user");
    const old = piHosts.get(request.path);
    if (old) {
      piHosts.delete(request.path);
      old.driver[Symbol.dispose]();
      setPiState(old, "stopped");
    }
    launchPi(request.path);
    return desktopResponseSchema.parse({ type: "accepted", requestId: crypto.randomUUID() });
  }
  if (request.type === "respond-workspace-trust") {
    if (!allowedProjectPaths.has(request.path))
      throw new Error("Project path was not selected by the user");
    const key = `${event.sender.id}:${request.requestId}`;
    if (pendingTrustRequests.get(key) !== request.path)
      throw new Error("Workspace trust request is no longer pending");
    pendingTrustRequests.delete(key);
    if (request.approved) {
      applicationModel.trustProject(request.path);
      await persistApplicationState();
    }
    return desktopResponseSchema.parse({ type: "accepted", requestId: request.requestId });
  }
  if (request.type === "create-worktree") {
    if (!allowedProjectPaths.has(request.path))
      throw new Error("Project path was not selected by the user");
    const record = await worktrees.create(
      request.path,
      request.baseWorktreePath,
      request.worktreeName,
    );
    allowedProjectPaths.add(record.worktreePath);
    if (applicationModel.isProjectTrusted(record.projectPath))
      applicationModel.trustProject(record.worktreePath);
    return desktopResponseSchema.parse({
      type: "worktree-created",
      requestId: request.requestId,
      record,
    });
  }
  if (request.type === "get-worktree-status") {
    return desktopResponseSchema.parse({
      type: "worktree-status-loaded",
      status: await worktrees.status(request.workspacePath),
    });
  }
  if (request.type === "land-worktree") {
    await requireWorktreeRecord(request.workspacePath);
    const result = await worktrees.land(request.workspacePath, { request: request.request });
    return desktopResponseSchema.parse({
      type: "worktree-landed",
      requestId: request.requestId,
      result,
    });
  }
  if (request.type === "discard-worktree") {
    await requireWorktreeRecord(request.workspacePath);
    await worktrees.discard(request.workspacePath, request.keepBranch);
    return desktopResponseSchema.parse({ type: "accepted", requestId: request.requestId });
  }
  if (request.type === "steer-subagent" || request.type === "abort-subagent") {
    const path = await resolveSessionWorkspacePath(request.parentSessionId);
    if (!allowedProjectPaths.has(path))
      throw new Error("Project path was not selected by the user");
    const driver = launchPi(path).driver;
    if (request.type === "steer-subagent")
      driver.steerSubagent(request.handleId, request.parentSessionId, request.text);
    else await driver.abortSubagent(request.handleId, request.parentSessionId);
    return desktopResponseSchema.parse({ type: "accepted", requestId: request.requestId });
  }
  // Model refresh is an app-global operation: it reaches every live runtime —
  // project sessions in any open workspace and Cake Chat — plus the shared
  // session-less catalog, not just the session whose settings page triggered it.
  if (request.type === "refresh-models") {
    void refreshModelsEverywhere(request.requestId);
    return desktopResponseSchema.parse({ type: "accepted", requestId: request.requestId });
  }
  // The model catalog lives in the shared agent directory, not in any session,
  // so unsent chats can list it without resolving a session workspace path.
  if (request.type === "list-models") {
    return desktopResponseSchema.parse({
      type: "models-listed",
      requestId: request.requestId,
      models: await listAgentCatalogModels(cakePaths.piAgent),
    });
  }
  const path =
    request.type === "open-workspace" || request.type === "inspect-workspace"
      ? request.path
      : request.type === "prompt" && request.newSession
        ? request.newSession.path
        : await resolveSessionWorkspacePath(request.sessionId);
  if (!allowedProjectPaths.has(path)) throw new Error("Project path was not selected by the user");
  if (request.type === "repair-inline-widget") {
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
    return desktopResponseSchema.parse({
      type: "inline-widget-repaired",
      widget: {
        source: extractRepairedWidget(repaired.response, request.language),
        repairSessionId: repaired.sessionId,
      },
    });
  }
  if (request.type === "inspect-workspace") {
    const inspection = inspectWorkspace(path);
    const trustRequired = inspection.trustRequired && !applicationModel.isProjectTrusted(path);
    const key = `${event.sender.id}:${request.requestId}`;
    clearPendingTrustRequests(event.sender.id);
    if (trustRequired) pendingTrustRequests.set(key, path);
    sendTo(event.sender, {
      type: "workspace-inspected",
      requestId: request.requestId,
      path,
      trustRequired,
    });
    return desktopResponseSchema.parse({ type: "accepted", requestId: request.requestId });
  }
  if (request.type === "load-session") {
    return desktopResponseSchema.parse({
      type: "session-loaded",
      session: await loadWorkspaceSessionPreview(
        path,
        request.sessionId,
        cakePaths.piSessions,
        cakePaths.piResolvedSessions,
      ),
    });
  }
  if (request.type === "list-review-threads") {
    return desktopResponseSchema.parse({
      type: "review-threads-loaded",
      threads: await reviewRepository.listSession(path, request.sessionId),
    });
  }
  if (request.type === "create-review-thread") {
    const thread = await reviewRepository.create(
      path,
      request.sessionId,
      request.anchor,
      request.body,
    );
    broadcast({ type: "review-thread-updated", thread });
    return desktopResponseSchema.parse({ type: "review-thread-saved", thread });
  }
  if (request.type === "reply-review-thread") {
    const thread = await reviewRepository.reply(
      path,
      request.sessionId,
      request.threadId,
      request.body,
    );
    broadcast({ type: "review-thread-updated", thread });
    return desktopResponseSchema.parse({ type: "review-thread-saved", thread });
  }
  if (request.type === "resolve-review-thread") {
    const thread = await reviewRepository.resolve(
      path,
      request.sessionId,
      request.threadId,
      request.resolved,
    );
    broadcast({ type: "review-thread-updated", thread });
    return desktopResponseSchema.parse({ type: "review-thread-saved", thread });
  }
  if (request.type === "open-workspace" || (request.type === "prompt" && request.newSession)) {
    if (inspectWorkspace(path).trustRequired && !applicationModel.isProjectTrusted(path)) {
      throw new Error("Project-local executable resources have not been trusted by the user");
    }
  }
  if (request.type === "open-workspace") {
    clearPendingTrustRequests(event.sender.id);
    windowWorkspaces.set(event.sender.id, path);
    if (request.sessionId) await restoreProjectSessionForUse(path, request.sessionId);
  }
  if (request.type === "respond-ui") {
    dispatchToPi(path, request);
    return desktopResponseSchema.parse({
      type: "ui-response-accepted",
      uiRequestId: request.uiRequestId,
    });
  }
  if (request.type === "respond-artifact") {
    dispatchToPi(path, request);
    return desktopResponseSchema.parse({
      type: "artifact-response-accepted",
      artifactRequestId: request.artifactRequestId,
    });
  }
  if (request.type === "export-artifacts") {
    return desktopResponseSchema.parse({
      type: "artifacts-exported",
      markdown: await artifactRepository.exportMarkdown(path, request.sessionId),
    });
  }
  if (request.type === "prompt") await restoreProjectSessionForUse(path, request.sessionId);
  dispatchToPi(path, request);
  return desktopResponseSchema.parse({ type: "accepted", requestId: request.requestId });
}

app.whenReady().then(async () => {
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
  await loadApplicationState();
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", () => {
  applicationQuitting = true;
  applicationModel[Symbol.dispose]();
  globalChatDriver[Symbol.dispose]();
  pluginBackends[Symbol.dispose]();
  vscodeEditor.disposeAll();
  for (const host of piHosts.values()) host.driver[Symbol.dispose]();
  piHosts.clear();
  if (process.env.CAKE_ELECTRON_SMOKE === "1") setImmediate(() => app.exit(0));
});

if (process.env.CAKE_ELECTRON_SMOKE === "1") {
  Object.assign(globalThis, {
    cakeSmokeResetPi() {
      const host = [...piHosts.values()][0];
      if (!host) throw new Error("Pi runtime is unavailable");
      piHosts.delete(host.path);
      host.driver[Symbol.dispose]();
      setPiState(host, "stopped");
    },
  });
}
