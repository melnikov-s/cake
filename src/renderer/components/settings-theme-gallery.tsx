import { observer } from "r-state-tree/react";
import type { ColorScheme } from "../../contracts/themes/color-theme";
import type { AppearanceSettingsStore } from "../stores/AppearanceSettingsStore";
import { Button } from "./ui/button";
import { DisclosureTrigger } from "./ui/disclosure-trigger";
import { ThemePreviewCard } from "./ui/theme-preview-card";

export const SettingsThemeGallery = observer(function SettingsThemeGallery({
  appearance,
  mode,
}: {
  appearance: AppearanceSettingsStore;
  mode: ColorScheme;
}) {
  const label = mode === "light" ? "Light" : "Dark";
  const preferred = appearance.preferredTheme(mode);
  const options = appearance.colorThemes.filter((option) => option.type === mode);
  const open = (appearance.galleryMode ?? appearance.resolvedMode) === mode;
  return (
    <div className="grid min-w-0 gap-3">
      <DisclosureTrigger
        id={`${mode}-theme-title`}
        aria-label={`${label} theme`}
        aria-controls={`${mode}-theme-gallery`}
        title={`${label} theme`}
        subtitle={`Saved: ${options.find((option) => option.choice === preferred)?.name}${appearance.resolvedMode === mode ? " · Active" : ""}`}
        open={open}
        onClick={() => appearance.browseThemes(mode)}
        className="rounded-sm py-1 focus-visible:outline-2 focus-visible:outline-ring"
      />
      {open ? (
        <div
          id={`${mode}-theme-gallery`}
          role="group"
          aria-label={`${label} themes`}
          className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,13rem),1fr))] gap-3"
        >
          {options.map((option) => (
            <ThemePreviewCard
              key={option.choice}
              name={option.name}
              theme={option.theme}
              selected={preferred === option.choice}
              onSelect={() => appearance.setPreferredTheme(mode, option.choice)}
            />
          ))}
        </div>
      ) : null}
      {open && preferred.startsWith("imported:") ? (
        <Button
          variant="ghost"
          size="sm"
          className="w-fit"
          aria-label={`Remove ${label.toLowerCase()} theme`}
          onClick={() => appearance.removeImportedTheme(preferred)}
        >
          Remove theme
        </Button>
      ) : null}
    </div>
  );
});
