import { Store, snapshot } from "r-state-tree";
import { CAKE_CHAT_SESSION_ID } from "../../contracts/cake-chats/cake-chat-identity";
import type { CakeChatCollectionStore } from "./CakeChatCollectionStore";

export type WorkspaceNavigatorMode = "todos" | "sessions";

/** Owns the one right-hand navigation accessory across chat and real tool surfaces. */
export class WorkspaceNavigatorStore extends Store<{
  projectPath(): string | undefined;
  activeSessionId(): string | undefined;
  cakeChat(): CakeChatCollectionStore;
  replyContext(name: string, text: string): void;
  companionSession():
    | {
        workspaceChatSidebarVisible: boolean;
        showWorkspaceChatSidebar(): void;
        toggleWorkspaceChatSidebar(): void;
      }
    | undefined;
}> {
  @snapshot accessoryVisible = true;
  @snapshot companionTab: "chat" | WorkspaceNavigatorMode = "chat";
  @snapshot mode: WorkspaceNavigatorMode = "todos";
  @snapshot width = 320;

  constructor(props: WorkspaceNavigatorStore["props"]) {
    super(props);
    // Follow navigation identity only: refreshes and manual pane/mode changes
    // within the current session must not take Chat back from the user.
    this.reaction(
      () => this.props.activeSessionId(),
      (sessionId) => {
        if (sessionId && this.props.companionSession()) this.showChat();
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
    this.mode = mode;
    this.accessoryVisible = true;
    this.companionTab = mode;
    this.props.companionSession()?.showWorkspaceChatSidebar();
  }

  toggle(mode?: WorkspaceNavigatorMode) {
    if (mode && (this.mode !== mode || !this.visible)) this.show(mode);
    else if (this.visible) this.close();
    else this.show(mode ?? this.mode);
  }

  close() {
    if (this.inCompanion) this.companionTab = "chat";
    else this.accessoryVisible = false;
  }

  setWidth(width: number) {
    this.width = Math.max(240, Math.min(520, width));
  }

  replyContext(name: string, text: string) {
    this.props.replyContext(name, text);
  }

  todoPane(sessionId: string) {
    return {
      visible: this.visible && this.mode === "todos" && this.todoSessionId === sessionId,
      open: () => {
        if (this.todoSessionId === sessionId) this.show("todos");
      },
      close: () => this.close(),
    };
  }
}
