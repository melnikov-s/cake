import { observer } from "r-state-tree/react";
import type { DesktopConnectionStore } from "../stores/DesktopConnectionStore";
import { SettingsDesktopHostSection } from "./settings-desktop-host-section";
import { Button } from "./ui/button";
export const DesktopConnectionScreen = observer(function DesktopConnectionScreen({
  connection,
}: {
  connection: DesktopConnectionStore;
}) {
  return (
    <main className="mx-auto grid h-full max-w-2xl content-center gap-4 overflow-auto p-8">
      <h1 className="text-xl font-semibold">Connect Cake to your server</h1>
      <p role="status">
        {connection.connecting
          ? "Connecting…"
          : "Not connected. Your local backend has not been started."}
      </p>
      <Button disabled={connection.connecting} onClick={() => void connection.retry()}>
        Retry connection
      </Button>
      <SettingsDesktopHostSection connection={connection} />
    </main>
  );
});
