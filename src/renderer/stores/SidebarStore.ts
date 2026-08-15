import { Store, observable } from "r-state-tree";
import type { ApplicationState, ProjectRecord } from "../../ipc/session-contract";
import { displaySessionTitle } from "../models/session-title";
import type { SessionCatalogStore } from "./SessionCatalogStore";

export interface SidebarStoreProps {
  activeSession(): { workspacePath: string; sessionId: string } | undefined;
  catalog: SessionCatalogStore;
}

/** Owns project navigation, session search/pagination, and activity badges. */
export class SidebarStore extends Store<SidebarStoreProps> {
  recentProjectPaths: string[] = observable([]);
  projects: ProjectRecord[] = observable([]);
  activityBySession: Record<string, "running" | "unread"> = observable({});
  search = "";
  limitsByProject: Record<string, number> = observable({});

  get sessions() { return this.props.catalog.sessions; }

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
    this.props.catalog.updateWorkspaceNames(names);
    const registeredPaths = new Set(state.projects.map((project) => project.path));
    const paths = this.recentProjectPaths.filter((path) => registeredPaths.has(path));
    for (const project of state.projects) if (!paths.includes(project.path)) paths.push(project.path);
    this.recentProjectPaths.splice(0, this.recentProjectPaths.length, ...paths);
  }

  private sessionKey(workspacePath: string, sessionId: string) {
    return `${workspacePath}\u0000${sessionId}`;
  }
}
