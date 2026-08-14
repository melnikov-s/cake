import { Store } from "r-state-tree";

/** Owns navigation between Cake's primary application surfaces. */
export class NavigationStore extends Store<Record<string, never>> {
  page: "chat" | "global" | "settings" = "chat";

  openChat() { this.page = "chat"; }
  openGlobalChat() { this.page = "global"; }
  openSettings() { this.page = "settings"; }
}
