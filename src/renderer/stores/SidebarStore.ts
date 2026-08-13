import { Store, observable } from "r-state-tree";
import type { ApplicationState, GlobalSessionSummary, ProjectRecord, SessionSnapshot } from "../../ipc/session-contract";
import { displaySessionTitle } from "../models/session-title";

export interface SidebarStoreProps {
  activeSession(): { workspacePath: string; sessionId: string } | undefined;
}

/** Owns the project/session catalog, search, pagination, and activity badges. */
export class SidebarStore extends Store<SidebarStoreProps> {
  recentProjectPaths: string[] = observable([]);
  projects: ProjectRecord[] = observable([]);
  sessions: GlobalSessionSummary[] = observable([]);
  activityBySession: Record<string, "running" | "unread"> = observable({});
  search = "";
  limitsByProject: Record<string, number> = observable({});

  projectSessions(workspacePath: string) {
    return this.sessions.filter((item) => item.workspacePath === workspacePath);
  }

  sessionActivity(workspacePath: string, sessionId: string) {
    return this.activityBySession[this.sessionKey(workspacePath, sessionId)];
  }

  updateSessionActivity(workspacePath: string, sessionId: string, streaming: boolean, wasStreaming = false, openingSession = false) {
    const key = this.sessionKey(workspacePath, sessionId);
    if (streaming) {
      this.activityBySession[key] = "running";
      return;
    }
    if (this.activityBySession[key] !== "running" && !wasStreaming) return;
    const active = this.props.activeSession();
    if ((active?.workspacePath === workspacePath && active.sessionId === sessionId) || openingSession) delete this.activityBySession[key];
    else this.activityBySession[key] = "unread";
  }

  markSessionRead(workspacePath: string, sessionId: string) {
    const key = this.sessionKey(workspacePath, sessionId);
    if (this.activityBySession[key] === "unread") delete this.activityBySession[key];
  }

  sessionLimit(workspacePath: string) {
    return this.limitsByProject[workspacePath] ?? 10;
  }

  showMoreSessions(workspacePath: string) {
    this.limitsByProject[workspacePath] = this.sessionLimit(workspacePath) + 10;
  }

  get searchedSessions() {
    const query = this.search.trim().toLocaleLowerCase();
    if (!query) return [];
    return this.sessions.filter((item) => `${item.title}\n${item.workspaceName}\n${item.workspacePath}`.toLocaleLowerCase().includes(query));
  }

  nameFromPath(path: string) {
    const normalized = path.replace(/\/+$/, "");
    return normalized.slice(normalized.lastIndexOf("/") + 1) || path;
  }

  sessionDisplayTitle(title: string) {
    return displaySessionTitle(title);
  }

  applyApplicationState(state: ApplicationState) {
    this.projects.splice(0, this.projects.length, ...state.projects);
    const names = new Map(state.projects.map((project) => [project.path, project.name]));
    const renamedSessions = this.sessions.map((session) => ({ ...session, workspaceName: names.get(session.workspacePath) ?? session.workspaceName }));
    this.sessions.splice(0, this.sessions.length, ...renamedSessions);
    const registeredPaths = new Set(state.projects.map((project) => project.path));
    const paths = this.recentProjectPaths.filter((path) => registeredPaths.has(path));
    for (const project of state.projects) if (!paths.includes(project.path)) paths.push(project.path);
    this.recentProjectPaths.splice(0, this.recentProjectPaths.length, ...paths);
  }

  replaceSessions(sessions: GlobalSessionSummary[]) {
    this.sessions.splice(0, this.sessions.length, ...sessions);
  }

  applyWorkspaceSessions(workspacePath: string, workspaceName: string, sessions: SessionSnapshot["sessions"]) {
    const otherSessions = this.sessions.filter((session) => session.workspacePath !== workspacePath);
    const workspaceSessions = sessions.map((session) => ({ ...session, workspacePath, workspaceName }));
    this.sessions.splice(0, this.sessions.length, ...otherSessions, ...workspaceSessions);
    this.sessions.sort((left, right) => right.modified.localeCompare(left.modified));
    if (!this.recentProjectPaths.includes(workspacePath)) this.recentProjectPaths.push(workspacePath);
  }

  private sessionKey(workspacePath: string, sessionId: string) {
    return `${workspacePath}\u0000${sessionId}`;
  }
}
