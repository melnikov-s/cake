import { Store } from "r-state-tree";

export type AppSurface = "workbench" | "global-chat" | "settings";

export type AppSelection =
  | { kind: "workbench" }
  | { kind: "project-session"; workspacePath: string; sessionId: string }
  | { kind: "cake-chat"; sessionId?: string }
  | { kind: "settings" };

/** Owns the one active application selection in this window. */
export class AppShellStore extends Store<Record<string, never>> {
  selection: AppSelection = { kind: "workbench" };

  get surface(): AppSurface {
    if (this.selection.kind === "settings") return "settings";
    if (this.selection.kind === "cake-chat") return "global-chat";
    return "workbench";
  }

  showWorkbench() { this.selection = { kind: "workbench" }; }
  selectProjectSession(workspacePath: string, sessionId: string) {
    this.selection = { kind: "project-session", workspacePath, sessionId };
  }
  selectCakeChat(sessionId?: string) { this.selection = { kind: "cake-chat", sessionId }; }
  showSettings() { this.selection = { kind: "settings" }; }
}
