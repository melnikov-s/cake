import { observer } from "r-state-tree/react";
import type { DesktopSharingSettingsStore } from "../stores/DesktopSharingSettingsStore";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import { Callout } from "./ui/callout";

export const SettingsDesktopSharingSection = observer(function SettingsDesktopSharingSection({
  sharing,
}: {
  sharing: DesktopSharingSettingsStore;
}) {
  return (
    <section
      id="setting-browser-sharing"
      className="grid gap-4 border-t border-border py-5"
      aria-labelledby="browser-sharing-title"
    >
      <h2 id="browser-sharing-title" className="text-[15px] font-semibold text-foreground">
        Browser sharing
      </h2>
      <p className="text-xs text-muted-foreground">
        Share this running Cake backend. Existing sessions and active turns stay in this process.
        Sharing is off at every app launch.
      </p>
      <Callout variant="warning">
        No authentication: anyone who can connect has full host access, including files, credentials
        through agent operations, and code execution. Only share with trusted devices on a private
        Tailscale network restricted to your devices, or behind an authenticated HTTPS proxy.
        Host/Origin allowlists are not a login and do not restrict trusted clients’ authority.
      </Callout>
      <label className="flex items-center justify-between gap-4 text-sm">
        Enable browser sharing
        <Switch
          aria-label="Enable browser sharing"
          checked={sharing.enabled}
          disabled={sharing.pending}
          onCheckedChange={(enabled) => void sharing.configure(enabled)}
        />
      </label>
      <label className="grid gap-1 text-xs">
        Bind IPv4 address
        <Input
          aria-label="Browser sharing bind address"
          value={sharing.bind}
          disabled={sharing.enabled || sharing.pending}
          onChange={(event) => sharing.setBind(event.target.value)}
        />
      </label>
      <label className="grid gap-1 text-xs">
        Port (0 chooses an available port)
        <Input
          aria-label="Browser sharing port"
          value={sharing.port}
          disabled={sharing.enabled || sharing.pending}
          onChange={(event) => sharing.setPort(event.target.value)}
        />
      </label>
      <label className="grid gap-1 text-xs">
        Proxy HTTPS origin (optional)
        <Input
          aria-label="Browser sharing HTTPS origin"
          placeholder="https://laptop.your-tailnet.ts.net"
          value={sharing.publicOrigin}
          disabled={sharing.enabled || sharing.pending}
          onChange={(event) => sharing.setPublicOrigin(event.target.value)}
        />
      </label>
      <p className="text-xs text-muted-foreground">
        Recommended for a phone: keep 127.0.0.1, choose a fixed port, and use private Tailscale
        Serve on your laptop with Tailscale on your phone. Enter its exact HTTPS origin without a
        path or trailing slash. This allows only that URL’s exact Host and Origin, replacing direct
        HTTP access. The proxy must preserve Host and WebSocket Origin; forwarded headers are not
        trusted. Cake does not configure the proxy or verify its access controls.
      </p>
      <p className="text-xs text-muted-foreground">
        Without a proxy, 127.0.0.1 works only on this computer. A concrete private IPv4 bind is an
        explicit alternative for trusted devices, but HTTP outside loopback lacks secure browser
        features. Never expose an unauthenticated listener publicly or use Tailscale Funnel.
      </p>
      <p role="status" className="break-words text-sm">
        {sharing.state?.status ?? "Loading sharing status…"}
        {sharing.state?.url ? ` — ${sharing.state.url}` : ""}
      </p>
      {sharing.state?.status === "serving" && sharing.state.publicOrigin && (
        <p className="break-words text-xs text-muted-foreground">
          Allowed Host: {new URL(sharing.state.publicOrigin).host}. Allowed Origin:{" "}
          {sharing.state.publicOrigin}. Listener: {sharing.state.bind}:{sharing.state.port}. The
          HTTPS URL is configured, not reachability-tested.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Keep the laptop awake and online; closing its lid may suspend access. Closing the last
        window keeps enabled sharing and agent work running. Use Quit Cake to stop the process.
        Disabling disconnects browsers, not accepted turns.
      </p>
      {(sharing.error ?? sharing.state?.error) && (
        <Callout variant="error">{sharing.error ?? sharing.state?.error}</Callout>
      )}
    </section>
  );
});
