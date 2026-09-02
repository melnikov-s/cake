import { Store, computed, observable, snapshot } from "r-state-tree";
import type { SessionCatalog } from "../models/SessionCatalog";
import type { SessionSummary } from "../models/SessionSummary";
import type { WorktreeRecord } from "../../ipc/worktree-contract";

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
  pending: true;
  draft: boolean;
}

/** Owns renderer-local pending-session and Managed Worktree policy over the catalog projection. */
export class SessionCatalogStore extends Store<{ model: SessionCatalog }> {
  @snapshot private readonly pendingSessions: PendingSessionSummary[] = observable([]);
  private readonly managedWorktreeOverrides = observable(new Map<string, WorktreeRecord>());

  @computed
  get sessions(): ReadonlyArray<SessionSummary | PendingSessionSummary> {
    const authoritativeIds = new Set(this.props.model.sessions.map((session) => session.sessionId));
    return [
      ...this.props.model.sessions,
      ...this.pendingSessions.filter((session) => !authoritativeIds.has(session.sessionId)),
    ].sort((left, right) => {
      if (left.resolved !== right.resolved) return left.resolved ? 1 : -1;
      return right.modifiedAt.localeCompare(left.modifiedAt);
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

  noteManagedWorktree(record: WorktreeRecord) {
    this.managedWorktreeOverrides.set(record.worktreePath, record);
  }

  @computed
  private get managedWorktreeIndex(): ReadonlyMap<string, WorktreeRecord> {
    const indexed = new Map<string, WorktreeRecord>();
    for (const session of this.sessions) {
      const record = session.managedWorktree;
      if (record && !indexed.has(session.workingDirectory))
        indexed.set(session.workingDirectory, record);
    }
    for (const [path, record] of this.managedWorktreeOverrides) indexed.set(path, record);
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

  upsertPending(
    sessionId: string,
    workingDirectory: string,
    projectName: string,
    options: { draft?: boolean; resolved?: boolean } = {},
  ) {
    if (this.props.model.find(sessionId))
      throw new Error(`Session ID collision detected: ${sessionId}`);
    const now = new Date().toISOString();
    const index = this.pendingSessions.findIndex((session) => session.sessionId === sessionId);
    const current = this.pendingSessions[index];
    const next: PendingSessionSummary = current
      ? {
          ...current,
          modifiedAt: now,
          resolved: options.resolved ?? current.resolved,
          draft: options.draft ?? current.draft,
        }
      : {
          sessionId,
          title: "New chat",
          createdAt: now,
          modifiedAt: now,
          messageCount: 0,
          resolved: options.resolved ?? false,
          unread: false,
          projectPath: this.projectOfManagedWorktree(workingDirectory) ?? workingDirectory,
          projectName,
          workingDirectory,
          pending: true,
          draft: options.draft ?? false,
        };
    if (index >= 0) this.pendingSessions.splice(index, 1, next);
    else this.pendingSessions.push(next);
  }

  setDraft(sessionId: string, draft: boolean) {
    this.updatePending(sessionId, (session) => ({ ...session, draft }));
  }

  setResolved(sessionId: string, resolved: boolean) {
    this.updatePending(sessionId, (session) => ({ ...session, resolved }));
  }

  remove(sessionId: string) {
    const index = this.pendingSessions.findIndex((session) => session.sessionId === sessionId);
    if (index >= 0) this.pendingSessions.splice(index, 1);
  }

  rename(sessionId: string, title: string) {
    const session = this.pendingSessions.find((candidate) => candidate.sessionId === sessionId);
    if (!session) return undefined;
    const previousTitle = session.title;
    this.updatePending(sessionId, (current) => ({ ...current, title }));
    return previousTitle;
  }

  private updatePending(
    sessionId: string,
    update: (session: PendingSessionSummary) => PendingSessionSummary,
  ) {
    const index = this.pendingSessions.findIndex((session) => session.sessionId === sessionId);
    const session = this.pendingSessions[index];
    if (index >= 0 && session) this.pendingSessions.splice(index, 1, update(session));
  }
}
