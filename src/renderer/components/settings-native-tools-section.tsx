import { observer } from "r-state-tree/react";
import { cakeDefaultTools } from "../../contracts/pi/native-tool-defaults";
import type { ProviderSettingsStore } from "../stores/ProviderSettingsStore";
import { nativeToolSelected, updateNativeToolSelection } from "../lib/native-tool-settings";
import { SettingsToggle } from "./settings/settings-toggle";
import { SettingsLinesField } from "./settings/settings-lines-field";
import { SettingsTextField } from "./settings/settings-text-field";
import { Button } from "./ui/button";

export const SettingsNativeToolsSection = observer(function SettingsNativeToolsSection({
  providers,
}: {
  providers: ProviderSettingsStore;
}) {
  const settings = providers.piSettings;
  const busy = providers.activeOperations.length > 0;
  const usingDefaults =
    settings?.defaultTools === null ||
    (settings?.defaultTools?.length === cakeDefaultTools.length &&
      settings.defaultTools.every((entry, index) => entry === cakeDefaultTools[index]));
  return (
    <section className="grid gap-1.5" aria-labelledby="native-tools-title">
      <header className="flex flex-wrap items-center justify-between gap-3 px-0.5">
        <h3 id="native-tools-title" className="text-xs font-semibold text-foreground">
          Native tools & codemode
        </h3>
        {settings && (
          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="rounded-sm"
              disabled={busy || settings.defaultTools?.length === 0}
              onClick={() => void providers.setPiSetting({ key: "defaultTools", value: [] })}
            >
              Disable built-in tools
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="rounded-sm"
              disabled={busy || usingDefaults}
              onClick={() => void providers.setPiSetting({ key: "defaultTools", value: null })}
            >
              Use Cake defaults
            </Button>
          </div>
        )}
      </header>
      {settings ? (
        <>
          <div className="divide-y divide-border/60 rounded-lg border border-border/80 bg-card/50">
            <SettingsToggle
              id="setting-codemode"
              label="Codemode"
              description="Allow native scripts and image/classifier calls."
              checked={nativeToolSelected(settings.defaultTools, "codemode")}
              disabled={busy}
              onChange={(enabled) =>
                void providers.setPiSetting({
                  key: "defaultTools",
                  value: updateNativeToolSelection(settings.defaultTools, "codemode", enabled),
                })
              }
            />
            <SettingsToggle
              id="setting-tool-search"
              label="Tool search"
              description="Enable Pi’s native tool discovery."
              checked={nativeToolSelected(settings.defaultTools, "tool_search")}
              disabled={busy}
              onChange={(enabled) =>
                void providers.setPiSetting({
                  key: "defaultTools",
                  value: updateNativeToolSelection(settings.defaultTools, "tool_search", enabled),
                })
              }
            />
            <SettingsTextField
              id="setting-codemode-inline-budget"
              label="Codemode inline budget"
              description="Estimated tokens for tool declarations (0–100000). 0 lists only namespaces."
              value={String(settings.codemodeInlineBudget)}
              onApply={(value) => void providers.setCodemodeInlineBudget(value)}
            />
            <SettingsLinesField
              id="setting-default-tools"
              label="Default tools"
              description="One native entry per line. Plain names replace defaults; +name adds, -name removes."
              value={settings.defaultTools ?? []}
              onApply={(value) => void providers.setPiSetting({ key: "defaultTools", value })}
            />
          </div>
          <p className="px-0.5 text-xs text-muted-foreground" role="status">
            {usingDefaults
              ? "Using Cake’s default tool selection (codemode enabled)"
              : settings.defaultTools?.length === 0
                ? "Explicit empty selection — built-in tools disabled"
                : "Explicit global tool selection"}
          </p>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          {providers.loadingSettings ? "Loading Pi’s settings…" : "Pi’s settings are unavailable."}
        </p>
      )}
    </section>
  );
});
