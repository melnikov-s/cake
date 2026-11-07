import { useState } from "react";
import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { Button } from "./ui/button";
import { Callout } from "./ui/callout";
import { CautionIcon, NetworkIcon, ReloadIcon } from "./ui/icons";
import { Popover, PopoverContent, PopoverIconTrigger } from "./ui/popover";
import { cn } from "../lib/utils";
import { QrCode } from "./ui/qr-code";

/** A shortcut to the same listener controlled by Settings; never configures a tunnel. */
export const BrowserSharingMenu = observer(function BrowserSharingMenu({
  rail = false,
}: {
  rail?: boolean;
}) {
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
        label={rail ? `Browser sharing: ${status}` : undefined}
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
        ) : (
          <NetworkIcon />
        )}
      </PopoverIconTrigger>
      <PopoverContent align="end" className="grid w-72 gap-3" aria-label="Browser sharing">
        <div className="flex items-center justify-between gap-3 text-xs">
          <strong>Browser sharing</strong>
          <span role="status" className="text-muted-foreground">
            {status}
          </span>
        </div>
        <p className="break-all select-text font-mono text-xs text-muted-foreground">
          {sharing.enabled
            ? (sharing.state?.url ?? `${sharing.state?.bind}:${sharing.state?.port}`)
            : `${sharing.bind}:${sharing.port}`}
        </p>
        {sharing.state?.preferences.google ? (
          <>
            <Callout variant="info">
              Google sign-in required. Approved accounts have full host access.
            </Callout>
          </>
        ) : (
          <Callout variant="warning">
            Anyone who can connect has full host access. Use only a trusted private network or
            authenticated HTTPS proxy. Sharing stays off at launch.
          </Callout>
        )}
        {sharing.qrUrl ? (
          <div className="grid justify-items-center gap-2">
            <QrCode
              value={sharing.qrUrl}
              label={
                sharing.state?.preferences.google
                  ? "Scan to open Cake and sign in with Google"
                  : "Scan to open Cake"
              }
            />
            <p className="text-xs text-muted-foreground">
              {sharing.state?.preferences.publicOrigin
                ? "Configured URL · reachability not verified"
                : "Devices must be on the same network."}
            </p>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {pending
              ? "Access QR code available once sharing is online."
              : !sharing.enabled
                ? "Sharing is off. Go online to show an access QR code."
                : sharing.state?.url
                  ? "This URL is local-only or unusable on another device. Set up an access URL in Connection settings."
                  : "No access URL available. Check Connection settings."}
          </p>
        )}
        {error && <Callout variant="error">{error}</Callout>}
        <Button
          className="transition-colors"
          size="sm"
          disabled={pending}
          onClick={() => void sharing.configure(!sharing.enabled)}
        >
          {pending ? status : sharing.enabled ? "Go offline" : "Go online"}
        </Button>
        <Button
          variant="ghost"
          className="transition-colors"
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
