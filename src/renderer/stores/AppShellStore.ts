import { Store } from "r-state-tree";

export type AppSurface = "workbench" | "global-chat" | "settings";

/** Owns which top-level Cake product surface is visible in this window. */
export class AppShellStore extends Store<Record<string, never>> {
  surface: AppSurface = "workbench";

  showWorkbench() { this.surface = "workbench"; }
  showGlobalChat() { this.surface = "global-chat"; }
  showSettings() { this.surface = "settings"; }
}
