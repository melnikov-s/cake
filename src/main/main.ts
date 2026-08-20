import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { app, BrowserWindow, dialog, ipcMain, shell, type WebContents } from "electron";
import { desktopRequestSchema, desktopResponseSchema, type DesktopEvent } from "../ipc/desktop-ipc";
import {
  windowViewStateSchema,
  type Attachment,
  type WindowViewState,
} from "../ipc/session-contract";
import {
  inspectWorkspace,
  listWorkspaceSessions,
  loadWorkspaceSessionPreview,
  suggestProjectFiles,
} from "../agent/session-discovery";
import { loadReviewSessionProjection, runInlineWidgetRepair } from "../agent/sidecar-runtime";
import { Application } from "../models/Application";
import { shouldAllowNavigation } from "./navigation-policy";
import { PiWorkspaceDriver, type PiWorkspaceCommand } from "./pi-workspace-driver";
import { ArtifactRepository } from "./artifact-repository";
import { ReviewRepository } from "./review-repository";
import { AtomicFileWriter } from "./atomic-file-writer";
import { GlobalChatDriver } from "./global-chat-driver";
import { resolveCakePaths } from "./cake-paths";
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

app.setName("Cake");
registerInlineWidgetScheme();

interface PiHost {
  path: string;
  driver: PiWorkspaceDriver;
  state: "starting" | "ready" | "stopped" | "failed";
  idleTimer?: ReturnType<typeof setTimeout>;
}

const windows = new Map<number, BrowserWindow>();
const windowSlots = new Map<number, number>();
const windowWorkspaces = new Map<number, string>();
const piHosts = new Map<string, PiHost>();
const sessionWorkspacePaths = new Map<string, string>();
const allowedProjectPaths = new Set<string>();
const pendingTrustRequests = new Map<string, string>();
const windowCustomizationRevisions = new Map<number, string>();
const customizationHealthTimers = new Map<number, ReturnType<typeof setTimeout>>();
let nextWindowSlot = 0;
let applicationModel = Application.from({});
const stateFileWriter = new AtomicFileWriter();

