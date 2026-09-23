import { Store } from "r-state-tree";
import type { EditorAnnotationSnapshot } from "../../ipc/editor-annotation";
import type { EditorLocation } from "../../ipc/editor-location";
import type { EditorSelectionHighlights } from "../../ipc/editor-selection";
import type { Attachment } from "../../ipc/session-contract";
import type { EmbeddedEditorStateSnapshot, EmbeddedEditorStatus } from "../client/Client";
import { ClientContext } from "./context/ClientContext";
import type { StoreEvent } from "../events/StoreEvent";
import { describeError } from "../lib/error-details";
import type { ProjectSessionPresentationMode } from "./ProjectSessionStore";

export interface EmbeddedEditorStoreProps {
  projectPath(): string | undefined;
  presentationMode(): ProjectSessionPresentationMode;
  setPresentationMode(mode: ProjectSessionPresentationMode): void;
  chatSidebarVisible(): boolean;
  toggleChatSidebar(): void;
  showChatSidebar(): void;
  chatSidebarWidth(): number;
  setChatSidebarWidth(width: number): void;
  annotations(): EditorAnnotationSnapshot | undefined;
  selectionHighlights(): EditorSelectionHighlights;
  startCakeChat(prompt: string): Promise<void>;
  enterProjectSidebarMode(): void;
  leaveProjectSidebarMode(): void;
  projectSidebarWidth(): number;
}

/** Viewport rect of the editor surface in window DIPs. */
export interface EmbeddedEditorViewport {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const EMPTY_VIEWPORT: EmbeddedEditorViewport = { x: 0, y: 0, width: 0, height: 0 };

/**
 * Owns the embedded VS Code workflow: IDE-mode visibility, install/launch
 * status, native view bounds reporting, and source reveal intents.
 */
export class EmbeddedEditorStore extends Store<EmbeddedEditorStoreProps> {
  visible = false;
  status: EmbeddedEditorStatus = "missing";
  statusMessage: string | undefined;
  customPath: string | undefined;
  error: string | undefined;
  errorDetails: string | undefined;
  /** Most recent workspace-relative path and explicit user selection inside VS Code. */
  lastActivePath: string | undefined;
  activeContextAttachment: Extract<Attachment, { kind: "source" }> | undefined;
  /** Rect the mounted editor surface last measured; undefined while it is unmounted. */
  measuredBounds: EmbeddedEditorViewport | undefined;
  private openedWorkspace: string | undefined;
  private opening: { readonly projectPath: string; readonly promise: Promise<void> } | undefined;
  private installation: Promise<void> | undefined;
  private sentAnnotationsFingerprint: string | undefined;
  private syncingAnnotations = false;
  private annotationSyncPending = false;
  private highlightSyncTail: Promise<void> = Promise.resolve();

  get vscode() {
    return ClientContext.consume(this)!.vscode;
  }

  get chatSidebarVisible() {
    return this.props.chatSidebarVisible();
  }

  get chatSidebarWidth() {
    return this.props.chatSidebarWidth();
  }

  get projectSidebarWidth() {
    return this.props.projectSidebarWidth();
  }

  /** Prevents a previously selected Working Directory from flashing during a session switch. */
  get nativeViewReady() {
    return this.visible && this.openedWorkspace === this.props.projectPath();
  }

  /**
   * What main should do with the native view: where the surface is (so the
   * workbench loads at its final size even while still hidden) and whether to
   * draw it. Derived from Store state so that hiding and re-showing within one
   * tick always settles on the visible payload.
   */
  get nativeViewBounds() {
    const rect = this.measuredBounds ?? EMPTY_VIEWPORT;
    return {
      visible: this.nativeViewReady && rect.width > 0 && rect.height > 0,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      projectSidebarWidth: this.projectSidebarWidth,
    };
  }

  constructor(props: EmbeddedEditorStore["props"]) {
    super(props);
    this.reaction(
      () => JSON.stringify(this.props.annotations()),
      () => void this.syncAnnotations(),
    );
    this.reaction(
      () =>
        JSON.stringify([
          this.nativeViewReady,
          this.props.projectPath(),
          this.props.selectionHighlights(),
        ]),
      () => {
        void this.syncSelectionHighlights().catch((error) => {
          if (!this.signal.aborted) this.error = describeError(error).message;
        });
      },
    );
    this.reaction(
      () => JSON.stringify(this.nativeViewBounds),
      () => void this.pushNativeViewBounds(),
    );
  }

