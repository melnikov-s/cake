import { Store, observable } from "r-state-tree";
import { formatRelativeSessionTime } from "../models/session-activity-time";
import type { ProjectCatalogStore } from "./ProjectCatalogStore";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import type { SessionRegistryStore } from "./SessionRegistryStore";

export interface SidebarStoreProps {
  projects: ProjectCatalogStore;
  catalog: SessionCatalogStore;
  sessions: SessionRegistryStore;
}

/** Owns project navigation, session pagination, and activity badges. */
export class SidebarStore extends Store<SidebarStoreProps> {
  limitsByProject: Record<string, number> = observable({});
  now = Date.now();

  constructor(props: SidebarStore["props"]) {
    super(props);
    this.effect(() => {
      const timer = setInterval(() => { this.now = Date.now(); }, 60_000);
      return () => clearInterval(timer);
    });
  }

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

  sessionActivityTime(modified: string) {
    return formatRelativeSessionTime(modified, this.now);
  }
}
