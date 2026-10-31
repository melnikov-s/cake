import { observer } from "r-state-tree/react";
import type { DesktopSharingSettingsStore } from "../stores/DesktopSharingSettingsStore";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Switch } from "./ui/switch";
import { QrCode } from "./ui/qr-code";
import { DisclosureTrigger } from "./ui/disclosure-trigger";

export const SettingsGoogleRemoteAccess = observer(function SettingsGoogleRemoteAccess({
  sharing,
}: {
  sharing: DesktopSharingSettingsStore;
}) {
  return (
    <div className="grid gap-3 px-3.5 py-3">
      <label className="flex items-center justify-between gap-4 text-xs font-medium">
        Require Google sign-in
        <Switch
          aria-label="Require Google sign-in"
          checked={sharing.googleEnabled}
          disabled={sharing.enabled || sharing.pending}
          onCheckedChange={(value) => sharing.setGoogleEnabled(value)}
        />
      </label>
      {sharing.enabled && sharing.state?.preferences.google && sharing.state.url && (
        <div className="grid justify-items-start gap-2">
          <Input aria-label="Remote access URL" readOnly value={sharing.state.url} />
          <QrCode value={sharing.state.url} label="Scan to open Cake and sign in with Google" />
          <span className="text-xs text-muted-foreground">
            Configured URL · reachability not verified
          </span>
        </div>
      )}
      {sharing.googleEnabled && (
        <>
          <label className="grid gap-1.5 text-xs font-medium">
            Google web client ID
            <Input
              aria-label="Google web client ID"
              value={sharing.googleClientId}
              disabled={sharing.enabled || sharing.pending}
              placeholder="….apps.googleusercontent.com"
              onChange={(event) => sharing.setGoogleClientId(event.target.value)}
            />
          </label>
          <label className="grid gap-1.5 text-xs font-medium">
            Allowed Google accounts
            <Textarea
              aria-label="Allowed Google accounts"
              value={sharing.allowedEmails}
              disabled={sharing.pending || sharing.saving}
              rows={3}
              placeholder="you@gmail.com"
              onChange={(event) => sharing.setAllowedEmails(event.target.value)}
            />
          </label>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              One email per line. Saving a removal signs that account out immediately.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              disabled={sharing.pending || sharing.saving}
              onClick={() => void sharing.saveGooglePreferences()}
            >
              Save allowed accounts
            </Button>
          </div>
          <DisclosureTrigger
            title="Google & Tailscale setup"
            open={sharing.googleSetupOpen}
            onClick={() => sharing.toggleGoogleSetup()}
          />
          {sharing.googleSetupOpen && (
            <div className="grid gap-2.5 rounded-lg border border-border/65 bg-muted/25 p-3 text-xs text-muted-foreground">
              <p>
                Install and sign in to Tailscale on this computer. Create a Google OAuth web client
                for personal use with these exact values:
              </p>
              <div className="grid gap-1">
                <span className="font-medium text-foreground">Authorized JavaScript origin</span>
                <code className="block break-all select-text rounded border border-border/60 bg-background/80 px-2.5 py-1.5 font-mono text-xs text-foreground">
                  {sharing.publicOrigin || "https://laptop.your-tailnet.ts.net"}
                </code>
              </div>
              <div className="grid gap-1">
                <span className="font-medium text-foreground">Authorized redirect URI</span>
                <code className="block break-all select-text rounded border border-border/60 bg-background/80 px-2.5 py-1.5 font-mono text-xs text-foreground">
                  {sharing.publicOrigin || "https://laptop.your-tailnet.ts.net"}
                  /auth/google/callback
                </code>
              </div>
              <p>
                Google sign-in only; no client secret is needed. Add your Google test users if the
                consent app is in Testing.
              </p>
              <div className="grid gap-1">
                <p>
                  After enabling Google-protected sharing in Cake, configure Funnel to forward to
                  this listener:
                </p>
                <code className="block break-all select-text rounded border border-border/60 bg-background/80 px-2.5 py-1.5 font-mono text-xs text-foreground">
                  tailscale funnel --bg http://127.0.0.1:{sharing.port}
                </code>
              </div>
              <p>
                Cake does not run this command. Keep the host online. The phone needs only a
                browser.
              </p>
            </div>
          )}
        </>
      )}
      {!sharing.googleEnabled && sharing.state?.preferences.google && (
        <Button
          variant="outline"
          size="sm"
          className="justify-self-start"
          disabled={sharing.pending || sharing.saving}
          onClick={() => void sharing.saveGooglePreferences()}
        >
          Save sign-in settings
        </Button>
      )}
    </div>
  );
});
