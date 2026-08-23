import { Store, observable } from "r-state-tree";
import { formatRelativeSessionTime } from "../../utils/format-relative-session-time";
import type { ProjectCatalogStore } from "./ProjectCatalogStore";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import type { SessionRegistryStore } from "./SessionRegistryStore";
import type { GlobalChatStore } from "./GlobalChatStore";
import type { DesktopClient } from "../desktop-client";

export interface SidebarStoreProps {
  client: Pick<DesktopClient, "showSessionContextMenu">;
  projects: ProjectCatalogStore;
  catalog: SessionCatalogStore;
  sessions: SessionRegistryStore;
  cakeChat(): GlobalChatStore;
  setSessionResolved(sessionId: string, resolved: boolean): Promise<void>;
  setCakeChatSessionResolved(sessionId: string, resolved: boolean): Promise<void>;
}

/** Owns project navigation, session pagination, and activity badges. */
export class SidebarStore extends Store<SidebarStoreProps> {
  limitsByProject: Record<string, number> = observable({});
  collapsedGroups: Record<string, boolean> = observable({});
  resolvedLaneExpanded = true;
  now = Date.now();

  constructor(props: SidebarStore["props"]) {
    super(props);
    this.effect(() => {
      const timer = setInterval(() => {
        this.now = Date.now();
      }, 60_000);
      return () => clearInterval(timer);
    });
  }

  get sessions() {
    return this.props.catalog.sessions;
  }

  showSessionContextMenu(sessionId: string, x: number, y: number) {
    return this.props.client.showSessionContextMenu({ sessionId, x, y });
  }

  projectSessions(workspacePath: string, resolved = false) {
    return this.props.catalog
      .projectSessions(workspacePath)
      .filter((item) => item.resolved === resolved);
  }

  cakeChatSessions(resolved = false) {
    return this.props.cakeChat().summaries.filter((session) => session.resolved === resolved);
  }

  get hasResolvedSessions() {
    return (
      this.cakeChatSessions(true).length > 0 ||
      this.props.projects.recentProjectPaths.some(
        (path) => this.projectSessions(path, true).length > 0,
      )
    );
  }

  sessionActivity(sessionId: string) {
    return this.props.sessions.findSession(sessionId)?.activity;
  }

  sessionLimit(workspacePath: string, resolved = false) {
    return this.limitsByProject[this.limitKey(workspacePath, resolved)] ?? 10;
  }

  showMoreSessions(workspacePath: string, resolved = false) {
    const key = this.limitKey(workspacePath, resolved);
    this.limitsByProject[key] = this.sessionLimit(workspacePath, resolved) + 10;
  }

  isGroupCollapsed(groupKey: string) {
    return this.collapsedGroups[groupKey] === true;
  }

  toggleGroupCollapsed(groupKey: string) {
    this.collapsedGroups[groupKey] = !this.isGroupCollapsed(groupKey);
  }

  setSessionResolved(sessionId: string, resolved: boolean) {
    return this.props.setSessionResolved(sessionId, resolved);
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