  receive(
    event: Extract<
      StoreEvent,
      {
        type: "embedded-editor-selection" | "embedded-editor-selection-cleared";
      }
    >,
  ) {
    if (event.workspacePath !== this.props.projectPath()) return;
    if (event.type === "embedded-editor-selection-cleared") {
      this.lastActivePath = undefined;
      this.activeContextAttachment = undefined;
      return;
    }
    this.lastActivePath = event.path;
    this.activeContextAttachment = {
      kind: "source",
      name: event.path.slice(-512),
      location: {
        path: event.path,
        range: {
          start: { line: event.startLine },
          end: { line: event.endLine },
        },
      },
    };
  }

  applyState(state: EmbeddedEditorStateSnapshot) {
    this.applySnapshot(state);
  }

  async show(location?: EditorLocation) {
    this.activate();
    await this.open();
    if (location) await this.reveal(location);
  }

  async showSourceControl() {
    const projectPath = this.props.projectPath();
    if (!projectPath) throw new Error("No project is open");
    this.activate();
    await this.open();
    if (
      this.signal.aborted ||
      this.props.projectPath() !== projectPath ||
      this.openedWorkspace !== projectPath
    )
      return;
    try {
      await this.vscode.openSourceControl(projectPath, { signal: this.signal });
    } catch (error) {
      if (this.signal.aborted) return;
      const described = describeError(error);
      this.error = described.message;
      this.errorDetails = described.details;
    }
  }

  private activate() {
    this.props.setPresentationMode("vscode");
    if (!this.visible) this.props.enterProjectSidebarMode();
    this.visible = true;
  }

  /** Restores the selected session's IDE presentation without changing its preference. */
  async restore(location?: EditorLocation) {
    if (this.props.presentationMode() !== "vscode") return;
    await this.show(location);
  }

  /** Toggles only Cake's chat drawer while leaving the VS Code surface mounted. */
  toggleChatSidebar() {
    if (this.visible) this.props.toggleChatSidebar();
  }

  showChatSidebar() {
    if (this.visible) this.props.showChatSidebar();
  }

  setChatSidebarWidth(width: number) {
    this.props.setChatSidebarWidth(width);
  }

  /** Opens the current project's editor; concurrent callers share one in-flight open. */
  async open() {
    const projectPath = this.props.projectPath();
    if (!projectPath) throw new Error("No project is open");
    if (this.opening?.projectPath === projectPath) return this.opening.promise;
    const promise = this.performOpen(projectPath).finally(() => {
      if (this.opening?.promise === promise) this.opening = undefined;
    });
    this.opening = { projectPath, promise };
    return promise;
  }

  private async performOpen(projectPath: string) {
    this.error = undefined;
    this.errorDetails = undefined;
    try {
      await this.vscode.open(projectPath, { signal: this.signal });
      if (this.signal.aborted || this.props.projectPath() !== projectPath) return;
      this.openedWorkspace = projectPath;
      await this.syncAnnotations();
      await this.syncSelectionHighlights();
    } catch (error) {
      if (this.signal.aborted) return;
      const described = describeError(error);
      this.error = described.message;
      this.errorDetails = described.details;
    }
  }

  /** Asks Cake Chat, in a fresh global session, to install and verify a VS Code server. */
  async askCakeToSetUp() {
    const platform = /Mac/.test(navigator.userAgent)
      ? "macOS"
      : /Linux/.test(navigator.userAgent)
        ? "Linux"
        : "Windows";
    const prompt = [
      "Cake's embedded VS Code editor could not find a VS Code server binary on this machine.",
      `Platform: ${platform}.`,
      this.props.projectPath() ? `Project: ${this.props.projectPath()}.` : undefined,
      "",
      "Please set one up for me:",
      "- On macOS, install code-server via Homebrew (`brew install code-server`) and verify it with `code-server --version`. Cake auto-detects /opt/homebrew/bin/code-server, /usr/local/bin/code-server, and /usr/bin/code-server once installed.",
      "- On Linux, no install is needed: Cake downloads openvscode-server automatically; if that download failed, diagnose the network or proxy problem.",
      "- If I already have a compatible server binary somewhere else, tell me where to point CAKE_VSCODE_SERVER_PATH (note: that environment variable must be set before launching Cake).",
      "",
      "When you're done, tell me to click the retry button in Cake's project browser.",
    ]
      .filter((line) => line !== undefined)
      .join("\n");
    this.error = undefined;
    this.errorDetails = undefined;
    try {
      await this.props.startCakeChat(prompt);
    } catch (error) {
      if (this.signal.aborted) return;
      const described = describeError(error);
      this.error = described.message;
      this.errorDetails = described.details;
    }
  }

