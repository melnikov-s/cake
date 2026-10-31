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
  previewChoice: ThemeChoice | undefined = undefined;
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

  get selectedThemeChoice() {
    return this.previewChoice ?? this.theme;
  }

  get activeImportedTheme() {
    if (this.previewTheme && this.selectedThemeChoice === `imported:${this.previewTheme.id}`)
      return this.previewTheme;
    return this.importedThemes.find((theme) => `imported:${theme.id}` === this.selectedThemeChoice);
  }

  get previewName() {
    const choice = this.selectedThemeChoice;
    if (choice === "system") return "System";
    if (choice === "light") return "Light";
    if (choice === "dark") return "Dark";
    return this.activeImportedTheme?.name;
  }

  previewSelection(theme: ThemeChoice) {
    this.previewChoice = theme;
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
    this.previewChoice = undefined;
    this.importError = undefined;
    try {
      this.previewTheme = parseVsCodeTheme(
        entry,
        this.themeSource ?? new Map(),
        crypto.randomUUID(),
      );
      this.previewChoice = `imported:${this.previewTheme.id}`;
    } catch (error) {
      this.importError = error instanceof Error ? error.message : String(error);
    }
  }

  applyPreview() {
    if (!this.previewChoice) return;
    if (this.previewTheme && this.previewChoice === `imported:${this.previewTheme.id}`)
      this.importedThemes.push(this.previewTheme);
    this.theme = this.previewChoice;
    this.cancelPreview();
  }

  cancelPreview() {
    this.previewChoice = undefined;
    this.previewTheme = undefined;
    this.themeSource = undefined;
    this.themeEntries.splice(0);
    this.importError = undefined;
  }

  removeImportedTheme() {
    const choice = this.selectedThemeChoice;
    const index = this.importedThemes.findIndex((theme) => `imported:${theme.id}` === choice);
    if (index < 0) return;
    this.importedThemes.splice(index, 1);
    if (choice === this.theme) this.setTheme("system");
    else this.cancelPreview();
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
