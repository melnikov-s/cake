import { Store, observable } from "r-state-tree";
import { formatRelativeSessionTime } from "../models/session-activity-time";
import type { ProjectCatalogStore } from "./ProjectCatalogStore";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import type { SessionRegistryStore } from "./SessionRegistryStore";
import type { GlobalChatStore } from "./GlobalChatStore";

export interface SidebarStoreProps {
  projects: ProjectCatalogStore;
  catalog: SessionCatalogStore;
  sessions: SessionRegistryStore;
  cakeChat(): GlobalChatStore;
  setProjectSessionResolved(workspacePath: string, sessionId: string, resolved: boolean): Promise<void>;
  setCakeChatSessionResolved(sessionId: string, resolved: boolean): Promise<void>;
}

/** Owns project navigation, session pagination, and activity badges. */
export class SidebarStore extends Store<SidebarStoreProps> {
  limitsByProject: Record<string, number> = observable({});
  resolvedLaneExpanded = true;
  now = Date.now();

  constructor(props: SidebarStore["props"]) {
    super(props);
    this.effect(() => {
      const timer = setInterval(() => { this.now = Date.now(); }, 60_000);
      return () => clearInterval(timer);
    });
  }

  get sessions() { return this.props.catalog.sessions; }

  projectSessions(workspacePath: string, resolved = false) {
    const resolvedIds = new Set(this.props.projects.find(workspacePath)?.resolvedSessionIds ?? []);
    return this.sessions.filter((item) => item.workspacePath === workspacePath && resolvedIds.has(item.id) === resolved);
  }

  cakeChatSessions(resolved = false) {
    return this.props.cakeChat().summaries.filter((session) => session.resolved === resolved);
  }

  get hasResolvedSessions() {
    return this.cakeChatSessions(true).length > 0
      || this.props.projects.recentProjectPaths.some((path) => this.projectSessions(path, true).length > 0);
  }

  sessionActivity(workspacePath: string, sessionId: string) {
    return this.props.sessions.findSession(sessionId, workspacePath)?.activity;
  }

  sessionLimit(workspacePath: string, resolved = false) {
    return this.limitsByProject[this.limitKey(workspacePath, resolved)] ?? 10;
  }

  showMoreSessions(workspacePath: string, resolved = false) {
    const key = this.limitKey(workspacePath, resolved);
    this.limitsByProject[key] = this.sessionLimit(workspacePath, resolved) + 10;
  }

  setProjectSessionResolved(workspacePath: string, sessionId: string, resolved: boolean) {
    return this.props.setProjectSessionResolved(workspacePath, sessionId, resolved);
  }

  setCakeChatSessionResolved(sessionId: string, resolved: boolean) {
    return this.props.setCakeChatSessionResolved(sessionId, resolved);
  }

  toggleResolvedLane() {
    this.resolvedLaneExpanded = !this.resolvedLaneExpanded;
  }

  sessionActivityTime(modified: string) {
    return formatRelativeSessionTime(modified, this.now);
  }

  private limitKey(workspacePath: string, resolved: boolean) {
    return `${resolved ? "resolved" : "active"}\u0000${workspacePath}`;
  }
}
