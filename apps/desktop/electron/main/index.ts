import { join } from "node:path";
import { app, BrowserWindow, ipcMain, utilityProcess, type UtilityProcess } from "electron";
import {
  desktopRequestSchema,
  desktopResponseSchema,
  workerEventSchema,
  type DesktopEvent,
  type WorkerCommand
} from "@cake/protocol";
import { mountDesktopKernelStore } from "@cake/state";

let window: BrowserWindow | null = null;
let worker: UtilityProcess | null = null;
const kernelStore = mountDesktopKernelStore();

function send(event: DesktopEvent) {
  if (window && !window.isDestroyed()) window.webContents.send("cake:event", event);
}

function launchWorker() {
  send({ type: "worker-state", state: "starting" });
  worker = utilityProcess.fork(join(import.meta.dirname, "worker.js"));
  worker.on("message", (input) => {
    const result = workerEventSchema.safeParse(input);
    if (!result.success) return;
    if (result.data.type === "ready") send({ type: "worker-state", state: "ready" });
    if (result.data.type === "text-delta") send(result.data);
    if (result.data.type === "fatal") send({ type: "worker-state", state: "failed" });
  });
  worker.on("exit", (code) => {
    worker = null;
    send({ type: "worker-state", state: code === 0 ? "stopped" : "failed" });
  });
}

function createWindow() {
  window = new BrowserWindow({
    width: 1000,
    height: 720,
    backgroundColor: "#f5f0e8",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.on("closed", () => { window = null; });

  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
}

ipcMain.handle("cake:request", (_event, input: unknown) => {
  const request = desktopRequestSchema.parse(input);
  if (request.type === "start-demo") {
    if (!worker) throw new Error("Worker is unavailable");
    const response = desktopResponseSchema.parse({ type: "started", requestId: crypto.randomUUID() });
    worker.postMessage({ type: "start", requestId: response.requestId } satisfies WorkerCommand);
    return response;
  }
});

app.whenReady().then(() => {
  createWindow();
  launchWorker();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  worker?.postMessage({ type: "shutdown" } satisfies WorkerCommand);
  kernelStore[Symbol.dispose]();
});
