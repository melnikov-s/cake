import { useState } from "react";
import { observer } from "r-state-tree/react";
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationDescription,
  ConfirmationRequest,
  ConfirmationTitle
} from "@/components/ai-elements/confirmation";
import { Button } from "@/components/ui/button";
import type { CustomizationStore } from "@/stores/CustomizationStore";

export const PluginSettings = observer(function PluginSettings({ store }: { store: CustomizationStore }) {
  const [deleteTarget, setDeleteTarget] = useState<string>();
  const enabledCount = store.plugins.filter((plugin) => plugin.enabled).length;

  return <>
    <section className="settings-section" aria-labelledby="plugins-title">
      <header>
        <div><h2 id="plugins-title">Plugins</h2><p>See installed plugins and control which customizations Cake loads.</p></div>
        <span className="settings-source">{enabledCount} enabled</span>
      </header>
      {store.error && <div className="notice notice-error" role="alert"><strong>Plugin operation failed</strong><span>{store.error}</span></div>}
      {store.plugins.length === 0 ? <p className="settings-empty">No plugins are installed.</p> : <div className="plugin-settings-list">
        {store.plugins.map((plugin) => <article className="plugin-settings-row" key={plugin.id}>
          <div className="plugin-settings-identity">
            <span className={plugin.enabled ? "plugin-state enabled" : "plugin-state"}><i />{plugin.enabled ? "Enabled" : "Disabled"}</span>
            <strong>{plugin.name}</strong>
            <small>Plugin ID: {plugin.id}</small>
            <small>Entry: {plugin.entry || "Invalid manifest"}</small>
            {plugin.diagnostics[0] && <small className="plugin-diagnostic" role="status">{plugin.diagnostics[0].message}</small>}
          </div>
          <div className="plugin-settings-actions">
            <Button variant="outline" size="sm" type="button" disabled={store.busy || Boolean(plugin.diagnostics.length)} onClick={() => void store.setPluginEnabled(plugin.id, !plugin.enabled)}>{plugin.enabled ? "Disable" : "Enable"}</Button>
            <Button variant="ghost" size="sm" type="button" disabled={store.busy} onClick={() => setDeleteTarget(plugin.id)}>Delete</Button>
          </div>
        </article>)}
      </div>}
      <p className="plugin-settings-note">Disabling or deleting an enabled plugin switches Cake to its safe core UI when the current scene depends on that plugin. Rebuild the scene to activate the new plugin set. Deleting removes source files; stored plugin data and recovery history are preserved.</p>
    </section>
    {deleteTarget && <div className="dialog-backdrop">
      <Confirmation state="requested" role="alertdialog" aria-labelledby="delete-plugin-title" aria-describedby="delete-plugin-description">
        <ConfirmationRequest>
          <ConfirmationTitle id="delete-plugin-title">Delete {deleteTarget}?</ConfirmationTitle>
          <ConfirmationDescription id="delete-plugin-description">This permanently removes the plugin’s source files. Stored plugin data and recovery history will remain available.</ConfirmationDescription>
          <ConfirmationActions>
            <ConfirmationAction variant="outline" onClick={() => setDeleteTarget(undefined)}>Cancel</ConfirmationAction>
            <ConfirmationAction variant="destructive" onClick={() => { const pluginId = deleteTarget; setDeleteTarget(undefined); void store.deletePlugin(pluginId); }}>Delete plugin</ConfirmationAction>
          </ConfirmationActions>
        </ConfirmationRequest>
      </Confirmation>
    </div>}
  </>;
});
