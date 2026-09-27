import { BrowserWindow, WebContentsView } from "electron";
import { Option, Schema } from "effect";
import type { CakeEvent } from "../../ipc/cake-rpc-contract";
import {
  projectSidebarVisibilityScript,
  VSCODE_BACKGROUND,
  VSCODE_SHELL_CONTROL_PREFIX,
  vscodeShellControlsScript,
  waitForWorkbenchLayoutScript,
} from "./vscode-view-scripts";

export interface VsCodeViewBounds {
  readonly visible: boolean;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly projectSidebarWidth: number;
}
export interface VsCodeViewEndpoint {
  readonly workspacePath: string;
  readonly url: string;
  readonly theme: "light" | "dark";
}
interface ViewEntry extends VsCodeViewEndpoint {
  readonly view: WebContentsView;
}
const shellControl = Schema.Struct({
  type: Schema.Literals(["back-to-agent", "toggle-project-sidebar", "toggle-chat-sidebar"]),
  workspace: Schema.String,
});
const hasGeometry = (bounds: VsCodeViewBounds) => bounds.width > 0 && bounds.height > 0;

/** Native presentation only. Never resolves workspace paths or starts a server. */
export class VsCodeViewsRuntime {
  private readonly views = new Map<number, ViewEntry>();
  private readonly requestedBounds = new Map<number, VsCodeViewBounds>();
  private readonly fullscreenWindows = new Set<number>();
  private disposed = false;
  constructor(private readonly send: (nativeId: number, event: CakeEvent) => void) {}

  async open(
    nativeId: number,
    window: BrowserWindow,
    endpoint: VsCodeViewEndpoint,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    if (this.disposed || window.isDestroyed())
      throw new Error("The editor window is no longer available");
    const previous = this.views.get(nativeId);
    if (previous?.url === endpoint.url) return;
    this.closeForWindow(nativeId, false);
    const view = new WebContentsView({
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
    });
    view.setBackgroundColor(VSCODE_BACKGROUND[endpoint.theme]);
    const entry = { ...endpoint, view };
    this.views.set(nativeId, entry);
    // The managed workbench must not navigate to another origin or open arbitrary windows.
    const address = new URL(endpoint.url);
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    view.webContents.on("will-navigate", (event, url) => {
      const target = new URL(url);
      if (target.origin !== address.origin || !target.pathname.startsWith(address.pathname))
        event.preventDefault();
    });
    view.webContents.on("console-message", (event) => {
      if (!event.message.startsWith(VSCODE_SHELL_CONTROL_PREFIX)) return;
      event.preventDefault();
      let value: unknown;
      try {
        value = JSON.parse(event.message.slice(VSCODE_SHELL_CONTROL_PREFIX.length));
      } catch {
        return;
      }
      const parsed = Schema.decodeUnknownOption(shellControl)(value);
      if (Option.isNone(parsed) || parsed.value.workspace !== endpoint.workspacePath) return;
      this.send(nativeId, {
        type:
          parsed.value.type === "back-to-agent"
            ? "embedded-editor-back-to-agent"
            : parsed.value.type === "toggle-project-sidebar"
              ? "embedded-editor-toggle-sidebar"
              : "embedded-editor-toggle-chat",
        workspacePath: endpoint.workspacePath,
      });
    });
    this.applyRequestedBounds(nativeId, view);
    const closeOnAbort = () => {
      if (this.views.get(nativeId) === entry) this.closeForWindow(nativeId, false);
    };
    signal.addEventListener("abort", closeOnAbort, { once: true });
    try {
      await view.webContents.loadURL(endpoint.url);
      signal.throwIfAborted();
      await view.webContents.executeJavaScript(waitForWorkbenchLayoutScript(endpoint.theme));
      signal.throwIfAborted();
      await view.webContents.executeJavaScript(
        vscodeShellControlsScript(
          endpoint.workspacePath,
          (this.requestedBounds.get(nativeId)?.x ?? 0) > 0,
        ),
      );
      signal.throwIfAborted();
      if (this.disposed || window.isDestroyed() || this.views.get(nativeId) !== entry)
        throw new Error("The editor window is no longer available");
      window.contentView.addChildView(view);
      this.applyRequestedBounds(nativeId, view);
    } catch (error) {
      closeOnAbort();
      throw error;
    } finally {
      signal.removeEventListener("abort", closeOnAbort);
    }
  }

  updateBounds(nativeId: number, requested: VsCodeViewBounds) {
    const previous = this.requestedBounds.get(nativeId);
    const bounds =
      hasGeometry(requested) || !previous ? requested : { ...previous, visible: requested.visible };
    this.requestedBounds.set(nativeId, bounds);
    const entry = this.views.get(nativeId);
    if (!entry) return;
    if ((previous?.x ?? 0) > 0 !== bounds.x > 0)
      void entry.view.webContents
        .executeJavaScript(projectSidebarVisibilityScript(bounds.x > 0))
        .catch(() => undefined);
    this.applyRequestedBounds(nativeId, entry.view);
  }

  setFullscreenSurfaceOpen(nativeId: number, open: boolean) {
    if (open) this.fullscreenWindows.add(nativeId);
    else this.fullscreenWindows.delete(nativeId);
    const entry = this.views.get(nativeId);
    if (entry) this.applyRequestedBounds(nativeId, entry.view);
  }

  private applyRequestedBounds(nativeId: number, view: WebContentsView) {
    const bounds = this.requestedBounds.get(nativeId);
    view.setVisible(
      Boolean(
        bounds && !this.fullscreenWindows.has(nativeId) && bounds.visible && hasGeometry(bounds),
      ),
    );
    if (!bounds || !hasGeometry(bounds)) return;
    view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    });
  }

  backToAgentForWindow(nativeId: number) {
    const entry = this.views.get(nativeId);
    const bounds = this.requestedBounds.get(nativeId);
    if (!entry || !bounds?.visible) return false;
    this.updateBounds(nativeId, { ...bounds, visible: false });
    this.send(nativeId, {
      type: "embedded-editor-back-to-agent",
      workspacePath: entry.workspacePath,
    });
    return true;
  }

  closeForWindow(nativeId: number, forgetBounds = true) {
    if (forgetBounds) {
      this.fullscreenWindows.delete(nativeId);
      this.requestedBounds.delete(nativeId);
    }
    const entry = this.views.get(nativeId);
    if (!entry) return;
    this.views.delete(nativeId);
    const window = BrowserWindow.getAllWindows().find(
      (candidate) => candidate.webContents.id === nativeId,
    );
    if (window && !window.isDestroyed()) window.contentView.removeChildView(entry.view);
    // Removing a WebContentsView does not destroy its WebContents or release network connections.
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
  }

  disposeAll() {
    this.disposed = true;
    for (const nativeId of this.views.keys()) this.closeForWindow(nativeId);
    this.requestedBounds.clear();
    this.fullscreenWindows.clear();
  }
}
