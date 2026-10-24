import { observer } from "r-state-tree/react";
import { Select } from "./ui/select";
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
        <label
          id="setting-theme"
          className="scroll-mt-8 flex items-center justify-between gap-4 px-3.5 py-2.5 text-sm"
        >
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <strong className="text-xs font-medium text-foreground">Theme</strong>
            <small className="text-xs text-muted-foreground">
              Follow your system or use a fixed appearance.
            </small>
          </span>
          <Select
            aria-label="Color theme"
            className="h-8 w-44 rounded-sm text-xs"
            value={appearance.theme}
            onChange={(event) => {
              const theme = (["system", "light", "dark"] as const).find(
                (candidate) => candidate === event.target.value,
              );
              if (theme) appearance.setTheme(theme);
            }}
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </Select>
        </label>
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
