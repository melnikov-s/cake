import { observer } from "r-state-tree/react";
import type { DesktopConnectionStore } from "../stores/DesktopConnectionStore";
import { SettingsDesktopHostSection } from "./settings-desktop-host-section";
import { Button } from "./ui/button";
import { StatusDot } from "./ui/status-dot";

export const DesktopConnectionScreen = observer(function DesktopConnectionScreen({
  connection,
}: {
  connection: DesktopConnectionStore;
}) {
  return (
    <main className="mx-auto grid h-full max-w-xl content-center gap-5 overflow-auto p-8">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border/80 bg-card p-5 shadow-sm">
        <div className="grid gap-1">
          <h1 className="text-base font-semibold tracking-tight text-foreground">
            Connect Cake to your server
          </h1>
          <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
            <StatusDot status={connection.connecting ? "running" : "attention"} size="sm" />
            <span>
              {connection.connecting
                ? "Connecting…"
                : "Not connected. Your local backend has not been started."}
            </span>
          </p>
        </div>
        <Button size="sm" disabled={connection.connecting} onClick={() => void connection.retry()}>
          Retry connection
        </Button>
      </div>
      <SettingsDesktopHostSection connection={connection} />
    </main>
  );
});
