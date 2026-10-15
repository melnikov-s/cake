import { Store, computed, observable, type ReadonlySignal } from "r-state-tree";
import type { SessionCatalog } from "../models/SessionCatalog";
import type { SessionSummary } from "../models/SessionSummary";
import type { WorktreeCatalog } from "../models/WorktreeCatalog";
import type { WorktreeRecord } from "../../contracts/worktrees/managed-worktree-data";
import { compareSessionSummariesForSidebar } from "../../utils/session-summary-order";
import { ClientContext } from "./context/ClientContext";
import { applySessionCatalogGroupUpdate } from "../reducers/CatalogReducer";

export interface PendingSessionSummary {
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

  @computed
  private get sessionIndex(): ReadonlyMap<string, SessionSummary | PendingSessionSummary> {
    const index = new Map<string, SessionSummary | PendingSessionSummary>();
    for (const session of this.props.model.sessions) index.set(session.sessionId, session);
    for (const session of this.props.pendingSessions?.() ?? []) {
      if (!index.has(session.sessionId)) index.set(session.sessionId, session);
    }
    return index;
  }

  find(sessionId: string) {
    return this.sessionIndex.get(sessionId);
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

  projectSessions(projectPath: string) {
    let group = this.projectSessionGroups.get(projectPath);
    if (!group) {
      group = computed(() => {
        // Read membership from the shared index, not the globally sorted list: metadata
        // changes in another Project must not invalidate this group's ordering.
        return [...this.sessionIndex.values()]
          .filter((session) => session.projectPath === projectPath)
          .sort((left, right) => {
            if (left.resolved !== right.resolved) return left.resolved ? 1 : -1;
            return compareSessionSummariesForSidebar(left, right);
          });
      });
      this.projectSessionGroups.set(projectPath, group);
    }
    return group.value;
  }

  hasMoreResolvedSessions(projectPath: string) {
    return this.props.model.resolvedHasMoreByProject[projectPath] === true;
  }

  notePendingManagedWorktree(record: WorktreeRecord) {
    this.pendingManagedWorktrees.set(record.worktreePath, record);
  }

  managedWorktree(workingDirectory: string) {
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
    const sessionsByWorktree = new Map<string, Array<SessionSummary | PendingSessionSummary>>();
    for (const session of this.projectSessions(projectPath)) {
      const record = this.managedWorktree(session.workingDirectory);
      if (!record || record.state !== "landed") continue;
      const sessions = sessionsByWorktree.get(record.worktreePath) ?? [];
      sessions.push(session);
      sessionsByWorktree.set(record.worktreePath, sessions);
    }
    return [...sessionsByWorktree.values()]
      .filter((sessions) => sessions.length > 0 && sessions.every((session) => session.resolved))
      .flatMap((sessions) => {
        const record = this.managedWorktree(sessions[0]?.workingDirectory ?? "");
        return record ? [record] : [];
      });
  }

  get authoritativeSessionIds() {
    return this.props.model.sessions.map((session) => session.sessionId);
  }
}
