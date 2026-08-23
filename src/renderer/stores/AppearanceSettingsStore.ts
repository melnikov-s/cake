import { Store } from "r-state-tree";
import type { WorkLogViewMode, WorkLogsExpansion } from "../../ipc/session-contract";

/** Owns window appearance and shared work-log presentation preferences. */
export class AppearanceSettingsStore extends Store<Record<string, never>> {
  theme: "system" | "light" | "dark" = "system";
  workLogViewMode: WorkLogViewMode = "auto";
  workLogsExpansion: WorkLogsExpansion = "collapsed";

  restore(preferences: {
    theme: "system" | "light" | "dark";
    workLogViewMode: WorkLogViewMode;
    workLogsExpansion: WorkLogsExpansion;
  }) {
    this.theme = preferences.theme;
    this.workLogViewMode = preferences.workLogViewMode;
    this.workLogsExpansion = preferences.workLogsExpansion;
  }

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
