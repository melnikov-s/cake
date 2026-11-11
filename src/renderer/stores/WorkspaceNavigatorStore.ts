import { Store, snapshot } from "r-state-tree";
import { MIN_WORKSPACE_PANEL_WIDTH } from "../lib/workspace-panel-geometry";
import type { ProjectSessionPresentationMode } from "../../contracts/project-sessions/project-session-presentation";
import { CAKE_CHAT_SESSION_ID } from "../../contracts/cake-chats/cake-chat-identity";
import type { WidgetAttachmentStore } from "./WidgetAttachmentStore";
import type { CakeChatCollectionStore } from "./CakeChatCollectionStore";

export type WorkspaceNavigatorMode = "todos" | "sessions";

/** Owns the one right-hand navigation accessory across chat and real tool surfaces. */
export class WorkspaceNavigatorStore extends Store<{
  widgets(): WidgetAttachmentStore;
  projectPath(): string | undefined;
  activeSessionId(): string | undefined;
  cakeChat(): CakeChatCollectionStore;
  replyContext(name: string, text: string): void;
  companionSession():
    | {
        presentationMode: ProjectSessionPresentationMode;
        workspaceChatSidebarVisible: boolean;
        showWorkspaceChatSidebar(): void;
        toggleWorkspaceChatSidebar(): void;
      }
    | undefined;
}> {
  @snapshot accessoryVisible = true;
  @snapshot companionTab: "chat" | WorkspaceNavigatorMode = "chat";
  @snapshot mode: WorkspaceNavigatorMode = "todos";
  private selectedWidgetId?: string;

  get selectedWidget() {
    return this.props.widgets().tabWidgets.find((entry) => entry.id === this.selectedWidgetId);
  }

  get showingWidget() {
    return Boolean(this.selectedWidget);
  }

  showWidget(id: string) {
    if (!this.props.widgets().tabWidgets.some((entry) => entry.id === id)) return;
    this.selectedWidgetId = id;
    this.accessoryVisible = true;
    this.companionTab = this.mode;
    this.props.companionSession()?.showWorkspaceChatSidebar();
  }
  /** Preferred width across modes; layout clamps never overwrite it. */
  @snapshot width = 320;

  constructor(props: WorkspaceNavigatorStore["props"]) {
    super(props);
    // Default to Chat on conversation or tool-mode entry, not on refreshes or tab changes.
    this.reaction(
      () => ({
        sessionId: this.props.activeSessionId(),
        mode: this.props.companionSession()?.presentationMode,
      }),
      (current, previous) => {
        if (
          current.sessionId &&
          current.mode &&
          current.mode !== "normal" &&
          (current.sessionId !== previous?.sessionId || current.mode !== previous?.mode)
        )
          this.showChat();
      },
    );
  }

  get inCompanion() {
    return Boolean(this.props.companionSession());
  }

  get visible() {
    const session = this.props.companionSession();
    return session
      ? session.workspaceChatSidebarVisible && this.companionTab !== "chat"
      : this.accessoryVisible;
  }

  /** The shell toggle owns the whole companion in tool modes, only the accessory in Main. */
  get paneVisible() {
    return this.props.companionSession()?.workspaceChatSidebarVisible ?? this.accessoryVisible;
  }

  togglePane() {
    const session = this.props.companionSession();
    if (session) session.toggleWorkspaceChatSidebar();
    else this.accessoryVisible = !this.accessoryVisible;
  }

  showChat() {
    this.selectedWidgetId = undefined;
    this.companionTab = "chat";
    this.props.companionSession()?.showWorkspaceChatSidebar();
  }

  get projectPath() {
    return this.props.projectPath();
  }

  get todoSessionId() {
    return this.projectPath
      ? this.props.cakeChat().projectChat(this.projectPath)?.sessionId
      : CAKE_CHAT_SESSION_ID;
  }

  get todos() {
    const id = this.todoSessionId;
    return id ? this.props.cakeChat().registry.load(id).todos : undefined;
  }

  show(mode: WorkspaceNavigatorMode) {
    this.selectedWidgetId = undefined;
    this.mode = mode;
    this.accessoryVisible = true;
    this.companionTab = mode;
    this.props.companionSession()?.showWorkspaceChatSidebar();
  }

  toggle(mode?: WorkspaceNavigatorMode) {
    if (mode && (this.showingWidget || this.mode !== mode || !this.visible)) this.show(mode);
    else if (this.visible) this.close();
    else this.show(mode ?? this.mode);
  }

  close() {
    if (this.inCompanion) this.companionTab = "chat";
    else this.accessoryVisible = false;
  }

  setWidth(width: number) {
    this.width = Math.max(MIN_WORKSPACE_PANEL_WIDTH, width);
  }

  replyContext(name: string, text: string) {
    this.props.replyContext(name, text);
  }

  todoPane(sessionId: string) {
    return {
      visible:
        this.visible &&
        !this.showingWidget &&
        this.mode === "todos" &&
        this.todoSessionId === sessionId,
      open: () => {
        if (this.todoSessionId === sessionId) this.show("todos");
      },
      close: () => this.close(),
    };
  }
}
