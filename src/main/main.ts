import { readFile, rename, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { homedir } from "node:os";
import { app, BrowserWindow, dialog, ipcMain, utilityProcess, type UtilityProcess } from "electron";
import { agentEventSchema, type AgentCommand } from "../ipc/agent-ipc";
import {
  desktopRequestSchema,
  desktopResponseSchema,
  type AgentState,
  type DesktopEvent
} from "../ipc/desktop-ipc";
import { windowViewStateSchema, type Attachment, type WindowViewState } from "../ipc/session-contract";

let window: BrowserWindow | null = null;
let agentProcess: UtilityProcess | null = null;
let agentState: AgentState = "stopped";
const allowedProjectPaths = new Set<string>();

if (process.env.CAKE_ELECTRON_USER_DATA) {
  app.setPath("userData", process.env.CAKE_ELECTRON_USER_DATA);
}

function send(event: DesktopEvent) {
  if (window && !window.isDestroyed()) window.webContents.send("cake:event", event);
}

function setAgentState(state: AgentState) {
  agentState = state;
  send({ type: "agent-state", state });
}

function launchAgent() {
  setAgentState("starting");
  agentProcess = utilityProcess.fork(join(import.meta.dirname, "agent.js"));
  agentProcess.on("message", (input) => {
    const result = agentEventSchema.safeParse(input);
    if (!result.success) return;
    if (result.data.type === "ready") setAgentState("ready");
    else if (result.data.type === "fatal") send({ type: "agent-error", requestId: result.data.requestId, message: result.data.message });
    else send(result.data);
  });
  agentProcess.on("exit", (code) => {
    agentProcess = null;
    setAgentState(code === 0 ? "stopped" : "failed");
  });
}

function createWindow() {
  window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: "#f5f0e8",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("did-finish-load", () => send({ type: "agent-state", state: agentState }));
  window.on("closed", () => { window = null; });

  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
}

function statePath() {
  return join(app.getPath("userData"), "window-state.json");
}

async function loadWindowState(): Promise<WindowViewState> {
  try {
    const parsed = windowViewStateSchema.parse(JSON.parse(await readFile(statePath(), "utf8")));
    if (parsed.projectPath) allowedProjectPaths.add(parsed.projectPath);
    for (const path of parsed.recentProjectPaths) allowedProjectPaths.add(path);
    return parsed;
  } catch {
    return windowViewStateSchema.parse({});
  }
}

async function saveWindowState(state: WindowViewState) {
  const parsed = windowViewStateSchema.parse(state);
  const target = statePath();
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}

const imageMimeTypes: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp"
};

async function chooseAttachments(): Promise<Attachment[]> {
  if (!window) return [];
  const result = await dialog.showOpenDialog(window, { properties: ["openFile", "multiSelections"] });
  if (result.canceled) return [];
  return Promise.all(result.filePaths.slice(0, 20).map(async (path): Promise<Attachment> => {
    const mimeType = imageMimeTypes[extname(path).toLowerCase()];
    if (mimeType) return { kind: "image", name: basename(path), mimeType, data: (await readFile(path)).toString("base64") };
    return { kind: "file", name: basename(path), path };
  }));
}

ipcMain.handle("cake:request", async (_event, input: unknown) => {
  const request = desktopRequestSchema.parse(input);
  if (request.type === "choose-project") {
    if (!window) return desktopResponseSchema.parse({ type: "project-chosen" });
    const result = await dialog.showOpenDialog(window, { properties: ["openDirectory"] });
    const path = result.canceled ? undefined : result.filePaths[0];
    if (path) allowedProjectPaths.add(path);
    return desktopResponseSchema.parse({ type: "project-chosen", path });
  }
  if (request.type === "get-home-directory") {
    const path = homedir();
    allowedProjectPaths.add(path);
    return desktopResponseSchema.parse({ type: "home-directory", path });
  }
  if (request.type === "choose-attachments") {
    return desktopResponseSchema.parse({ type: "attachments-chosen", attachments: await chooseAttachments() });
  }
  if (request.type === "load-window-state") {
    return desktopResponseSchema.parse({ type: "window-state-loaded", state: await loadWindowState() });
  }
  if (request.type === "save-window-state") {
    await saveWindowState(request.state);
    return desktopResponseSchema.parse({ type: "window-state-saved" });
  }
  if (!agentProcess) throw new Error("Agent process is unavailable");
  if ((request.type === "inspect-workspace" || request.type === "open-workspace") && !allowedProjectPaths.has(request.path)) {
    throw new Error("Project path was not selected by the user");
  }
  if (request.type === "respond-ui") {
    agentProcess.postMessage({ type: "ui-response", requestId: request.requestId, uiRequestId: request.uiRequestId, value: request.value, cancelled: request.cancelled } satisfies AgentCommand);
    return desktopResponseSchema.parse({ type: "ui-response-accepted", uiRequestId: request.uiRequestId });
  }
  agentProcess.postMessage(request satisfies AgentCommand);
  return desktopResponseSchema.parse({ type: "accepted", requestId: request.requestId });
});

app.whenReady().then(() => {
  createWindow();
  launchAgent();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  agentProcess?.postMessage({ type: "shutdown" } satisfies AgentCommand);
});

if (process.env.CAKE_ELECTRON_SMOKE === "1") {
  Object.assign(globalThis, {
    cakeSmokeTerminateAgent() {
      if (!agentProcess) throw new Error("Agent process is unavailable");
      agentProcess.kill();
    }
  });
}
