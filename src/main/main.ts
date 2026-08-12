import { readFile, rename, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { homedir } from "node:os";
import { app, BrowserWindow, dialog, ipcMain, shell, type WebContents } from "electron";
import { desktopRequestSchema, desktopResponseSchema, type DesktopEvent } from "../ipc/desktop-ipc";
import { windowViewStateSchema, type Attachment, type WindowViewState } from "../ipc/session-contract";
import { inspectWorkspace, listWorkspaceSessions, loadReviewSessionMessages, loadWorkspaceSessionPreview, migrateLegacyReviewSession, suggestProjectFiles } from "../agent/pi-runtime";
import { ApplicationModel } from "./application-model";
import { shouldAllowNavigation } from "./navigation-policy";
import { PiWorkspaceDriver, type PiWorkspaceCommand } from "./pi-workspace-driver";
import { ArtifactRepository } from "./artifact-repository";
import { ReviewRepository } from "./review-repository";

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
const allowedProjectPaths = new Set<string>();
const pendingTrustRequests = new Map<string, string>();
let nextWindowSlot = 0;
let applicationModel = ApplicationModel.from({});

function clearPendingTrustRequests(webContentsId: number) {
  for (const key of pendingTrustRequests.keys()) if (key.startsWith(`${webContentsId}:`)) pendingTrustRequests.delete(key);
}

if (process.env.CAKE_ELECTRON_USER_DATA) app.setPath("userData", process.env.CAKE_ELECTRON_USER_DATA);
const artifactRepository = new ArtifactRepository(join(app.getPath("userData"), "artifacts"));
const reviewRepository = new ReviewRepository(join(app.getPath("userData"), "reviews"), loadReviewSessionMessages, migrateLegacyReviewSession);

function sendTo(target: WebContents, event: DesktopEvent) {
  if (!target.isDestroyed()) target.send("cake:event", event);
}

function broadcast(event: DesktopEvent) {
  for (const window of windows.values()) sendTo(window.webContents, event);
}

function appStatePath() {
  return join(app.getPath("userData"), "application.json");
}

async function loadApplicationState() {
  try {
    applicationModel = ApplicationModel.from(JSON.parse(await readFile(appStatePath(), "utf8")));
  } catch {
    applicationModel = ApplicationModel.from({});
  }
  for (const project of applicationModel.projects) allowedProjectPaths.add(project.path);
}

async function persistApplicationState() {
  const target = appStatePath();
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(applicationModel.snapshot(), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}

function statePath(slot: number) {
  return join(app.getPath("userData"), slot === 0 ? "window-state.json" : `window-state-${slot}.json`);
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
  const target = statePath(slot);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}

function setPiState(host: PiHost, state: PiHost["state"]) {
  host.state = state;
  broadcast({ type: "pi-state", state, workspacePath: host.path });
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
    emit: broadcast,
    artifactRepository,
    reviewRepository,
    isTrusted: () => applicationModel.isProjectTrusted(path),
    openExternal: async (url) => {
      const protocol = new URL(url).protocol;
      if (protocol !== "https:" && protocol !== "http:") throw new Error("Authentication URL must use HTTP or HTTPS");
      await shell.openExternal(url);
    }
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
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    ...(process.platform === "darwin" ? { trafficLightPosition: { x: 18, y: 18 } } : {}),
    backgroundColor: "#111315",
    webPreferences: { preload: join(import.meta.dirname, "../preload/preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  const webContentsId = window.webContents.id;
  windows.set(window.id, window);
  windowSlots.set(webContentsId, slot);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    // Vite sometimes falls back from a module update to a full-page reload. Blocking
    // that same-origin reload after Chromium has cleared the document leaves a blank
    // window, so keep dev-server navigation available while rejecting external URLs.
    if (!shouldAllowNavigation(window.webContents.getURL(), url, process.env.ELECTRON_RENDERER_URL)) event.preventDefault();
  });
  window.webContents.on("did-finish-load", () => sendTo(window.webContents, { type: "pi-state", state: "ready" }));
  window.on("closed", () => {
    const path = windowWorkspaces.get(webContentsId);
    windows.delete(window.id);
    windowSlots.delete(webContentsId);
    windowWorkspaces.delete(webContentsId);
    clearPendingTrustRequests(webContentsId);
    if (path) piHosts.get(path)?.driver.cancelPendingRequests();
    if (path) scheduleIdle(path);
  });
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  return window;
}

const imageMimeTypes: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

async function chooseAttachments(window: BrowserWindow): Promise<Attachment[]> {
  const result = await dialog.showOpenDialog(window, { properties: ["openFile", "multiSelections"] });
  if (result.canceled) return [];
  return Promise.all(result.filePaths.slice(0, 20).map(async (path): Promise<Attachment> => {
    const mimeType = imageMimeTypes[extname(path).toLowerCase()];
    return mimeType ? { kind: "image", name: basename(path), mimeType, data: (await readFile(path)).toString("base64") } : { kind: "file", name: basename(path), path };
  }));
}

ipcMain.handle("cake:request", async (event, input: unknown) => {
  const request = desktopRequestSchema.parse(input);
  const owner = BrowserWindow.fromWebContents(event.sender);
  const slot = windowSlots.get(event.sender.id) ?? 0;
  if (request.type === "choose-project") {
    if (!owner) return desktopResponseSchema.parse({ type: "project-chosen" });
    const result = await dialog.showOpenDialog(owner, { properties: ["openDirectory"] });
    const path = result.canceled ? undefined : result.filePaths[0];
    if (path) allowedProjectPaths.add(path);
    return desktopResponseSchema.parse({ type: "project-chosen", path });
  }
  if (request.type === "get-home-directory") {
    const path = homedir(); allowedProjectPaths.add(path);
    return desktopResponseSchema.parse({ type: "home-directory", path });
  }
  if (request.type === "choose-attachments") return desktopResponseSchema.parse({ type: "attachments-chosen", attachments: owner ? await chooseAttachments(owner) : [] });
  if (request.type === "suggest-files") {
    if (!allowedProjectPaths.has(request.workspacePath)) throw new Error("Project path was not selected by the user");
    return desktopResponseSchema.parse({ type: "file-suggestions", suggestions: await suggestProjectFiles(request.workspacePath, request.prefix) });
  }
  if (request.type === "load-window-state") return desktopResponseSchema.parse({ type: "window-state-loaded", state: await loadWindowState(slot) });
  if (request.type === "save-window-state") {
    await saveWindowState(slot, request.state);
    return desktopResponseSchema.parse({ type: "window-state-saved" });
  }
  if (request.type === "load-application-state") return desktopResponseSchema.parse({ type: "application-state-loaded", state: applicationModel.snapshot() });
  if (request.type === "list-sessions") {
    const sessions = (await Promise.all(applicationModel.projects.map(async (project) => {
      try {
        return (await listWorkspaceSessions(project.path)).map((session) => ({ ...session, workspacePath: project.path, workspaceName: project.name }));
      } catch {
        return [];
      }
    }))).flat().sort((left, right) => right.modified.localeCompare(left.modified));
    const reviewThreads = (await Promise.all(sessions.map((session) => reviewRepository.listSession(session.workspacePath, session.id)))).flat();
    return desktopResponseSchema.parse({ type: "sessions-listed", sessions, reviewThreads });
  }
  if (request.type === "register-project") {
    if (!allowedProjectPaths.has(request.path)) throw new Error("Project path was not selected by the user");
    applicationModel.upsertProject(request.path, request.name);
    await persistApplicationState();
    return desktopResponseSchema.parse({ type: "application-state-updated", state: applicationModel.snapshot() });
  }
  if (request.type === "rename-project") {
    if (!allowedProjectPaths.has(request.path)) throw new Error("Project path was not selected by the user");
    applicationModel.projects.find((project) => project.path === request.path)?.rename(request.name);
    await persistApplicationState();
    return desktopResponseSchema.parse({ type: "application-state-updated", state: applicationModel.snapshot() });
  }
  if (request.type === "remove-project") {
    if (!allowedProjectPaths.has(request.path)) throw new Error("Project path was not selected by the user");
    applicationModel.removeProject(request.path);
    allowedProjectPaths.delete(request.path);
    const host = piHosts.get(request.path);
    if (host) {
      piHosts.delete(request.path);
      host.driver[Symbol.dispose]();
      setPiState(host, "stopped");
    }
    for (const [webContentsId, workspacePath] of windowWorkspaces) if (workspacePath === request.path) windowWorkspaces.delete(webContentsId);
    await persistApplicationState();
    return desktopResponseSchema.parse({ type: "application-state-updated", state: applicationModel.snapshot() });
  }
  if (request.type === "archive-session") {
    if (!allowedProjectPaths.has(request.path)) throw new Error("Project path was not selected by the user");
    applicationModel.projects.find((project) => project.path === request.path)?.setSessionArchived(request.sessionId, request.archived);
    await persistApplicationState();
    return desktopResponseSchema.parse({ type: "application-state-updated", state: applicationModel.snapshot() });
  }
  if (request.type === "new-window") {
    createWindow();
    return desktopResponseSchema.parse({ type: "window-created" });
  }
  if (request.type === "restart-pi") {
    if (!allowedProjectPaths.has(request.path)) throw new Error("Project path was not selected by the user");
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
    if (!allowedProjectPaths.has(request.path)) throw new Error("Project path was not selected by the user");
    const key = `${event.sender.id}:${request.requestId}`;
    if (pendingTrustRequests.get(key) !== request.path) throw new Error("Workspace trust request is no longer pending");
    pendingTrustRequests.delete(key);
    if (request.approved) {
      applicationModel.trustProject(request.path);
      await persistApplicationState();
    }
    return desktopResponseSchema.parse({ type: "accepted", requestId: request.requestId });
  }
  const path = request.type === "open-workspace" || request.type === "inspect-workspace" ? request.path : request.workspacePath;
  if (!allowedProjectPaths.has(path)) throw new Error("Project path was not selected by the user");
  if (request.type === "inspect-workspace") {
    const inspection = inspectWorkspace(path);
    const trustRequired = inspection.trustRequired && !applicationModel.isProjectTrusted(path);
    const key = `${event.sender.id}:${request.requestId}`;
    clearPendingTrustRequests(event.sender.id);
    if (trustRequired) pendingTrustRequests.set(key, path);
    sendTo(event.sender, { type: "workspace-inspected", requestId: request.requestId, path, trustRequired });
    return desktopResponseSchema.parse({ type: "accepted", requestId: request.requestId });
  }
  if (request.type === "load-session") {
    return desktopResponseSchema.parse({ type: "session-loaded", session: await loadWorkspaceSessionPreview(request.workspacePath, request.sessionId) });
  }
  if (request.type === "list-review-threads") {
    return desktopResponseSchema.parse({ type: "review-threads-loaded", threads: await reviewRepository.listSession(request.workspacePath, request.sessionId) });
  }
  if (request.type === "create-review-thread") {
    const thread = await reviewRepository.create(request.workspacePath, request.sessionId, request.anchor, request.body);
    broadcast({ type: "review-thread-updated", thread });
    return desktopResponseSchema.parse({ type: "review-thread-saved", thread });
  }
  if (request.type === "reply-review-thread") {
    const thread = await reviewRepository.reply(request.workspacePath, request.sessionId, request.threadId, request.body);
    broadcast({ type: "review-thread-updated", thread });
    return desktopResponseSchema.parse({ type: "review-thread-saved", thread });
  }
  if (request.type === "resolve-review-thread") {
    const thread = await reviewRepository.resolve(request.workspacePath, request.sessionId, request.threadId, request.resolved);
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
    return desktopResponseSchema.parse({ type: "ui-response-accepted", uiRequestId: request.uiRequestId });
  }
  if (request.type === "respond-artifact") {
    dispatchToPi(path, request);
    return desktopResponseSchema.parse({ type: "artifact-response-accepted", artifactRequestId: request.artifactRequestId });
  }
  if (request.type === "export-artifacts") {
    return desktopResponseSchema.parse({ type: "artifacts-exported", markdown: await artifactRepository.exportMarkdown(request.workspacePath, request.sessionId) });
  }
  dispatchToPi(path, request satisfies PiWorkspaceCommand);
  return desktopResponseSchema.parse({ type: "accepted", requestId: request.requestId });
});

app.whenReady().then(async () => {
  await loadApplicationState();
  createWindow();
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => {
  for (const host of piHosts.values()) host.driver[Symbol.dispose]();
  piHosts.clear();
  if (process.env.CAKE_ELECTRON_SMOKE === "1") setImmediate(() => app.exit(0));
});

if (process.env.CAKE_ELECTRON_SMOKE === "1") {
  Object.assign(globalThis, {
    cakeSmokeResetPi() {
      const host = piHosts.values().next().value as PiHost | undefined;
      if (!host) throw new Error("Pi runtime is unavailable");
      piHosts.delete(host.path);
      host.driver[Symbol.dispose]();
      setPiState(host, "stopped");
    }
  });
}
