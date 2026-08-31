import { Store, observable } from "r-state-tree";
import type { SessionCatalog } from "../models/SessionCatalog";
import type { SessionSummary } from "../models/SessionSummary";
import type { WorktreeRecord } from "../../ipc/worktree-contract";

/** Owns renderer-local pending-session and Managed Worktree policy over the catalog projection. */
export class SessionCatalogStore extends Store<{ model: SessionCatalog }> {
  private readonly managedWorktrees = observable(new Map<string, WorktreeRecord>());

  get sessions() {
    return this.props.model.sessions;
  }

  find(sessionId: string) {
    return this.props.model.find(sessionId);
  }

  get sessionsById(): ReadonlyMap<string, SessionSummary> {
    return new Map(this.sessions.map((session) => [session.sessionId, session]));
  }

  get sessionsByProject(): ReadonlyMap<string, readonly SessionSummary[]> {
    const grouped = new Map<string, SessionSummary[]>();
    for (const session of this.sessions) {
      const sessions = grouped.get(session.projectPath) ?? [];
      sessions.push(session);
      grouped.set(session.projectPath, sessions);
    }
    return grouped;
  }

  projectSessions(projectPath: string) {
    return this.props.model.projectSessions(projectPath);
  }

  noteManagedWorktree(record: WorktreeRecord) {
    this.managedWorktrees.set(record.worktreePath, record);
  }

  managedWorktree(workingDirectory: string) {
    return (
      this.managedWorktrees.get(workingDirectory) ??
      this.sessions.find((session) => session.workingDirectory === workingDirectory)
        ?.managedWorktree
    );
  }

  projectOfManagedWorktree(workingDirectory: string) {
    return this.managedWorktree(workingDirectory)?.projectPath;
  }

  resolvedWorktrees(projectPath: string) {
    const sessionsByWorktree = new Map<string, SessionSummary[]>();
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
    this.props.model.upsertPending({
      sessionId,
      projectPath: this.projectOfManagedWorktree(workingDirectory) ?? workingDirectory,
      projectName,
      workingDirectory,
      ...options,
    });
  }

  setDraft(sessionId: string, draft: boolean) {
    const session = this.find(sessionId);
    if (session?.pending) session.draft = draft;
  }

  setResolved(sessionId: string, resolved: boolean) {
    const session = this.find(sessionId);
    if (session) session.resolved = resolved;
  }

  remove(sessionId: string) {
    this.props.model.removePending(sessionId);
  }

  rename(sessionId: string, title: string) {
    const session = this.find(sessionId);
    if (!session) return undefined;
    const previousTitle = session.title;
    session.title = title;
    return previousTitle;
  }
}
