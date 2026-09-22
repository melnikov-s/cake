import { Store, child, createStore, snapshot } from "r-state-tree";
import { formatRelativeSessionTime } from "../../utils/format-relative-session-time";
import type { WorktreeOperationCatalog } from "../models/WorktreeOperationCatalog";
import type { CakeChatCollectionStore } from "./CakeChatCollectionStore";
import { ClientContext } from "./context/ClientContext";
import type { EmbeddedEditorSettingsStore } from "./EmbeddedEditorSettingsStore";
import type { ProjectCatalogStore } from "./ProjectCatalogStore";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import type { SessionMetadataStore } from "./SessionMetadataStore";
import type { SessionRegistryStore } from "./SessionRegistryStore";
import { SidebarSessionListStore } from "./SidebarSessionListStore";

export interface SidebarStoreProps {
  projects: ProjectCatalogStore;
  catalog: SessionCatalogStore;
  sessions: SessionRegistryStore;
  sessionMetadata: SessionMetadataStore;
  worktreeOperations?: WorktreeOperationCatalog;
  cakeChat(): CakeChatCollectionStore;
  selectedConversation?(): { kind: "project-session" | "cake-chat"; sessionId: string } | undefined;
  setSessionResolved(sessionId: string, resolved: boolean): Promise<void>;
  setSessionLabels(sessionId: string, labelIds: readonly string[]): Promise<void>;
  setCakeChatSessionResolved(sessionId: string, resolved: boolean): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  deleteCakeChatSession(sessionId: string): Promise<void>;
  setSessionUnread(sessionId: string, unread: boolean): Promise<void>;
  embeddedEditorSettings: EmbeddedEditorSettingsStore;
}

/** Owns sidebar visibility, sizing, navigation mode, and Project focus presentation. */
export class SidebarStore extends Store<SidebarStoreProps> {
  get electron() {
    return ClientContext.consume(this)!.electron;
  }

  @snapshot hidden = false;
  @snapshot width = 292;
  @snapshot navigationMode: "projects" | "activity" = "projects";
  /** Window-local presentation mode that narrows navigation to one Project. */
  @snapshot focusedProjectPath: string | undefined;
  private ideActive = false;
  private ideHidden: boolean | undefined;
  private ideVisibilityManuallySet = false;
  private ideViewportWidth = Number.POSITIVE_INFINITY;
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

  @child
  get sessionListStore(): SidebarSessionListStore {
    return createStore(SidebarSessionListStore, {
      projects: this.props.projects,
      catalog: this.props.catalog,
      sessions: this.props.sessions,
      sessionMetadata: this.props.sessionMetadata,
      worktreeOperations: this.props.worktreeOperations,
      cakeChat: this.props.cakeChat,
      selectedConversation: this.props.selectedConversation,
    });
  }

  get visible() {
    return !(this.ideActive ? (this.ideHidden ?? this.hidden) : this.hidden);
  }

  get focusModeProjectPath() {
    const path = this.focusedProjectPath;
    return path && this.props.projects.find(path) ? path : undefined;
  }

  focusProject(path: string) {
    if (!this.props.projects.find(path)) return;
    this.focusedProjectPath = path;
    this.sessionListStore.expandActiveGroup(path);
  }

  leaveProjectFocus() {
    this.focusedProjectPath = undefined;
  }

  managedWorktree(workingDirectory: string) {
    return this.props.catalog.managedWorktree(workingDirectory);
  }

  projectSessionCount(path: string) {
    return this.props.catalog.projectSessions(path).length;
  }

  resolvedWorktreeCount(path: string) {
    return this.props.catalog.resolvedWorktrees(path).length;
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
    familyChild?: boolean,
  ) {
    const session = this.props.catalog.find(sessionId);
    return this.electron.showSessionContextMenu({
      sessionId,
      x,
      y,
      resolved,
      draft: session?.draft === true,
      unread,
      familyChild,
    });
  }

  async showProjectContextMenu(path: string, x: number, y: number) {
    const action = await this.electron.showProjectContextMenu({
      path,
      x,
      y,
      resolvedWorktreeCount: this.props.catalog.resolvedWorktrees(path).length,
      sessionSort: this.sessionListStore.projectSessionSort(path),
    });
    if (action === "sort-by-date") this.sessionListStore.setProjectSessionSort(path, "date");
    if (action === "sort-by-label") this.sessionListStore.setProjectSessionSort(path, "label");
    return action;
  }

  showProjects() {
    this.navigationMode = "projects";
  }

  showActivity() {
    this.focusedProjectPath = undefined;
    this.navigationMode = "activity";
  }

  setSessionResolved(sessionId: string, resolved: boolean) {
    return this.props.setSessionResolved(sessionId, resolved);
  }

  setSessionLabels(sessionId: string, labelIds: readonly string[]) {
    return this.props.setSessionLabels(sessionId, labelIds);
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

  sessionActivityTime(modified: string) {
    return formatRelativeSessionTime(modified, this.now);
  }
}
