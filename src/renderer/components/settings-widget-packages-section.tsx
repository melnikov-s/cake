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
    <section id="widget-packages-title" aria-label="Widget packages" className="grid gap-1.5">
      <header className="flex items-center justify-between gap-3 px-0.5">
        <h2 className="text-xs font-semibold text-foreground">Widget packages</h2>
        <Button
          variant="outline"
          size="sm"
          className="rounded-sm"
          disabled={settings.busy}
          onClick={() => void settings.load()}
        >
          Refresh packages
        </Button>
      </header>
      <div className="divide-y divide-border/60 rounded-lg border border-border/80 bg-card/50">
        <div className="flex items-center justify-between gap-4 px-3.5 py-2.5 text-sm max-[620px]:flex-col max-[620px]:items-stretch">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <strong className="text-xs font-medium text-foreground">Package name or version</strong>
            <small className="text-xs text-muted-foreground">
              Install npm packages for interactive widgets. React and ReactDOM are built in.
            </small>
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <Input
              aria-label="Widget package specifier"
              placeholder="@scope/package@version"
              className="h-8 w-56 rounded-sm font-mono text-xs"
              value={settings.specifier}
              disabled={settings.busy}
              onChange={(event) => {
                settings.specifier = event.target.value;
              }}
            />
            <Button
              size="sm"
              className="rounded-sm"
              disabled={settings.busy || !settings.specifier.trim()}
              onClick={() => void settings.install()}
            >
              Install widget package
            </Button>
          </div>
        </div>
        {!settings.busy && settings.snapshot?.packages.length === 0 && (
          <p className="px-3.5 py-2.5 text-xs text-muted-foreground">
            No widget packages installed.
          </p>
        )}
        {settings.snapshot?.packages.map((pkg) => (
          <div key={pkg.name} className="flex flex-wrap items-center gap-2 px-3.5 py-2.5 text-xs">
            <strong className="min-w-0 break-all font-mono font-medium text-foreground">
              {pkg.name}
            </strong>
            <Badge variant="outline" size="xs">
              {pkg.version}
            </Badge>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto rounded-sm"
              disabled={settings.busy}
              onClick={() => void settings.remove(pkg.name)}
            >
              Remove {pkg.name}
            </Button>
          </div>
        ))}
      </div>
      {settings.snapshot && (
        <p className="break-all px-0.5 text-xs text-muted-foreground">
          Backend package directory: {settings.snapshot.directory}
        </p>
      )}
      {settings.busy && (
        <p role="status" className="px-0.5 text-xs text-muted-foreground">
          Updating widget packages…
        </p>
      )}
      {settings.error && <Callout variant="error">{settings.error}</Callout>}
      {settings.notice && <Callout variant="info">{settings.notice}</Callout>}
    </section>
  );
});
