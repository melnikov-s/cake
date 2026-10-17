import { observer } from "r-state-tree/react";
import type { DesktopConnectionStore } from "../stores/DesktopConnectionStore";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Callout } from "./ui/callout";
import { Input } from "./ui/input";
import { StatusDot } from "./ui/status-dot";

export const SettingsDesktopHostSection = observer(function SettingsDesktopHostSection({
  connection,
}: {
  connection: DesktopConnectionStore;
}) {
  return (
    <section className="grid gap-1.5" aria-label="Cake backend">
      <h2 className="px-0.5 text-xs font-semibold text-foreground">Cake backend</h2>
      <div className="divide-y divide-border/60 rounded-lg border border-border/80 bg-card/50">
        <div className="flex flex-wrap items-center justify-between gap-4 px-3.5 py-2.5 text-sm">
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <StatusDot status={connection.connected ? "ready" : "attention"} />
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-xs font-medium text-foreground">
                Current host: {connection.hostLabel}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {connection.remote
                  ? connection.connected
                    ? "Connected to remote server"
                    : "Disconnected from remote server"
                  : "Running locally on this Mac"}
              </span>
            </div>
          </div>
          {connection.remote ? (
            <Button
              variant="outline"
              size="sm"
              className="rounded-sm"
              disabled={connection.selecting}
              onClick={() => void connection.selectLocal()}
            >
              Return to local
            </Button>
          ) : (
            <Badge variant="secondary">Local</Badge>
          )}
        </div>
        <div className="flex items-center justify-between gap-4 px-3.5 py-2.5 text-sm max-[620px]:flex-col max-[620px]:items-stretch">
          <label htmlFor="cake-server-url-input" className="flex min-w-0 flex-1 flex-col gap-0.5">
            <strong className="text-xs font-medium text-foreground">Server URL</strong>
            <small className="text-[11px] text-muted-foreground">
              Relaunches Cake and connects to an existing server.
            </small>
          </label>
          <div className="flex shrink-0 items-center gap-2 max-[620px]:w-full">
            <Input
              id="cake-server-url-input"
              aria-label="Cake server URL"
              className="h-8 w-56 rounded-sm font-mono text-xs max-[620px]:flex-1"
              placeholder="http://127.0.0.1:4317"
              value={connection.url}
              onChange={(event) => connection.setUrl(event.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              className="rounded-sm"
              disabled={connection.selecting}
              onClick={() => void connection.selectRemote()}
            >
              Connect on relaunch
            </Button>
          </div>
        </div>
      </div>
      <p className="px-0.5 text-[11px] text-muted-foreground">
        No authentication. Connect only to a trusted private network or authenticated tunnel.
      </p>
      {connection.error && <Callout variant="error">{connection.error}</Callout>}
    </section>
  );
});
