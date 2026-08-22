import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, request as httpRequest, type Server as HttpServer } from "node:http";
import net from "node:net";
import { copyFile, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WebContentsView, BrowserWindow } from "electron";
import { z } from "zod";
import {
  downloadFile,
  extractArchive,
  platformAssetName,
  releaseAssetUrl,
  resolveServerBinary,
  VSCODE_SERVER_VERSION,
} from "./vscode-server-binary";

/** Idle servers are stopped after this long without an attached viewer or activity. */
const IDLE_EVICT_MS = 3 * 60_000;
/** Hard cap on concurrently running servers; beyond this the least recently used one dies. */
const MAX_RUNNING_SERVERS = 3;
const START_TIMEOUT = 45_000;

export type EmbeddedEditorStatus = "missing" | "downloading" | "starting" | "ready" | "failed";

export interface EmbeddedEditorState {
  status: EmbeddedEditorStatus;
  message?: string;
}

/** Payloads the companion extension posts to Cake's localhost bridge. */
const bridgeMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    workspace: z.string().min(1).max(4_096),
    port: z.number().int().min(1).max(65_535),
  }),
  z.object({
    type: z.literal("activity"),
    workspace: z.string().min(1).max(4_096),
    path: z.string().min(1).max(8_192),
  }),
]);

/** Requests Cake posts to the companion extension's localhost server. */
interface CompanionRevealRequest {
  type: "reveal";
  path: string;
  line?: number;
}

interface BroadcastTarget {
  broadcast(
    event:
      | {
          type: "embedded-editor-state";
          status: EmbeddedEditorStatus;
          message?: string;
        }
      | { type: "embedded-editor-activity"; workspacePath: string; path: string },
  ): void;
}

export interface VsCodeServerManagerProps extends BroadcastTarget {
  /** Directory that holds downloads, extracted servers, extensions, and per-workspace state. */
  root: string;
  /** Parsed companion manifest, serialized as the extension's package.json. */
  companionManifest: CompanionManifest;
  /** Path to the companion extension main script (copied verbatim). */
  companionMain: string;
  customPath(): string | undefined;
}

/**
 * One openvscode-server process serving one workspace folder. The process is
 * shared by every Cake surface that opens that folder.
 */
interface ServerInstance {
  workspacePath: string;
  child: ChildProcess;
  port: number;
  token: string;
  lastUsedAt: number;
  viewers: number;
  evictTimer?: ReturnType<typeof setTimeout>;
}

/** The native view one Cake window shows for its current workspace. */
interface ViewEntry {
  workspacePath: string;
  view: WebContentsView;
}

/** The sideloaded companion extension's package.json contract. */
export interface CompanionManifest {
  name: string;
  displayName: string;
  description: string;
  version: string;
  publisher: string;
  private: boolean;
  license: string;
  engines: { vscode: string };
  main: string;
  activationEvents: string[];
  contributes: {
    commands: Array<{ command: string; title: string }>;
  };
}

/**
 * Owns the embedded VS Code editor: resolving or downloading openvscode-server,
 * sideloading the Cake companion extension, running at most one server per
 * workspace folder (shared across sessions of that folder), attaching views to
 * the single application window, and relaying bridge traffic between the
 * companion extension and renderer stores.
 */
export class VsCodeServerManager {
  status: EmbeddedEditorStatus = "missing";
  message: string | undefined;
  private props: VsCodeServerManagerProps;
  private servers = new Map<string, ServerInstance>();
  private starting = new Map<string, Promise<ServerInstance>>();
  private views = new Map<number, ViewEntry>();
  private companionPorts = new Map<string, number>();
  private bridge: HttpServer | undefined;
  private bridgePort: number | undefined;
  private installPromise: Promise<void> | undefined;

  constructor(props: VsCodeServerManagerProps) {
    this.props = props;
  }

  snapshotState(): EmbeddedEditorState & { customPath?: string } {
    const state: EmbeddedEditorState & { customPath?: string } = {
      status: this.status,
    };
    if (this.message) state.message = this.message;
    const customPath = this.props.customPath();
    if (customPath) state.customPath = customPath;
    return state;
  }

  private setStatus(status: EmbeddedEditorStatus, message?: string) {
    this.status = status;
    this.message = message;
    this.props.broadcast({ type: "embedded-editor-state", status, message });
  }

