import { Store, observable, snapshot } from "r-state-tree";

export type AppSurface = "workbench" | "global-chat" | "settings";

export type WindowConversationSelection =
  | { kind: "project-session"; sessionId: string }
  | { kind: "cake-chat"; sessionId: string };

export type AppSelection =
  | { kind: "workbench" }
  | { kind: "project-session"; sessionId: string }
  | { kind: "cake-chat"; sessionId?: string }
  | { kind: "settings" };

/** One visited conversation in the window's back/forward session history. */
export type SessionHistoryEntry =
  | { kind: "project-session"; sessionId: string }
  | { kind: "cake-chat"; sessionId: string };

/** Owns the one active application selection and its session navigation history in this window. */
export interface AppShellStoreProps {
  projectSessionResolved(sessionId: string): boolean | undefined;
  cakeChatSessionResolved(sessionId: string): boolean | undefined;
  markProjectSessionRead(sessionId: string): void;
}

const sameSessionEntry = (left: SessionHistoryEntry, right: SessionHistoryEntry) =>
  left.kind === right.kind && left.sessionId === right.sessionId;

export class AppShellStore extends Store<AppShellStoreProps> {
  @snapshot selection: AppSelection = { kind: "workbench" };
  @snapshot activeConversation: WindowConversationSelection | undefined;
  @snapshot private readonly sessionHistory: SessionHistoryEntry[] = observable([]);
  @snapshot private sessionHistoryCursor = -1;
  private pendingTraversal: { entry: SessionHistoryEntry; cursor: number } | undefined;

  constructor(props: AppShellStore["props"]) {
    super(props);
    this.reaction(
      () => {
        const active = this.activeConversation;
        if (!active) return undefined;
        const resolved =
          active.kind === "project-session"
            ? this.props.projectSessionResolved(active.sessionId)
            : this.props.cakeChatSessionResolved(active.sessionId);
        return { ...active, resolved };
      },
      (current, previous) => {
        if (
          !current ||
          !previous ||
          current.kind !== previous.kind ||
          current.sessionId !== previous.sessionId ||
          previous.resolved !== true ||
          current.resolved !== false
        )
          return;
        if (current.kind === "project-session") this.selectProjectSession(current.sessionId);
        else this.selectCakeChat(current.sessionId);
      },
    );
  }

  get surface(): AppSurface {
    if (this.selection.kind === "settings") return "settings";
    if (this.selection.kind === "cake-chat") return "global-chat";
    return "workbench";
  }

  get canGoBack() {
    return this.historyCursorInDirection(-1) !== undefined;
  }

  get canGoForward() {
    return this.historyCursorInDirection(1) !== undefined;
  }

  /** Steps the history cursor back to the next unresolved entry. */
  goBack(): SessionHistoryEntry | undefined {
    const cursor = this.historyCursorInDirection(-1);
    if (cursor === undefined) return undefined;
    const entry = this.sessionHistory[cursor]!;
    this.pendingTraversal = { entry, cursor };
    return entry;
  }

  /** Steps the history cursor forward to the next unresolved entry. */
  goForward(): SessionHistoryEntry | undefined {
    const cursor = this.historyCursorInDirection(1);
    if (cursor === undefined) return undefined;
    const entry = this.sessionHistory[cursor]!;
    this.pendingTraversal = { entry, cursor };
    return entry;
  }

  private historyCursorInDirection(direction: -1 | 1): number | undefined {
    for (
      let cursor = this.sessionHistoryCursor + direction;
      cursor >= 0 && cursor < this.sessionHistory.length;
      cursor += direction
    ) {
      const entry = this.sessionHistory[cursor]!;
      const resolved =
        entry.kind === "project-session"
          ? this.props.projectSessionResolved(entry.sessionId)
          : this.props.cakeChatSessionResolved(entry.sessionId);
      if (resolved !== true) return cursor;
    }
    return undefined;
  }

  /**
   * Drops every history entry for the given sessions. Returns the nearest retained entry when
   * the current conversation was removed so the caller can navigate there.
   */
  removeSessionsFromHistory(sessionIds: readonly string[]): SessionHistoryEntry | undefined {
    const removedIds = new Set(sessionIds);
    if (this.pendingTraversal && removedIds.has(this.pendingTraversal.entry.sessionId))
      this.pendingTraversal = undefined;
    const cursor = this.sessionHistoryCursor;
    const current = this.sessionHistory[cursor];
    const activeConversationRemoved =
      this.activeConversation !== undefined && removedIds.has(this.activeConversation.sessionId);
    const currentRemoved =
      activeConversationRemoved || (current !== undefined && removedIds.has(current.sessionId));
    const kept: SessionHistoryEntry[] = [];
    let keptBeforeCursor = 0;
    for (let index = 0; index < this.sessionHistory.length; index += 1) {
      const entry = this.sessionHistory[index]!;
      if (removedIds.has(entry.sessionId)) continue;
      const previous = kept.at(-1);
      if (previous && sameSessionEntry(previous, entry)) continue;
      if (index < cursor) keptBeforeCursor += 1;
      kept.push(entry);
    }
    this.sessionHistory.splice(0, this.sessionHistory.length, ...kept);
    this.sessionHistoryCursor =
      kept.length === 0 ? -1 : Math.min(keptBeforeCursor, kept.length - 1);
    return currentRemoved ? this.sessionHistory[this.sessionHistoryCursor] : undefined;
  }

  showWorkbench() {
    this.markDepartingProjectSession();
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
    if (
      this.selection.kind === "project-session" &&
      this.selection.sessionId === sessionId &&
      this.activeConversation?.kind === "project-session" &&
      this.activeConversation.sessionId === sessionId
    )
      return;
    this.markDepartingProjectSession(sessionId);
    const selection = { kind: "project-session", sessionId } as const;
    this.selection = selection;
    this.activeConversation = selection;
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
    if (
      this.selection.kind === "cake-chat" &&
      this.selection.sessionId === sessionId &&
      (sessionId === undefined
        ? this.activeConversation === undefined
        : this.activeConversation?.kind === "cake-chat" &&
          this.activeConversation.sessionId === sessionId)
    )
      return;
    this.markDepartingProjectSession();
    const selection = { kind: "cake-chat", sessionId } as const;
    this.selection = selection;
    this.activeConversation = sessionId ? { kind: "cake-chat", sessionId } : undefined;
  }
  showSettings() {
    this.markDepartingProjectSession();
    this.selection = { kind: "settings" };
  }

  private markDepartingProjectSession(nextSessionId?: string) {
    if (this.selection.kind === "project-session" && this.selection.sessionId !== nextSessionId)
      this.props.markProjectSessionRead(this.selection.sessionId);
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
