import { Store, computed, observable, type ReadonlySignal } from "r-state-tree";
import type { SessionCatalog } from "../models/SessionCatalog";
import type { SessionSummary } from "../models/SessionSummary";
import type { WorktreeCatalog } from "../models/WorktreeCatalog";
import type {
  WorktreeRecord,
  WorktreeCatalogEntry,
} from "../../contracts/worktrees/managed-worktree-data";
import { compareSessionSummariesForSidebar } from "../../utils/session-summary-order";
import { resolveSessionReference } from "../../contracts/project-sessions/session-reference";
import { ClientContext } from "./context/ClientContext";
import { applySessionCatalogGroupUpdate } from "../reducers/CatalogReducer";

export interface PendingSessionSummary {
  purpose?: "user" | "delegated";
  sessionId: string;
  title: string;
  createdAt: string;
  modifiedAt: string;
  messageCount: number;
  parentSessionId?: string;
  resolved: boolean;
  unread: boolean;
  running: boolean;
  projectPath: string;
  projectName: string;
  workingDirectory: string;
  familyId?: string;
  familyParentSessionId?: string;
  familyChildSessionIds?: readonly string[];
  familyChildOrder?: number;
  familyDepth?: number;
  pending: true;
  draft: boolean;
}

/** Projects the authoritative and renderer-pending catalogs with Managed Worktree policy. */
export class SessionCatalogStore extends Store<{
  model: SessionCatalog;
  worktrees: WorktreeCatalog;
  pendingSessions?(): readonly PendingSessionSummary[];
}> {
  /** Bridges newly-created worktrees only until their first authoritative session projection. */
  private readonly pendingManagedWorktrees = observable(new Map<string, WorktreeRecord>());
  /** Keeps catalog derivation scoped to the Project whose sidebar group consumes it. */
  private readonly projectSessionGroups = new Map<
    string,
    ReadonlySignal<ReadonlyArray<SessionSummary | PendingSessionSummary>>
  >();

  constructor(props: SessionCatalogStore["props"]) {
    super(props);
    this.reaction(
      () => this.props.worktrees.worktrees.map((worktree) => worktree.worktreePath),
      (projectedPaths) => {
        for (const path of projectedPaths) this.pendingManagedWorktrees.delete(path);
      },
    );
  }

  @computed
  get sessions(): ReadonlyArray<SessionSummary | PendingSessionSummary> {
    return [...this.sessionIndex.values()].sort((left, right) => {
      if (left.resolved !== right.resolved) return left.resolved ? 1 : -1;
      return compareSessionSummariesForSidebar(left, right);
    });
  }

  /** Filter archives before active ordering/activity work, not after sorting all history. */
  @computed
  get activeSessions(): ReadonlyArray<SessionSummary | PendingSessionSummary> {
    return [...this.sessionIndex.values()].filter((session) => !session.resolved);
  }

  @computed
  private get sessionIndex(): ReadonlyMap<string, SessionSummary | PendingSessionSummary> {
    const index = new Map<string, SessionSummary | PendingSessionSummary>();
    for (const session of this.props.model.sessions) index.set(session.sessionId, session);
    for (const session of this.pendingSessionIndex.values()) {
      if (!index.has(session.sessionId)) index.set(session.sessionId, session);
    }
    return index;
  }

  @computed
  private get pendingSessionIndex(): ReadonlyMap<string, PendingSessionSummary> {
    const index = new Map<string, PendingSessionSummary>();
    for (const session of this.props.pendingSessions?.() ?? []) {
      if (!index.has(session.sessionId)) index.set(session.sessionId, session);
    }
    return index;
  }

  /** Attention, membership and routing stay current even before the Sessions list is opened. */
  get backgroundSessions() {
    if (!this.props.model.signals.loaded) return this.activeSessions;
    const sessions = this.props.model.signals.sessions.map((session) => ({
      ...session,
      resolved: false as const,
    }));
    const ids = new Set(sessions.map((session) => session.sessionId));
    return [
      ...sessions,
      ...(this.props.pendingSessions?.().filter((session) => !ids.has(session.sessionId)) ?? []),
    ];
  }

  sessionPurpose(sessionId: string) {
    return (
      this.props.model.signals.purposes[sessionId] ?? this.backgroundSession(sessionId)?.purpose
    );
  }

  backgroundSession(sessionId: string) {
    return this.props.model.signals.find(sessionId) ?? this.find(sessionId);
  }

  get backgroundSignalsLoaded() {
    return this.props.model.signals.loaded;
  }

  find(sessionId: string) {
    return this.props.model.find(sessionId) ?? this.pendingSessionIndex.get(sessionId);
  }

  @computed
  private get resolutionSessionIds() {
    return [
      ...new Set([
        ...this.authoritativeSessionIds,
        ...this.props.model.signals.resolvedSessionIds,
        ...this.pendingSessionIndex.keys(),
      ]),
    ];
  }

  isResolved(reference: string) {
    const identity = resolveSessionReference(reference, this.resolutionSessionIds);
    return (
      identity.ok &&
      (this.props.model.signals.isResolved(identity.sessionId) ||
        this.find(identity.sessionId)?.resolved === true)
    );
  }

  /** Reconcile one explicit identity without reloading the Project catalog or a transcript. */
  async lookup(sessionId: string) {
    const existing = this.find(sessionId);
    if (existing?.pending) return existing;
    const session = await ClientContext.consume(this)!.projectSessions.lookup(
      { sessionId, ...(existing ? { workingDirectory: existing.workingDirectory } : null) },
      { signal: this.signal },
    );
    this.signal.throwIfAborted();
    applySessionCatalogGroupUpdate(
      this.props.model,
      { projectPath: session.projectPath, resolved: session.resolved },
      { _tag: "Event", revision: 0, event: { _tag: "Upserted", session } },
    );
    return this.find(sessionId);
  }

  get sessionsById(): ReadonlyMap<string, SessionSummary | PendingSessionSummary> {
    return this.sessionIndex;
  }

  projectSessions(projectPath: string, resolved?: boolean) {
    const key = `${resolved === undefined ? "all" : resolved ? "resolved" : "active"}:${projectPath}`;
    let group = this.projectSessionGroups.get(key);
    if (!group) {
      group = computed(() => {
        // Read membership from the shared index, not the globally sorted list: metadata
        // changes in another Project must not invalidate this group's ordering.
        const sessions = resolved === false ? this.activeSessions : [...this.sessionIndex.values()];
        return sessions
          .filter(
            (session) =>
              session.projectPath === projectPath &&
              (resolved === undefined || session.resolved === resolved),
          )
          .sort((left, right) => {
            if (left.resolved !== right.resolved) return left.resolved ? 1 : -1;
            return compareSessionSummariesForSidebar(left, right);
          });
      });
      this.projectSessionGroups.set(key, group);
    }
    return group.value;
  }

  hasMoreResolvedSessions(projectPath: string) {
    return this.props.model.resolvedHasMoreByProject[projectPath] === true;
  }

  /** Unknown until the Project's archive page is observed. */
  resolvedSessionTotal(projectPath: string): number | undefined {
    return this.props.model.resolvedTotalByProject[projectPath];
  }

  notePendingManagedWorktree(record: WorktreeRecord) {
    this.pendingManagedWorktrees.set(record.worktreePath, record);
  }

  managedWorktree(workingDirectory: string): WorktreeCatalogEntry | undefined {
    return (
      this.props.worktrees.find(workingDirectory) ??
      this.pendingManagedWorktrees.get(workingDirectory)
    );
  }

  projectPathFor(workingDirectory: string) {
    return this.managedWorktree(workingDirectory)?.projectPath ?? workingDirectory;
  }

  managedWorktreesForProject(projectPath: string) {
    return this.props.worktrees.forProject(projectPath);
  }

  resolvedWorktrees(projectPath: string) {
    // Landing authority is the Worktree catalog, not whichever archive page happens
    // to be loaded. Background membership vetoes unfinished checkouts without list demand.
    const activeDirectories = new Set(
      this.backgroundSessions
        .filter((session) => session.projectPath === projectPath)
        .map((session) => session.workingDirectory),
    );
    return this.managedWorktreesForProject(projectPath).filter(
      (record) => record.state === "landed" && !activeDirectories.has(record.worktreePath),
    );
  }

  get authoritativeSessionIds() {
    return [
      ...new Set([
        ...this.props.model.signals.sessions.map((session) => session.sessionId),
        ...this.props.model.sessions.map((session) => session.sessionId),
      ]),
    ];
  }
}
