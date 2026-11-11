import { Store, child, computed, createStore, snapshot } from "r-state-tree";
import { formatRelativeSessionTime } from "../../utils/format-relative-session-time";
import type { CakeChatCollectionStore } from "./CakeChatCollectionStore";
import { ClientContext } from "./context/ClientContext";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import { SessionManagementContext } from "./context/SessionManagementContext";
import { SessionRetirementContext } from "./context/SessionRetirementContext";
import { SessionRegistryContext } from "./context/SessionRegistryContext";
import { SidebarSessionListStore } from "./SidebarSessionListStore";
import { SessionSearchStore } from "./SessionSearchStore";
import { WorkspaceNavigatorContext } from "./context/WorkspaceNavigatorContext";

export interface SidebarStoreProps {
  catalog: SessionCatalogStore;
  createAutomation?(projectPath: string): void;
  cakeChat(): CakeChatCollectionStore;
  selectedConversation?(): { kind: "project-session" | "cake-chat"; sessionId: string } | undefined;
}

/** Owns sidebar visibility, sizing, navigation mode, and Project focus presentation. */
export class SidebarStore extends Store<SidebarStoreProps> {
  get electron() {
    return ClientContext.consume(this)!.electron;
  }

  private get sessions() {
    return SessionRegistryContext.consume(this)!;
  }

  @snapshot hidden = false;
  @snapshot width = 292;
  @snapshot navigationMode: "projects" | "activity" = "projects";
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

  @child
  get sessionListStore(): SidebarSessionListStore {
    return createStore(SidebarSessionListStore, {
      catalog: this.props.catalog,
      cakeChat: this.props.cakeChat,
      additionalCatalogDemand: () => this.sessionSearchStore.open,
      selectedConversation: this.props.selectedConversation,
    });
  }

  @child
  get sessionSearchStore(): SessionSearchStore {
    return createStore(SessionSearchStore, {
      catalog: this.props.catalog,
    });
  }

  get visible() {
    return !this.hidden;
  }

  managedWorktree(workingDirectory: string) {
    return this.props.catalog.managedWorktree(workingDirectory);
  }

  /** Focus is scope-owned, so its associations survive worker/tool navigation and pane closure. */
  @computed
  private get focusedTodos() {
    return WorkspaceNavigatorContext.consume(this)?.todos?.focusedItems;
  }

  /** Association cues are independent of navigation selection and attention. */
  isSessionAssociatedWithFocusedTodos(sessionId: string) {
    return (
      this.focusedTodos?.some((todo) =>
        todo.associations.some(
          (association) => association.kind === "session" && association.sessionId === sessionId,
        ),
      ) ?? false
    );
  }

  projectSessionCount(path: string) {
    return this.props.catalog.projectSessions(path).length;
  }

  resolvedWorktreeCount(path: string) {
    return this.props.catalog.resolvedWorktrees(path).length;
  }

  toggle() {
    this.hidden = !this.hidden;
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
      delegated: session?.purpose === "delegated",
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
    if (action === "new-automation") this.props.createAutomation?.(path);
    if (action === "sort-by-date") this.sessionListStore.setProjectSessionSort(path, "date");
    if (action === "sort-by-label") this.sessionListStore.setProjectSessionSort(path, "label");
    return action;
  }

  showProjects() {
    this.navigationMode = "projects";
  }

  showActivity() {
    this.navigationMode = "activity";
  }

  moveToUser(sessionId: string) {
    return SessionManagementContext.consume(this)!.moveToUser(sessionId);
  }

  renameSession(sessionId: string, name: string) {
    return SessionManagementContext.consume(this)!.renameSession(sessionId, name);
  }

  async setSessionResolved(sessionId: string, resolved: boolean) {
    await SessionRetirementContext.consume(this)!.setProjectSessionResolved(sessionId, resolved);
  }

  setSessionLabels(sessionId: string, labelIds: readonly string[]) {
    return SessionManagementContext.consume(this)!.setSessionLabels(sessionId, labelIds);
  }

  deleteSession(sessionId: string) {
    return SessionRetirementContext.consume(this)!.deleteProjectSession(sessionId);
  }

  setSessionUnread(sessionId: string, unread: boolean) {
    if (!unread) this.sessions.findSession(sessionId)?.markRead();
    return SessionManagementContext.consume(this)!.setSessionUnread(sessionId, unread);
  }

  sessionActivityTime(modified: string) {
    return formatRelativeSessionTime(modified, this.now);
  }
}
