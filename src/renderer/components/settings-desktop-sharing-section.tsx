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
        network or authenticated tunnel.
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
      <p className="text-xs text-muted-foreground">
        127.0.0.1 is reachable only on this computer, not from a phone. To use another trusted
        device, explicitly bind this computer’s private network IPv4 address. Do not expose Cake to
        a public network.
      </p>
      <p role="status" className="text-sm">
        {sharing.state?.status ?? "Loading sharing status…"}
        {sharing.state?.url ? ` — ${sharing.state.url}` : ""}
      </p>
      <p className="text-xs text-muted-foreground">
        Closing the last window keeps enabled sharing and agent work running. Use Quit Cake to stop
        the process. Disabling disconnects browsers, not accepted turns.
      </p>
      {(sharing.error ?? sharing.state?.error) && (
        <Callout variant="error">{sharing.error ?? sharing.state?.error}</Callout>
      )}
    </section>
  );
});
