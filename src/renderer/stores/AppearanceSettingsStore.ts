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
  selectedMode: ColorScheme | undefined = undefined;
  importError: string | undefined = undefined;
  importing = false;
  themeSource: ReadonlyMap<string, string> | undefined = undefined;
  themeEntries: string[] = observable([]);
  selectedEntry = "";
  importedEntries = new Map<string, ColorThemeChoice>();
  @snapshot projectAvatarsEnabled = true;
  @snapshot sessionAvatarsEnabled = true;
  @snapshot sidebarCharactersEnabled = false;
  @snapshot workLogViewMode: WorkLogViewMode = "auto";
  @snapshot workLogsExpansion: WorkLogsExpansion = "collapsed";

  get colorThemes(): readonly ColorThemeOption[] {
    return [
      ...bundledColorThemes,
      ...this.importedThemes.map((theme): ColorThemeOption => ({
        choice: `imported:${theme.id}`,
        name: theme.name,
        type: theme.type,
        theme,
      })),
    ];
  }

  get resolvedMode(): ColorScheme {
    return this.theme === "system" ? this.systemColorScheme : this.theme;
  }

  preferredTheme(mode: ColorScheme) {
    return mode === "light" ? this.lightTheme : this.darkTheme;
  }

  get activeColorTheme() {
    const choice = this.preferredTheme(this.resolvedMode);
    return this.colorThemes.find((theme) => theme.choice === choice)?.theme;
  }

  get activeCustomTheme() {
    const theme = this.activeColorTheme;
    return theme === "light" || theme === "dark" ? undefined : theme;
  }

  get selectionMessage() {
    if (!this.selectedMode || this.selectedMode === this.resolvedMode) return undefined;
    const label = this.selectedMode === "light" ? "Light" : "Dark";
    return `This theme will apply when ${label} mode is active.`;
  }

  setSystemColorScheme(scheme: ColorScheme) {
    this.systemColorScheme = scheme;
  }

  browseThemes(mode: ColorScheme) {
    this.galleryMode = (this.galleryMode ?? this.resolvedMode) === mode ? "closed" : mode;
  }

  async importThemeFiles(files: readonly File[]) {
    if (this.importing) return;
    this.themeSource = undefined;
    this.themeEntries.splice(0);
    this.importedEntries.clear();
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
      if (entry) this.importEntry(entry);
    } catch (error) {
      this.importError = error instanceof Error ? error.message : String(error);
    } finally {
      this.importing = false;
    }
  }

  importEntry(entry: string) {
    this.selectedEntry = entry;
    this.importError = undefined;
    try {
      const savedChoice = this.importedEntries.get(entry);
      const savedTheme = this.colorThemes.find((option) => option.choice === savedChoice);
      if (savedTheme) {
        this.setPreferredTheme(savedTheme.type, savedTheme.choice);
        this.galleryMode = savedTheme.type;
        return;
      }
      const theme = parseVsCodeTheme(entry, this.themeSource ?? new Map(), crypto.randomUUID());
      const choice: ColorThemeChoice = `imported:${theme.id}`;
      this.importedThemes.push(theme);
      this.importedEntries.set(entry, choice);
      this.setPreferredTheme(theme.type, choice);
      this.galleryMode = theme.type;
    } catch (error) {
      this.importError = error instanceof Error ? error.message : String(error);
    }
  }

  removeImportedTheme(choice: ColorThemeChoice) {
    const index = this.importedThemes.findIndex((theme) => `imported:${theme.id}` === choice);
    if (index < 0) return;
    this.importedThemes.splice(index, 1);
    if (choice === this.lightTheme) this.lightTheme = "bundled:cake-light";
    if (choice === this.darkTheme) this.darkTheme = "bundled:cake-dark";
    this.selectedMode = undefined;
  }

  setTheme(theme: AppearanceMode) {
    this.selectedMode = undefined;
    this.theme = theme;
    this.galleryMode = theme === "system" ? undefined : theme;
  }

  setPreferredTheme(mode: ColorScheme, choice: ColorThemeChoice) {
    if (!this.colorThemes.some((option) => option.choice === choice && option.type === mode))
      throw new Error(`Choose an available ${mode} theme.`);
    if (mode === "light") this.lightTheme = choice;
    else this.darkTheme = choice;
    this.selectedMode = mode;
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
