import { Store, observable } from "r-state-tree";
import type { GlobalSessionSummary, SessionSnapshot } from "../../ipc/session-contract";

/** The single renderer-owned catalog of Pi session summaries. */
export class SessionCatalogStore extends Store<Record<string, never>> {
  readonly sessions: GlobalSessionSummary[] = observable([]);
  private indexedById = new Map<string, GlobalSessionSummary>();
  private indexedByProject = new Map<string, GlobalSessionSummary[]>();
  private resolvedSessionIds = new Set<string>();

  find(sessionId: string) {
    return this.indexedById.get(sessionId);
  }

  get sessionsById(): ReadonlyMap<string, GlobalSessionSummary> {
    return this.indexedById;
  }

  get sessionsByProject(): ReadonlyMap<string, readonly GlobalSessionSummary[]> {
    return this.indexedByProject;
  }

  projectSessions(workspacePath: string) {
    return this.indexedByProject.get(workspacePath) ?? [];
  }

  replace(sessions: GlobalSessionSummary[]) {
    this.assertUniqueIds(sessions);
    this.sessions.splice(0, this.sessions.length, ...sessions);
    this.sortByActivity();
    this.rebuildIndexes();
  }

  applyWorkspace(workspacePath: string, workspaceName: string, sessions: SessionSnapshot["sessions"]) {
    const prior = new Map(this.sessions.filter((session) => session.workspacePath === workspacePath).map((session) => [session.id, session]));
    const otherSessions = this.sessions.filter((session) => session.workspacePath !== workspacePath);
    const workspaceSessions = sessions.map((session) => ({
      ...session,
      resolved: this.resolvedSessionIds.has(session.id) || prior.get(session.id)?.resolved === true || session.resolved,
      workspacePath,
      workspaceName
    }));
    const next = [...otherSessions, ...workspaceSessions];
    this.assertUniqueIds(next);
    this.sessions.splice(0, this.sessions.length, ...next);
    this.sortByActivity();
    this.rebuildIndexes();
  }

  applyResolvedState(resolvedSessionIds: readonly string[]) {
    this.resolvedSessionIds = new Set(resolvedSessionIds);
    for (let index = 0; index < this.sessions.length; index += 1) {
      const session = this.sessions[index]!;
      const resolved = this.resolvedSessionIds.has(session.id);
      if (session.resolved !== resolved) this.sessions.splice(index, 1, { ...session, resolved });
    }
    this.rebuildIndexes();
  }

  rename(sessionId: string, title: string) {
    const index = this.sessions.findIndex((session) => session.id === sessionId);
    if (index < 0) return undefined;
    const session = this.sessions[index]!;
    const previousTitle = session.title;
    this.sessions.splice(index, 1, { ...session, title });
    this.rebuildIndexes();
    return previousTitle;
  }

  updateWorkspaceNames(names: ReadonlyMap<string, string>) {
    for (let index = 0; index < this.sessions.length; index += 1) {
      const session = this.sessions[index]!;
      const workspaceName = names.get(session.workspacePath) ?? session.workspaceName;
      if (workspaceName !== session.workspaceName) this.sessions.splice(index, 1, { ...session, workspaceName });
    }
    this.rebuildIndexes();
  }

  private sortByActivity() {
    this.sessions.sort((left, right) => right.modified.localeCompare(left.modified));
  }

  private assertUniqueIds(sessions: readonly GlobalSessionSummary[]) {
    const seen = new Set<string>();
    for (const session of sessions) {
      if (seen.has(session.id)) throw new Error(`Session ID collision detected: ${session.id}`);
      seen.add(session.id);
    }
  }

  private rebuildIndexes() {
    const byId = new Map<string, GlobalSessionSummary>();
    const byProject = new Map<string, GlobalSessionSummary[]>();
    for (const session of this.sessions) {
      byId.set(session.id, session);
      const projectSessions = byProject.get(session.workspacePath) ?? [];
      projectSessions.push(session);
      byProject.set(session.workspacePath, projectSessions);
    }
    this.indexedById = byId;
    this.indexedByProject = byProject;
  }
}
