import { observer } from "r-state-tree/react";
import type { AppearanceSettingsStore } from "../stores/AppearanceSettingsStore";

export const SettingsAppearanceSection = observer(function SettingsAppearanceSection({
  appearance,
  onViewStateChange,
}: {
  appearance: AppearanceSettingsStore;
  onViewStateChange(): void;
}) {
  return (
    <section className="settings-section" aria-labelledby="appearance-title">
      <header>
        <div>
          <h2 id="appearance-title">Appearance</h2>
          <p>Choose how Cake looks on this device.</p>
        </div>
      </header>
      <div className="settings-fields">
        <label>
          <span>
            Theme<small>Follow your system or use a fixed appearance.</small>
          </span>
          <select
            aria-label="Color theme"
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
          </select>
        </label>
      </div>
    </section>
  );
});
