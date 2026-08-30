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
import { Callout } from "@/components/ui/callout";
import { DialogBackdrop } from "@/components/ui/dialog";
import { StatusDot } from "@/components/ui/status-dot";
import { Badge } from "@/components/ui/badge";
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
      <section className="border-t border-border py-5" aria-labelledby="plugins-title">
        <header className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 id="plugins-title" className="text-[15px] font-semibold text-foreground">
              Plugins
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              See installed plugins and control which customizations Cake loads.
            </p>
          </div>
          <Badge variant="outline" size="xs" className="text-muted-foreground">
            {enabledCount} enabled
          </Badge>
        </header>
        {store.error && (
          <Callout variant="error" className="mb-3">
            <strong>Plugin operation failed</strong>
            <span className="text-xs">{store.error}</span>
          </Callout>
        )}
        {slotDiagnostics.length > 0 && (
          <Callout variant="error" className="mb-3">
            <strong>Custom scene slot mismatch</strong>
            <span className="text-xs">
              {slotDiagnostics
                .map(
                  ({ name, outletCount }) =>
                    `${name}: ${outletCount === 0 ? "missing" : `${outletCount} outlets`}`,
                )
                .join("; ")}
            </span>
          </Callout>
        )}
        {store.plugins.length === 0 ? (
          <p className="text-xs text-muted-foreground">No plugins are installed.</p>
        ) : (
          <div className="grid gap-3">
            {store.plugins.map((plugin) => (
              <article
                className="flex items-start justify-between gap-4 rounded-xl border border-border bg-muted/50 p-3"
                key={plugin.id}
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <StatusDot status={plugin.enabled ? "complete" : "pending"} />
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {plugin.enabled ? "Enabled" : "Disabled"}
                    </span>
                    <strong className="text-xs font-semibold text-foreground">{plugin.name}</strong>
                  </div>
                  <div className="grid gap-0.5 font-mono text-[11px] text-muted-foreground">
                    <small>Plugin ID: {plugin.id}</small>
                    <small>Renderer: {plugin.renderer ?? "None"}</small>
                    <small>Backend: {plugin.backend ?? "None"}</small>
                    <small>
                      Scene:{" "}
                      {plugin.scene
                        ? `${plugin.scene}${plugin.activeScene ? " · Active" : ""}`
                        : "None"}
                    </small>
                  </div>
                  {plugin.diagnostics[0] && (
                    <small className="block text-xs text-destructive" role="status">
                      {plugin.diagnostics[0].message}
                    </small>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
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
        <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
          Enabled plugins are trusted local software. Renderer contributions load automatically. A
          plugin may optionally replace the whole scene, and its scene can still mount Cake slots.
          Backends may read or modify files, execute programs, and access the network. Changes take
          effect after validation and activation.
        </p>
      </section>
      {deleteTarget && (
        <DialogBackdrop>
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
        </DialogBackdrop>
      )}
    </>
  );
});
