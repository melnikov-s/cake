import { observer } from "r-state-tree/react";
import type { BrowserConnectionStore } from "../stores/BrowserConnectionStore";
import { Button } from "./ui/button";
import { StatusDot } from "./ui/status-dot";

/** Browser-host connection framing around the same application shell. */
export const BrowserConnectionStatus = observer(function BrowserConnectionStatus({
  connection,
}: {
  connection: BrowserConnectionStore;
}) {
  if (connection.connected && !connection.uncertainOperation) return null;
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 border-b border-border/65 bg-sidebar/60 px-4 py-1.5 text-xs"
      role="status"
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="inline-flex items-center gap-2 font-medium text-foreground">
          <StatusDot
            status={
              connection.connected ? "ready" : connection.everConnected ? "attention" : "running"
            }
            size="sm"
          />
          {connection.connected
            ? "Connected"
            : connection.everConnected
              ? "Disconnected — reconnecting. Keep the laptop awake and check VPN or proxy access."
              : "Connecting… If this persists, check laptop sharing, VPN and proxy sign-in."}
        </span>
        {connection.uncertainOperation && (
          <span className="text-muted-foreground">
            Delivery uncertain ({connection.uncertainOperation}). Nothing will be replayed. Check
            the refreshed transcript/state before continuing; a retained draft may already have been
            sent.
          </span>
        )}
      </div>
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
    </div>
  );
});