  install() {
    this.installation ??= this.performInstall().finally(() => {
      if (!this.signal.aborted) this.installation = undefined;
    });
    return this.installation;
  }

  private async performInstall() {
    this.error = undefined;
    this.errorDetails = undefined;
    try {
      await this.vscode.install({ signal: this.signal });
    } catch (error) {
      if (this.signal.aborted) return;
      const described = describeError(error);
      this.error = described.message;
      this.errorDetails = described.details;
    }
  }

  async useExistingInstallation(path: string) {
    try {
      await this.vscode.setServerPath(path || undefined, { signal: this.signal });
    } catch (error) {
      if (this.signal.aborted) return;
      const described = describeError(error, "Embedded editor");
      this.error = described.message;
      this.errorDetails = described.details;
    }
  }

  /** Records the editor surface's measured rect; undefined once the surface unmounts. */
  setMeasuredBounds(bounds: EmbeddedEditorViewport | undefined) {
    this.measuredBounds = bounds;
  }

  private async pushNativeViewBounds() {
    try {
      await this.vscode.updateBounds(this.nativeViewBounds, { signal: this.signal });
    } catch {
      // The next derived change pushes again; a failed push of a superseded rect is ignorable.
    }
  }

  /** Serializes active-session Cake discussion annotations to VS Code. */
  async syncAnnotations() {
    const projectPath = this.props.projectPath();
    if (!projectPath || !this.visible || this.openedWorkspace !== projectPath) return;
    if (this.syncingAnnotations) {
      this.annotationSyncPending = true;
      return;
    }
    this.syncingAnnotations = true;
    try {
      do {
        this.annotationSyncPending = false;
        const snapshot = this.props.annotations();
        if (!snapshot) return;
        const fingerprint = JSON.stringify(snapshot);
        if (fingerprint === this.sentAnnotationsFingerprint) continue;
        await this.vscode.updateAnnotations(projectPath, snapshot, { signal: this.signal });
        if (this.signal.aborted || this.props.projectPath() !== projectPath) return;
        this.sentAnnotationsFingerprint = fingerprint;
      } while (this.annotationSyncPending);
    } catch (error) {
      if (this.signal.aborted) return;
      const described = describeError(error);
      this.error = described.message;
      this.errorDetails = described.details;
    } finally {
      this.syncingAnnotations = false;
    }
  }

  /** Serialize full replacements, reading the active Store only when each send starts. */
  syncSelectionHighlights(): Promise<void> {
    const pending = this.highlightSyncTail.then(async () => {
      this.signal.throwIfAborted();
      const projectPath = this.props.projectPath();
      if (!projectPath || !this.nativeViewReady) return;
      await this.vscode.updateSelectionHighlights(projectPath, this.props.selectionHighlights(), {
        signal: this.signal,
      });
    });
    this.highlightSyncTail = pending.catch(() => undefined);
    return pending;
  }

  async reveal(location: EditorLocation) {
    const projectPath = this.props.projectPath();
    if (!projectPath || !this.visible) throw new Error("Embedded VS Code is not visible");
    if (this.openedWorkspace !== projectPath) await this.open();
    this.signal.throwIfAborted();
    if (this.props.projectPath() !== projectPath || !this.nativeViewReady)
      throw new Error("Embedded VS Code changed before navigation completed");
    return this.vscode.reveal(projectPath, location, { signal: this.signal });
  }

  /** Hides the native surface while retaining the current session's IDE preference. */
  suspend() {
    if (this.visible) this.props.leaveProjectSidebarMode();
    this.visible = false;
    this.lastActivePath = undefined;
    this.activeContextAttachment = undefined;
  }

  /** Explicitly returns the selected session to Agent presentation. */
  hide() {
    this.props.setPresentationMode("normal");
    this.suspend();
  }

  private applySnapshot(state: EmbeddedEditorStateSnapshot) {
    this.status = state.status;
    this.statusMessage = state.message;
    this.customPath = state.customPath;
  }
}
