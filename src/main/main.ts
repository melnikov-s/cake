import { readFile, rename, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { homedir } from "node:os";
import { app, BrowserWindow, dialog, ipcMain, utilityProcess, type UtilityProcess, type WebContents } from "electron";
import { agentEventSchema, type AgentCommand } from "../ipc/agent-ipc";
import { desktopRequestSchema, desktopResponseSchema, type DesktopEvent } from "../ipc/desktop-ipc";
import { windowViewStateSchema, type Attachment, type WindowViewState } from "../ipc/session-contract";
import { ApplicationModel } from "./application-model";

interface AgentHost {
  path: string;
  process: UtilityProcess;
  state: "starting" | "ready" | "stopped" | "failed";
  queue: AgentCommand[];
  idleTimer?: ReturnType<typeof setTimeout>;
}

const windows = new Map<number, BrowserWindow>();
const windowSlots = new Map<number, number>();
const windowWorkspaces = new Map<number, string>();
const agents = new Map<string, AgentHost>();
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

function setAgentState(host: AgentHost, state: AgentHost["state"]) {
  host.state = state;
  broadcast({ type: "agent-state", state, workspacePath: host.path });
}

function launchAgent(path: string) {
  const existing = agents.get(path);
  if (existing && existing.state !== "failed" && existing.state !== "stopped") return existing;
  if (existing) {
    if (existing.idleTimer) clearTimeout(existing.idleTimer);
    agents.delete(path);
  }
  const process = utilityProcess.fork(join(import.meta.dirname, "agent.js"), [], { env: { ...globalThis.process.env, CAKE_WORKSPACE_PATH: path } });
  const host: AgentHost = { path, process, state: "starting", queue: [] };
  agents.set(path, host);
  setAgentState(host, "starting");
  process.on("message", (input) => {
    const result = agentEventSchema.safeParse(input);
    if (!result.success) return;
    if (result.data.type === "ready") {
      setAgentState(host, "ready");
      for (const command of host.queue.splice(0)) process.postMessage(command);
    } else if (result.data.type === "fatal") {
      broadcast({ type: "agent-error", requestId: result.data.requestId, message: result.data.message });
    } else broadcast(result.data);
  });
  process.on("exit", (code) => {
    if (agents.get(path) !== host) return;
    host.queue.splice(0);
    setAgentState(host, code === 0 ? "stopped" : "failed");
    agents.delete(path);
  });
  return host;
}

function post(path: string, command: AgentCommand) {
  const host = launchAgent(path);
  if (host.idleTimer) clearTimeout(host.idleTimer);
  if (host.state === "ready") host.process.postMessage(command);
  else host.queue.push(command);
}

function scheduleIdle(path: string) {
  const host = agents.get(path);
  if (!host || [...windowWorkspaces.values()].includes(path)) return;
  if (host.idleTimer) clearTimeout(host.idleTimer);
  host.idleTimer = setTimeout(() => {
    if ([...windowWorkspaces.values()].includes(path)) return;
    host.process.postMessage({ type: "shutdown" } satisfies AgentCommand);
    agents.delete(path);
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
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("did-finish-load", () => sendTo(window.webContents, { type: "agent-state", state: "ready" }));
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
  if (request.type === "restart-agent") {
    const old = agents.get(request.path);
    if (old) { agents.delete(request.path); old.process.kill(); }
    launchAgent(request.path);
    return desktopResponseSchema.parse({ type: "accepted", requestId: crypto.randomUUID() });
  }
  const path = request.type === "open-workspace" || request.type === "inspect-workspace" ? request.path : request.workspacePath;
  if (!allowedProjectPaths.has(path)) throw new Error("Project path was not selected by the user");
  if (request.type === "open-workspace") {
    const previous = windowWorkspaces.get(event.sender.id);
    windowWorkspaces.set(event.sender.id, path);
    if (previous && previous !== path) scheduleIdle(previous);
  }
  if (request.type === "respond-ui") {
    post(path, { ...request, type: "ui-response" });
    return desktopResponseSchema.parse({ type: "ui-response-accepted", uiRequestId: request.uiRequestId });
  }
  post(path, request satisfies AgentCommand);
  return desktopResponseSchema.parse({ type: "accepted", requestId: request.requestId });
});

app.whenReady().then(async () => {
  await loadApplicationState();
  createWindow();
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => {
  for (const host of agents.values()) host.process.kill();
  agents.clear();
  if (process.env.CAKE_ELECTRON_SMOKE === "1") setImmediate(() => app.exit(0));
});

if (process.env.CAKE_ELECTRON_SMOKE === "1") {
  Object.assign(globalThis, { cakeSmokeTerminateAgent() { const host = agents.values().next().value as AgentHost | undefined; if (!host) throw new Error("Agent process is unavailable"); host.process.kill(); } });
}
