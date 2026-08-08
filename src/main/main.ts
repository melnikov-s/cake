import { readFile, rename, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { homedir } from "node:os";
import { app, BrowserWindow, dialog, ipcMain, type WebContents } from "electron";
import { desktopRequestSchema, desktopResponseSchema, type DesktopEvent } from "../ipc/desktop-ipc";
import { windowViewStateSchema, type Attachment, type WindowViewState } from "../ipc/session-contract";
import { listWorkspaceSessions, loadWorkspaceSessionPreview } from "../agent/pi-runtime";
import { ApplicationModel } from "./application-model";
import { shouldAllowNavigation } from "./navigation-policy";
import { PiWorkspaceDriver, type PiWorkspaceCommand } from "./pi-workspace-driver";

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
let nextWindowSlot = 0;
let applicationModel = ApplicationModel.from({});

if (process.env.CAKE_ELECTRON_USER_DATA) app.setPath("userData", process.env.CAKE_ELECTRON_USER_DATA);

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
    const state = windowViewStateSchema.parse(JSON.parse(await readFile(statePath(slot), "utf8")));
    if (state.projectPath) allowedProjectPaths.add(state.projectPath);
    for (const path of state.recentProjectPaths) allowedProjectPaths.add(path);
    return state;
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
  const driver = new PiWorkspaceDriver({ workspacePath: path, emit: broadcast });
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
    backgroundColor: "#f5f0e8",
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
    return desktopResponseSchema.parse({ type: "sessions-listed", sessions });
  }
  if (request.type === "register-project") {
    allowedProjectPaths.add(request.path);
    applicationModel.upsertProject(request.path, request.name);
    await persistApplicationState();
    return desktopResponseSchema.parse({ type: "application-state-updated", state: applicationModel.snapshot() });
  }
  if (request.type === "rename-project") {
    applicationModel.projects.find((project) => project.path === request.path)?.rename(request.name);
    await persistApplicationState();
    return desktopResponseSchema.parse({ type: "application-state-updated", state: applicationModel.snapshot() });
  }
  if (request.type === "remove-project") {
    applicationModel.removeProject(request.path);
    allowedProjectPaths.delete(request.path);
    await persistApplicationState();
    return desktopResponseSchema.parse({ type: "application-state-updated", state: applicationModel.snapshot() });
  }
  if (request.type === "archive-session") {
    applicationModel.projects.find((project) => project.path === request.path)?.setSessionArchived(request.sessionId, request.archived);
    await persistApplicationState();
    return desktopResponseSchema.parse({ type: "application-state-updated", state: applicationModel.snapshot() });
  }
  if (request.type === "new-window") {
    createWindow();
    return desktopResponseSchema.parse({ type: "window-created" });
  }
  if (request.type === "restart-pi") {
    const old = piHosts.get(request.path);
    if (old) {
      piHosts.delete(request.path);
      old.driver[Symbol.dispose]();
      setPiState(old, "stopped");
    }
    launchPi(request.path);
    return desktopResponseSchema.parse({ type: "accepted", requestId: crypto.randomUUID() });
  }
  const path = request.type === "open-workspace" || request.type === "inspect-workspace" ? request.path : request.workspacePath;
  if (!allowedProjectPaths.has(path)) throw new Error("Project path was not selected by the user");
  if (request.type === "load-session") {
    return desktopResponseSchema.parse({ type: "session-loaded", session: await loadWorkspaceSessionPreview(request.workspacePath, request.sessionId) });
  }
  if (request.type === "open-workspace") {
    const previous = windowWorkspaces.get(event.sender.id);
    windowWorkspaces.set(event.sender.id, path);
    if (previous && previous !== path) scheduleIdle(previous);
  }
  if (request.type === "respond-ui") {
    dispatchToPi(path, request);
    return desktopResponseSchema.parse({ type: "ui-response-accepted", uiRequestId: request.uiRequestId });
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
