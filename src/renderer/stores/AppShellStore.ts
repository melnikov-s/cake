import { Store } from "r-state-tree";
import type { WindowConversationSelection } from "../../ipc/session-contract";

export type AppSurface = "workbench" | "global-chat" | "settings";

export type AppSelection =
  | { kind: "workbench" }
  | { kind: "project-session"; workspacePath: string; sessionId: string }
  | { kind: "cake-chat"; sessionId?: string }
  | { kind: "settings" };

/** Owns the one active application selection in this window. */
export interface AppShellStoreProps {
  sessionWorkspacePath(sessionId: string): string | undefined;
}

export class AppShellStore extends Store<AppShellStoreProps> {
  selection: AppSelection = { kind: "workbench" };
  activeConversation: WindowConversationSelection | undefined;

  get surface(): AppSurface {
    if (this.selection.kind === "settings") return "settings";
    if (this.selection.kind === "cake-chat") return "global-chat";
    return "workbench";
  }

  showWorkbench() {
    this.selection = { kind: "workbench" };
    this.activeConversation = undefined;
  }
  selectProjectSession(sessionId: string) {
    const workspacePath = this.props.sessionWorkspacePath(sessionId);
    if (!workspacePath) throw new Error(`Cake could not find session ${sessionId}`);
    this.selection = { kind: "project-session", workspacePath, sessionId };
    this.activeConversation = this.selection;
  }
  selectCakeChat(sessionId?: string) {
    this.selection = { kind: "cake-chat", sessionId };
    this.activeConversation = sessionId ? { kind: "cake-chat", sessionId } : undefined;
  }
  showSettings() {
    this.selection = { kind: "settings" };
  }
  restoreConversation(selection: WindowConversationSelection) {
    this.activeConversation = selection;
    this.selection = selection;
  }
}
