import { observer } from "r-state-tree/react";
import { Select } from "./ui/select";
import { FilePicker } from "./ui/file-picker";
import { SegmentedControlButton, SegmentedControlGroup } from "./ui/segmented-control";
import { SettingsThemeGallery } from "./settings-theme-gallery";
import { SettingsToggle } from "./settings/settings-toggle";
import type { AppearanceSettingsStore } from "../stores/AppearanceSettingsStore";

export const SettingsAppearanceSection = observer(function SettingsAppearanceSection({
  appearance,
}: {
  appearance: AppearanceSettingsStore;
}) {
  return (
    <section className="grid gap-1.5" aria-labelledby="appearance-title">
      <h2 id="appearance-title" className="px-0.5 text-xs font-semibold text-foreground">
        Appearance
      </h2>
      <div className="divide-y divide-border/60 rounded-lg border border-border/80 bg-card/50">
        <div id="setting-theme" className="grid scroll-mt-8 gap-3 px-3.5 py-3">
          <SegmentedControlGroup aria-label="Appearance mode" className="w-fit">
            {(["light", "dark", "system"] as const).map((mode) => (
              <SegmentedControlButton
                key={mode}
                active={appearance.theme === mode}
                onClick={() => appearance.setTheme(mode)}
              >
                {mode === "system" ? "System" : mode === "light" ? "Light" : "Dark"}
              </SegmentedControlButton>
            ))}
          </SegmentedControlGroup>
          <SettingsThemeGallery appearance={appearance} mode="light" />
          <SettingsThemeGallery appearance={appearance} mode="dark" />
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
          </div>
          {appearance.themeSource && appearance.themeEntries.length > 1 ? (
            <Select
              aria-label="Theme source"
              value={appearance.selectedEntry}
              onChange={(event) => appearance.importEntry(event.target.value)}
            >
              {appearance.themeEntries.map((path) => (
                <option key={path} value={path}>
                  {path}
                </option>
              ))}
            </Select>
          ) : null}
          {appearance.selectionMessage ? (
            <p
              role="status"
              className="sticky bottom-0 z-10 rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground shadow-xs"
            >
              {appearance.selectionMessage}
            </p>
          ) : null}
          {appearance.importError ? (
            <p role="alert" className="text-xs text-destructive">
              {appearance.importError}
            </p>
          ) : null}
        </div>
        <div
          id="setting-left-toolbar"
          className="grid scroll-mt-8 gap-2 py-3"
          role="group"
          aria-labelledby="left-toolbar-title"
        >
          <h3 id="left-toolbar-title" className="px-3.5 text-xs font-semibold">
            Left toolbar
          </h3>
          <SettingsToggle
            id="setting-left-toolbar-auto-hide"
            label="Auto-hide"
            description="Reveal at the left edge, or use the Show left toolbar button with keyboard or touch."
            checked={appearance.leftToolbar.preferences.autoHide}
            onChange={(autoHide) => void appearance.leftToolbar.change({ autoHide })}
          />
          <div className="grid gap-1.5 px-3.5">
            <label htmlFor="left-toolbar-layout" className="text-xs font-medium">
              Layout
            </label>
            <Select
              id="left-toolbar-layout"
              aria-describedby="left-toolbar-help"
              value={appearance.leftToolbar.preferences.layout}
              onChange={(event) => {
                const layout = event.target.value;
                if (layout === "full" || layout === "slim" || layout === "dynamic")
                  void appearance.leftToolbar.change({ layout });
              }}
            >
              <option value="full">Full</option>
              <option value="slim">Slim</option>
              <option value="dynamic" disabled={appearance.leftToolbar.preferences.autoHide}>
                Dynamic
              </option>
            </Select>
            <p id="left-toolbar-help" className="text-xs text-muted-foreground">
              Full shows names; Slim shows icons. Dynamic expands on hover or keyboard focus.
              Dynamic requires Auto-hide off. Turning Auto-hide off restores your previous layout.
              On touch, tap the reveal button or the editor’s left edge. Escape dismisses after any
              open menu.
            </p>
            {appearance.leftToolbar.error && (
              <p role="alert" className="text-xs text-destructive">
                {appearance.leftToolbar.error}
              </p>
            )}
          </div>
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
