import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";

export const CustomizationRecovery = observer(function CustomizationRecovery() {
  const store = useStore(RootStore).customizationStore;
  const state = store.state;
  if (!state || (!state.recoveryRequired && state.diagnostics.length === 0 && !store.error)) return null;
  return (
    <aside className="customization-recovery" aria-label="Customization recovery">
      <div>
        <strong>{state.recoveryRequired ? "Cake started in its recovery scene" : "Customization needs attention"}</strong>
        <span>{store.error ?? state.diagnostics.at(-1)?.message ?? "The customization candidate could not be activated."}</span>
      </div>
      <details>
        <summary>Diagnostics ({state.diagnostics.length})</summary>
        <pre>{state.diagnostics.map((diagnostic) => `${diagnostic.phase}${diagnostic.pluginId ? ` · ${diagnostic.pluginId}` : ""}${diagnostic.file ? ` · ${diagnostic.file}` : ""}\n${diagnostic.message}`).join("\n\n")}</pre>
      </details>
      {store.plugins.length > 0 && <details><summary>Plugins ({store.plugins.length})</summary><div className="customization-plugin-list">{store.plugins.map((plugin) => <p key={plugin.id}><span>{plugin.id}{plugin.diagnostics[0] ? ` · ${plugin.diagnostics[0].message}` : ""}</span><button type="button" disabled={store.busy} onClick={() => void store.setPluginEnabled(plugin.id, !plugin.enabled)}>{plugin.enabled ? "Disable" : "Enable"}</button></p>)}</div></details>}
      <nav>
        <button type="button" disabled={store.busy} onClick={() => void store.rebuild()}>{store.busy ? "Building…" : "Build and retry"}</button>
        {(state.rollbackRevision || state.lastKnownGoodRevision) && <button type="button" disabled={store.busy} onClick={() => void store.rollback()}>Roll back</button>}
        <button type="button" disabled={store.busy} onClick={() => void store.useFactory()}>Keep factory scene</button>
      </nav>
    </aside>
  );
});
