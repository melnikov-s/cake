import { useState } from "react";
import { observer } from "r-state-tree/react";
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationDescription,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@/components/ai-elements/confirmation";
import { Button } from "@/components/ui/button";
import { usePluginSlotDiagnostics } from "@/plugin-runtime";
import type { CustomizationStore } from "@/stores/CustomizationStore";

export const PluginSettings = observer(function PluginSettings({
  store,
}: {
  store: CustomizationStore;
}) {
  const [deleteTarget, setDeleteTarget] = useState<string>();
  const enabledCount = store.plugins.filter((plugin) => plugin.enabled).length;
  const slotDiagnostics = usePluginSlotDiagnostics();

  return (
    <>
      <section className="settings-section" aria-labelledby="plugins-title">
        <header>
          <div>
            <h2 id="plugins-title">Plugins</h2>
            <p>See installed plugins and control which customizations Cake loads.</p>
          </div>
          <span className="settings-source">{enabledCount} enabled</span>
        </header>
        {store.error && (
          <div className="notice notice-error" role="alert">
            <strong>Plugin operation failed</strong>
            <span>{store.error}</span>
          </div>
        )}
        {slotDiagnostics.length > 0 && (
          <div className="notice notice-error" role="status">
            <strong>Custom scene slot mismatch</strong>
            <span>
              {slotDiagnostics
                .map(
                  ({ name, outletCount }) =>
                    `${name}: ${outletCount === 0 ? "missing" : `${outletCount} outlets`}`,
                )
                .join("; ")}
            </span>
          </div>
        )}
        {store.plugins.length === 0 ? (
          <p className="settings-empty">No plugins are installed.</p>
        ) : (
          <div className="plugin-settings-list">
            {store.plugins.map((plugin) => (
              <article className="plugin-settings-row" key={plugin.id}>
                <div className="plugin-settings-identity">
                  <span className={plugin.enabled ? "plugin-state enabled" : "plugin-state"}>
                    <i />
                    {plugin.enabled ? "Enabled" : "Disabled"}
                  </span>
                  <strong>{plugin.name}</strong>
                  <small>Plugin ID: {plugin.id}</small>
                  <small>Renderer: {plugin.renderer ?? "None"}</small>
                  <small>Backend: {plugin.backend ?? "None"}</small>
                  <small>
                    Scene:{" "}
                    {plugin.scene
                      ? `${plugin.scene}${plugin.activeScene ? " · Active" : ""}`
                      : "None"}
                  </small>
                  {plugin.diagnostics[0] && (
                    <small className="plugin-diagnostic" role="status">
                      {plugin.diagnostics[0].message}
                    </small>
                  )}
                </div>
                <div className="plugin-settings-actions">
                  {plugin.scene && plugin.enabled && (
                    <Button
                      variant="outline"
                      size="sm"
                      type="button"
                      disabled={store.busy || Boolean(plugin.diagnostics.length)}
                      onClick={() =>
                        void store.setActiveScene(plugin.activeScene ? undefined : plugin.id)
                      }
                    >
                      {plugin.activeScene ? "Use default scene" : "Use scene"}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    type="button"
                    disabled={store.busy || Boolean(plugin.diagnostics.length)}
                    onClick={() => void store.setPluginEnabled(plugin.id, !plugin.enabled)}
                  >
                    {plugin.enabled ? "Disable" : "Enable"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    disabled={store.busy}
                    onClick={() => setDeleteTarget(plugin.id)}
                  >
                    Delete
                  </Button>
                </div>
              </article>
            ))}
          </div>
        )}
        <p className="plugin-settings-note">
          Enabled plugins are trusted local software. Renderer contributions load automatically. A
          plugin may optionally replace the whole scene, and its scene can still mount Cake slots.
          Backends may read or modify files, execute programs, and access the network. Changes take
          effect after validation and activation.
        </p>
      </section>
      {deleteTarget && (
        <div className="dialog-backdrop">
          <Confirmation
            state="requested"
            role="alertdialog"
            aria-labelledby="delete-plugin-title"
            aria-describedby="delete-plugin-description"
          >
            <ConfirmationRequest>
              <ConfirmationTitle id="delete-plugin-title">Delete {deleteTarget}?</ConfirmationTitle>
              <ConfirmationDescription id="delete-plugin-description">
                This permanently removes the plugin’s source files. Stored plugin data and recovery
                history will remain available.
              </ConfirmationDescription>
              <ConfirmationActions>
                <ConfirmationAction variant="outline" onClick={() => setDeleteTarget(undefined)}>
                  Cancel
                </ConfirmationAction>
                <ConfirmationAction
                  variant="destructive"
                  onClick={() => {
                    const pluginId = deleteTarget;
                    setDeleteTarget(undefined);
                    void store.deletePlugin(pluginId);
                  }}
                >
                  Delete plugin
                </ConfirmationAction>
              </ConfirmationActions>
            </ConfirmationRequest>
          </Confirmation>
        </div>
      )}
    </>
  );
});
