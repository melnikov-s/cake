import { observer } from "r-state-tree/react";
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
  return (
    <section className="border-t border-border py-5" aria-labelledby="native-tools-title">
      <h3 id="native-tools-title" className="text-[15px] font-semibold text-foreground">
        Native tools & codemode
      </h3>
      <p className="my-3 text-xs leading-relaxed text-muted-foreground">
        These backend Pi startup settings apply to eligible Project Sessions, not restricted chats.
        Reload can enable newly added tools but does not disable removed tools in an existing
        session. Project settings and disabled extensions may override this global list. Cake keeps
        codemode exposure in “on” mode, preserving direct tools.
      </p>
      {settings ? (
        <div className="grid gap-4">
          <SettingsToggle
            id="setting-codemode"
            label="Codemode"
            description="Allow native scripts and image/classifier calls. No models are called just by enabling this."
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
            description="Enable Pi’s native tool discovery. Preserves the other tool selections."
            checked={nativeToolSelected(settings.defaultTools, "tool_search")}
            disabled={busy}
            onChange={(enabled) =>
              void providers.setPiSetting({
                key: "defaultTools",
                value: updateNativeToolSelection(settings.defaultTools, "tool_search", enabled),
              })
            }
          />
          <SettingsLinesField
            id="setting-default-tools"
            label="Default tools"
            description="One native entry per line. Plain names replace defaults; +name adds, -name removes. Applying an empty list disables built-in tools."
            value={settings.defaultTools ?? []}
            onApply={(value) => void providers.setPiSetting({ key: "defaultTools", value })}
          />
          <div className="flex items-center justify-between gap-4">
            <p className="text-xs text-muted-foreground" role="status">
              {settings.defaultTools === null
                ? "Inheriting Pi’s default tool selection"
                : settings.defaultTools.length === 0
                  ? "Explicit empty selection — built-in tools disabled"
                  : "Explicit global tool selection"}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={busy || settings.defaultTools?.length === 0}
                onClick={() => void providers.setPiSetting({ key: "defaultTools", value: [] })}
              >
                Disable built-in tools
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || settings.defaultTools === null}
                onClick={() => void providers.setPiSetting({ key: "defaultTools", value: null })}
              >
                Use Pi defaults
              </Button>
            </div>
          </div>
          <SettingsTextField
            id="setting-codemode-inline-budget"
            label="Codemode inline budget"
            description="Estimated tokens for tool declarations (0–100000). 0 lists only namespaces."
            value={String(settings.codemodeInlineBudget)}
            onApply={(value) => void providers.setCodemodeInlineBudget(value)}
          />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {providers.loadingSettings ? "Loading Pi’s settings…" : "Pi’s settings are unavailable."}
        </p>
      )}
    </section>
  );
});
