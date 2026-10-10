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
    <section className="border-t border-border py-5" aria-labelledby="extensions-title">
      <header className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 id="extensions-title" className="text-[15px] font-semibold text-foreground">
            Automatic extensions
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Enable or disable discovered global extensions. These are Pi settings, shared with
            terminal Pi. Running sessions reload when idle.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={providers.extensionsLoading || Boolean(providers.extensionUpdateId)}
          onClick={() => void providers.loadExtensions()}
        >
          Refresh extensions
        </Button>
      </header>
      {providers.extensionsLoading && <LoadingSpinner label="Loading extensions" />}
      <div className="grid gap-4">
        {providers.extensionSources.map((extension) => (
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
        ))}
      </div>
    </section>
  );
});
