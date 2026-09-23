import { Option, Schema } from "effect";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, request as httpRequest, type Server as HttpServer } from "node:http";
import net from "node:net";
import { copyFile, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { WebContentsView, BrowserWindow } from "electron";
import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser";
import type { EditorAnnotationSnapshot } from "../../ipc/editor-annotation";
import { EditorSelectionReveal, type EditorSelectionHighlights } from "../../ipc/editor-selection";
import type { EditorLocation } from "../../ipc/editor-location";
import { jsonValueSchema, type JsonValue } from "../../ipc/json-contract";
import type { VscodeEditorAction } from "../../ipc/vscode-editor-action";
import cakeIconMarkup from "../../assets/cake-icon.svg?raw";
import {
  downloadFile,
  extractArchive,
  platformAssetName,
  releaseAssetUrl,
  resolveServerBinary,
  serverFlavor,
  VSCODE_SERVER_VERSION,
  VsCodeServerNotInstalledError,
  type ServerFlavor,
} from "./vscode-server-binary";

/** Idle servers are stopped after this long without an attached viewer or activity. */
export const VSCODE_SERVER_IDLE_TTL = "3 minutes";
/** Hard cap on concurrently running servers; beyond this the least recently used one dies. */
const MAX_RUNNING_SERVERS = 3;
const START_TIMEOUT = 45_000;
const COMPANION_START_TIMEOUT = 5_000;
const COMPANION_SCRIPT_TIMEOUT = 30_000;
const COMPANION_REQUEST_TIMEOUT = 5_000;
const COMPANION_SCRIPT_RESULT_BYTES = 256_000;
/** Explicit selections carry up to 48k of source plus context and a note, JSON-escaped. */
const BRIDGE_MESSAGE_BYTES = 256_000;
const VSCODE_BACKGROUND = { dark: "#121519", light: "#f5f7f9" } as const;
const WORKBENCH_LAYOUT_READY_TIMEOUT_MS = 10_000;
// VS Code exposes editor-title actions to extensions, but those disappear when no
// file is open and it has no public top-level title-bar contribution point. Cake
// owns this managed web surface, so install its shell controls alongside the
// corresponding native title-bar controls and keep them present across rerenders.
const VSCODE_SHELL_CONTROL_PREFIX = "__CAKE_SHELL_CONTROL__";

function waitForWorkbenchLayoutScript(theme: "light" | "dark") {
  const themeClass = theme === "dark" ? "vs-dark" : "vs";
  return `new Promise((resolve) => {
    let timeout;
    const matches = () => {
      const workbench = document.querySelector(".monaco-workbench.${themeClass}");
      const sidebar = document.querySelector(".monaco-workbench .part.sidebar");
      if (!(workbench instanceof HTMLElement) || !(sidebar instanceof HTMLElement)) return false;
      const bounds = sidebar.getBoundingClientRect();
      return bounds.width === 0 || bounds.height === 0;
    };
    const observer = new MutationObserver(() => {
      if (!matches()) return;
      observer.disconnect();
      clearTimeout(timeout);
      resolve(true);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
      childList: true,
      subtree: true,
    });
    timeout = setTimeout(() => {
      observer.disconnect();
      resolve(false);
    }, ${WORKBENCH_LAYOUT_READY_TIMEOUT_MS});
    if (matches()) {
      observer.disconnect();
      clearTimeout(timeout);
      resolve(true);
    }
  })`;
}

function projectSidebarVisibilityScript(visible: boolean) {
  return `(() => {
    window.__cakeProjectSidebarVisible = ${JSON.stringify(visible)};
    const control = document.getElementById("cake-toggle-project-sidebar");
    if (!control) return;
    control.style.display = window.__cakeProjectSidebarVisible ? "none" : "flex";
  })()`;
}

function vscodeShellControlsScript(workspacePath: string, projectSidebarVisible: boolean) {
  return `(() => {
    const cakeIconMarkup = ${JSON.stringify(cakeIconMarkup)};
    const controlPrefix = ${JSON.stringify(VSCODE_SHELL_CONTROL_PREFIX)};
    const workspace = ${JSON.stringify(workspacePath)};
    window.__cakeProjectSidebarVisible = ${JSON.stringify(projectSidebarVisible)};
    const controls = [
      ["cake-back-to-agent", "Cake: Back to Agent", "cake", "back-to-agent", "start"],
      [
        "cake-toggle-project-sidebar",
        "Cake: Toggle Sessions Sidebar",
        "layout-sidebar-left",
        "toggle-project-sidebar",
        "start",
      ],
      [
        "cake-toggle-chat-sidebar",
        "Cake: Toggle Chat Sidebar",
        "layout-sidebar-right",
        "toggle-chat-sidebar",
        "end",
      ],
    ];
    const install = () => {
      const actions = document.querySelector(
        ".part.titlebar .titlebar-right .action-toolbar-container .actions-container",
      );
      const commandCenter = document.querySelector(".part.titlebar .command-center");
      const navigationActions = commandCenter?.querySelector(
        ":scope > .monaco-toolbar > .monaco-action-bar > .actions-container",
      );
      if (!(actions instanceof HTMLElement)) return;
      const projectSidebarActions =
        navigationActions instanceof HTMLElement ? navigationActions : actions;
      const secondarySidebarAction = actions.querySelector(
        '[aria-label*="Toggle Secondary Side Bar"], [title*="Toggle Secondary Side Bar"]',
      );
      secondarySidebarAction?.closest(".action-item")?.remove();
      for (const [id, label, icon, type, placement] of controls) {
        const existing = document.getElementById(id);
        if (existing) {
          if (id === "cake-toggle-project-sidebar") {
            existing.style.display = window.__cakeProjectSidebarVisible ? "none" : "flex";
            if (
              existing.parentElement !== projectSidebarActions ||
              projectSidebarActions.firstElementChild !== existing
            ) {
              projectSidebarActions.prepend(existing);
            }
          }
          continue;
        }
        const item = document.createElement("li");
        item.id = id;
        item.className = "action-item";
        if (id === "cake-toggle-project-sidebar") {
          item.style.display = window.__cakeProjectSidebarVisible ? "none" : "flex";
        }
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
          if (type === "toggle-project-sidebar") item.style.display = "none";
          console.debug(controlPrefix + JSON.stringify({ type, workspace }));
        });
        action.setAttribute("role", "button");
        action.setAttribute("aria-label", label);
        action.title = label;
        item.append(action);
        if (id === "cake-toggle-project-sidebar") projectSidebarActions.prepend(item);
        else if (placement === "start") actions.prepend(item);
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
const editorPreferencesSchema = Schema.StructWithRest(
  Schema.Struct({
    "security.workspace.trust.enabled": Schema.optionalKey(Schema.Boolean),
    "workbench.colorTheme": Schema.optionalKey(Schema.String),
    "workbench.startupEditor": Schema.optionalKey(Schema.String),
    "workbench.secondarySideBar.defaultVisibility": Schema.optionalKey(Schema.String),
    "chat.disableAIFeatures": Schema.optionalKey(Schema.Boolean),
    "extensions.ignoreRecommendations": Schema.optionalKey(Schema.Boolean),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

export type EmbeddedEditorStatus = "missing" | "downloading" | "starting" | "ready" | "failed";

export interface EmbeddedEditorState {
  status: EmbeddedEditorStatus;
  message?: string;
}

/** Payloads the companion extension posts to Cake's localhost bridge. */
const bounded = (minimum: number, maximum: number) =>
  Schema.String.check(Schema.isMinLength(minimum), Schema.isMaxLength(maximum));
const workspaceMessage = { workspace: bounded(1, 4_096) };
const nonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
/** An explicit, user-initiated VS Code selection handed to a Cake action. */
const explicitSelectionMessage = {
  ...workspaceMessage,
  path: bounded(1, 8_192),
  startLine: nonNegativeInt,
  startColumn: nonNegativeInt,
  endLine: nonNegativeInt,
  endColumn: nonNegativeInt,
  selectedText: bounded(1, 48_000),
  contextBefore: bounded(0, 8_000),
  contextAfter: bounded(0, 8_000),
};
const bridgeMessageSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("hello"),
    ...workspaceMessage,
    port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
  }),
  Schema.Struct({ type: Schema.Literal("back-to-agent"), ...workspaceMessage }),
  Schema.Struct({ type: Schema.Literal("toggle-project-sidebar"), ...workspaceMessage }),
  Schema.Struct({ type: Schema.Literal("toggle-chat-sidebar"), ...workspaceMessage }),
  Schema.Struct({
    type: Schema.Literal("open-annotation"),
    ...workspaceMessage,
    sessionId: bounded(1, 256),
    threadId: bounded(1, 256),
  }),
  Schema.Struct({ type: Schema.Literal("selection-cleared"), ...workspaceMessage }),
  Schema.Struct({
    type: Schema.Literal("selection"),
    ...workspaceMessage,
    path: bounded(1, 8_192),
    startLine: nonNegativeInt,
    endLine: nonNegativeInt,
  }),
  Schema.Struct({
    type: Schema.Literal("add-annotation"),
    ...explicitSelectionMessage,
    comment: Schema.optionalKey(bounded(1, 16_000)),
  }),
  Schema.Struct({ type: Schema.Literal("ask-in-side-chat"), ...explicitSelectionMessage }),
]);

interface EmbeddedEditorExplicitSelection {
  readonly path: string;
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly selectedText: string;
  readonly contextBefore: string;
  readonly contextAfter: string;
}

/** Requests Cake posts to the companion extension's localhost server. */
type CompanionRequest =
  | ({ type: "reveal" } & EditorLocation)
  | { type: "open-source-control" }
  | ({ type: "annotations" } & EditorAnnotationSnapshot)
  | ({ type: "selection-highlights" } & EditorSelectionHighlights)
  | { type: "set-theme"; theme: "light" | "dark" }
  | { type: "script"; source: string; input: JsonValue }
  | { type: "editor-action"; action: VscodeEditorAction };

interface BroadcastTarget {
  broadcast(
    event:
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
      | { type: "embedded-editor-toggle-sidebar"; workspacePath: string }
      | { type: "embedded-editor-selection-cleared"; workspacePath: string }
      | ({
          type: "embedded-editor-annotation-requested";
          workspacePath: string;
          comment?: string;
        } & EmbeddedEditorExplicitSelection)
      | ({
          type: "embedded-editor-side-chat-requested";
          workspacePath: string;
        } & EmbeddedEditorExplicitSelection),
  ): void;
  stateChanged(state: EmbeddedEditorState & { customPath?: string }): void;
}

export interface VsCodeServerRuntimeProps extends BroadcastTarget {
  /** Test seam for deterministic child-process lifecycle coverage. */
  spawnServer?: typeof spawn;
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
  /** Forks/replaces one idle eviction in the owning Effect Scope. */
  scheduleIdleEviction(key: string): void;
  cancelIdleEviction(key: string): void;
  invalidateServer(key: string): void;
  evictServer(key: string): Promise<void>;
  pollUntil<A>(
    key: string,
    check: () => A | undefined,
    interval: number,
    timeout: number,
    failure: string,
    signal?: AbortSignal,
  ): Promise<A>;
  acquireServer(
    workspacePath: string,
    binary: string,
    signal?: AbortSignal,
  ): Promise<ServerInstance>;
}

/**
 * One openvscode-server process serving one workspace folder. The process is
 * shared by every Cake surface that opens that folder.
 */
export interface ServerInstance {
  workspacePath: string;
  child: ChildProcess;
  port: number;
  token: string;
  flavor: ServerFlavor;
  binary: string;
  lastUsedAt: number;
  viewers: number;
}

/** The native view one Cake window shows for its current workspace. */
interface ViewEntry {
  workspacePath: string;
  view: WebContentsView;
}

type ViewBounds = {
  visible: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  projectSidebarWidth: number;
};

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
export class VsCodeServerRuntime {
  status: EmbeddedEditorStatus = "missing";
  message: string | undefined;
  private props: VsCodeServerRuntimeProps;
  private servers = new Map<string, ServerInstance>();
  private views = new Map<number, ViewEntry>();
  /** One window's in-flight `open`; later opens for that window wait so it never owns two views. */
  private openings = new Map<number, Promise<void>>();
  /**
   * Latest renderer-owned rect, retained when it arrives before the native view
   * exists. A hidden report without geometry keeps the previous rect.
   */
  private requestedBounds = new Map<number, ViewBounds>();
  /** Windows whose Cake renderer currently owns the viewport with a fullscreen surface. */
  private fullscreenWindows = new Set<number>();
  private companionPorts = new Map<string, number>();
  /** Maps canonical server workspaces back to the project path Cake presents to the renderer. */
  private presentedWorkspacePaths = new Map<string, string>();
  private bridge: HttpServer | undefined;
  private bridgePort: number | undefined;
  private readonly bridgeToken = randomBytes(32).toString("hex");
  /** Theme last pushed to running companions; duplicated pushes are skipped. */
  private pushedTheme: "light" | "dark" | undefined;
  private disposed = false;

  constructor(props: VsCodeServerRuntimeProps) {
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

  setStatus(status: EmbeddedEditorStatus, message?: string) {
    this.status = status;
    this.message = message;
    this.props.stateChanged(this.snapshotState());
  }

  async refreshStatus() {
    if (this.status === "downloading" || this.status === "starting") return;
    try {
      await resolveServerBinary(this.props.root, this.props.customPath());
      this.setStatus("ready");
    } catch {
      this.setStatus("missing");
    }
  }

  /** Downloads and extracts openvscode-server unless a usable binary already exists. */
  async ensureInstalled(): Promise<string> {
    try {
      const binary = await resolveServerBinary(this.props.root, this.props.customPath());
      this.setStatus("ready");
      return binary;
    } catch (error) {
      if (error instanceof VsCodeServerNotInstalledError && process.platform !== "linux")
        throw error;
    }
    await this.download();
    const binary = await resolveServerBinary(this.props.root, this.props.customPath());
    this.setStatus("ready");
    return binary;
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
   * window was previously showing. Opens for the same window run one at a
   * time: a concurrent second open would otherwise attach its own view and
   * orphan the first one in the window.
   */
  open(
    webContentsId: number,
    getWindow: () => BrowserWindow | null,
    workspacePath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const previous = this.openings.get(webContentsId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.openNext(webContentsId, getWindow, workspacePath, signal));
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    this.openings.set(webContentsId, settled);
    void settled.then(() => {
      if (this.openings.get(webContentsId) === settled) this.openings.delete(webContentsId);
    });
    return current;
  }

  private async openNext(
    webContentsId: number,
    getWindow: () => BrowserWindow | null,
    workspacePath: string,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    let binary: string;
    try {
      binary = await this.ensureInstalled();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus(
        error instanceof VsCodeServerNotInstalledError ? "missing" : "failed",
        message,
      );
      throw error;
    }
    const resolved = await realpath(workspacePath);
    signal?.throwIfAborted();
    this.presentedWorkspacePaths.set(resolved, workspacePath);
    const instance = await this.serverFor(resolved, binary, signal);
    signal?.throwIfAborted();

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
    const theme = await this.props.preferredTheme();
    const view = new WebContentsView({
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
    });
    // Chromium otherwise clears a new WebContentsView to white before VS Code
    // has restored its theme. Keep that first paint consistent with Cake.
    view.setBackgroundColor(VSCODE_BACKGROUND[theme]);
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
      signal?.throwIfAborted();
      // loadURL resolves before the asynchronously bootstrapped workbench applies
      // its saved theme and before Cake's companion closes VS Code's primary sidebar.
      // Keep the unattached native view out of sight until both are reflected in the DOM.
      await view.webContents.executeJavaScript(waitForWorkbenchLayoutScript(theme));
      signal?.throwIfAborted();
      await view.webContents.executeJavaScript(
        vscodeShellControlsScript(
          workspacePath,
          (this.requestedBounds.get(webContentsId)?.x ?? 0) > 0,
        ),
      );
      signal?.throwIfAborted();
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

  /**
   * Positions or hides the native view for one window. Bounds are DIPs relative
   * to the content area. A hidden report without geometry (the surface is
   * unmounted) keeps the last rect so the workbench stays laid out and showing
   * it again only flips visibility instead of resizing from an empty view.
   */
  updateBounds(webContentsId: number, requested: ViewBounds) {
    const previousBounds = this.requestedBounds.get(webContentsId);
    const bounds: ViewBounds =
      hasGeometry(requested) || !previousBounds
        ? requested
        : { ...previousBounds, visible: requested.visible };
    const projectSidebarWasVisible = (previousBounds?.x ?? 0) > 0;
    const projectSidebarVisible = bounds.x > 0;
    this.requestedBounds.set(webContentsId, bounds);
    const entry = this.views.get(webContentsId);
    if (!entry) return;
    if (projectSidebarWasVisible !== projectSidebarVisible)
      void entry.view.webContents
        .executeJavaScript(projectSidebarVisibilityScript(projectSidebarVisible))
        .catch(() => undefined);
    this.applyRequestedBounds(webContentsId, entry.view);
    const instance = this.servers.get(entry.workspacePath);
    if (instance) this.touch(instance);
  }

  /** Temporarily suppresses the native editor without changing its retained renderer bounds. */
  setFullscreenSurfaceOpen(webContentsId: number, open: boolean) {
    if (open) this.fullscreenWindows.add(webContentsId);
    else this.fullscreenWindows.delete(webContentsId);
    const entry = this.views.get(webContentsId);
    if (entry) this.applyRequestedBounds(webContentsId, entry.view);
  }

  private applyRequestedBounds(webContentsId: number, view: WebContentsView) {
    const bounds = this.requestedBounds.get(webContentsId);
    if (!bounds) {
      // Nothing has been reported for this window yet; never draw an unplaced view.
      view.setVisible(false);
      return;
    }
    view.setVisible(
      !this.fullscreenWindows.has(webContentsId) && bounds.visible && hasGeometry(bounds),
    );
    if (!hasGeometry(bounds)) return;
    view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    });
  }

  /**
   * Asks the Working Directory's companion extension to reveal an editor
   * location and reports how it was presented.
   */
  async reveal(
    workspacePath: string,
    location: EditorLocation,
    signal?: AbortSignal,
  ): Promise<EditorSelectionReveal> {
    const resolved = await realpath(workspacePath);
    const instance = this.servers.get(resolved);
    if (!instance) throw new Error("The embedded editor is not running for this project yet");
    const port = await this.waitForCompanionPort(resolved, signal);
    this.touch(instance);
    const response = await postJsonResult(
      port,
      "/",
      { type: "reveal", ...location },
      this.bridgeToken,
      COMPANION_REQUEST_TIMEOUT,
      signal,
    );
    return Schema.decodeUnknownSync(EditorSelectionReveal)(response);
  }

  /** Complete presentation replacement; main retains no selection state. */
  async updateSelectionHighlights(
    workingDirectory: string,
    highlights: EditorSelectionHighlights,
    signal?: AbortSignal,
  ): Promise<void> {
    const resolved = await realpath(workingDirectory);
    const instance = this.servers.get(resolved);
    if (!instance) throw new Error("The embedded editor is not running for this project yet");
    const port = await this.waitForCompanionPort(resolved, signal);
    this.touch(instance);
    await postJsonResult(
      port,
      "/",
      { type: "selection-highlights", locations: highlights.locations },
      this.bridgeToken,
      COMPANION_REQUEST_TIMEOUT,
      signal,
    );
  }

  /** Reports whether this workspace currently has a visible embedded editor surface. */
  async isVisible(workspacePath: string) {
    const resolved = await realpath(workspacePath);
    return this.isResolvedWorkspaceVisible(resolved);
  }

  private isResolvedWorkspaceVisible(workspacePath: string) {
    return [...this.views.entries()].some(
      ([ownerId, entry]) =>
        entry.workspacePath === workspacePath &&
        this.requestedBounds.get(ownerId)?.visible === true,
    );
  }

  /** Runs trusted JavaScript in the workspace's companion extension host. */
  async runScript(
    workspacePath: string,
    source: string,
    input: JsonValue,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    const resolved = await realpath(workspacePath);
    const instance = this.servers.get(resolved);
    if (!instance) throw new Error("The embedded editor is not running for this project yet");
    const port = await this.waitForCompanionPort(resolved, signal);
    this.touch(instance);
    return postJsonResult(
      port,
      "/",
      { type: "script", source, input },
      this.bridgeToken,
      COMPANION_SCRIPT_TIMEOUT,
      signal,
    );
  }

  /** Runs one schema-validated, companion-owned editor action for the workspace. */
  async performEditorAction(
    workspacePath: string,
    action: VscodeEditorAction,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    const resolved = await realpath(workspacePath);
    const instance = this.servers.get(resolved);
    if (!instance) throw new Error("The embedded editor is not running for this project yet");
    const port = await this.waitForCompanionPort(resolved, signal);
    this.touch(instance);
    return postJsonResult(
      port,
      "/",
      { type: "editor-action", action },
      this.bridgeToken,
      COMPANION_SCRIPT_TIMEOUT,
      signal,
    );
  }

  /** Opens VS Code's native Source Control view for the workspace. */
  async openSourceControl(workspacePath: string, signal?: AbortSignal) {
    const resolved = await realpath(workspacePath);
    const instance = this.servers.get(resolved);
    if (!instance) throw new Error("The embedded editor is not running for this project yet");
    const port = await this.waitForCompanionPort(resolved, signal);
    this.touch(instance);
    await postJson(port, "/", { type: "open-source-control" }, this.bridgeToken, signal);
  }

  /** Replaces the active session's Cake discussion annotations in VS Code. */
  async updateAnnotations(
    workspacePath: string,
    snapshot: EditorAnnotationSnapshot,
    signal?: AbortSignal,
  ) {
    const resolved = await realpath(workspacePath);
    const instance = this.servers.get(resolved);
    if (!instance) throw new Error("The embedded editor is not running for this project yet");
    const port = await this.waitForCompanionPort(resolved, signal);
    this.touch(instance);
    await postJson(port, "/", { type: "annotations", ...snapshot }, this.bridgeToken, signal);
  }

  /**
   * Pushes Cake's current theme to every running embedded editor. Skipped when
   * the preference is unchanged; servers started later pick the theme up from
   * their seeded preferences.
   */
  async updateTheme(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const theme = await this.props.preferredTheme();
    signal?.throwIfAborted();
    if (theme === this.pushedTheme) return;
    this.pushedTheme = theme;
    const pushes: Array<Promise<void>> = [];
    for (const [workspacePath, port] of this.companionPorts) {
      const instance = this.servers.get(workspacePath);
      if (!instance) continue;
      this.touch(instance);
      pushes.push(
        postJson(port, "/", { type: "set-theme", theme }, this.bridgeToken, signal).catch(() => {
          signal?.throwIfAborted();
          // A stopping companion misses this push; the theme is applied on next start.
        }),
      );
    }
    await Promise.all(pushes);
  }

  private waitForCompanionPort(workspacePath: string, signal?: AbortSignal) {
    return this.props
      .pollUntil(
        `companion:${workspacePath}`,
        () => {
          const port = this.companionPorts.get(workspacePath);
          return port ?? (this.servers.has(workspacePath) ? undefined : 0);
        },
        50,
        COMPANION_START_TIMEOUT,
        "The VS Code companion extension did not finish starting",
        signal,
      )
      .then((port) => {
        if (port === 0) throw new Error("The embedded editor is no longer running");
        return port;
      });
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
    this.fullscreenWindows.delete(webContentsId);
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
    this.disposed = true;
    for (const [, entry] of this.views) entry.view.setVisible(false);
    this.views.clear();
    this.openings.clear();
    this.requestedBounds.clear();
    this.fullscreenWindows.clear();
    this.companionPorts.clear();
    this.presentedWorkspacePaths.clear();
    this.bridge?.close();
    this.bridge = undefined;
    this.bridgePort = undefined;
  }

  /** Returns the running server for a folder or shares one Effect-owned in-flight start. */
  private serverFor(
    resolvedWorkspace: string,
    binary: string,
    signal?: AbortSignal,
  ): Promise<ServerInstance> {
    const existing = this.servers.get(resolvedWorkspace);
    if (existing) return Promise.resolve(existing);
    return this.props.acquireServer(resolvedWorkspace, binary, signal);
  }

  async startServer(
    workspacePath: string,
    binary: string,
    signal?: AbortSignal,
  ): Promise<ServerInstance> {
    signal?.throwIfAborted();
    if (this.disposed) throw new Error("The VS Code runtime has been disposed");
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

    signal?.throwIfAborted();
    if (this.disposed) throw new Error("The VS Code runtime has been disposed");
    const child = (this.props.spawnServer ?? spawn)(
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
      binary,
      lastUsedAt: Date.now(),
      viewers: 0,
    };

    const exitHandler = (code: number | null) => {
      if (this.servers.get(workspacePath) !== instance) return;
      this.forgetServer(instance);
      this.servers.delete(workspacePath);
      this.props.invalidateServer(this.serverCacheKey(instance));
      this.setStatus("failed", `VS Code exited unexpectedly (code ${code ?? "unknown"})`);
    };
    child.once("exit", exitHandler);

    try {
      await waitForServerStart(child, START_TIMEOUT, signal);
      signal?.throwIfAborted();
      if (this.disposed) throw new Error("The VS Code runtime has been disposed");
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
      await this.props.evictServer(this.serverCacheKey(victim));
    }
  }

  private releaseViewer(workspacePath: string) {
    const instance = this.servers.get(workspacePath);
    if (!instance) return;
    instance.viewers = Math.max(0, instance.viewers - 1);
    if (instance.viewers === 0) this.scheduleEviction(instance);
  }

  private scheduleEviction(instance: ServerInstance) {
    this.props.scheduleIdleEviction(this.serverCacheKey(instance));
  }

  private cancelEviction(instance: ServerInstance) {
    this.props.cancelIdleEviction(this.serverCacheKey(instance));
  }

  private serverCacheKey(instance: ServerInstance) {
    return `${instance.workspacePath}\0${instance.binary}`;
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

  releaseServer(instance: ServerInstance) {
    if (this.servers.get(instance.workspacePath) === instance) {
      this.forgetServer(instance);
      this.servers.delete(instance.workspacePath);
    }
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
        if (size > BRIDGE_MESSAGE_BYTES) {
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
    if (this.disposed) {
      server.close();
      throw new Error("The VS Code runtime has been disposed");
    }
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
    const message = Schema.decodeUnknownOption(bridgeMessageSchema)(payload);
    if (Option.isNone(message)) return;
    if (message.value.type === "hello") {
      this.companionPorts.set(message.value.workspace, message.value.port);
      return;
    }
    const presentedWorkspace =
      this.presentedWorkspacePaths.get(message.value.workspace) ?? message.value.workspace;
    if (
      message.value.type === "back-to-agent" ||
      message.value.type === "toggle-project-sidebar" ||
      message.value.type === "toggle-chat-sidebar"
    ) {
      const type =
        message.value.type === "back-to-agent"
          ? "embedded-editor-back-to-agent"
          : message.value.type === "toggle-project-sidebar"
            ? "embedded-editor-toggle-sidebar"
            : "embedded-editor-toggle-chat";
      this.props.broadcast({ type, workspacePath: presentedWorkspace });
      return;
    }
    if (message.value.type === "open-annotation") {
      this.focusCakeWindow(message.value.workspace);
      this.props.broadcast({
        type: "embedded-editor-annotation-opened",
        workspacePath: presentedWorkspace,
        sessionId: message.value.sessionId,
        threadId: message.value.threadId,
      });
      return;
    }
    if (message.value.type === "selection-cleared") {
      this.props.broadcast({
        type: "embedded-editor-selection-cleared",
        workspacePath: presentedWorkspace,
      });
      return;
    }
    if (message.value.type === "selection") {
      this.props.broadcast({
        type: "embedded-editor-selection",
        workspacePath: presentedWorkspace,
        path: message.value.path,
        startLine: message.value.startLine,
        endLine: message.value.endLine,
      });
      return;
    }
    // Explicit selection actions hand the user over to Cake's composer, so focus follows.
    this.focusCakeWindow(message.value.workspace);
    const selection: EmbeddedEditorExplicitSelection = {
      path: message.value.path,
      startLine: message.value.startLine,
      startColumn: message.value.startColumn,
      endLine: message.value.endLine,
      endColumn: message.value.endColumn,
      selectedText: message.value.selectedText,
      contextBefore: message.value.contextBefore,
      contextAfter: message.value.contextAfter,
    };
    if (message.value.type === "add-annotation") {
      this.props.broadcast({
        type: "embedded-editor-annotation-requested",
        workspacePath: presentedWorkspace,
        ...selection,
        ...(message.value.comment !== undefined ? { comment: message.value.comment } : null),
      });
      return;
    }
    this.props.broadcast({
      type: "embedded-editor-side-chat-requested",
      workspacePath: presentedWorkspace,
      ...selection,
    });
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
    const parsed = Schema.decodeUnknownOption(editorPreferencesSchema)(
      parseJsonc(raw, parseErrors, { allowTrailingComma: true }),
    );
    if (parseErrors.length > 0 || Option.isNone(parsed)) {
      // Do not replace malformed user-authored settings.
      return;
    }
    const settings = parsed.value;
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
      const registryItemSchema = Schema.StructWithRest(
        Schema.Struct({
          identifier: Schema.StructWithRest(Schema.Struct({ id: Schema.String }), [
            Schema.Record(Schema.String, Schema.Unknown),
          ]),
        }),
        [Schema.Record(Schema.String, Schema.Unknown)],
      );
      const parsed = Schema.decodeUnknownOption(Schema.Array(registryItemSchema))(
        JSON.parse(registryRaw),
      );
      if (Option.isNone(parsed)) return;
      const canonicalCompanion = {
        identifier: { id: "cake.cake-companion" },
        version: this.props.companionManifest.version,
        location: { scheme: "file", path: join(extensionsRoot, "cake-companion") },
        relativeLocation: "cake-companion",
      };
      const retained = parsed.value.filter(
        (item) => item.identifier.id.toLowerCase() !== "cake.cake-companion",
      );
      const canonical = [...retained, canonicalCompanion];
      if (JSON.stringify(parsed.value) !== JSON.stringify(canonical))
        await writeFile(join(extensionsRoot, "extensions.json"), `${JSON.stringify(canonical)}\n`);
    } catch {
      // A malformed registry is rebuilt on the next extension-host scan.
    }
  }

  private touch(instance: ServerInstance) {
    instance.lastUsedAt = Date.now();
  }
}

function hasGeometry(bounds: ViewBounds) {
  return bounds.width > 0 && bounds.height > 0;
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
  signal?: AbortSignal,
): Promise<void> {
  await postJsonResponse(port, requestPath, body, token, COMPANION_REQUEST_TIMEOUT, signal);
}

async function postJsonResult(
  port: number,
  requestPath: string,
  body: CompanionRequest,
  token: string,
  timeout: number,
  signal?: AbortSignal,
): Promise<JsonValue> {
  const response = await postJsonResponse(port, requestPath, body, token, timeout, signal);
  const parsed: unknown = response.length === 0 ? null : JSON.parse(response.toString("utf8"));
  return Schema.decodeUnknownSync(jsonValueSchema)(parsed);
}

function postJsonResponse(
  port: number,
  requestPath: string,
  body: CompanionRequest,
  token: string,
  timeout: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise<Buffer>((resolvePromise, reject) => {
    signal?.throwIfAborted();
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
      timeout,
    });
    const onAbort = () => request.destroy(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    request.on("response", (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > COMPANION_SCRIPT_RESULT_BYTES) {
          response.destroy(new Error("Companion extension response was too large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        const responseBody = Buffer.concat(chunks);
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
          cleanup();
          resolvePromise(responseBody);
          return;
        }
        cleanup();
        reject(
          new Error(
            responseBody.toString("utf8") ||
              `Companion extension returned HTTP ${response.statusCode ?? "unknown"}`,
          ),
        );
      });
      response.on("error", (error) => {
        cleanup();
        reject(error);
      });
    });
    request.on("timeout", () => {
      request.destroy(new Error("Companion extension did not respond"));
    });
    request.on("error", (error) => {
      cleanup();
      reject(error);
    });
    request.end(payload);
  });
}

function waitForServerStart(
  child: ChildProcess,
  timeout: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    signal?.throwIfAborted();
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
    const onAbort = () => {
      cleanup();
      child.kill();
      reject(signal?.reason);
    };
    function cleanup() {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    }
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
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
