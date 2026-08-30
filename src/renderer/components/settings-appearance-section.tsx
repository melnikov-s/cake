import { observer } from "r-state-tree/react";
import { Select } from "./ui/select";
import type { AppearanceSettingsStore } from "../stores/AppearanceSettingsStore";

export const SettingsAppearanceSection = observer(function SettingsAppearanceSection({
  appearance,
  onViewStateChange,
}: {
  appearance: AppearanceSettingsStore;
  onViewStateChange(): void;
}) {
  return (
    <section className="border-t border-border py-5" aria-labelledby="appearance-title">
      <header className="mb-4">
        <div>
          <h2 id="appearance-title" className="text-[15px] font-semibold text-foreground">
            Appearance
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Choose how Cake looks on this device.
          </p>
        </div>
      </header>
      <div className="grid gap-4">
        <label className="flex items-center justify-between gap-6 text-sm">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <strong className="text-xs font-medium text-foreground">Theme</strong>
            <small className="text-[11px] text-muted-foreground">
              Follow your system or use a fixed appearance.
            </small>
          </span>
          <Select
            aria-label="Color theme"
            className="h-8 max-w-xs text-xs"
            value={appearance.theme}
            onChange={(event) => {
              const theme = (["system", "light", "dark"] as const).find(
                (candidate) => candidate === event.target.value,
              );
              if (theme) appearance.setTheme(theme);
              onViewStateChange();
            }}
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </Select>
        </label>
      </div>
    </section>
  );
});
