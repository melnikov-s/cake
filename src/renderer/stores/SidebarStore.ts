import { Store, observable } from "r-state-tree";
import { formatRelativeSessionTime } from "../../utils/format-relative-session-time";
import type { ProjectCatalogStoreInstance } from "./ProjectCatalogStore";
import type { SessionCatalogStoreInstance } from "./SessionCatalogStore";
import type { SessionRegistryStore } from "./SessionRegistryStore";
import type { GlobalChatStore } from "./GlobalChatStore";
import type { DesktopClient } from "../desktop-client";

export interface SidebarStoreProps {
  client: Pick<DesktopClient, "showSessionContextMenu" | "showProjectContextMenu">;
  projects: ProjectCatalogStoreInstance;
  catalog: SessionCatalogStoreInstance;
  sessions: SessionRegistryStore;
  cakeChat(): GlobalChatStore;
  setSessionResolved(sessionId: string, resolved: boolean): Promise<void>;
  setCakeChatSessionResolved(sessionId: string, resolved: boolean): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  deleteCakeChatSession(sessionId: string): Promise<void>;
  setSessionUnread(sessionId: string, unread: boolean): Promise<void>;
}

/** Owns project navigation, session pagination, and activity badges. */
export class SidebarStore extends Store<SidebarStoreProps> {
  limitsByProject: Record<string, number> = observable({});
  collapsedGroups: Record<string, boolean> = observable({});
  resolvedLaneExpanded = false;
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

  showSessionContextMenu(
    sessionId: string,
    x: number,
    y: number,
    resolved: boolean,
    unread?: boolean,
  ) {
    return this.props.client.showSessionContextMenu({ sessionId, x, y, resolved, unread });
  }

  showProjectContextMenu(path: string, x: number, y: number) {
    return this.props.client.showProjectContextMenu({
      path,
      x,
      y,
      resolvedWorktreeCount: this.props.catalog.resolvedWorktrees(path).length,
    });
  }

  projectSessionCount(path: string) {
    return this.props.catalog.projectSessions(path).length;
  }

  resolvedWorktreeCount(path: string) {
    return this.props.catalog.resolvedWorktrees(path).length;
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
    const activity = this.props.sessions.findSession(sessionId)?.activity;
    if (activity) return activity;
    return this.props.catalog.find(sessionId)?.unread ? "unread" : undefined;
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

  deleteSession(sessionId: string) {
    return this.props.deleteSession(sessionId);
  }

  deleteCakeChatSession(sessionId: string) {
    return this.props.deleteCakeChatSession(sessionId);
  }

  setSessionUnread(sessionId: string, unread: boolean) {
    if (!unread) this.props.sessions.findSession(sessionId)?.markRead();
    return this.props.setSessionUnread(sessionId, unread);
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
