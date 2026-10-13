import { snapshot, Store } from "r-state-tree";

/** User-owned permission, persisted in this window's existing Store snapshot. */
export class AgentNavigationSettingsStore extends Store<Record<string, never>> {
  @snapshot enabled = true;

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
  }
}
