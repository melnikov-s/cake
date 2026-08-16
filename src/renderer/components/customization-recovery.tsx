import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";

export const CustomizationRecovery = observer(function CustomizationRecovery() {
  const root = useStore(RootStore);
  const store = root.customizationStore;
  const state = store.state;
  if (!state || (!state.recoveryRequired && state.diagnostics.length === 0 && !store.error)) return null;
  const latestDiagnostic = state.diagnostics.at(-1);
  const enabledPlugins = store.plugins.filter((plugin) => plugin.enabled);
  const affectedPlugin = latestDiagnostic?.pluginId
    ? store.plugins.find((plugin) => plugin.id === latestDiagnostic.pluginId)
    : enabledPlugins.length === 1 ? enabledPlugins[0] : undefined;
  const failureSummary = affectedPlugin
    ? `${affectedPlugin.name} didn’t load.`
    : "Your custom interface didn’t load.";
  return (
    <aside className="customization-recovery" aria-label="Customization recovery">
      <div>
        <strong>{state.recoveryRequired ? "Cake opened the default interface" : "Customization needs attention"}</strong>
        <span>{store.error ?? `${failureSummary} ${latestDiagnostic?.message ?? "Cake could not activate the custom interface."}`}</span>
      </div>
      <details>
        <summary>Technical details ({state.diagnostics.length})</summary>
        <pre>{state.diagnostics.map((diagnostic) => {
          const plugin = diagnostic.pluginId ? store.plugins.find((item) => item.id === diagnostic.pluginId) : affectedPlugin;
          return `${diagnostic.phase}${plugin ? ` · ${plugin.name} (${plugin.id})` : ""}${diagnostic.file ? ` · ${diagnostic.file}` : ""}\n${diagnostic.message}`;
        }).join("\n\n")}{state.failedRevision ? `\n\nBuild: ${state.failedRevision}` : ""}</pre>
      </details>
      {store.plugins.length > 0 && <details><summary>Plugins ({store.plugins.length})</summary><div className="customization-plugin-list">{store.plugins.map((plugin) => <p key={plugin.id}><span>{plugin.name} · {plugin.id}{plugin.diagnostics[0] ? ` · ${plugin.diagnostics[0].message}` : ""}</span><button type="button" disabled={store.busy} onClick={() => void store.setPluginEnabled(plugin.id, !plugin.enabled)}>{plugin.enabled ? "Disable" : "Enable"}</button></p>)}</div></details>}
      <nav>
        <button type="button" onClick={() => void root.startCakeChat("Repair the current Cake customization, build it, and retry activation.")}>Build and retry</button>
        {(state.rollbackRevision || state.lastKnownGoodRevision) && <button type="button" disabled={store.busy} onClick={() => void store.rollback()}>Roll back</button>}
        <button type="button" disabled={store.busy} onClick={() => void store.useFactory()}>Use default Cake</button>
      </nav>
    </aside>
  );
});
