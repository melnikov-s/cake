import { Store, computed, observable, type ReadonlySignal } from "r-state-tree";
import type { SessionCatalog } from "../models/SessionCatalog";
import type { SessionSummary } from "../models/SessionSummary";
import type { WorktreeCatalog } from "../models/WorktreeCatalog";
import type { WorktreeRecord } from "../../domain/worktrees/managed-worktree-data";
import { compareSessionSummariesForSidebar } from "../../utils/session-summary-order";

export interface PendingSessionSummary {
  sessionId: string;
  title: string;
  createdAt: string;
  modifiedAt: string;
  messageCount: number;
  parentSessionId?: string;
  resolved: boolean;
  unread: boolean;
  projectPath: string;
  projectName: string;
  workingDirectory: string;
  familyId?: string;
  familyParentSessionId?: string;
  familyChildSessionIds?: readonly string[];
  familyChildOrder?: number;
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
    const authoritativeIds = new Set(this.props.model.sessions.map((session) => session.sessionId));
    return [
      ...this.props.model.sessions,
      ...(this.props.pendingSessions?.() ?? []).filter(
        (session) => !authoritativeIds.has(session.sessionId),
      ),
    ].sort((left, right) => {
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

  get sessionsById(): ReadonlyMap<string, SessionSummary | PendingSessionSummary> {
    return this.sessionIndex;
  }

  projectSessions(projectPath: string) {
    let group = this.projectSessionGroups.get(projectPath);
    if (!group) {
      group = computed(() => {
        const authoritative = this.props.model.sessions.filter(
          (session) => session.projectPath === projectPath,
        );
        const authoritativeIds = new Set(authoritative.map((session) => session.sessionId));
        const pending = (this.props.pendingSessions?.() ?? []).filter(
          (session) =>
            session.projectPath === projectPath && !authoritativeIds.has(session.sessionId),
        );
        return [...authoritative, ...pending].sort((left, right) => {
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

  projectOfManagedWorktree(workingDirectory: string) {
    return this.managedWorktree(workingDirectory)?.projectPath;
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
