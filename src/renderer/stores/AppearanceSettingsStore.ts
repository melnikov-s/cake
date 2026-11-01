import { observable, snapshot, Store } from "r-state-tree";
import type {
  AppearanceMode,
  ColorScheme,
  ColorThemeChoice,
  ImportedColorTheme,
} from "../../contracts/themes/color-theme";
import { bundledColorThemes, type ColorThemeOption } from "../../utils/bundled-color-themes";
import { parseVsCodeTheme } from "../../utils/vscode-theme";
import type {
  WorkLogViewMode,
  WorkLogsExpansion,
} from "../../contracts/conversations/session-contract";

/** Owns window appearance and shared work-log presentation preferences. */
export class AppearanceSettingsStore extends Store<Record<string, never>> {
  @snapshot theme: AppearanceMode = "system";
  @snapshot lightTheme: ColorThemeChoice = "bundled:cake-light";
  @snapshot darkTheme: ColorThemeChoice = "bundled:cake-dark";
  @snapshot importedThemes: ImportedColorTheme[] = observable([]);
  systemColorScheme: ColorScheme = "light";
  galleryMode: ColorScheme | "closed" | undefined = undefined;
  previewTheme: ImportedColorTheme | undefined = undefined;
  previewChoice: ColorThemeChoice | undefined = undefined;
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

  get colorThemes(): readonly ColorThemeOption[] {
    return [
      ...bundledColorThemes,
      ...[...this.importedThemes, ...(this.previewTheme ? [this.previewTheme] : [])].map(
        (theme): ColorThemeOption => ({
          choice: `imported:${theme.id}`,
          name: theme.name,
          type: theme.type,
          theme,
        }),
      ),
    ];
  }

  get resolvedMode(): ColorScheme {
    return this.theme === "system" ? this.systemColorScheme : this.theme;
  }

  preferredTheme(mode: ColorScheme) {
    return mode === "light" ? this.lightTheme : this.darkTheme;
  }

  get selectedThemeChoice() {
    return this.previewChoice ?? this.preferredTheme(this.resolvedMode);
  }

  get activeColorTheme() {
    return this.colorThemes.find((theme) => theme.choice === this.selectedThemeChoice)?.theme;
  }

  get activeCustomTheme() {
    const theme = this.activeColorTheme;
    return theme === "light" || theme === "dark" ? undefined : theme;
  }

  get activeAppearanceMode(): AppearanceMode {
    if (!this.previewChoice) return this.theme;
    const theme = this.activeColorTheme;
    return theme === "light" || theme === "dark" ? theme : (theme?.type ?? this.theme);
  }

  get previewName() {
    return this.colorThemes.find((theme) => theme.choice === this.previewChoice)?.name;
  }

  setSystemColorScheme(scheme: ColorScheme) {
    this.systemColorScheme = scheme;
  }

  browseThemes(mode: ColorScheme) {
    this.galleryMode = (this.galleryMode ?? this.resolvedMode) === mode ? "closed" : mode;
  }

  previewSelection(choice: ColorThemeChoice) {
    this.previewChoice = choice;
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
      this.galleryMode = this.previewTheme.type;
    } catch (error) {
      this.importError = error instanceof Error ? error.message : String(error);
    }
  }

  applyPreview() {
    if (!this.previewChoice) return;
    const option = this.colorThemes.find((theme) => theme.choice === this.previewChoice);
    if (!option) return;
    if (this.previewTheme && this.previewChoice === `imported:${this.previewTheme.id}`)
      this.importedThemes.push(this.previewTheme);
    this.setPreferredTheme(option.type, this.previewChoice);
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
    if (choice === this.lightTheme) this.lightTheme = "bundled:cake-light";
    if (choice === this.darkTheme) this.darkTheme = "bundled:cake-dark";
    this.cancelPreview();
  }

  setTheme(theme: AppearanceMode) {
    this.cancelPreview();
    this.theme = theme;
    this.galleryMode = theme === "system" ? undefined : theme;
  }

  setPreferredTheme(mode: ColorScheme, choice: ColorThemeChoice) {
    if (!this.colorThemes.some((option) => option.choice === choice && option.type === mode))
      throw new Error(`Choose an available ${mode} theme.`);
    if (mode === "light") this.lightTheme = choice;
    else this.darkTheme = choice;
    this.cancelPreview();
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
