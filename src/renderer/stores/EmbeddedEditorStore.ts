import { Store } from "r-state-tree";
import type { SourceLocation } from "../../ipc/source-location";
import type { Attachment, UiPart } from "../../ipc/session-contract";
import { agentChanges } from "../../utils/agent-changes";
import type {
  DesktopClient,
  DesktopClientEvent,
  EmbeddedEditorStateSnapshot,
  EmbeddedEditorStatus,
} from "../desktop-client";
import { describeError } from "../error-details";

export interface EmbeddedEditorStoreProps {
  client: Pick<
    DesktopClient,
    | "getEmbeddedEditorState"
    | "installEmbeddedEditor"
    | "setVscodeServerPath"
    | "openEmbeddedEditor"
    | "updateEmbeddedEditorBounds"
    | "revealInEmbeddedEditor"
    | "updateEmbeddedEditorChanges"
  >;
  projectPath(): string | undefined;
  parts(): readonly UiPart[];
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
  /** Most recent workspace-relative path and visible selection inside VS Code. */
  lastActivePath: string | undefined;
  activeContextAttachment: Extract<Attachment, { kind: "source" }> | undefined;
  private openedWorkspace: string | undefined;
  private boundsRevision = 0;
  private refreshRevision = 0;
  private installation: Promise<void> | undefined;
  private sentChangesFingerprint: string | undefined;
  private syncingChanges = false;
  private changeSyncPending = false;

  async refresh() {
    const revision = ++this.refreshRevision;
    try {
      const state: EmbeddedEditorStateSnapshot = await this.props.client.getEmbeddedEditorState();
      if (this.signal.aborted || revision !== this.refreshRevision) return;
      this.applySnapshot(state);
    } catch (error) {
      if (this.signal.aborted || revision !== this.refreshRevision) return;
      const described = describeError(error);
      this.error = described.message;
      this.errorDetails = described.details;
    }
  }

  receive(
    event: Extract<
      DesktopClientEvent,
      { type: "embedded-editor-state-received" | "embedded-editor-activity" }
    >,
  ) {
    if (event.type === "embedded-editor-state-received") {
      this.applySnapshot({ status: event.status, message: event.message });
      return;
    }
    if (event.workspacePath !== this.props.projectPath()) return;
    this.lastActivePath = event.path;
    this.activeContextAttachment = {
      kind: "source",
      name: event.path.slice(-512),
      location: {
        path: event.path,
        documentVersion: event.documentVersion,
        range: {
          start: { line: event.startLine, column: event.startColumn },
          end: { line: event.endLine, column: event.endColumn },
        },
      },
      selectedText: event.selectedText,
      contextBefore: event.contextBefore,
      contextAfter: event.contextAfter,
    };
  }

  async show(location?: SourceLocation) {
    this.visible = true;
    await this.open();
    if (location) await this.reveal(location);
  }

  /** Toggles IDE mode from inside VS Code; hiding reports null bounds immediately. */
  async toggleChat() {
    if (this.visible) {
      this.hide();
      return;
    }
    await this.show();
  }

  async open() {
    const projectPath = this.props.projectPath();
    if (!projectPath) throw new Error("No project is open");
    this.error = undefined;
    this.errorDetails = undefined;
    try {
      await this.props.client.openEmbeddedEditor(projectPath);
      if (this.signal.aborted || this.props.projectPath() !== projectPath) return;
      this.openedWorkspace = projectPath;
      await this.syncAgentChanges();
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
      await this.props.client.installEmbeddedEditor();
    } catch (error) {
      if (this.signal.aborted) return;
      const described = describeError(error);
      this.error = described.message;
      this.errorDetails = described.details;
    }
  }

  async useExistingInstallation(path: string) {
    try {
      await this.props.client.setVscodeServerPath(path || undefined);
    } catch (error) {
      if (this.signal.aborted) return;
      const described = describeError(error, "Embedded editor");
      this.error = described.message;
      this.errorDetails = described.details;
    }
    await this.refresh();
  }

  /** Reports the visible rect of the embedded surface; null hides the native view. */
  async reportBounds(bounds: { x: number; y: number; width: number; height: number } | null) {
    const revision = ++this.boundsRevision;
    const payload = bounds
      ? { visible: true, ...bounds }
      : { visible: false, x: 0, y: 0, width: 0, height: 0 };
    try {
      await this.props.client.updateEmbeddedEditorBounds(payload);
    } catch {
      // A stale bounds report after a newer one is expected and ignorable.
      if (revision !== this.boundsRevision) return;
    }
  }

  /** Serializes transcript-derived edits to VS Code; a newer update wins after the active send. */
  async syncAgentChanges() {
    const projectPath = this.props.projectPath();
    if (!projectPath || !this.visible || this.openedWorkspace !== projectPath) return;
    if (this.syncingChanges) {
      this.changeSyncPending = true;
      return;
    }
    this.syncingChanges = true;
    try {
      do {
        this.changeSyncPending = false;
        const changes = agentChanges(this.props.parts());
        const fingerprint = JSON.stringify(changes);
        if (fingerprint === this.sentChangesFingerprint) continue;
        await this.props.client.updateEmbeddedEditorChanges(projectPath, changes);
        if (this.signal.aborted || this.props.projectPath() !== projectPath) return;
        this.sentChangesFingerprint = fingerprint;
      } while (this.changeSyncPending);
    } catch (error) {
      if (this.signal.aborted) return;
      const described = describeError(error);
      this.error = described.message;
      this.errorDetails = described.details;
    } finally {
      this.syncingChanges = false;
    }
  }

  async reveal(location: SourceLocation) {
    const projectPath = this.props.projectPath();
    if (!projectPath || !this.visible) return;
    if (this.openedWorkspace !== projectPath) await this.open();
    if (this.signal.aborted || this.props.projectPath() !== projectPath || !this.visible) return;
    try {
      await this.props.client.revealInEmbeddedEditor(projectPath, location);
    } catch (error) {
      if (this.signal.aborted) return;
      const described = describeError(error);
      this.error = described.message;
      this.errorDetails = described.details;
    }
  }

  hide() {
    this.visible = false;
    void this.reportBounds(null);
  }

  close() {
    this.hide();
    this.openedWorkspace = undefined;
    this.lastActivePath = undefined;
    this.activeContextAttachment = undefined;
    this.sentChangesFingerprint = undefined;
    this.changeSyncPending = false;
  }

  private applySnapshot(state: EmbeddedEditorStateSnapshot) {
    this.status = state.status;
    this.statusMessage = state.message;
    this.customPath = state.customPath;
  }
}
