import { observer, useStore } from "r-state-tree/react";
import { Button } from "./ui/button";
import { RootStore } from "../stores/RootStore";

export const CustomizationRecovery = observer(function CustomizationRecovery() {
  const root = useStore(RootStore);
  const store = root.customizationStore;
  const state = store.state;
  if (!state || (state.diagnostics.length === 0 && !store.error)) return null;
  const latestDiagnostic = state.diagnostics.at(-1);
  const enabledPlugins = store.plugins.filter((plugin) => plugin.enabled);
  const affectedPlugin = latestDiagnostic?.pluginId
    ? store.plugins.find((plugin) => plugin.id === latestDiagnostic.pluginId)
    : (store.plugins.find((plugin) => plugin.activeScene) ??
      (enabledPlugins.length === 1 ? enabledPlugins[0] : undefined));
  if (!affectedPlugin?.enabled) return null;
  const repairPrompt = `Repair the enabled Cake extension ${affectedPlugin.name} (${affectedPlugin.id}), build it, and retry activation.${latestDiagnostic ? ` The latest diagnostic was: ${latestDiagnostic.message}` : ""}`;
  return (
    <aside
      className="fixed right-4 bottom-4 z-[2147483647] grid w-[min(440px,calc(100vw-32px))] gap-3 rounded-xl border border-[#6f5b43] bg-[#201d19] p-4 text-[13px] leading-relaxed text-[#f6f4ef] shadow-2xl"
      aria-label="Customization recovery"
    >
      <div className="grid min-w-0 gap-0.5">
        <strong className="font-semibold text-white">{`${affectedPlugin.name} failed to load`}</strong>
        <span className="text-[#d2c7b8]">
          {store.error ??
            "This extension is enabled, but Cake couldn’t load it. What would you like to do?"}
        </span>
      </div>
      <nav className="flex justify-end gap-2 max-sm:flex-wrap">
        <Button
          variant="outline"
          size="sm"
          type="button"
          disabled={store.busy}
          onClick={() => void store.setPluginEnabled(affectedPlugin.id, false)}
          className="border-[#79664e] bg-[#3a3128] text-[#f6f4ef] hover:bg-[#4a3f33]"
        >
          Disable for now
        </Button>
        <Button
          size="sm"
          type="button"
          disabled={store.busy}
          onClick={() => void root.startCakeChat(repairPrompt)}
          className="bg-primary text-primary-foreground"
        >
          Repair
        </Button>
      </nav>
    </aside>
  );
});
