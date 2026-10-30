import { useEffect } from "react";
import { observer } from "r-state-tree/react";
import type { LocalMcpSettingsStore } from "../stores/LocalMcpSettingsStore";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import { Badge } from "./ui/badge";
import { Callout } from "./ui/callout";
import { CopyButton } from "./ui/copy-button";

export const SettingsLocalMcpSection = observer(function SettingsLocalMcpSection({
  settings,
}: {
  settings: LocalMcpSettingsStore;
}) {
  useEffect(() => {
    void settings.load();
  }, [settings]);
  const snapshot = settings.snapshot;
  const enabled = snapshot?.configuration.enabled ?? false;
  const error = settings.error ?? snapshot?.runtime.error;
  return (
    <section
      id="local-mcp-settings-title"
      className="grid min-w-0 gap-2"
      aria-label="Cake MCP server"
    >
      <header className="flex items-center justify-between gap-3 px-0.5">
        <h2 className="text-xs font-semibold text-foreground">Cake MCP server</h2>
        <Badge>
          {snapshot?.runtime.status === "serving"
            ? "Running"
            : snapshot?.runtime.status === "error"
              ? "Failed"
              : "Off"}
        </Badge>
      </header>
      <div className="divide-y divide-border/60 rounded-lg border border-border/80 bg-card/50">
        <label className="flex items-center justify-between gap-4 px-3.5 py-2.5 text-xs">
          <span>Full control of Cake</span>
          <Switch
            aria-label="Allow full control of Cake"
            checked={enabled}
            disabled={settings.busy || !snapshot}
            onCheckedChange={(value) => void settings.save(value)}
          />
        </label>
        <div className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-2.5">
          <label className="flex items-center gap-3 text-xs">
            Port
            <Input
              aria-label="MCP server port"
              inputMode="numeric"
              className="w-24"
              value={settings.port}
              disabled={settings.busy}
              onChange={(event) => settings.setPort(event.target.value)}
            />
          </label>
          <Button
            size="sm"
            disabled={settings.busy || !snapshot}
            onClick={() => void settings.save()}
          >
            Apply
          </Button>
        </div>
        {snapshot?.runtime.url && (
          <div className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-2.5">
            <code className="min-w-0 truncate text-xs">{snapshot.runtime.url}</code>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={settings.busy}
                onClick={() => void settings.rotateToken()}
              >
                Reset access token
              </Button>
              <CopyButton
                label="MCP client configuration"
                disabled={settings.busy}
                getText={async () => settings.snapshot?.clientConfiguration ?? ""}
                onError={() => settings.reportCopyError()}
              />
            </div>
          </div>
        )}
      </div>
      {error && <Callout variant="error">{error}</Callout>}
    </section>
  );
});
