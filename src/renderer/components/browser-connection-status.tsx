import { observer } from "r-state-tree/react";
import type { BrowserConnectionStore } from "../stores/BrowserConnectionStore";
import { Button } from "./ui/button";

/** Browser-host connection framing around the same application shell. */
export const BrowserConnectionStatus = observer(function BrowserConnectionStatus({
  connection,
}: {
  connection: BrowserConnectionStore;
}) {
  if (connection.connected && !connection.uncertainOperation) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-3 border-b border-border bg-muted px-4 py-2 text-xs"
      role="status"
    >
      <span>
        {connection.connected
          ? "Connected"
          : connection.everConnected
            ? "Disconnected — reconnecting"
            : "Connecting…"}
      </span>
      {connection.uncertainOperation && (
        <>
          <span>
            Delivery uncertain ({connection.uncertainOperation}). Nothing will be replayed. Check
            the refreshed transcript/state before continuing; a retained draft may already have been
            sent.
          </span>
          <Button
            size="sm"
            disabled={!connection.connected}
            onClick={() => connection.acknowledgeUncertainty()}
          >
            I checked the server state
          </Button>
        </>
      )}
    </div>
  );
});
