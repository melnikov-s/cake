import { observer } from "r-state-tree/react";
import type { CakeChatOverlaySettingsStore } from "../stores/CakeChatOverlaySettingsStore";
import { DEFAULT_CAKE_CHAT_OVERLAY_SHORTCUT } from "../../contracts/desktop/cake-chat-overlay-data";
import { HotkeyRecorder } from "./ui/hotkey-recorder";
import { Callout } from "./ui/callout";
import { SettingsToggle } from "./settings/settings-toggle";

export const SettingsCakeChatOverlaySection = observer(function SettingsCakeChatOverlaySection({
  store,
}: {
  store: CakeChatOverlaySettingsStore;
}) {
  return (
    <section className="grid gap-1.5" aria-labelledby="cake-chat-overlay-settings-title">
      <h2
        id="cake-chat-overlay-settings-title"
        className="px-0.5 text-xs font-semibold text-foreground"
      >
        Drop-down Cake Chat
      </h2>
      <div className="divide-y divide-border/60 rounded-lg border border-border/80 bg-card/50">
        <div className="flex flex-wrap items-center justify-between gap-4 px-3.5 py-2.5 text-sm">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <strong className="text-xs font-medium text-foreground">Global shortcut</strong>
            <small className="text-[11px] text-muted-foreground">
              Opens Cake Chat from the top of the screen while another app is active.
            </small>
          </span>
          <HotkeyRecorder
            label="Drop-down Cake Chat"
            value={store.shortcut}
            defaultValue={DEFAULT_CAKE_CHAT_OVERLAY_SHORTCUT}
            onChange={(value) => void store.setShortcut(value)}
            onClear={() => void store.setShortcut("")}
            onReset={() => void store.setShortcut(DEFAULT_CAKE_CHAT_OVERLAY_SHORTCUT)}
          />
        </div>
        <SettingsToggle
          id="setting-cake-chat-overlay-selected-text"
          label="Bring selected text along"
          description="Attach the active app’s selected text as a removable chip when opening the drop-down."
          checked={store.captureSelectedText}
          onChange={(enabled) => void store.setCaptureSelectedText(enabled)}
        />
      </div>
      <p className="px-0.5 text-[11px] text-muted-foreground">
        If macOS uses Command–` for window switching, choose another shortcut or disable “Move focus
        to next window” in System Settings.
      </p>
      {store.error && <Callout variant="error">{store.error}</Callout>}
    </section>
  );
});
