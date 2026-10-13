import { useEffect } from "react";
import { observer } from "r-state-tree/react";
import type { WidgetPackageSettingsStore } from "../stores/WidgetPackageSettingsStore";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Callout } from "./ui/callout";
import { Badge } from "./ui/badge";

export const SettingsWidgetPackagesSection = observer(function SettingsWidgetPackagesSection({
  settings,
}: {
  settings: WidgetPackageSettingsStore;
}) {
  useEffect(() => {
    void settings.load();
  }, [settings]);
  return (
    <section
      id="widget-packages-title"
      aria-label="Widget packages"
      className="grid gap-4 border-t border-border py-5"
    >
      <p className="text-xs text-muted-foreground">
        Install npm registry packages for interactive widgets. Dependencies are shared across all
        Projects on the connected backend, outside Cake’s application dependencies. New widgets can
        use them immediately without restarting Cake.
      </p>
      <Callout>
        Install only packages you trust. React and ReactDOM are provided by Cake. Removing a package
        affects future widget compilation, not previously accepted artifact browser output.
      </Callout>
      {settings.snapshot && (
        <p className="break-all text-xs text-muted-foreground">
          Backend package directory: {settings.snapshot.directory}
        </p>
      )}
      <label className="grid gap-1 text-xs">
        Package name or version
        <Input
          aria-label="Widget package specifier"
          placeholder="@scope/package@version"
          value={settings.specifier}
          disabled={settings.busy}
          onChange={(event) => {
            settings.specifier = event.target.value;
          }}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={settings.busy || !settings.specifier.trim()}
          onClick={() => void settings.install()}
        >
          Install widget package
        </Button>
        <Button variant="outline" disabled={settings.busy} onClick={() => void settings.load()}>
          Refresh packages
        </Button>
      </div>
      {settings.busy && (
        <p role="status" className="text-xs text-muted-foreground">
          Updating widget packages…
        </p>
      )}
      {settings.error && <Callout variant="error">{settings.error}</Callout>}
      {settings.notice && <Callout variant="info">{settings.notice}</Callout>}
      {!settings.busy && settings.snapshot?.packages.length === 0 && (
        <p className="text-sm text-muted-foreground">No widget packages installed.</p>
      )}
      <div className="grid gap-2">
        {settings.snapshot?.packages.map((pkg) => (
          <div
            key={pkg.name}
            className="flex flex-wrap items-center gap-2 rounded-md border border-border p-3"
          >
            <strong className="min-w-0 break-all text-sm">{pkg.name}</strong>
            <Badge variant="outline" size="xs">
              {pkg.version}
            </Badge>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              disabled={settings.busy}
              onClick={() => void settings.remove(pkg.name)}
            >
              Remove {pkg.name}
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
});
