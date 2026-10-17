import { Store, observable, snapshot } from "r-state-tree";
import { SessionMetadataContext } from "./context/SessionMetadataContext";

export type AppSurface = "workbench" | "cake-chat" | "artifact-library" | "settings";
export type ConversationWorkspace = "home" | "project-sessions" | "cake-chat";

export type WindowConversationSelection =
  | { kind: "project-session"; sessionId: string }
  | { kind: "cake-chat"; sessionId: string };

export type AppSelection =
  | { kind: "workbench" }
  | { kind: "project-session"; sessionId: string }
  | { kind: "cake-chat"; sessionId?: string }
  | { kind: "artifact-library" }
  | { kind: "settings" };

/** One visited conversation in the window's back/forward session history. */
export type SessionHistoryEntry =
  | { kind: "project-session"; sessionId: string }
  | { kind: "cake-chat"; sessionId: string };

/** Owns workspace/cover selection and window visits, never the layouts' session identities. */
export interface AppShellStoreProps {
  focusedSessionId(workspace: "project-sessions" | "cake-chat"): string | undefined;
  sessionInNavigationScope(entry: SessionHistoryEntry): boolean;
  onProjectSessionDeparted(sessionId: string): void;
}

const sameSessionEntry = (left: SessionHistoryEntry, right: SessionHistoryEntry) =>
  left.kind === right.kind && left.sessionId === right.sessionId;

export class AppShellStore extends Store<AppShellStoreProps> {
  @snapshot readonly navigationVersion = 2;
  @snapshot workspace: ConversationWorkspace = "home";
  @snapshot coveringSurface: "settings" | "artifact-library" | undefined;

  get activeConversation(): WindowConversationSelection | undefined {
    if (this.workspace === "home") return undefined;
    const sessionId = this.props.focusedSessionId(this.workspace);
    return sessionId
      ? { kind: this.workspace === "cake-chat" ? "cake-chat" : "project-session", sessionId }
      : undefined;
  }

  get selection(): AppSelection {
    if (this.coveringSurface) return { kind: this.coveringSurface };
    return (
      this.activeConversation ?? {
        kind: this.workspace === "cake-chat" ? "cake-chat" : "workbench",
      }
    );
  }
  @snapshot private readonly sessionHistory: SessionHistoryEntry[] = observable([]);
  @snapshot private sessionHistoryCursor = -1;
  private pendingTraversal: { entry: SessionHistoryEntry; cursor: number } | undefined;

  private get metadata() {
    return SessionMetadataContext.consume(this)!;
  }

  constructor(props: AppShellStore["props"]) {
    super(props);
    this.reaction(
      () => (this.selection.kind === "project-session" ? this.selection.sessionId : undefined),
      (current, previous) => {
        if (previous && previous !== current) this.props.onProjectSessionDeparted(previous);
      },
    );
    this.reaction(
      () => {
        const active = this.activeConversation;
        if (active?.kind !== "project-session") return undefined;
        return { ...active, resolved: this.metadata.isResolved(active.sessionId) };
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
        this.recordCurrentConversationVisit();
      },
    );
  }

  get surface(): AppSurface {
    if (this.selection.kind === "settings") return "settings";
    if (this.selection.kind === "artifact-library") return "artifact-library";
    if (this.selection.kind === "cake-chat") return "cake-chat";
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

  /** Coordinates pane-local traversal with this window's visit history.
   * The cursor commits only when the actual target selection lands.
   */
  prepareProjectSessionTraversal(sessionId: string, direction: -1 | 1) {
    const entry = { kind: "project-session", sessionId } as const;
    const cursor = this.historyCursorInDirection(direction, entry);
    this.pendingTraversal = cursor === undefined ? undefined : { entry, cursor };
  }

  private historyCursorInDirection(
    direction: -1 | 1,
    target?: SessionHistoryEntry,
  ): number | undefined {
    for (
      let cursor = this.sessionHistoryCursor + direction;
      cursor >= 0 && cursor < this.sessionHistory.length;
      cursor += direction
    ) {
      const entry = this.sessionHistory[cursor]!;
      if (!this.props.sessionInNavigationScope(entry)) continue;
      if (target && !sameSessionEntry(entry, target)) continue;
      if (entry.kind === "cake-chat" || this.metadata.isResolved(entry.sessionId) !== true)
        return cursor;
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

  selectWorkspace(workspace: ConversationWorkspace) {
    this.workspace = workspace;
    this.coveringSurface = undefined;
  }

  dismissCoveringSurface() {
    this.coveringSurface = undefined;
  }

  showArtifactLibrary() {
    this.coveringSurface = "artifact-library";
  }

  showSettings() {
    this.coveringSurface = "settings";
  }

  /** Records the landed layout selection, excluding archived Project Session previews. */
  recordCurrentConversationVisit() {
    const entry = this.activeConversation;
    if (!entry) return;
    if (entry.kind === "project-session" && this.metadata.isResolved(entry.sessionId)) return;
    this.recordSessionVisit(entry);
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
