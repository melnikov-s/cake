import { Store } from "r-state-tree";
import { ClientContext } from "./context/ClientContext";
import { ActiveProjectSessionContext } from "./context/ActiveProjectSessionContext";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";

export type CommandPane = "changelog" | "tree" | "resources";
export type TreeNavigationSummaryMode = "none" | "summary" | "custom";

export interface TreeNavigationPrompt {
  entryId: string;
  summaryMode: TreeNavigationSummaryMode;
  customInstructions: string;
}

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
  navigationPrompt: TreeNavigationPrompt | undefined;
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
    this.navigationPrompt = undefined;
  }

  requestNavigation(entryId: string) {
    if (!this.activeSession || this.signal.aborted || this.navigationPrompt) return false;
    this.pane = undefined;
    this.navigationPrompt = {
      entryId,
      summaryMode: "none",
      customInstructions: "",
    };
    return true;
  }

  selectNavigationSummary(summaryMode: TreeNavigationSummaryMode) {
    if (this.navigationPrompt) this.navigationPrompt = { ...this.navigationPrompt, summaryMode };
  }

  setNavigationInstructions(customInstructions: string) {
    if (this.navigationPrompt)
      this.navigationPrompt = { ...this.navigationPrompt, customInstructions };
  }

  cancelNavigation() {
    this.navigationPrompt = undefined;
  }

  async confirmNavigation() {
    const prompt = this.navigationPrompt;
    if (!prompt) return false;
    const customInstructions = prompt.customInstructions.trim();
    if (prompt.summaryMode === "custom" && !customInstructions) return false;
    this.navigationPrompt = undefined;
    const options = { summarize: prompt.summaryMode !== "none" };
    if (prompt.summaryMode === "custom") Object.assign(options, { customInstructions });
    return this.navigateTo(prompt.entryId, options);
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
  private async navigateTo(
    entryId: string,
    options: { summarize: boolean; customInstructions?: string },
  ) {
    const context = this.activeSession;
    if (!context || this.signal.aborted) return false;
    const revision = ++this.navigationRevision;
    const editorText = this.props.editorText(entryId);
    const operationId = this.props.operations.start("project-workbench");
    try {
      await this.client.projectSessions.navigate(
        { sessionId: context.sessionId, entryId, ...options },
        { signal: this.signal },
      );
      if (!this.signal.aborted && revision === this.navigationRevision) {
        if (editorText !== undefined) this.props.setDraft(editorText);
        this.props.requestComposerFocus();
      }
      return !this.signal.aborted;
    } catch (error) {
      if (!this.signal.aborted && revision === this.navigationRevision)
        this.props.reportError(error);
      return false;
    } finally {
      this.props.operations.finish(operationId);
    }
  }
}
