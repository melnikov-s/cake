import { Store, snapshot } from "r-state-tree";
import { CAKE_CHAT_SESSION_ID } from "../../contracts/cake-chats/cake-chat-identity";
import type { CakeChatCollectionStore } from "./CakeChatCollectionStore";

export type WorkspaceNavigatorMode = "todos" | "sessions";

/** Owns the one right-hand navigation accessory across chat and real tool surfaces. */
export class WorkspaceNavigatorStore extends Store<{
  projectPath(): string | undefined;
  cakeChat(): CakeChatCollectionStore;
  replyContext(name: string, text: string): void;
}> {
  @snapshot visible = true;
  @snapshot mode: WorkspaceNavigatorMode = "todos";
  @snapshot width = 320;

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
    this.visible = true;
  }

  toggle(mode?: WorkspaceNavigatorMode) {
    if (mode && (this.mode !== mode || !this.visible)) this.show(mode);
    else this.visible = !this.visible;
  }

  close() {
    this.visible = false;
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
