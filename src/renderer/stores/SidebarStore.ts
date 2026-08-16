import { Store, observable } from "r-state-tree";
import { displaySessionTitle } from "../models/session-title";
import type { ProjectCatalogStore } from "./ProjectCatalogStore";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import type { SessionRegistryStore } from "./SessionRegistryStore";

export interface SidebarStoreProps {
  projects: ProjectCatalogStore;
  catalog: SessionCatalogStore;
  sessions: SessionRegistryStore;
}

/** Owns project navigation, session search/pagination, and activity badges. */
export class SidebarStore extends Store<SidebarStoreProps> {
  search = "";
  limitsByProject: Record<string, number> = observable({});

  get sessions() { return this.props.catalog.sessions; }

  projectSessions(workspacePath: string) {
    return this.sessions.filter((item) => item.workspacePath === workspacePath);
  }

  sessionActivity(workspacePath: string, sessionId: string) {
    return this.props.sessions.findSession(sessionId, workspacePath)?.activity;
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

  sessionDisplayTitle(title: string) {
    return displaySessionTitle(title);
  }
}
