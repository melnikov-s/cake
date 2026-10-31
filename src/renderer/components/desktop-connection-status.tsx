import { observer } from "r-state-tree/react";
import type { DesktopConnectionStore } from "../stores/DesktopConnectionStore";
import { Button } from "./ui/button";
import { StatusDot } from "./ui/status-dot";

export const DesktopConnectionStatus = observer(function DesktopConnectionStatus({
  connection,
}: {
  connection: DesktopConnectionStore;
}) {
  if (!connection.remote) return null;
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 border-b border-border/65 bg-sidebar/60 px-4 py-1.5 text-xs"
      role="status"
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="inline-flex items-center gap-2 font-medium text-foreground">
          <StatusDot status={connection.connected ? "ready" : "attention"} size="sm" />
          {connection.connected ? "Remote" : "Disconnected — reconnecting"}: {connection.hostLabel}
        </span>
        {connection.error && <span className="text-destructive">{connection.error}</span>}
        {connection.uncertainOperation && (
          <span className="text-muted-foreground">
            Delivery uncertain ({connection.uncertainOperation}). Nothing will be replayed. Check
            the refreshed transcript/state before continuing; a retained draft may already have been
            sent.
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        {connection.uncertainOperation && (
          <Button
            variant="outline"
            size="sm"
            disabled={!connection.connected}
            onClick={() => connection.acknowledgeUncertainty()}
          >
            I checked the server state
          </Button>
        )}
        {!connection.connected && (
          <Button variant="outline" size="sm" onClick={() => void connection.selectLocal()}>
            Return to local
          </Button>
        )}
      </div>
    </div>
  );
});
