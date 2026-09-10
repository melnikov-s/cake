import { snapshot, Store } from "r-state-tree";
import type { CakeEditorSettings } from "../../domain/application/cake-settings-data";

/** Owns persisted window preferences for the embedded VS Code presentation. */
export class EmbeddedEditorSettingsStore extends Store<Record<string, never>> {
  @snapshot sidebarAutoHide: CakeEditorSettings["sidebarAutoHide"] = "never";
  @snapshot sidebarAutoHideWidth: CakeEditorSettings["sidebarAutoHideWidth"] = 1440;

  setSidebarAutoHide(mode: CakeEditorSettings["sidebarAutoHide"]) {
    this.sidebarAutoHide = mode;
  }

  setSidebarAutoHideWidth(width: CakeEditorSettings["sidebarAutoHideWidth"]) {
    this.sidebarAutoHideWidth = width;
  }
}
