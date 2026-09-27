import { observer } from "r-state-tree/react";
import type { DesktopConnectionStore } from "../stores/DesktopConnectionStore";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Callout } from "./ui/callout";

export const SettingsDesktopHostSection = observer(function SettingsDesktopHostSection({
  connection,
}: {
  connection: DesktopConnectionStore;
}) {
  return (
    <section className="grid gap-4 border-t border-border py-5" aria-label="Cake backend">
      <h2 className="text-[15px] font-semibold">Cake backend</h2>
      <p className="text-sm">Current host: {connection.hostLabel}</p>
      <Callout variant="warning">
        No authentication. Connect only to a trusted private server or authenticated tunnel. The
        server has full authority over its files and agent work. Native dialogs and notifications
        stay on this device.
      </Callout>
      <label className="grid gap-1 text-xs">
        Server URL
        <Input
          aria-label="Cake server URL"
          value={connection.url}
          onChange={(event) => connection.setUrl(event.target.value)}
        />
      </label>
      <p className="text-xs text-muted-foreground">
        Changing hosts requires confirmation and relaunch. Local work stops on quit; remote work
        continues. Unsent input and window state are separate for each host. The server must
        explicitly enable missing-Origin native connections.
      </p>
      <div className="flex gap-2">
        <Button disabled={connection.selecting} onClick={() => void connection.selectRemote()}>
          Connect on relaunch
        </Button>
        {connection.remote && (
          <Button
            variant="outline"
            disabled={connection.selecting}
            onClick={() => void connection.selectLocal()}
          >
            Return to local
          </Button>
        )}
      </div>
      {connection.remote && (
        <p className="text-xs text-muted-foreground">
          Remote VS Code uses the server’s code-server installation. Widget compilation and assets
          are backend-owned; rendered review and embedded browsing use this desktop. Provider
          credentials stay on the server; supported authentication flows are presented on this
          device.
        </p>
      )}
      {connection.error && <Callout variant="error">{connection.error}</Callout>}
    </section>
  );
});
