import { observer } from "r-state-tree/react";
import { Select } from "./ui/select";
import { Button } from "./ui/button";
import { FilePicker } from "./ui/file-picker";
import { ThemePreviewCard } from "./ui/theme-preview-card";
import { useSystemColorTheme } from "../lib/resolved-color-theme";
import { SettingsToggle } from "./settings/settings-toggle";
import type { AppearanceSettingsStore } from "../stores/AppearanceSettingsStore";

export const SettingsAppearanceSection = observer(function SettingsAppearanceSection({
  appearance,
}: {
  appearance: AppearanceSettingsStore;
}) {
  const systemTheme = useSystemColorTheme();
  const selected = appearance.selectedThemeChoice;
  return (
    <section className="grid gap-1.5" aria-labelledby="appearance-title">
      <h2 id="appearance-title" className="px-0.5 text-xs font-semibold text-foreground">
        Appearance
      </h2>
      <div className="divide-y divide-border/60 rounded-lg border border-border/80 bg-card/50">
        <div id="setting-theme" className="grid scroll-mt-8 gap-3 px-3.5 py-3">
          <h3 className="text-xs font-medium text-foreground">Theme</h3>
          <div
            role="group"
            aria-label="Color theme"
            className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,13rem),1fr))] gap-3"
          >
            {(["system", "light", "dark"] as const).map((choice) => (
              <ThemePreviewCard
                key={choice}
                name={choice === "system" ? "System" : choice === "light" ? "Light" : "Dark"}
                theme={choice === "system" ? systemTheme : choice}
                selected={selected === choice}
                onSelect={() => appearance.previewSelection(choice)}
              />
            ))}
            {appearance.importedThemes.map((theme) => (
              <ThemePreviewCard
                key={theme.id}
                name={theme.name}
                theme={theme}
                selected={selected === `imported:${theme.id}`}
                onSelect={() => appearance.previewSelection(`imported:${theme.id}`)}
              />
            ))}
            {appearance.previewTheme ? (
              <ThemePreviewCard
                name={appearance.previewTheme.name}
                theme={appearance.previewTheme}
                selected={selected === `imported:${appearance.previewTheme.id}`}
                onSelect={() => {
                  if (appearance.previewTheme)
                    appearance.previewSelection(`imported:${appearance.previewTheme.id}`);
                }}
              />
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <FilePicker
              disabled={appearance.importing}
              onFiles={(files) => void appearance.importThemeFiles(files)}
            >
              Import VS Code theme
            </FilePicker>
            <FilePicker
              directory
              disabled={appearance.importing}
              onFiles={(files) => void appearance.importThemeFiles(files)}
            >
              Import theme folder
            </FilePicker>
            {selected.startsWith("imported:") && !appearance.themeSource ? (
              <Button variant="ghost" size="sm" onClick={() => appearance.removeImportedTheme()}>
                Remove theme
              </Button>
            ) : null}
          </div>
          {appearance.themeSource && appearance.themeEntries.length > 1 ? (
            <Select
              aria-label="Theme source"
              value={appearance.selectedEntry}
              onChange={(event) => appearance.previewEntry(event.target.value)}
            >
              {appearance.themeEntries.map((path) => (
                <option key={path} value={path}>
                  {path}
                </option>
              ))}
            </Select>
          ) : null}
          {appearance.previewChoice !== undefined || appearance.themeSource ? (
            <div className="flex flex-wrap items-center gap-2">
              {appearance.previewChoice !== undefined ? (
                <span role="status" className="mr-auto text-xs text-muted-foreground">
                  Preview: {appearance.previewName}
                </span>
              ) : null}
              <Button
                size="sm"
                disabled={appearance.previewChoice === undefined}
                onClick={() => appearance.applyPreview()}
              >
                Apply theme
              </Button>
              <Button variant="ghost" size="sm" onClick={() => appearance.cancelPreview()}>
                Cancel
              </Button>
            </div>
          ) : null}
          {appearance.importError ? (
            <p role="alert" className="text-xs text-destructive">
              {appearance.importError}
            </p>
          ) : null}
        </div>
        <SettingsToggle
          id="setting-project-avatars"
          label="Project avatars"
          description="Show project icons in the sidebar."
          checked={appearance.projectAvatarsEnabled}
          onChange={(enabled) => appearance.setProjectAvatarsEnabled(enabled)}
        />
        <SettingsToggle
          id="setting-session-avatars"
          label="Session avatars"
          description="Show label-colored sidebar icons and character avatars in chat."
          checked={appearance.sessionAvatarsEnabled}
          onChange={(enabled) => appearance.setSessionAvatarsEnabled(enabled)}
        />
        <SettingsToggle
          id="setting-sidebar-characters"
          label="Show session characters"
          description="Use characters instead of small squares for sidebar sessions."
          checked={appearance.sidebarCharactersEnabled}
          onChange={(enabled) => appearance.setSidebarCharactersEnabled(enabled)}
        />
      </div>
    </section>
  );
});
