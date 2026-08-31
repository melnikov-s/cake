import { snapshot, Store } from "r-state-tree";
import type { WorkLogViewMode, WorkLogsExpansion } from "../../ipc/session-contract";

/** Owns window appearance and shared work-log presentation preferences. */
export class AppearanceSettingsStore extends Store<Record<string, never>> {
  @snapshot theme: "system" | "light" | "dark" = "system";
  @snapshot workLogViewMode: WorkLogViewMode = "auto";
  @snapshot workLogsExpansion: WorkLogsExpansion = "collapsed";

  setTheme(theme: "system" | "light" | "dark") {
    this.theme = theme;
  }

  setWorkLogViewMode(mode: WorkLogViewMode) {
    this.workLogViewMode = mode;
  }

  setWorkLogsExpansion(expansion: WorkLogsExpansion) {
    this.workLogsExpansion = expansion;
  }
}
