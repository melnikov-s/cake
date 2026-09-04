import { snapshot, Store } from "r-state-tree";

export type EmbeddedEditorSidebarAutoHide = "never" | "always" | "below-width";

/** Owns persisted window preferences for the embedded VS Code presentation. */
export class EmbeddedEditorSettingsStore extends Store<Record<string, never>> {
  @snapshot sidebarAutoHide: EmbeddedEditorSidebarAutoHide = "never";
  @snapshot sidebarAutoHideWidth = 1440;

  setSidebarAutoHide(mode: EmbeddedEditorSidebarAutoHide) {
    this.sidebarAutoHide = mode;
  }

  setSidebarAutoHideWidth(width: number) {
    this.sidebarAutoHideWidth = width;
  }
}
