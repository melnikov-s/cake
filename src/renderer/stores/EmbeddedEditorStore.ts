import { Store } from "r-state-tree";
import type { EditorAnnotationSnapshot } from "../../ipc/editor-annotation";
import type { SourceLocation } from "../../ipc/source-location";
import type { Attachment } from "../../ipc/session-contract";
import type { EmbeddedEditorStateSnapshot, EmbeddedEditorStatus } from "../client/RendererClient";
import { RendererClientContext } from "../client/RendererClientContext";
import type { RendererEvent } from "../RendererEvent";
import { describeError } from "../error-details";

export interface EmbeddedEditorStoreProps {
  projectPath(): string | undefined;
  ideMode(): boolean;
  setIdeMode(active: boolean): void;
  chatSidebarVisible(): boolean;
  toggleChatSidebar(): void;
  showChatSidebar(): void;
  chatSidebarWidth(): number;
  setChatSidebarWidth(width: number): void;
  annotations(): EditorAnnotationSnapshot | undefined;
  startCakeChat(prompt: string): Promise<void>;
}

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
  private openedWorkspace: string | undefined;
  private boundsRevision = 0;
  private installation: Promise<void> | undefined;
  private sentAnnotationsFingerprint: string | undefined;
  private syncingAnnotations = false;
  private annotationSyncPending = false;

  get vscode() {
    return RendererClientContext.consume(this)!.vscode;
  }

  get chatSidebarVisible() {
    return this.props.chatSidebarVisible();
  }

  get chatSidebarWidth() {
    return this.props.chatSidebarWidth();
  }

  /** Prevents a previously selected Working Directory from flashing during a session switch. */
  get nativeViewReady() {
    return this.visible && this.openedWorkspace === this.props.projectPath();
  }

  constructor(props: EmbeddedEditorStore["props"]) {
    super(props);
    this.reaction(
      () => JSON.stringify(this.props.annotations()),
      () => void this.syncAnnotations(),
    );
  }

  receive(
    event: Extract<
      RendererEvent,
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

  async show(location?: SourceLocation) {
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

  /** Adopts an editor instance that main opened for an agent-directed action. */
  showAgentEditor() {
    const projectPath = this.props.projectPath();
    if (!projectPath) return;
    this.activate();
    this.openedWorkspace = projectPath;
    void this.syncAnnotations();
  }

  private activate() {
    this.props.setIdeMode(true);
    this.visible = true;
  }

  /** Restores the selected session's IDE presentation without changing its preference. */
  async restore() {
    if (!this.props.ideMode()) return;
    this.visible = true;
    await this.open();
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

  async open() {
    const projectPath = this.props.projectPath();
    if (!projectPath) throw new Error("No project is open");
    this.error = undefined;
    this.errorDetails = undefined;
    try {
      await this.vscode.open(projectPath, { signal: this.signal });
      if (this.signal.aborted || this.props.projectPath() !== projectPath) return;
      this.openedWorkspace = projectPath;
      await this.syncAnnotations();
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

  /** Reports the visible rect of the embedded surface; null hides the native view. */
  async reportBounds(bounds: { x: number; y: number; width: number; height: number } | null) {
    const revision = ++this.boundsRevision;
    const payload = bounds
      ? { visible: true, ...bounds }
      : { visible: false, x: 0, y: 0, width: 0, height: 0 };
    try {
      await this.vscode.updateBounds(payload, { signal: this.signal });
    } catch {
      // A stale bounds report after a newer one is expected and ignorable.
      if (revision !== this.boundsRevision) return;
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

  async reveal(location: SourceLocation) {
    const projectPath = this.props.projectPath();
    if (!projectPath || !this.visible) return;
    if (this.openedWorkspace !== projectPath) await this.open();
    if (this.signal.aborted || this.props.projectPath() !== projectPath || !this.visible) return;
    try {
      await this.vscode.reveal(projectPath, location, { signal: this.signal });
    } catch (error) {
      if (this.signal.aborted) return;
      const described = describeError(error);
      this.error = described.message;
      this.errorDetails = described.details;
    }
  }

  /** Hides the native surface while retaining the current session's IDE preference. */
  suspend() {
    this.visible = false;
    this.lastActivePath = undefined;
    this.activeContextAttachment = undefined;
    void this.reportBounds(null);
  }

  /** Explicitly returns the selected session to Agent presentation. */
  hide() {
    this.props.setIdeMode(false);
    this.suspend();
  }

  private applySnapshot(state: EmbeddedEditorStateSnapshot) {
    this.status = state.status;
    this.statusMessage = state.message;
    this.customPath = state.customPath;
  }
}
