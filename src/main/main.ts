import { join } from "node:path";
import { app, BrowserWindow, ipcMain, utilityProcess, type UtilityProcess } from "electron";
import { agentEventSchema, type AgentCommand } from "../ipc/agent-ipc";
import {
  desktopRequestSchema,
  desktopResponseSchema,
  type AgentState,
  type DesktopEvent
} from "../ipc/desktop-ipc";

let window: BrowserWindow | null = null;
let agentProcess: UtilityProcess | null = null;
let agentState: AgentState = "stopped";

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
    if (result.data.type === "text-delta") send(result.data);
    if (result.data.type === "ui-request") send(result.data);
    if (result.data.type === "complete") send(result.data);
    if (result.data.type === "fatal") {
      send({ type: "agent-error", requestId: result.data.requestId, message: result.data.message });
      if (!result.data.requestId) setAgentState("failed");
    }
  });
  agentProcess.on("exit", (code) => {
    agentProcess = null;
    setAgentState(code === 0 ? "stopped" : "failed");
  });
}

function createWindow() {
  window = new BrowserWindow({
    width: 1000,
    height: 720,
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

ipcMain.handle("cake:request", (_event, input: unknown) => {
  const request = desktopRequestSchema.parse(input);
  if (request.type === "start-foundation-check") {
    if (!agentProcess) throw new Error("Agent process is unavailable");
    const response = desktopResponseSchema.parse({ type: "started", requestId: request.requestId });
    agentProcess.postMessage({ type: "start", requestId: request.requestId } satisfies AgentCommand);
    return response;
  }

  if (!agentProcess) throw new Error("Agent process is unavailable");
  const response = desktopResponseSchema.parse({
    type: "ui-response-accepted",
    uiRequestId: request.uiRequestId
  });
  agentProcess.postMessage({
    type: "ui-response",
    requestId: request.requestId,
    uiRequestId: request.uiRequestId,
    accepted: request.accepted
  } satisfies AgentCommand);
  return response;
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
