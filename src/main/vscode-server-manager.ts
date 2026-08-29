import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, request as httpRequest, type Server as HttpServer } from "node:http";
import net from "node:net";
import { copyFile, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { WebContentsView, BrowserWindow } from "electron";
import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser";
import { z } from "zod";
import type { SourceLocation } from "../ipc/source-location";
import type { EditorAnnotationSnapshot } from "../ipc/editor-annotation";
import cakeIconMarkup from "../assets/cake-icon.svg?raw";
import {
  downloadFile,
  extractArchive,
  platformAssetName,
  releaseAssetUrl,
  resolveServerBinary,
  serverFlavor,
  VSCODE_SERVER_VERSION,
  type ServerFlavor,
} from "./vscode-server-binary";

/** Idle servers are stopped after this long without an attached viewer or activity. */
const IDLE_EVICT_MS = 3 * 60_000;
/** Hard cap on concurrently running servers; beyond this the least recently used one dies. */
const MAX_RUNNING_SERVERS = 3;
const START_TIMEOUT = 45_000;
const COMPANION_START_TIMEOUT = 5_000;
// VS Code exposes editor-title actions to extensions, but those disappear when no
// file is open and it has no public top-level title-bar contribution point. Cake
// owns this managed web surface, so install its two shell controls alongside the
// built-in layout actions and keep them present across title-bar rerenders.
const VSCODE_SHELL_CONTROL_PREFIX = "__CAKE_SHELL_CONTROL__";

function vscodeShellControlsScript(workspacePath: string) {
  return `(() => {
    const cakeIconMarkup = ${JSON.stringify(cakeIconMarkup)};
    const controlPrefix = ${JSON.stringify(VSCODE_SHELL_CONTROL_PREFIX)};
    const workspace = ${JSON.stringify(workspacePath)};
    const controls = [
      ["cake-back-to-agent", "Cake: Back to Agent", "cake", "back-to-agent"],
      [
        "cake-toggle-chat-sidebar",
        "Cake: Toggle Chat Sidebar",
        "layout-sidebar-right",
        "toggle-chat-sidebar",
      ],
    ];
    const install = () => {
      const actions = document.querySelector(
        ".part.titlebar .titlebar-right .action-toolbar-container .actions-container",
      );
      if (!(actions instanceof HTMLElement)) return;
      const secondarySidebarAction = actions.querySelector(
        '[aria-label*="Toggle Secondary Side Bar"], [title*="Toggle Secondary Side Bar"]',
      );
      secondarySidebarAction?.closest(".action-item")?.remove();
      for (const [id, label, icon, type] of controls) {
        if (document.getElementById(id)) continue;
        const item = document.createElement("li");
        item.id = id;
        item.className = "action-item";
        const action = document.createElement("a");
        action.className = icon === "cake" ? "action-label" : "action-label codicon codicon-" + icon;
        if (icon === "cake") {
          action.innerHTML = cakeIconMarkup + "<span>Back to Agent</span>";
          action.style.alignItems = "center";
          action.style.color = "var(--vscode-titleBar-activeForeground)";
          action.style.gap = "6px";
          action.style.padding = "0 8px";
        }
        action.href = "#";
        action.addEventListener("click", (event) => {
          event.preventDefault();
          console.debug(controlPrefix + JSON.stringify({ type, workspace }));
        });
        action.setAttribute("role", "button");
        action.setAttribute("aria-label", label);
        action.title = label;
        item.append(action);
        if (id === "cake-back-to-agent") actions.prepend(item);
        else actions.append(item);
      }
    };
    install();
    if (!window.__cakeShellControlsObserver) {
      window.__cakeShellControlsObserver = new MutationObserver(install);
      window.__cakeShellControlsObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    }
  })()`;
}
const editorPreferencesSchema = z.looseObject({
  "security.workspace.trust.enabled": z.boolean().optional(),
  "workbench.colorTheme": z.string().optional(),
  "workbench.startupEditor": z.string().optional(),
  "workbench.secondarySideBar.defaultVisibility": z.string().optional(),
  "chat.disableAIFeatures": z.boolean().optional(),
  "extensions.ignoreRecommendations": z.boolean().optional(),
});

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
    type: z.literal("back-to-agent"),
    workspace: z.string().min(1).max(4_096),
  }),
  z.object({
    type: z.literal("toggle-chat-sidebar"),
    workspace: z.string().min(1).max(4_096),
  }),
  z.object({
    type: z.literal("open-annotation"),
    workspace: z.string().min(1).max(4_096),
    sessionId: z.string().min(1).max(256),
    threadId: z.string().min(1).max(256),
  }),
  z.object({
    type: z.literal("selection-cleared"),
    workspace: z.string().min(1).max(4_096),
  }),
  z.object({
    type: z.literal("selection"),
    workspace: z.string().min(1).max(4_096),
    path: z.string().min(1).max(8_192),
    startLine: z.number().int().nonnegative(),
    endLine: z.number().int().nonnegative(),
  }),
]);