  async refreshStatus() {
    if (this.status === "downloading" || this.status === "starting") return;
    try {
      await resolveServerBinary(this.props.root, this.props.customPath());
      if (this.status !== "ready") this.setStatus("ready");
    } catch {
      if (this.status !== "failed") this.setStatus("missing");
    }
  }

  /** Downloads and extracts openvscode-server unless a usable binary already exists. */
  private async ensureInstalled(): Promise<string> {
    try {
      return await resolveServerBinary(this.props.root, this.props.customPath());
    } catch {
      // fall through to download
    }
    await this.download();
    return resolveServerBinary(this.props.root, this.props.customPath());
  }

  /** Runs one install attempt at a time; concurrent callers share the outcome. */
  install(): Promise<void> {
    this.installPromise ??= this.ensureInstalled()
      .then(() => this.setStatus("ready"))
      .catch((error: unknown) => {
        this.setStatus("failed", error instanceof Error ? error.message : String(error));
        throw error;
      })
      .finally(() => {
        this.installPromise = undefined;
      });
    return this.installPromise;
  }

  private async download(): Promise<void> {
    const asset = platformAssetName();
    const url = releaseAssetUrl(asset);
    this.setStatus("downloading", `Downloading ${asset}`);
    const downloads = join(this.props.root, "downloads");
    await mkdir(downloads, { recursive: true });
    const archivePath = join(downloads, asset);
    try {
      await downloadFile(url, archivePath, (fraction) => {
        // Coarse progress keeps event traffic bounded while still feeling live.
        const percent = Math.round(fraction * 100);
        if (percent % 5 === 0) this.setStatus("downloading", `Downloading ${asset} (${percent}%)`);
      });
    } catch (error) {
      await rm(archivePath, { force: true });
      throw new Error(
        `Could not download ${url}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    this.setStatus("downloading", "Extracting");
    const appDir = join(this.props.root, `openvscode-server-v${VSCODE_SERVER_VERSION}`);
    await extractArchive(archivePath, appDir, asset.endsWith(".zip"));
    await rm(archivePath, { force: true });
  }

  /**
   * Shows the embedded editor for `workspacePath` in one window. Reuses the
   * running server for that folder when one exists, replacing whatever this
   * window was previously showing.
   */
  async open(webContentsId: number, getWindow: () => BrowserWindow | null, workspacePath: string) {
    let binary: string;
    try {
      binary = await this.ensureInstalled();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus("failed", message);
      throw error;
    }
    const resolved = await realpath(workspacePath);
    const instance = await this.serverFor(resolved, binary);

    const window = getWindow();
    if (!window || window.isDestroyed())
      throw new Error("The editor window is no longer available");

    const previous = this.views.get(webContentsId);
    if (previous && previous.workspacePath === resolved) {
      this.touch(instance);
      return;
    }
    if (previous) {
      this.releaseViewer(previous.workspacePath);
      detachView(window, previous.view);
    }
    const view = new WebContentsView({
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
    });
    this.views.set(webContentsId, { workspacePath: resolved, view });
    instance.viewers += 1;
    this.cancelEviction(instance);

    try {
      await view.webContents.loadURL(`http://127.0.0.1:${instance.port}/?tkn=${instance.token}`);
    } catch (error) {
      this.views.delete(webContentsId);
      this.releaseViewer(resolved);
      detachView(window, view);
      throw error;
    }
    window.contentView.addChildView(view);
    this.touch(instance);
  }

  /** Positions or hides the native view for one window. Bounds are DIPs relative to the content area. */
  updateBounds(
    webContentsId: number,
    bounds: { visible: boolean; x: number; y: number; width: number; height: number },
  ) {
    const entry = this.views.get(webContentsId);
    if (!entry) return;
    entry.view.setVisible(bounds.visible && bounds.width > 0 && bounds.height > 0);
    entry.view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    });
    const instance = this.servers.get(entry.workspacePath);
    if (instance) this.touch(instance);
  }

  /** Asks the workspace's companion extension to reveal a file at a line. */
  async reveal(workspacePath: string, path: string, line?: number) {
    const resolved = await realpath(workspacePath);
    const instance = this.servers.get(resolved);
    const port = this.companionPorts.get(resolved);
    if (!instance || !port)
      throw new Error("The embedded editor is not running for this project yet");
    this.touch(instance);
    await postJson(port, "/", { type: "reveal", path, line });
  }

  /** Detaches one window's view and lets its former server go idle. */
  closeForWindow(webContentsId: number) {
    const entry = this.views.get(webContentsId);
    if (!entry) return;
    this.views.delete(webContentsId);
    this.releaseViewer(entry.workspacePath);
    const window = BrowserWindow.getAllWindows().find(
      (candidate) => candidate.webContents.id === webContentsId,
    );
    if (window) detachView(window, entry.view);
  }

  disposeAll() {
    for (const [, entry] of this.views) entry.view.setVisible(false);
    this.views.clear();
    for (const [, instance] of this.servers) this.disposeServer(instance);
    this.servers.clear();
    this.starting.clear();
    this.companionPorts.clear();
    this.bridge?.close();
    this.bridge = undefined;
    this.bridgePort = undefined;
  }

  /** Returns the running server for a folder or starts one, deduplicating concurrent starts. */
  private serverFor(resolvedWorkspace: string, binary: string): Promise<ServerInstance> {
    const existing = this.servers.get(resolvedWorkspace);
    if (existing) return Promise.resolve(existing);
    const pending = this.starting.get(resolvedWorkspace);
    if (pending) return pending;
    const started = this.startServer(resolvedWorkspace, binary).catch((error) => {
      this.starting.delete(resolvedWorkspace);
      throw error;
    });
    this.starting.set(resolvedWorkspace, started);
    return started;
  }

  private async startServer(workspacePath: string, binary: string): Promise<ServerInstance> {
    this.setStatus("starting", "Starting VS Code");
    await this.enforceRunningCap();
    await this.startBridge();
    const extensionDir = await this.syncCompanionExtension();
    const port = await findFreePort();
    const token = randomBytes(24).toString("hex");
    const userDataDir = join(this.props.root, "user-data", workspaceHash(workspacePath));
    await mkdir(userDataDir, { recursive: true });

    const child = spawn(
      binary,
      [
        "--port",
        String(port),
        "--bind-addr",
        `127.0.0.1:${port}`,
        "--connection-token",
        token,
        "--extensions-dir",
        extensionDir,
        "--user-data-dir",
        userDataDir,
        "--disable-telemetry",
        workspacePath,
      ],
      {
        cwd: workspacePath,
        env: (() => {
          // The server is a plain Node process; strip the Electron runtime flag
          // so its child processes (extension host) do not re-enter Electron.
          const env: NodeJS.ProcessEnv = {
            ...process.env,
            CAKE_BRIDGE_PORT: String(this.bridgePort),
            CAKE_WORKSPACE_PATH: workspacePath,
          };
          delete env.ELECTRON_RUN_AS_NODE;
          return env;
        })(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout?.pause();
    child.stderr?.pause();

    const instance: ServerInstance = {
      workspacePath,
      child,
      port,
      token,
      lastUsedAt: Date.now(),
      viewers: 0,
    };

    const exitHandler = (code: number | null) => {
      if (this.servers.get(workspacePath) !== instance) return;
      this.forgetServer(instance);
      this.setStatus("failed", `VS Code exited unexpectedly (code ${code ?? "unknown"})`);
    };
    child.once("exit", exitHandler);

    try {
      await waitForServerStart(child, START_TIMEOUT);
    } catch (error) {
      child.removeListener("exit", exitHandler);
      child.kill();
      throw error;
    }

    this.servers.set(workspacePath, instance);
    this.setStatus("ready");
    return instance;
  }

  /** Stops the least recently used viewer-less server when the running cap is exceeded. */
  private async enforceRunningCap() {
    while (this.servers.size >= MAX_RUNNING_SERVERS) {
      const victim = [...this.servers.values()]
        .filter((candidate) => candidate.viewers === 0)
        .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
      if (!victim) return;
      this.disposeServer(victim);
      this.servers.delete(victim.workspacePath);
    }
  }

  private releaseViewer(workspacePath: string) {
    const instance = this.servers.get(workspacePath);
    if (!instance) return;
    instance.viewers = Math.max(0, instance.viewers - 1);
    if (instance.viewers === 0) this.scheduleEviction(instance);
  }

  private scheduleEviction(instance: ServerInstance) {
    if (instance.evictTimer) clearTimeout(instance.evictTimer);
    instance.evictTimer = setTimeout(() => {
      instance.evictTimer = undefined;
      if (instance.viewers > 0) return;
      this.disposeServer(instance);
      this.servers.delete(instance.workspacePath);
    }, IDLE_EVICT_MS);
  }

  private cancelEviction(instance: ServerInstance) {
    if (instance.evictTimer) {
      clearTimeout(instance.evictTimer);
      instance.evictTimer = undefined;
    }
  }

  private forgetServer(instance: ServerInstance) {
    this.cancelEviction(instance);
    this.companionPorts.delete(instance.workspacePath);
    const affectedViewers = [...this.views.entries()].filter(
      ([, entry]) => entry.workspacePath === instance.workspacePath,
    );
    for (const [webContentsId] of affectedViewers) this.views.delete(webContentsId);
    for (const [webContentsId, entry] of affectedViewers) {
      const window = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.webContents.id === webContentsId,
      );
      if (window) detachView(window, entry.view);
    }
  }

  private disposeServer(instance: ServerInstance) {
    this.cancelEviction(instance);
    this.companionPorts.delete(instance.workspacePath);
    instance.child.removeAllListeners("exit");
    instance.child.kill();
  }

  /** Localhost-only relay for companion extension traffic. The extension posts hello/activity here. */
  private async startBridge() {
    if (this.bridge) return;
    const server = createServer((req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 65_536) {
          res.writeHead(413).end();
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        res.writeHead(204).end();
        this.handleBridgeMessage(Buffer.concat(chunks));
      });
      req.on("error", () => {});
    });
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolvePromise());
    });
    const untypedAddress: unknown = server.address();
    // SAFETY: the bridge listens on 127.0.0.1 with port 0, so the kernel-assigned
    // endpoint is always the net.AddressInfo form, never null or the string form.
    const address = untypedAddress as net.AddressInfo;
    this.bridge = server;
    this.bridgePort = address.port;
  }

  private handleBridgeMessage(raw: Buffer) {
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      return;
    }
    const message = bridgeMessageSchema.safeParse(payload);
    if (!message.success) return;
    if (message.data.type === "hello") {
      this.companionPorts.set(message.data.workspace, message.data.port);
      return;
    }
    this.props.broadcast({
      type: "embedded-editor-activity",
      workspacePath: message.data.workspace,
      path: message.data.path,
    });
  }

  private async syncCompanionExtension() {
    const extensionRoot = join(this.props.root, "extensions", "cake-companion");
    await mkdir(extensionRoot, { recursive: true });
    await writeFile(
      join(extensionRoot, "package.json"),
      `${JSON.stringify(this.props.companionManifest, null, 2)}\n`,
    );
    await copyFile(this.props.companionMain, join(extensionRoot, "extension.js"));
    return join(this.props.root, "extensions");
  }

  private touch(instance: ServerInstance) {
    instance.lastUsedAt = Date.now();
  }
}

