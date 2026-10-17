import { observer } from "r-state-tree/react";
import type { CakeEditorSettings } from "../../contracts/application/cake-settings-data";
import type { EmbeddedEditorSettingsStore } from "../stores/EmbeddedEditorSettingsStore";
import { Select } from "./ui/select";

const autoHideModes: readonly CakeEditorSettings["sidebarAutoHide"][] = [
  "never",
  "always",
  "below-width",
];
const widthOptions = [1024, 1280, 1440, 1728, 1920] as const;

export const SettingsEmbeddedEditorSection = observer(function SettingsEmbeddedEditorSection({
  settings,
}: {
  settings: EmbeddedEditorSettingsStore;
}) {
  return (
    <section className="grid gap-1.5" aria-labelledby="embedded-editor-title">
      <h2 id="embedded-editor-title" className="px-0.5 text-xs font-semibold text-foreground">
        VS Code
      </h2>
      <div className="divide-y divide-border/60 rounded-lg border border-border/80 bg-card/50">
        <label
          id="setting-editor-sidebar-auto-hide"
          className="scroll-mt-8 flex items-center justify-between gap-4 px-3.5 py-2.5 text-sm"
        >
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <strong className="text-xs font-medium text-foreground">
              Auto-hide project sidebar
            </strong>
            <small className="text-[11px] text-muted-foreground">
              Temporary while VS Code is open; restores when returning to the agent.
            </small>
          </span>
          <Select
            aria-label="Auto-hide project sidebar in VS Code"
            className="h-8 w-52 rounded-sm text-xs"
            value={settings.sidebarAutoHide}
            onChange={(event) => {
              const mode = autoHideModes.find((candidate) => candidate === event.target.value);
              if (mode) settings.setSidebarAutoHide(mode);
            }}
          >
            <option value="never">Never</option>
            <option value="always">Always</option>
            <option value="below-width">Below a window width</option>
          </Select>
        </label>
        {settings.sidebarAutoHide === "below-width" ? (
          <label
            id="setting-editor-sidebar-auto-hide-width"
            className="scroll-mt-8 flex items-center justify-between gap-4 px-3.5 py-2.5 text-sm"
          >
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <strong className="text-xs font-medium text-foreground">Window width</strong>
              <small className="text-[11px] text-muted-foreground">
                Hide the sidebar when the Cake window is narrower than this width.
              </small>
            </span>
            <Select
              aria-label="VS Code sidebar auto-hide window width"
              className="h-8 w-52 rounded-sm text-xs"
              value={String(settings.sidebarAutoHideWidth)}
              onChange={(event) => {
                const width = widthOptions.find(
                  (candidate) => candidate === Number(event.target.value),
                );
                if (width) settings.setSidebarAutoHideWidth(width);
              }}
            >
              {widthOptions.map((width) => (
                <option key={width} value={width}>
                  {width.toLocaleString()} px
                </option>
              ))}
            </Select>
          </label>
        ) : null}
      </div>
    </section>
  );
});
