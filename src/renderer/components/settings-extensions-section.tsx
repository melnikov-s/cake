import { useEffect } from "react";
import { observer } from "r-state-tree/react";
import type { ProviderSettingsStore } from "../stores/ProviderSettingsStore";
import { SettingsToggle } from "./settings/settings-toggle";
import { Button } from "./ui/button";
import { LoadingSpinner } from "./ui/loading-state";

export const SettingsExtensionsSection = observer(function SettingsExtensionsSection({
  providers,
}: {
  providers: ProviderSettingsStore;
}) {
  useEffect(() => {
    void providers.loadExtensions();
  }, [providers]);
  return (
    <section className="grid gap-1.5" aria-labelledby="extensions-title">
      <header className="flex items-center justify-between gap-3 px-0.5">
        <h2 id="extensions-title" className="text-xs font-semibold text-foreground">
          Automatic extensions
        </h2>
        <Button
          variant="outline"
          size="sm"
          className="rounded-sm"
          disabled={providers.extensionsLoading || Boolean(providers.extensionUpdateId)}
          onClick={() => void providers.loadExtensions()}
        >
          Refresh extensions
        </Button>
      </header>
      {providers.extensionsLoading && <LoadingSpinner label="Loading extensions" />}
      <div className="divide-y divide-border/60 rounded-lg border border-border/80 bg-card/50">
        {providers.extensionSources.length === 0 && !providers.extensionsLoading ? (
          <p className="px-3.5 py-2.5 text-xs text-muted-foreground">No discovered extensions.</p>
        ) : (
          providers.extensionSources.map((extension) => (
            <SettingsToggle
              key={extension.id}
              label={extension.name}
              description={
                extension.source === "builtin"
                  ? "Pi built-in extension"
                  : `${extension.source} · ${extension.path}`
              }
              checked={extension.enabled}
              disabled={providers.extensionsLoading || Boolean(providers.extensionUpdateId)}
              onChange={(enabled) => void providers.setExtensionEnabled(extension.id, enabled)}
            />
          ))
        )}
      </div>
    </section>
  );
});