function workspaceHash(workspacePath: string) {
  return createHash("sha256").update(workspacePath).digest("hex").slice(0, 16);
}

function detachView(window: BrowserWindow, view: WebContentsView) {
  if (window.isDestroyed()) return;
  try {
    window.contentView.removeChildView(view);
  } catch {
    // The view was already detached with its window.
  }
}

async function postJson(
  port: number,
  requestPath: string,
  body: CompanionRevealRequest,
): Promise<void> {
  const payload = Buffer.from(JSON.stringify(body));
  await new Promise<void>((resolvePromise, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: requestPath,
      headers: { "content-type": "application/json", "content-length": payload.length },
      timeout: 5_000,
    });
    request.on("response", (response) => {
      response.resume();
      resolvePromise();
    });
    request.on("timeout", () => {
      request.destroy(new Error("Companion extension did not respond"));
    });
    request.on("error", reject);
    request.end(payload);
  });
}

function waitForServerStart(child: ChildProcess, timeout: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("VS Code did not finish starting in time"));
    }, timeout);
    const onData = (chunk: Buffer) => {
      if (/listening|on port|at http/i.test(chunk.toString("utf8"))) {
        cleanup();
        resolvePromise();
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`VS Code exited during startup (code ${code ?? "unknown"})`));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    function cleanup() {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
    }
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function findFreePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const untypedAddress: unknown = server.address();
      // SAFETY: the socket listens on 127.0.0.1 with port 0, so the kernel-assigned
      // endpoint is always the net.AddressInfo form, never null or a string.
      const address = untypedAddress as net.AddressInfo;
      server.close(() => resolvePromise(address.port));
    });
  });
}
