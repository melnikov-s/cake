import { Store } from "r-state-tree";
import type { DesktopClient, DesktopClientEvent } from "../desktop-client";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";

export type CommandPane = "changelog" | "tree" | "resources";

export interface CommandPaneStoreProps {
  client: Pick<DesktopClient, "getChangelog" | "navigateSession">;
  operations: SessionOperationCoordinatorStore;
  sessionContext(): { sessionId: string } | undefined;
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
  private changelogOperationId: string | undefined;
  private navigationRevision = 0;
  private readonly navigationOperationIds = new Set<string>();

  constructor(props: CommandPaneStore["props"]) {
    super(props);
    this.effect(() => () => {
      if (this.changelogOperationId) this.props.operations.finish(this.changelogOperationId);
      for (const operationId of this.navigationOperationIds)
        this.props.operations.finish(operationId);
    });
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
    const context = this.props.sessionContext();
    if (!context || this.changelogLoading || this.signal.aborted) return;
    const operationId = this.props.operations.start("project-workbench");
    this.changelogOperationId = operationId;
    this.changelogLoading = true;
    try {
      await this.props.client.getChangelog({ operationId, sessionId: context.sessionId });
    } catch (error) {
      if (this.signal.aborted) return;
      this.changelogOperationId = undefined;
      this.changelogLoading = false;
      this.props.operations.finish(operationId);
      this.props.reportError(error);
    }
  }

  /** Navigation dispatch is latest-wins for draft restoration. */
  async navigateTo(entryId: string) {
    const context = this.props.sessionContext();
    if (!context || this.signal.aborted) return;
    const revision = ++this.navigationRevision;
    const editorText = this.props.editorText(entryId);
    this.close();
    const operationId = this.props.operations.start("project-workbench");
    this.navigationOperationIds.add(operationId);
    try {
      await this.props.client.navigateSession({
        operationId,
        sessionId: context.sessionId,
        entryId,
      });
      if (!this.signal.aborted && revision === this.navigationRevision && editorText !== undefined)
        this.props.setDraft(editorText);
    } catch (error) {
      this.navigationOperationIds.delete(operationId);
      this.props.operations.finish(operationId);
      if (!this.signal.aborted && revision === this.navigationRevision)
        this.props.reportError(error);
    }
  }

  receive(event: DesktopClientEvent) {
    if (
      event.type === "operation-completed" &&
      this.navigationOperationIds.has(event.operationId)
    ) {
      this.navigationOperationIds.delete(event.operationId);
      this.props.operations.finish(event.operationId);
      return true;
    }
    if (event.type === "changelog-received") {
      if (event.operationId !== this.changelogOperationId) return false;
      this.finishChangelogOperation(event.operationId);
      if (event.sessionId === this.props.sessionContext()?.sessionId)
        this.changelogMarkdown = event.markdown;
      return true;
    }
    if (event.type === "operation-failed" && event.operationId !== undefined) {
      if (this.navigationOperationIds.has(event.operationId)) {
        this.navigationOperationIds.delete(event.operationId);
        this.props.operations.finish(event.operationId);
        this.props.reportError(event.message);
        return true;
      }
      if (event.operationId === this.changelogOperationId) {
        this.finishChangelogOperation(event.operationId);
        this.props.reportError(event.message);
        return true;
      }
    }
    if (
      event.type === "pi-state-changed" &&
      (event.state === "failed" || event.state === "stopped")
    ) {
      if (this.changelogOperationId) this.finishChangelogOperation(this.changelogOperationId);
      for (const operationId of this.navigationOperationIds)
        this.props.operations.finish(operationId);
      this.navigationOperationIds.clear();
      return true;
    }
    return false;
  }

  private finishChangelogOperation(operationId: string) {
    this.changelogOperationId = undefined;
    this.changelogLoading = false;
    this.props.operations.finish(operationId);
  }
}
