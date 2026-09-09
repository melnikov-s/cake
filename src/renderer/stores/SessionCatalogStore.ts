import { Store, computed, observable } from "r-state-tree";
import type { SessionCatalog } from "../models/SessionCatalog";
import type { SessionSummary } from "../models/SessionSummary";
import type { WorktreeRecord } from "../../ipc/worktree-contract";
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
  managedWorktree?: WorktreeRecord;
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
  pendingSessions?(): readonly PendingSessionSummary[];
}> {
  /** Bridges newly-created worktrees only until their first authoritative session projection. */
  private readonly pendingManagedWorktrees = observable(new Map<string, WorktreeRecord>());

  constructor(props: SessionCatalogStore["props"]) {
    super(props);
    this.reaction(
      () =>
        this.props.model.sessions.flatMap((session) =>
          session.managedWorktree ? [session.managedWorktree.worktreePath] : [],
        ),
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
    return new Map(this.sessions.map((session) => [session.sessionId, session]));
  }

  find(sessionId: string) {
    return this.sessionIndex.get(sessionId);
  }

  get sessionsById(): ReadonlyMap<string, SessionSummary | PendingSessionSummary> {
    return this.sessionIndex;
  }

  @computed
  get sessionsByProject(): ReadonlyMap<
    string,
    ReadonlyArray<SessionSummary | PendingSessionSummary>
  > {
    const grouped = new Map<string, Array<SessionSummary | PendingSessionSummary>>();
    for (const session of this.sessions) {
      const sessions = grouped.get(session.projectPath) ?? [];
      sessions.push(session);
      grouped.set(session.projectPath, sessions);
    }
    return grouped;
  }

  projectSessions(projectPath: string) {
    return this.sessionsByProject.get(projectPath) ?? [];
  }

  hasMoreResolvedSessions(projectPath: string) {
    return this.props.model.resolvedHasMoreByProject[projectPath] === true;
  }

  notePendingManagedWorktree(record: WorktreeRecord) {
    this.pendingManagedWorktrees.set(record.worktreePath, record);
  }

  @computed
  private get managedWorktreeIndex(): ReadonlyMap<string, WorktreeRecord> {
    const indexed = new Map<string, WorktreeRecord>();
    for (const session of this.props.model.sessions) {
      const record = session.managedWorktree;
      if (record && !indexed.has(session.workingDirectory))
        indexed.set(session.workingDirectory, record);
    }
    for (const [path, record] of this.pendingManagedWorktrees)
      if (!indexed.has(path)) indexed.set(path, record);
    return indexed;
  }

  managedWorktree(workingDirectory: string) {
    return this.managedWorktreeIndex.get(workingDirectory);
  }

  projectOfManagedWorktree(workingDirectory: string) {
    return this.managedWorktree(workingDirectory)?.projectPath;
  }

  resolvedWorktrees(projectPath: string) {
    const sessionsByWorktree = new Map<string, Array<SessionSummary | PendingSessionSummary>>();
    for (const session of this.projectSessions(projectPath)) {
      const record = session.managedWorktree;
      if (!record || record.state !== "landed") continue;
      const sessions = sessionsByWorktree.get(record.worktreePath) ?? [];
      sessions.push(session);
      sessionsByWorktree.set(record.worktreePath, sessions);
    }
    return [...sessionsByWorktree.values()]
      .filter((sessions) => sessions.length > 0 && sessions.every((session) => session.resolved))
      .map((sessions) => sessions[0]!.managedWorktree!);
  }

  get authoritativeSessionIds() {
    return this.props.model.sessions.map((session) => session.sessionId);
  }
}
