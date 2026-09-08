import { Store } from "r-state-tree";
import { ClientContext } from "./context/ClientContext";
import { ActiveProjectSessionContext } from "./context/ActiveProjectSessionContext";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";

export type CommandPane = "changelog" | "tree" | "resources";

export interface CommandPaneStoreProps {
  operations: SessionOperationCoordinatorStore;
  editorText(entryId: string): string | undefined;
  setDraft(value: string): void;
  requestComposerFocus(): void;
  reportError(error: unknown): void;
}

/** Owns command-pane selection, changelog loading, and session-tree navigation. */
export class CommandPaneStore extends Store<CommandPaneStoreProps> {
  pane: CommandPane | undefined;
  changelogMarkdown = "";
  changelogLoading = false;
  private navigationRevision = 0;

  get client() {
    return ClientContext.consume(this)!;
  }

  get activeSession() {
    return ActiveProjectSessionContext.consume(this);
  }

  async open(pane: CommandPane) {
    this.pane = pane;
    if (pane === "changelog") await this.refreshChangelog();
  }

  toggle(pane: CommandPane) {
    if (this.pane === pane) this.close();
    else void this.open(pane);
  }

  close() {
    this.pane = undefined;
    this.props.requestComposerFocus();
  }

  dismiss() {
    this.pane = undefined;
  }

  async refreshChangelog() {
    const context = this.activeSession;
    if (!context || this.changelogLoading || this.signal.aborted) return;
    const operationId = this.props.operations.start("project-workbench");
    this.changelogLoading = true;
    try {
      this.changelogMarkdown = await this.client.projectSessions.getChangelog(
        { sessionId: context.sessionId },
        { signal: this.signal },
      );
    } catch (error) {
      if (!this.signal.aborted) this.props.reportError(error);
    } finally {
      this.changelogLoading = false;
      this.props.operations.finish(operationId);
    }
  }

  /** Navigation dispatch is latest-wins for draft restoration. */
  async navigateTo(entryId: string) {
    const context = this.activeSession;
    if (!context || this.signal.aborted) return;
    const revision = ++this.navigationRevision;
    const editorText = this.props.editorText(entryId);
    this.close();
    const operationId = this.props.operations.start("project-workbench");
    try {
      await this.client.projectSessions.navigate(
        { sessionId: context.sessionId, entryId },
        { signal: this.signal },
      );
      if (!this.signal.aborted && revision === this.navigationRevision && editorText !== undefined)
        this.props.setDraft(editorText);
    } catch (error) {
      if (!this.signal.aborted && revision === this.navigationRevision)
        this.props.reportError(error);
    } finally {
      this.props.operations.finish(operationId);
    }
  }
}
