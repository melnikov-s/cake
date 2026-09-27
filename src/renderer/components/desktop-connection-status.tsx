import { observer } from "r-state-tree/react";
import type { DesktopConnectionStore } from "../stores/DesktopConnectionStore";
import { Button } from "./ui/button";
export const DesktopConnectionStatus = observer(function DesktopConnectionStatus({
  connection,
}: {
  connection: DesktopConnectionStore;
}) {
  if (!connection.remote) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-3 border-b border-border bg-muted px-4 py-2 text-xs"
      role="status"
    >
      <span>
        {connection.connected ? "Remote" : "Disconnected — reconnecting"}: {connection.hostLabel}
      </span>
      {connection.error && <span>{connection.error}</span>}
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
      {!connection.connected && (
        <Button size="sm" onClick={() => void connection.selectLocal()}>
          Return to local
        </Button>
      )}
    </div>
  );
});
