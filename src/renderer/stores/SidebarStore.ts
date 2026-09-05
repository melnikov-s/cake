import { Store, observable, snapshot } from "r-state-tree";
import { formatRelativeSessionTime } from "../../utils/format-relative-session-time";
import type { ProjectCatalogStore } from "./ProjectCatalogStore";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import type { SessionRegistryStore } from "./SessionRegistryStore";
import type { CakeChatCollectionStore } from "./CakeChatCollectionStore";
import { RendererClientContext } from "../client/RendererClientContext";
import type { ProjectSessionCatalogQuery } from "../../domain/project-session-data";
import type { CakeChatCatalogQuery } from "../../domain/cake-chat-data";
import type { EmbeddedEditorSettingsStore } from "./EmbeddedEditorSettingsStore";

export interface SidebarStoreProps {
  projects: ProjectCatalogStore;
  catalog: SessionCatalogStore;
  sessions: SessionRegistryStore;
  cakeChat(): CakeChatCollectionStore;
  setSessionResolved(sessionId: string, resolved: boolean): Promise<void>;
  setCakeChatSessionResolved(sessionId: string, resolved: boolean): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  deleteCakeChatSession(sessionId: string): Promise<void>;
  setSessionUnread(sessionId: string, unread: boolean): Promise<void>;
  embeddedEditorSettings: EmbeddedEditorSettingsStore;
}

/** Owns project navigation, metadata-stream demand, and activity badges. */
export class SidebarStore extends Store<SidebarStoreProps> {
  get electron() {
    return RendererClientContext.consume(this)!.electron;
  }

  @snapshot hidden = false;
  @snapshot width = 292;
  private ideActive = false;
  private ideHidden: boolean | undefined;
  private ideVisibilityManuallySet = false;
  private ideViewportWidth = Number.POSITIVE_INFINITY;
  @snapshot private readonly expandedActiveGroups: Record<string, boolean> = observable({
    "cake-chat": true,
  });
  private readonly expandedResolvedGroups: Record<string, boolean> = observable({});
  private readonly activatedResolvedCatalogs: Record<string, boolean> = observable({});
  private readonly sessionLimits: Record<string, number> = observable({});
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
    this.effect(() => {
      const browserWindow = globalThis.window;
      if (!browserWindow) return;
      const updateViewportWidth = () => this.updateIdeViewportWidth(browserWindow.innerWidth);
      browserWindow.addEventListener("resize", updateViewportWidth);
      return () => browserWindow.removeEventListener("resize", updateViewportWidth);
    });
    this.reaction(
      () => [
        this.props.embeddedEditorSettings.sidebarAutoHide,
        this.props.embeddedEditorSettings.sidebarAutoHideWidth,
      ],
      () => this.applyIdeAutoHide(),
    );
  }

  get visible() {
    return !(this.ideActive ? (this.ideHidden ?? this.hidden) : this.hidden);
  }

  get sessions() {
    return this.props.catalog.sessions;
  }

  toggle() {
    if (this.ideActive) {
      this.ideHidden = this.visible;
      this.ideVisibilityManuallySet = true;
      return;
    }
    this.hidden = !this.hidden;
  }

  enterIdeMode(viewportWidth = globalThis.window?.innerWidth ?? Number.POSITIVE_INFINITY) {
    if (this.ideActive) return;
    this.ideActive = true;
    this.ideViewportWidth = viewportWidth;
    this.ideVisibilityManuallySet = false;
    this.applyIdeAutoHide();
  }

  leaveIdeMode() {
    this.ideActive = false;
    this.ideHidden = undefined;
    this.ideVisibilityManuallySet = false;
  }

  updateIdeViewportWidth(width: number) {
    this.ideViewportWidth = width;
    this.applyIdeAutoHide();
  }

  private applyIdeAutoHide() {
    if (!this.ideActive || this.ideVisibilityManuallySet) return;
    const settings = this.props.embeddedEditorSettings;
    this.ideHidden =
      settings.sidebarAutoHide === "always" ||
      (settings.sidebarAutoHide === "below-width" &&
        this.ideViewportWidth < settings.sidebarAutoHideWidth)
        ? true
        : undefined;
  }

  setWidth(width: number) {
    this.width = width;
  }

  showSessionContextMenu(
    sessionId: string,
    x: number,
    y: number,
    resolved: boolean,
    unread?: boolean,
  ) {
    return this.electron.showSessionContextMenu({ sessionId, x, y, resolved, unread });
  }

  showProjectContextMenu(path: string, x: number, y: number) {
    return this.electron.showProjectContextMenu({
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

  sessionLimit(groupKey: string, resolved = false) {
    return this.sessionLimits[this.limitKey(groupKey, resolved)] ?? 10;
  }

  showMoreSessions(groupKey: string, resolved = false) {
    const key = this.limitKey(groupKey, resolved);
    this.sessionLimits[key] = this.sessionLimit(groupKey, resolved) + 10;
  }

  sessionActivity(sessionId: string) {
    const activity = this.props.sessions.findSession(sessionId)?.activity;
    if (activity) return activity;
    return this.props.catalog.find(sessionId)?.unread ? "unread" : undefined;
  }

  isActiveGroupExpanded(groupKey: string) {
    return this.expandedActiveGroups[groupKey] !== false;
  }

  toggleActiveGroupExpanded(groupKey: string) {
    this.expandedActiveGroups[groupKey] = !this.isActiveGroupExpanded(groupKey);
  }

  isResolvedGroupExpanded(groupKey: string) {
    return this.expandedResolvedGroups[groupKey] === true;
  }

  toggleResolvedGroupExpanded(groupKey: string) {
    const expanded = !this.isResolvedGroupExpanded(groupKey);
    this.expandedResolvedGroups[groupKey] = expanded;
    if (expanded) this.activatedResolvedCatalogs[groupKey] = true;
  }

  get projectSessionCatalogQueries(): ReadonlyArray<ProjectSessionCatalogQuery> {
    const queries: ProjectSessionCatalogQuery[] = [];
    for (const projectPath of this.props.projects.orderedProjectPaths) {
      queries.push({ projectPath, resolved: false });
      if (this.activatedResolvedCatalogs[projectPath])
        queries.push({ projectPath, resolved: true });
    }
    return queries;
  }

  get cakeChatCatalogQueries(): ReadonlyArray<CakeChatCatalogQuery> {
    return this.activatedResolvedCatalogs["cake-chat"]
      ? [{ resolved: false }, { resolved: true }]
      : [{ resolved: false }];
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

  private limitKey(groupKey: string, resolved: boolean) {
    return `${resolved ? "resolved" : "active"}:${groupKey}`;
  }
}