function clearPendingTrustRequests(webContentsId: number) {
  for (const key of pendingTrustRequests.keys())
    if (key.startsWith(`${webContentsId}:`)) pendingTrustRequests.delete(key);
}

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
const reviewRepository = new ReviewRepository(
  join(app.getPath("userData"), "reviews"),
  cakePaths.piReviewSessions,
  (record) => loadReviewSessionProjection(record, cakePaths.piReviewSessions),
);
let globalChatController: WebContents | undefined;
const globalChatDriver = new GlobalChatDriver({
  agentDir: cakePaths.piAgent,
  sessionDir: cakePaths.piGlobalChatSessions,
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

function rememberSessionLocation(workspacePath: string, sessionId: string) {
  const existing = sessionWorkspacePaths.get(sessionId);
  if (existing && existing !== workspacePath)
    throw new Error(`Session ID collision detected: ${sessionId}`);
  sessionWorkspacePaths.set(sessionId, workspacePath);
}

async function resolveSessionWorkspacePath(sessionId: string) {
  const cached = sessionWorkspacePaths.get(sessionId);
  if (cached && allowedProjectPaths.has(cached)) return cached;
  const matches = (
    await Promise.all(
      applicationModel.projects.map(async (project) => {
        if (!allowedProjectPaths.has(project.path)) return undefined;
        try {
          const sessions = await listWorkspaceSessions(project.path, cakePaths.piSessions);
          return sessions.some((session) => session.id === sessionId) ? project.path : undefined;
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

function appStatePath() {
  return join(app.getPath("userData"), "application.json");
}

async function loadApplicationState() {
  try {
    applicationModel = Application.from(JSON.parse(await readFile(appStatePath(), "utf8")));
  } catch {
    applicationModel = Application.from({});
  }
  for (const project of applicationModel.projects) allowedProjectPaths.add(project.path);
}

async function persistApplicationState() {
  await stateFileWriter.write(
    appStatePath(),
    `${JSON.stringify(applicationModel.snapshot(), null, 2)}\n`,
  );
}

function statePath(slot: number) {
  return join(
    app.getPath("userData"),
    slot === 0 ? "window-state.json" : `window-state-${slot}.json`,
  );
}

async function loadWindowState(slot: number): Promise<WindowViewState> {
  try {
    return windowViewStateSchema.parse(JSON.parse(await readFile(statePath(slot), "utf8")));
  } catch {
    return windowViewStateSchema.parse({});
  }
}

async function saveWindowState(slot: number, state: WindowViewState) {
  const parsed = windowViewStateSchema.parse(state);
  await stateFileWriter.write(statePath(slot), `${JSON.stringify(parsed, null, 2)}\n`);
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

function launchPi(path: string) {
  const existing = piHosts.get(path);
  if (existing && existing.state !== "failed" && existing.state !== "stopped") return existing;
  if (existing) {
    if (existing.idleTimer) clearTimeout(existing.idleTimer);
    existing.driver[Symbol.dispose]();
    piHosts.delete(path);
  }
  const driver = new PiWorkspaceDriver({
    workspacePath: path,
    agentDir: cakePaths.piAgent,
    sessionDir: cakePaths.piSessions,
    widgetSessionDir: cakePaths.piWidgetSessions,
    pluginAgentSessionDir: cakePaths.piPluginAgentSessions,
    emit: broadcast,
    artifactRepository,
    reviewRepository,
    pluginResources: pluginAgentResources,
    isTrusted: () => applicationModel.isProjectTrusted(path),
    utilityModel: () => applicationModel.utilityModel,
    fastMode: (sessionId) => applicationModel.hasSessionFastMode(sessionId),
    setFastMode: async (sessionId, enabled) => {
      applicationModel.setSessionFastMode(sessionId, enabled);
      await persistApplicationState();
    },
    resolveAgentModel: (preference, snapshot) =>
      resolveAgentModel(preference, snapshot, applicationModel.utilityModel),
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
  const host = launchPi(path);
  if (host.idleTimer) clearTimeout(host.idleTimer);
  host.driver.dispatch(command);
}

function scheduleIdle(path: string) {
  const host = piHosts.get(path);
  if (!host || [...windowWorkspaces.values()].includes(path)) return;
  if (host.idleTimer) clearTimeout(host.idleTimer);
  host.idleTimer = setTimeout(() => {
    if ([...windowWorkspaces.values()].includes(path)) return;
    host.driver[Symbol.dispose]();
    piHosts.delete(path);
  }, 5 * 60_000);
}

function createWindow(slot = nextWindowSlot++) {
  const browserWindowOptions = {
    width: 1180,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: "#15191d",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  } as const;
  const window = new BrowserWindow(
    process.platform === "darwin"
      ? { ...browserWindowOptions, trafficLightPosition: { x: 18, y: 18 } }
      : browserWindowOptions,
  );
  const webContentsId = window.webContents.id;
  windows.set(window.id, window);
  windowSlots.set(webContentsId, slot);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
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
  window.on("closed", () => {
    const path = windowWorkspaces.get(webContentsId);
    windows.delete(window.id);
    windowSlots.delete(webContentsId);
    windowWorkspaces.delete(webContentsId);
    clearPendingTrustRequests(webContentsId);
    pluginAgents.disposeOwner(webContentsId);
    windowCustomizationRevisions.delete(webContentsId);
    const healthTimer = customizationHealthTimers.get(webContentsId);
    if (healthTimer) clearTimeout(healthTimer);
    customizationHealthTimers.delete(webContentsId);
    if (path) piHosts.get(path)?.driver.cancelPendingRequests();
    if (path) scheduleIdle(path);
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
const runFile = promisify(execFile);

async function regularWorkspaceFiles(workspace: string, paths: string[]) {
  const files: string[] = [];
  for (let offset = 0; offset < paths.length; offset += 200) {
    const batch = await Promise.all(
      paths.slice(offset, offset + 200).map(async (path) => {
        try {
          const target = resolve(workspace, path);
          const relativePath = relative(workspace, target);
          if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath))
            return undefined;
          return (await lstat(target)).isFile() ? path : undefined;
        } catch {
          return undefined;
        }
      }),
    );
    files.push(...batch.filter((path): path is string => Boolean(path)));
  }
  return files;
}

async function listWorkspaceFiles(workspacePath: string) {
  const workspace = await realpath(workspacePath);
  try {
    const { stdout } = await runFile(
      "git",
      ["-C", workspace, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { encoding: "utf8", timeout: 10_000, maxBuffer: 16_000_000 },
    );
    const paths = stdout
      .split("\0")
      .filter(Boolean)
      .slice(0, 50_000)
      .sort((left, right) => left.localeCompare(right));
    return regularWorkspaceFiles(workspace, paths);
  } catch {
    const files: string[] = [];
    const omitted = new Set([".git", "node_modules", "dist", "out", ".cache"]);
    const visit = async (directory: string, prefix = "") => {
      if (files.length >= 50_000) return;
      const entries = await readdir(directory, { withFileTypes: true });
      await Promise.all(
        entries.map(async (entry) => {
          if (files.length >= 50_000 || entry.isSymbolicLink() || omitted.has(entry.name)) return;
          const path = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) await visit(join(directory, entry.name), path);
          else if (entry.isFile()) files.push(path.split(sep).join("/"));
        }),
      );
    };
    await visit(workspace);
    return files.sort((left, right) => left.localeCompare(right)).slice(0, 50_000);
  }
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
  const request = desktopRequestSchema.parse(untrustedInput);
  const owner = BrowserWindow.fromWebContents(event.sender);
  const slot = windowSlots.get(event.sender.id) ?? 0;
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
    globalChatDriver.open(request.requestId, request.tools, {
      newSession: request.newSession,
      sessionId: request.sessionId,
      initialPrompt: request.initialPrompt,
    });
    return desktopResponseSchema.parse({ type: "accepted", requestId: request.requestId });
  }
  if (request.type === "prompt-global-chat") {
    globalChatController = event.sender;
    globalChatDriver.prompt(
      request.requestId,
      request.sessionId,
      request.text,
      request.attachments,
    );
    return desktopResponseSchema.parse({ type: "accepted", requestId: request.requestId });
  }
  if (request.type === "abort-global-chat") {
    globalChatController = event.sender;
    globalChatDriver.abort(request.requestId, request.sessionId);
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
  if (request.type === "set-global-chat-fast-mode") {
    globalChatController = event.sender;
    globalChatDriver.setFastMode(request.requestId, request.sessionId, request.enabled);
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
  if (request.type === "list-workspace-files") {
    if (!allowedProjectPaths.has(request.workspacePath))
      throw new Error("Project path was not selected by the user");
    return desktopResponseSchema.parse({
      type: "workspace-files",
      files: await listWorkspaceFiles(request.workspacePath),
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
      state: await loadWindowState(slot),
    });
  if (request.type === "save-window-state") {
    await saveWindowState(slot, request.state);
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
  if (request.type === "list-sessions") {
    const resolvedSessionIds = new Set(applicationModel.resolvedSessionIds);
    const sessions = (
      await Promise.all(
        applicationModel.projects.map(async (project) => {
          try {
            return (await listWorkspaceSessions(project.path, cakePaths.piSessions)).map(
              (session) => {
                rememberSessionLocation(project.path, session.id);
                return {
                  ...session,
                  resolved: resolvedSessionIds.has(session.id),
                  workspacePath: project.path,
                  workspaceName: project.name,
                };
              },
            );
          } catch {
            return [];
          }
        }),
      )
    )
      .flat()
      .sort((left, right) => right.modified.localeCompare(left.modified));
    const reviewThreads = (
      await Promise.all(
        sessions.map((session) => reviewRepository.listSession(session.workspacePath, session.id)),
      )
    ).flat();
    return desktopResponseSchema.parse({ type: "sessions-listed", sessions, reviewThreads });
  }
  if (request.type === "register-project") {
    if (!allowedProjectPaths.has(request.path))
      throw new Error("Project path was not selected by the user");
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
    applicationModel.setSessionsResolved([request.sessionId], request.resolved);
    await persistApplicationState();
    return desktopResponseSchema.parse({
      type: "application-state-updated",
      state: applicationModel.snapshot(),
    });
  }
  if (request.type === "resolve-sessions") {
    applicationModel.setSessionsResolved(request.sessionIds, request.resolved);
    await persistApplicationState();
    return desktopResponseSchema.parse({
      type: "application-state-updated",
      state: applicationModel.snapshot(),
    });
  }
  if (request.type === "resolve-cake-chat-session") {
    applicationModel.setCakeChatSessionResolved(request.sessionId, request.resolved);
    await persistApplicationState();
    return desktopResponseSchema.parse({
      type: "application-state-updated",
      state: applicationModel.snapshot(),
    });
  }
  if (request.type === "new-window") {
    createWindow();
    return desktopResponseSchema.parse({ type: "window-created" });
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
  const path =
    request.type === "open-workspace" || request.type === "inspect-workspace"
      ? request.path
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
      session: await loadWorkspaceSessionPreview(path, request.sessionId, cakePaths.piSessions),
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
  if (request.type === "open-workspace") {
    if (inspectWorkspace(path).trustRequired && !applicationModel.isProjectTrusted(path)) {
      throw new Error("Project-local executable resources have not been trusted by the user");
    }
    clearPendingTrustRequests(event.sender.id);
    const previous = windowWorkspaces.get(event.sender.id);
    windowWorkspaces.set(event.sender.id, path);
    if (previous && previous !== path) scheduleIdle(previous);
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
  dispatchToPi(path, request);
  return desktopResponseSchema.parse({ type: "accepted", requestId: request.requestId });
});

app.whenReady().then(async () => {
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
  globalChatDriver[Symbol.dispose]();
  pluginBackends[Symbol.dispose]();
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
