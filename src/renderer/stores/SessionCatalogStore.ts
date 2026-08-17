import { Store, observable } from "r-state-tree";
import type { GlobalSessionSummary, ProjectRecord, SessionSnapshot } from "../../ipc/session-contract";

/** The single renderer-owned catalog of Pi session summaries. */
export class SessionCatalogStore extends Store<Record<string, never>> {
  readonly sessions: GlobalSessionSummary[] = observable([]);

  find(workspacePath: string, sessionId: string) {
    return this.sessions.find((session) => session.workspacePath === workspacePath && session.id === sessionId);
  }

  replace(sessions: GlobalSessionSummary[]) {
    this.sessions.splice(0, this.sessions.length, ...sessions);
    this.sortByActivity();
  }

  applyWorkspace(workspacePath: string, workspaceName: string, sessions: SessionSnapshot["sessions"]) {
    const prior = new Map(this.sessions.filter((session) => session.workspacePath === workspacePath).map((session) => [session.id, session]));
    const otherSessions = this.sessions.filter((session) => session.workspacePath !== workspacePath);
    const workspaceSessions = sessions.map((session) => ({ ...session, resolved: prior.get(session.id)?.resolved ?? session.resolved, workspacePath, workspaceName }));
    this.sessions.splice(0, this.sessions.length, ...otherSessions, ...workspaceSessions);
    this.sortByActivity();
  }

  applyProjectResolvedState(projects: readonly ProjectRecord[]) {
    const resolvedByProject = new Map(projects.map((project) => [project.path, new Set(project.resolvedSessionIds)]));
    for (let index = 0; index < this.sessions.length; index += 1) {
      const session = this.sessions[index]!;
      const resolved = resolvedByProject.get(session.workspacePath)?.has(session.id) ?? false;
      if (session.resolved !== resolved) this.sessions.splice(index, 1, { ...session, resolved });
    }
  }

  rename(workspacePath: string, sessionId: string, title: string) {
    const index = this.sessions.findIndex((session) => session.workspacePath === workspacePath && session.id === sessionId);
    if (index < 0) return undefined;
    const session = this.sessions[index]!;
    const previousTitle = session.title;
    this.sessions.splice(index, 1, { ...session, title });
    return previousTitle;
  }

  updateWorkspaceNames(names: ReadonlyMap<string, string>) {
    for (let index = 0; index < this.sessions.length; index += 1) {
      const session = this.sessions[index]!;
      const workspaceName = names.get(session.workspacePath) ?? session.workspaceName;
      if (workspaceName !== session.workspaceName) this.sessions.splice(index, 1, { ...session, workspaceName });
    }
  }

  private sortByActivity() {
    this.sessions.sort((left, right) => right.modified.localeCompare(left.modified));
  }
}
