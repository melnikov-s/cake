import { observer, useStore } from "r-state-tree/react";
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
    : store.plugins.find((plugin) => plugin.activeScene) ?? (enabledPlugins.length === 1 ? enabledPlugins[0] : undefined);
  if (!affectedPlugin?.enabled) return null;
  const repairPrompt = `Repair the enabled Cake extension ${affectedPlugin.name} (${affectedPlugin.id}), build it, and retry activation.${latestDiagnostic ? ` The latest diagnostic was: ${latestDiagnostic.message}` : ""}`;
  return (
    <aside className="customization-recovery" aria-label="Customization recovery">
      <div>
        <strong>{`${affectedPlugin.name} failed to load`}</strong>
        <span>{store.error ?? "This extension is enabled, but Cake couldn’t load it. What would you like to do?"}</span>
      </div>
      <nav>
        <button type="button" disabled={store.busy} onClick={() => void store.setPluginEnabled(affectedPlugin.id, false)}>Disable for now</button>
        <button type="button" disabled={store.busy} onClick={() => void root.startCakeChat(repairPrompt)}>Repair</button>
      </nav>
    </aside>
  );
});
