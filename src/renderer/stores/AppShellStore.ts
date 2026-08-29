import { Store, observable } from "r-state-tree";
import type { WindowConversationSelection } from "../../ipc/session-contract";

export type AppSurface = "workbench" | "global-chat" | "settings";

export type AppSelection =
  | { kind: "workbench" }
  | { kind: "project-session"; workspacePath: string; sessionId: string }
  | { kind: "cake-chat"; sessionId?: string }
  | { kind: "settings" };

/** One visited conversation in the window's back/forward session history. */
export type SessionHistoryEntry =
  | { kind: "project-session"; sessionId: string }
  | { kind: "cake-chat"; sessionId: string };

/** Owns the one active application selection and its session navigation history in this window. */
export interface AppShellStoreProps {
  sessionWorkspacePath(sessionId: string): string | undefined;
}

const sameSessionEntry = (left: SessionHistoryEntry, right: SessionHistoryEntry) =>
  left.kind === right.kind && left.sessionId === right.sessionId;

export class AppShellStore extends Store<AppShellStoreProps> {
  selection: AppSelection = { kind: "workbench" };
  activeConversation: WindowConversationSelection | undefined;
  private readonly sessionHistory: SessionHistoryEntry[] = observable([]);
  private sessionHistoryCursor = -1;
  private pendingTraversal: { entry: SessionHistoryEntry; cursor: number } | undefined;

  get surface(): AppSurface {
    if (this.selection.kind === "settings") return "settings";
    if (this.selection.kind === "cake-chat") return "global-chat";
    return "workbench";
  }

  get canGoBack() {
    return this.sessionHistoryCursor > 0;
  }

  get canGoForward() {
    return (
      this.sessionHistoryCursor >= 0 && this.sessionHistoryCursor < this.sessionHistory.length - 1
    );
  }

  /** Steps the history cursor back; the caller must navigate to the returned entry. */
  goBack(): SessionHistoryEntry | undefined {
    if (!this.canGoBack) return undefined;
    const cursor = this.sessionHistoryCursor - 1;
    const entry = this.sessionHistory[cursor]!;
    this.pendingTraversal = { entry, cursor };
    return entry;
  }

  /** Steps the history cursor forward; the caller must navigate to the returned entry. */
  goForward(): SessionHistoryEntry | undefined {
    if (!this.canGoForward) return undefined;
    const cursor = this.sessionHistoryCursor + 1;
    const entry = this.sessionHistory[cursor]!;
    this.pendingTraversal = { entry, cursor };
    return entry;
  }

  /**
   * Drops every history entry for a session. Returns the entry to navigate to when the
   * removal orphaned the current position; the caller navigates there.
   */
  removeSessionFromHistory(sessionId: string): SessionHistoryEntry | undefined {
    if (this.pendingTraversal?.entry.sessionId === sessionId) this.pendingTraversal = undefined;
    const cursor = this.sessionHistoryCursor;
    const current = this.sessionHistory[cursor];
    const currentRemoved = current !== undefined && current.sessionId === sessionId;
    const kept: SessionHistoryEntry[] = [];
    let keptBeforeCursor = 0;
    for (let index = 0; index < this.sessionHistory.length; index += 1) {
      const entry = this.sessionHistory[index]!;
      if (entry.sessionId === sessionId) continue;
      if (index < cursor) keptBeforeCursor += 1;
      kept.push(entry);
    }
    this.sessionHistory.splice(0, this.sessionHistory.length, ...kept);
    this.sessionHistoryCursor =
      kept.length === 0 ? -1 : Math.min(keptBeforeCursor, kept.length - 1);
    return currentRemoved ? this.sessionHistory[this.sessionHistoryCursor] : undefined;
  }

  showWorkbench() {
    this.selection = { kind: "workbench" };
    this.activeConversation = undefined;
  }
  selectProjectSession(sessionId: string) {
    this.setProjectSessionSelection(sessionId);
    this.recordSessionVisit({ kind: "project-session", sessionId });
  }
  /** Selects an archived transcript without adding it to back/forward history. */
  previewResolvedProjectSession(sessionId: string) {
    this.setProjectSessionSelection(sessionId);
  }
  private setProjectSessionSelection(sessionId: string) {
    const workspacePath = this.props.sessionWorkspacePath(sessionId);
    if (!workspacePath) throw new Error(`Cake could not find session ${sessionId}`);
    this.selection = { kind: "project-session", workspacePath, sessionId };
    this.activeConversation = this.selection;
  }
  selectCakeChat(sessionId?: string) {
    this.setCakeChatSelection(sessionId);
    if (sessionId) this.recordSessionVisit({ kind: "cake-chat", sessionId });
  }
  /** Selects an archived Cake Chat transcript without adding it to history. */
  previewResolvedCakeChat(sessionId: string) {
    this.setCakeChatSelection(sessionId);
  }
  private setCakeChatSelection(sessionId?: string) {
    this.selection = { kind: "cake-chat", sessionId };
    this.activeConversation = sessionId ? { kind: "cake-chat", sessionId } : undefined;
  }
  showSettings() {
    this.selection = { kind: "settings" };
  }
  restoreConversation(selection: WindowConversationSelection) {
    this.activeConversation = selection;
    this.selection = selection;
  }

  /**
   * Records a visit to the top of the history, truncating any forward branch. A pending
   * traversal commits once its target selection actually lands; any other selection
   * cancels the traversal and records normally.
   */
  private recordSessionVisit(entry: SessionHistoryEntry) {
    const traversal = this.pendingTraversal;
    this.pendingTraversal = undefined;
    if (traversal && sameSessionEntry(traversal.entry, entry)) {
      this.sessionHistoryCursor = traversal.cursor;
      return;
    }
    const current = this.sessionHistory[this.sessionHistoryCursor];
    if (current && sameSessionEntry(current, entry)) return;
    this.sessionHistory.splice(this.sessionHistoryCursor + 1);
    this.sessionHistory.push(entry);
    this.sessionHistoryCursor = this.sessionHistory.length - 1;
  }
}
