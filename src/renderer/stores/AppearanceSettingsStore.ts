import { observable, snapshot, Store } from "r-state-tree";
import type { ImportedColorTheme, ThemeChoice } from "../../contracts/themes/color-theme";
import { parseVsCodeTheme } from "../../utils/vscode-theme";
import type {
  WorkLogViewMode,
  WorkLogsExpansion,
} from "../../contracts/conversations/session-contract";

/** Owns window appearance and shared work-log presentation preferences. */
export class AppearanceSettingsStore extends Store<Record<string, never>> {
  @snapshot theme: ThemeChoice = "system";
  @snapshot importedThemes: ImportedColorTheme[] = observable([]);
  previewTheme: ImportedColorTheme | undefined = undefined;
  importError: string | undefined = undefined;
  importing = false;
  themeSource: ReadonlyMap<string, string> | undefined = undefined;
  themeEntries: string[] = observable([]);
  selectedEntry = "";
  @snapshot projectAvatarsEnabled = true;
  @snapshot sessionAvatarsEnabled = true;
  @snapshot sidebarCharactersEnabled = false;
  @snapshot workLogViewMode: WorkLogViewMode = "auto";
  @snapshot workLogsExpansion: WorkLogsExpansion = "collapsed";

  get activeImportedTheme() {
    return (
      this.previewTheme ??
      this.importedThemes.find((theme) => `imported:${theme.id}` === this.theme)
    );
  }

  async importThemeFiles(files: readonly File[]) {
    if (this.importing) return;
    this.cancelPreview();
    this.importing = true;
    this.importError = undefined;
    try {
      const source = new Map<string, string>();
      for (const file of files) {
        if (!/\.jsonc?$/i.test(file.name)) continue;
        const content = await file.text();
        if (this.signal.aborted) return;
        source.set(file.webkitRelativePath || file.name, content);
      }
      this.themeSource = source;
      this.themeEntries.splice(
        0,
        this.themeEntries.length,
        ...[...source.keys()].filter((path) => !path.endsWith("package.json")),
      );
      if (!this.themeEntries.length)
        throw new Error("Choose a VS Code color-theme JSON/JSONC file or folder.");
      const entry = this.themeEntries[0];
      if (entry) this.previewEntry(entry);
    } catch (error) {
      this.importError = error instanceof Error ? error.message : String(error);
    } finally {
      this.importing = false;
    }
  }

  previewEntry(entry: string) {
    this.selectedEntry = entry;
    this.previewTheme = undefined;
    this.importError = undefined;
    try {
      this.previewTheme = parseVsCodeTheme(
        entry,
        this.themeSource ?? new Map(),
        crypto.randomUUID(),
      );
    } catch (error) {
      this.importError = error instanceof Error ? error.message : String(error);
    }
  }

  applyPreview() {
    if (!this.previewTheme) return;
    const theme = this.previewTheme;
    this.importedThemes.push(theme);
    this.theme = `imported:${theme.id}`;
    this.cancelPreview();
  }

  cancelPreview() {
    this.previewTheme = undefined;
    this.themeSource = undefined;
    this.themeEntries.splice(0);
    this.importError = undefined;
  }

  removeImportedTheme() {
    const index = this.importedThemes.findIndex((theme) => `imported:${theme.id}` === this.theme);
    if (index < 0) return;
    this.importedThemes.splice(index, 1);
    this.setTheme("system");
  }

  setTheme(theme: ThemeChoice) {
    this.cancelPreview();
    this.theme = theme;
  }

  setProjectAvatarsEnabled(enabled: boolean) {
    this.projectAvatarsEnabled = enabled;
  }

  setSessionAvatarsEnabled(enabled: boolean) {
    this.sessionAvatarsEnabled = enabled;
  }

  setSidebarCharactersEnabled(enabled: boolean) {
    this.sidebarCharactersEnabled = enabled;
  }

  setWorkLogViewMode(mode: WorkLogViewMode) {
    this.workLogViewMode = mode;
  }

  setWorkLogsExpansion(expansion: WorkLogsExpansion) {
    this.workLogsExpansion = expansion;
  }
}
