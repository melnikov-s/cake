import { observer } from "r-state-tree/react";
import type { DesktopSharingSettingsStore } from "../stores/DesktopSharingSettingsStore";
import { Callout } from "./ui/callout";
import { Input } from "./ui/input";
import { StatusDot } from "./ui/status-dot";
import { Switch } from "./ui/switch";

export const SettingsDesktopSharingSection = observer(function SettingsDesktopSharingSection({
  sharing,
}: {
  sharing: DesktopSharingSettingsStore;
}) {
  const status = sharing.state?.status;
  const dotStatus =
    status === "serving"
      ? "ready"
      : status === "starting" || status === "stopping"
        ? "running"
        : "stopped";
  const statusText = !sharing.state
    ? "Loading sharing status…"
    : sharing.state.status === "serving"
      ? `Serving — ${sharing.state.url ?? `${sharing.state.bind}:${sharing.state.port}`}`
      : sharing.state.status === "starting"
        ? "Starting…"
        : sharing.state.status === "stopping"
          ? "Stopping…"
          : "Off · sharing stays off at launch";

  return (
    <section
      id="setting-browser-sharing"
      className="grid gap-1.5"
      aria-labelledby="browser-sharing-title"
    >
      <h2 id="browser-sharing-title" className="px-0.5 text-xs font-semibold text-foreground">
        Browser sharing
      </h2>
      <div className="divide-y divide-border/60 rounded-lg border border-border/80 bg-card/50">
        <label className="flex items-center justify-between gap-4 px-3.5 py-2.5 text-sm">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <strong className="text-xs font-medium text-foreground">Enable browser sharing</strong>
            <span
              role="status"
              className="flex items-center gap-1.5 break-all text-xs text-muted-foreground"
            >
              <StatusDot size="sm" status={dotStatus} />
              <span>{statusText}</span>
            </span>
          </span>
          <Switch
            aria-label="Enable browser sharing"
            checked={sharing.enabled}
            disabled={sharing.pending}
            onCheckedChange={(enabled) => void sharing.configure(enabled)}
          />
        </label>
        <label className="flex items-center justify-between gap-4 px-3.5 py-2.5 text-sm max-[620px]:flex-col max-[620px]:items-stretch">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <strong className="text-xs font-medium text-foreground">Bind IPv4 address</strong>
            <small className="text-xs text-muted-foreground">
              Use 127.0.0.1 for local or proxied connections.
            </small>
          </span>
          <Input
            aria-label="Browser sharing bind address"
            className="h-8 w-40 rounded-sm font-mono text-xs max-[620px]:w-full"
            value={sharing.bind}
            disabled={sharing.enabled || sharing.pending}
            onChange={(event) => sharing.setBind(event.target.value)}
          />
        </label>
        <label className="flex items-center justify-between gap-4 px-3.5 py-2.5 text-sm max-[620px]:flex-col max-[620px]:items-stretch">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <strong className="text-xs font-medium text-foreground">Port</strong>
            <small className="text-xs text-muted-foreground">
              Set to 0 to choose an available port automatically.
            </small>
          </span>
          <Input
            aria-label="Browser sharing port"
            className="h-8 w-28 rounded-sm font-mono text-xs max-[620px]:w-full"
            value={sharing.port}
            disabled={sharing.enabled || sharing.pending}
            onChange={(event) => sharing.setPort(event.target.value)}
          />
        </label>
        <label className="flex items-center justify-between gap-4 px-3.5 py-2.5 text-sm max-[620px]:flex-col max-[620px]:items-stretch">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <strong className="text-xs font-medium text-foreground">Proxy HTTPS origin</strong>
            <small className="text-xs text-muted-foreground">
              Optional exact origin for Tailscale Serve or reverse proxy.
            </small>
          </span>
          <Input
            aria-label="Browser sharing HTTPS origin"
            className="h-8 w-72 rounded-sm font-mono text-xs max-[620px]:w-full"
            placeholder="https://laptop.your-tailnet.ts.net"
            value={sharing.publicOrigin}
            disabled={sharing.enabled || sharing.pending}
            onChange={(event) => sharing.setPublicOrigin(event.target.value)}
          />
        </label>
        {sharing.state?.status === "serving" && sharing.state.publicOrigin && (
          <div className="px-3.5 py-2 font-mono text-xs text-muted-foreground">
            Listener {sharing.state.bind}:{sharing.state.port} · Origin {sharing.state.publicOrigin}
          </div>
        )}
      </div>
      <p className="px-0.5 text-xs text-muted-foreground">
        Connection preferences save automatically when valid. Sharing stays off at launch. Anyone
        who can connect has full host access. Share only on a private Tailscale network or behind an
        authenticated HTTPS proxy.
      </p>
      {(sharing.error ?? sharing.state?.error) && (
        <Callout variant="error">{sharing.error ?? sharing.state?.error}</Callout>
      )}
    </section>
  );
});