/** Requests Cake posts to the companion extension's localhost server. */
type CompanionRequest =
  | ({ type: "reveal" } & SourceLocation)
  | { type: "open-source-control" }
  | ({ type: "annotations" } & EditorAnnotationSnapshot)
  | { type: "set-theme"; theme: "light" | "dark" };

interface BroadcastTarget {
  broadcast(
    event:
      | {
          type: "embedded-editor-state";
          status: EmbeddedEditorStatus;
          message?: string;
        }
      | {
          type: "embedded-editor-selection";
          workspacePath: string;
          path: string;
          startLine: number;
          endLine: number;
        }
      | { type: "embedded-editor-back-to-agent"; workspacePath: string }
      | {
          type: "embedded-editor-annotation-opened";
          workspacePath: string;
          sessionId: string;
          threadId: string;
        }
      | { type: "embedded-editor-toggle-chat"; workspacePath: string }
      | { type: "embedded-editor-selection-cleared"; workspacePath: string },
  ): void;
}

export interface VsCodeServerManagerProps extends BroadcastTarget {
  /** Directory that holds downloads, extracted servers, extensions, and per-workspace state. */
  root: string;
  /** Parsed companion manifest, serialized as the extension's package.json. */
  companionManifest: CompanionManifest;
  /** Path to the companion extension main script (copied verbatim). */
  companionMain: string;
  /** Raw theme files contributed by the companion, written under its extension root. */
  companionThemes: Array<{ path: string; content: string }>;
  customPath(): string | undefined;
  preferredTheme(): Promise<"light" | "dark">;
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
  flavor: ServerFlavor;
  lastUsedAt: number;
  viewers: number;
  evictTimer?: ReturnType<typeof setTimeout>;
}

/** The native view one Cake window shows for its current workspace. */
interface ViewEntry {
  workspacePath: string;
  view: WebContentsView;
}

