import { Store } from "r-state-tree";
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
  >;
  projectPath(): string | undefined;
  schedulePersistence(): void;
}

/**
 * Owns the embedded VS Code editor workflow for the project browser: the
 * built-in-reader vs. VS Code mode choice, install/launch status, native view
 * bounds reporting, and reveal intents into the running editor.
 */
export class EmbeddedEditorStore extends Store<EmbeddedEditorStoreProps> {
  mode: "builtin" | "vscode" = "builtin";
  status: EmbeddedEditorStatus = "missing";
  statusMessage: string | undefined;
  customPath: string | undefined;
  error: string | undefined;
  errorDetails: string | undefined;
  /** Most recent workspace-relative path the user was editing inside VS Code. */
  lastActivePath: string | undefined;
  private openedWorkspace: string | undefined;
  private boundsRevision = 0;

  async refresh() {
    try {
      const state: EmbeddedEditorStateSnapshot = await this.props.client.getEmbeddedEditorState();
      if (this.signal.aborted) return;
      this.applySnapshot(state);
    } catch (error) {
      const described = describeError(error);
      this.error = described.message;
      this.errorDetails = described.details;
    }
  }

  setMode(mode: "builtin" | "vscode") {
    if (this.mode === mode) return;
    this.mode = mode;
    this.props.schedulePersistence();
    if (mode === "vscode") void this.open();
    else void this.reportBounds(null);
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
    if (event.workspacePath === this.props.projectPath()) this.lastActivePath = event.path;
  }

  async open() {
    const projectPath = this.props.projectPath();
    if (!projectPath) throw new Error("No project is open");
    this.error = undefined;
    this.errorDetails = undefined;
    try {
      await this.props.client.openEmbeddedEditor(projectPath);
      this.openedWorkspace = projectPath;
    } catch (error) {
      const described = describeError(error);
      this.error = described.message;
      this.errorDetails = described.details;
    }
  }

  async install() {
    this.error = undefined;
    this.errorDetails = undefined;
    try {
      await this.props.client.installEmbeddedEditor();
    } catch (error) {
      const described = describeError(error);
      this.error = described.message;
      this.errorDetails = described.details;
    }
  }

  async useExistingInstallation(path: string) {
    try {
      await this.props.client.setVscodeServerPath(path || undefined);
    } catch (error) {
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

  async reveal(path: string, line?: number) {
    const projectPath = this.props.projectPath();
    if (!projectPath || this.mode !== "vscode") return;
    if (this.openedWorkspace !== projectPath) await this.open();
    try {
      await this.props.client.revealInEmbeddedEditor(projectPath, path, line);
    } catch (error) {
      const described = describeError(error);
      this.error = described.message;
      this.errorDetails = described.details;
    }
  }

  close() {
    this.openedWorkspace = undefined;
    this.lastActivePath = undefined;
    void this.reportBounds(null);
  }

  private applySnapshot(state: EmbeddedEditorStateSnapshot) {
    this.status = state.status;
    this.statusMessage = state.message;
    this.customPath = state.customPath;
  }
}
