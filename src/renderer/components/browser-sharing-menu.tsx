import { useState } from "react";
import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { Button } from "./ui/button";
import { Callout } from "./ui/callout";
import { CautionIcon, NetworkIcon, NetworkOffIcon, ReloadIcon } from "./ui/icons";
import { Popover, PopoverContent, PopoverIconTrigger } from "./ui/popover";
import { cn } from "../lib/utils";

/** A shortcut to the same device-local listener controlled by Settings, not internet access. */
export const BrowserSharingMenu = observer(function BrowserSharingMenu() {
  const root = useStore(RootStore);
  const sharing = root.settingsStore.desktopSharing;
  const [open, setOpen] = useState(false);
  if (root.props.browserHost || root.desktopConnection?.remote) return null;
  const error = sharing.error ?? sharing.state?.error;
  const pending = sharing.pending;
  const status = !sharing.state
    ? "Loading…"
    : pending
      ? sharing.state.status === "stopping" || sharing.enabled
        ? "Going offline…"
        : "Connecting…"
      : error || sharing.state.status === "failed"
        ? "Error"
        : sharing.enabled
          ? "Online"
          : "Offline";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverIconTrigger
        tooltip={`Browser sharing: ${status}${status === "Offline" ? " — go online" : ""}`}
        className={cn(
          sharing.enabled && "text-success",
          !pending && (error || sharing.state?.status === "failed") && "text-destructive",
        )}
      >
        {pending ? (
          <span className="motion-safe:animate-spin">
            <ReloadIcon />
          </span>
        ) : error || sharing.state?.status === "failed" ? (
          <CautionIcon />
        ) : sharing.enabled ? (
          <NetworkIcon />
        ) : (
          <NetworkOffIcon />
        )}
      </PopoverIconTrigger>
      <PopoverContent align="end" className="grid w-72 gap-3" aria-label="Browser sharing">
        <div className="flex items-center justify-between gap-3 text-xs">
          <strong>Browser sharing</strong>
          <span role="status" className="text-muted-foreground">
            {status}
          </span>
        </div>
        <p className="break-all font-mono text-xs text-muted-foreground">
          {sharing.enabled
            ? (sharing.state?.url ?? `${sharing.state?.bind}:${sharing.state?.port}`)
            : `${sharing.bind}:${sharing.port}`}
        </p>
        <Callout variant="warning">
          Anyone who can connect has full host access. Use only a trusted private network or
          authenticated HTTPS proxy. Sharing stays off at launch.
        </Callout>
        {error && <Callout variant="error">{error}</Callout>}
        <Button
          size="sm"
          disabled={pending}
          onClick={() => void sharing.configure(!sharing.enabled)}
        >
          {pending ? status : sharing.enabled ? "Go offline" : "Go online"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setOpen(false);
            root.settingsStore.selectPage("network");
            root.navigationStore.showSettings();
          }}
        >
          Connection settings
        </Button>
      </PopoverContent>
    </Popover>
  );
});