type ViewBounds = { visible: boolean; x: number; y: number; width: number; height: number };

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
    commands: Array<{ command: string; title: string; icon?: string }>;
    menus?: Record<string, Array<{ command: string; when?: string; group?: string }>>;
    themes?: Array<{ label: string; uiTheme: string; path: string }>;
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
  /** Latest renderer-owned rect, retained when it arrives before the native view exists. */
  private requestedBounds = new Map<number, ViewBounds>();
  private companionPorts = new Map<string, number>();
  /** Maps canonical server workspaces back to the project path Cake presents to the renderer. */
  private presentedWorkspacePaths = new Map<string, string>();
  private bridge: HttpServer | undefined;
  private bridgePort: number | undefined;
  private readonly bridgeToken = randomBytes(32).toString("hex");
  private installPromise: Promise<void> | undefined;
  /** Theme last pushed to running companions; duplicated pushes are skipped. */
  private pushedTheme: "light" | "dark" | undefined;

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
    this.presentedWorkspacePaths.set(resolved, workspacePath);
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
    view.webContents.on("console-message", (event) => {
      if (!event.message.startsWith(VSCODE_SHELL_CONTROL_PREFIX)) return;
      event.preventDefault();
      this.handleBridgeMessage(
        Buffer.from(event.message.slice(VSCODE_SHELL_CONTROL_PREFIX.length), "utf8"),
      );
    });
    this.views.set(webContentsId, { workspacePath: resolved, view });
    this.applyRequestedBounds(webContentsId, view);
    instance.viewers += 1;
    this.cancelEviction(instance);

    try {
      const authSuffix = instance.flavor === "openvscode" ? `/?tkn=${instance.token}` : "/";
      await view.webContents.loadURL(`http://127.0.0.1:${instance.port}${authSuffix}`);
      await view.webContents.executeJavaScript(vscodeShellControlsScript(workspacePath));
    } catch (error) {
      this.views.delete(webContentsId);
      this.releaseViewer(resolved);
      detachView(window, view);
      throw error;
    }
    window.contentView.addChildView(view);
    // A newer rect may have arrived while loadURL was pending.
    this.applyRequestedBounds(webContentsId, view);
    this.touch(instance);
  }

  /** Positions or hides the native view for one window. Bounds are DIPs relative to the content area. */
  updateBounds(webContentsId: number, bounds: ViewBounds) {
    this.requestedBounds.set(webContentsId, bounds);
    const entry = this.views.get(webContentsId);
    if (!entry) return;
    this.applyRequestedBounds(webContentsId, entry.view);
    const instance = this.servers.get(entry.workspacePath);
    if (instance) this.touch(instance);
  }

  private applyRequestedBounds(webContentsId: number, view: WebContentsView) {
    const bounds = this.requestedBounds.get(webContentsId);
    if (!bounds) return;
    view.setVisible(bounds.visible && bounds.width > 0 && bounds.height > 0);
    view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    });
  }

  /** Asks the workspace's companion extension to reveal and highlight a source location. */
  async reveal(workspacePath: string, location: SourceLocation) {
    const resolved = await realpath(workspacePath);
    const instance = this.servers.get(resolved);
    if (!instance) throw new Error("The embedded editor is not running for this project yet");
    const port = await this.waitForCompanionPort(resolved);
    this.touch(instance);
    await postJson(port, "/", { type: "reveal", ...location }, this.bridgeToken);
  }

  /** Opens VS Code's native Source Control view for the workspace. */
  async openSourceControl(workspacePath: string) {
    const resolved = await realpath(workspacePath);
    const instance = this.servers.get(resolved);
    if (!instance) throw new Error("The embedded editor is not running for this project yet");
    const port = await this.waitForCompanionPort(resolved);
    this.touch(instance);
    await postJson(port, "/", { type: "open-source-control" }, this.bridgeToken);
  }

  /** Replaces the active session's Cake discussion annotations in VS Code. */
  async updateAnnotations(workspacePath: string, snapshot: EditorAnnotationSnapshot) {
    const resolved = await realpath(workspacePath);
    const instance = this.servers.get(resolved);
    if (!instance) throw new Error("The embedded editor is not running for this project yet");
    const port = await this.waitForCompanionPort(resolved);
    this.touch(instance);
    await postJson(port, "/", { type: "annotations", ...snapshot }, this.bridgeToken);
  }

  /**
   * Pushes Cake's current theme to every running embedded editor. Skipped when
   * the preference is unchanged; servers started later pick the theme up from
   * their seeded preferences.
   */
  async updateTheme() {
    const theme = await this.props.preferredTheme();
    if (theme === this.pushedTheme) return;
    this.pushedTheme = theme;
    const pushes: Array<Promise<void>> = [];
    for (const [workspacePath, port] of this.companionPorts) {
      const instance = this.servers.get(workspacePath);
      if (!instance) continue;
      this.touch(instance);
      pushes.push(
        postJson(port, "/", { type: "set-theme", theme }, this.bridgeToken).catch(() => {
          // A stopping companion misses this push; the theme is applied on next start.
        }),
      );
    }
    await Promise.all(pushes);
  }

  private async waitForCompanionPort(workspacePath: string) {
    const deadline = Date.now() + COMPANION_START_TIMEOUT;
    while (Date.now() < deadline) {
      const port = this.companionPorts.get(workspacePath);
      if (port) return port;
      if (!this.servers.has(workspacePath)) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    throw new Error("The VS Code companion extension did not finish starting");
  }

  /** Converts a native window-close request into Back to Agent while the editor is visible. */
  backToAgentForWindow(webContentsId: number) {
    const entry = this.views.get(webContentsId);
    const bounds = this.requestedBounds.get(webContentsId);
    if (!entry || !bounds?.visible) return false;
    this.updateBounds(webContentsId, { ...bounds, visible: false });
    this.props.broadcast({
      type: "embedded-editor-back-to-agent",
      workspacePath: this.presentedWorkspacePaths.get(entry.workspacePath) ?? entry.workspacePath,
    });
    return true;
  }

  /** Detaches one window's view and lets its former server go idle. */
  closeForWindow(webContentsId: number) {
    this.requestedBounds.delete(webContentsId);
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
    this.requestedBounds.clear();
    for (const [, instance] of this.servers) this.disposeServer(instance);
    this.servers.clear();
    this.starting.clear();
    this.companionPorts.clear();
    this.presentedWorkspacePaths.clear();
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
    const started = this.startServer(resolvedWorkspace, binary).finally(() => {
      this.starting.delete(resolvedWorkspace);
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
    await this.ensureEditorPreferences(userDataDir);
    const flavor = serverFlavor(binary);

    const child = spawn(
      binary,
      // code-server (the common local install) and openvscode-server differ in
      // their listen/auth flags; both take the folder as the final positional.
      flavor === "codeserver"
        ? [
            "--bind-addr",
            `127.0.0.1:${port}`,
            "--auth",
            "none",
            "--disable-workspace-trust",
            "--extensions-dir",
            extensionDir,
            "--user-data-dir",
            userDataDir,
            workspacePath,
          ]
        : [
            "--port",
            String(port),
            "--bind-addr",
            `127.0.0.1:${port}`,
            "--connection-token",
            token,
            "--disable-workspace-trust",
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
            CAKE_BRIDGE_TOKEN: this.bridgeToken,
            CAKE_WORKSPACE_PATH: workspacePath,
          };
          delete env.ELECTRON_RUN_AS_NODE;
          return env;
        })(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const instance: ServerInstance = {
      workspacePath,
      child,
      port,
      token,
      flavor,
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
    // Startup readiness is detected from these streams. Pause them only after
    // detection; pausing before waitForServerStart prevents its data listeners
    // from ever receiving code-server's listening message.
    child.stdout?.pause();
    child.stderr?.pause();

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
    this.presentedWorkspacePaths.delete(instance.workspacePath);
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
    this.presentedWorkspacePaths.delete(instance.workspacePath);
    instance.child.removeAllListeners("exit");
    instance.child.kill();
  }

  /** Localhost-only relay for companion extension traffic. The extension posts hello/activity here. */
  private async startBridge() {
    if (this.bridge) return;
    const server = createServer((req, res) => {
      if (req.headers["x-cake-token"] !== this.bridgeToken) {
        res.writeHead(401).end();
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 96_000) {
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
    const presentedWorkspace =
      this.presentedWorkspacePaths.get(message.data.workspace) ?? message.data.workspace;
    if (message.data.type === "back-to-agent" || message.data.type === "toggle-chat-sidebar") {
      this.props.broadcast({
        type:
          message.data.type === "back-to-agent"
            ? "embedded-editor-back-to-agent"
            : "embedded-editor-toggle-chat",
        workspacePath: presentedWorkspace,
      });
      return;
    }
    if (message.data.type === "open-annotation") {
      this.focusCakeWindow(message.data.workspace);
      this.props.broadcast({
        type: "embedded-editor-annotation-opened",
        workspacePath: presentedWorkspace,
        sessionId: message.data.sessionId,
        threadId: message.data.threadId,
      });
      return;
    }
    if (message.data.type === "selection-cleared") {
      this.props.broadcast({
        type: "embedded-editor-selection-cleared",
        workspacePath: presentedWorkspace,
      });
      return;
    }
    if (message.data.type === "selection") {
      this.props.broadcast({
        type: "embedded-editor-selection",
        workspacePath: presentedWorkspace,
        path: message.data.path,
        startLine: message.data.startLine,
        endLine: message.data.endLine,
      });
      return;
    }
  }

  private focusCakeWindow(workspacePath: string) {
    for (const [webContentsId, entry] of this.views) {
      if (entry.workspacePath !== workspacePath) continue;
      BrowserWindow.getAllWindows()
        .find((candidate) => candidate.webContents.id === webContentsId)
        ?.webContents.focus();
    }
  }

  private async ensureEditorPreferences(userDataDir: string) {
    const userDir = join(userDataDir, "User");
    const settingsPath = join(userDir, "settings.json");
    await mkdir(userDir, { recursive: true });
    let raw = "{}";
    try {
      raw = await readFile(settingsPath, "utf8");
    } catch {
      // The per-workspace profile has not been initialized yet.
    }
    const parseErrors: ParseError[] = [];
    const parsed = editorPreferencesSchema.safeParse(
      parseJsonc(raw, parseErrors, { allowTrailingComma: true }),
    );
    if (parseErrors.length > 0 || !parsed.success) {
      // Do not replace malformed user-authored settings.
      return;
    }
    const settings = parsed.data;
    const updates: Array<{ key: string; value: unknown }> = [];
    if (settings["security.workspace.trust.enabled"] !== false) {
      // Cake already gates project resources through its own persisted trust decision.
      updates.push({ key: "security.workspace.trust.enabled", value: false });
    }
    // The embedded editor is a Cake-managed surface: it always follows the app's
    // appearance, so an earlier pick (or a stale value from a previous mode) is
    // replaced with the current preference on every start.
    const themeLabel = (await this.props.preferredTheme()) === "dark" ? "Cake Dark" : "Cake Light";
    if (settings["workbench.colorTheme"] !== themeLabel) {
      updates.push({ key: "workbench.colorTheme", value: themeLabel });
    }
    if (settings["workbench.startupEditor"] === undefined)
      updates.push({ key: "workbench.startupEditor", value: "none" });
    if (settings["workbench.secondarySideBar.defaultVisibility"] !== "hidden")
      updates.push({ key: "workbench.secondarySideBar.defaultVisibility", value: "hidden" });
    if (settings["chat.disableAIFeatures"] !== true)
      updates.push({ key: "chat.disableAIFeatures", value: true });
    if (settings["extensions.ignoreRecommendations"] !== true)
      updates.push({ key: "extensions.ignoreRecommendations", value: true });
    if (updates.length === 0) return;

    let updated = raw;
    for (const update of updates)
      updated = applyEdits(
        updated,
        modify(updated, [update.key], update.value, {
          formattingOptions: { insertSpaces: true, tabSize: 2 },
        }),
      );
    await writeFile(settingsPath, `${updated.trimEnd()}\n`);
  }

  private async syncCompanionExtension() {
    const extensionsRoot = join(this.props.root, "extensions");
    const extensionRoot = join(extensionsRoot, "cake-companion");
    await mkdir(extensionRoot, { recursive: true });
    await writeFile(
      join(extensionRoot, "package.json"),
      `${JSON.stringify(this.props.companionManifest, null, 2)}\n`,
    );
    await copyFile(this.props.companionMain, join(extensionRoot, "extension.js"));
    for (const theme of this.props.companionThemes) {
      const relative = theme.path.replace(/^\.?\//, "");
      const target = join(extensionRoot, ...relative.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, theme.content);
    }
    await this.syncExtensionRegistry(extensionsRoot);
    return extensionsRoot;
  }

  /** Keeps Cake's sideloaded extension canonical without altering user extensions. */
  private async syncExtensionRegistry(extensionsRoot: string) {
    let registryRaw: string | undefined;
    try {
      registryRaw = await readFile(join(extensionsRoot, "extensions.json"), "utf8");
    } catch {
      // A missing registry is rebuilt by the next extension-host scan.
      return;
    }
    try {
      const parsed = z
        .array(z.object({ identifier: z.object({ id: z.string() }).loose() }).loose())
        .safeParse(JSON.parse(registryRaw));
      if (!parsed.success) return;
      const canonicalCompanion = {
        identifier: { id: "cake.cake-companion" },
        version: this.props.companionManifest.version,
        location: { scheme: "file", path: join(extensionsRoot, "cake-companion") },
        relativeLocation: "cake-companion",
      };
      const retained = parsed.data.filter(
        (item) => item.identifier.id.toLowerCase() !== "cake.cake-companion",
      );
      const canonical = [...retained, canonicalCompanion];
      if (JSON.stringify(parsed.data) !== JSON.stringify(canonical))
        await writeFile(join(extensionsRoot, "extensions.json"), `${JSON.stringify(canonical)}\n`);
    } catch {
      // A malformed registry is rebuilt on the next extension-host scan.
    }
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
  body: CompanionRequest,
  token: string,
): Promise<void> {
  const payload = Buffer.from(JSON.stringify(body));
  await new Promise<void>((resolvePromise, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: requestPath,
      headers: {
        "content-type": "application/json",
        "content-length": payload.length,
        "x-cake-token": token,
      },
      timeout: 5_000,
    });
    request.on("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
          resolvePromise();
          return;
        }
        reject(
          new Error(
            Buffer.concat(chunks).toString("utf8") ||
              `Companion extension returned HTTP ${response.statusCode ?? "unknown"}`,
          ),
        );
      });
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
