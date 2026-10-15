import { observer } from "r-state-tree/react";
import type { CakeChatOverlaySettingsStore } from "../stores/CakeChatOverlaySettingsStore";
import { DEFAULT_CAKE_CHAT_OVERLAY_SHORTCUT } from "../../contracts/desktop/cake-chat-overlay-data";
import { HotkeyRecorder } from "./ui/hotkey-recorder";
import { Callout } from "./ui/callout";

export const SettingsCakeChatOverlaySection = observer(function SettingsCakeChatOverlaySection({
  store,
}: {
  store: CakeChatOverlaySettingsStore;
}) {
  return (
    <section
      className="grid gap-5 border-t border-border py-5"
      aria-labelledby="cake-chat-overlay-settings-title"
    >
      <div>
        <h2 id="cake-chat-overlay-settings-title" className="text-[15px] font-semibold">
          Drop-down Cake Chat
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Drop Cake Chat down from the top of the screen while another app is active. It shows the
          same live conversation as the Cake window. Press the shortcut again, Escape, or the close
          button to put it away.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium">Global shortcut</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Inside a Cake window the keys keep their in-app meaning, such as toggling the terminal.
            Clear to turn the shortcut off.
          </p>
        </div>
        <HotkeyRecorder
          label="Drop-down Cake Chat"
          value={store.shortcut}
          defaultValue={DEFAULT_CAKE_CHAT_OVERLAY_SHORTCUT}
          onChange={(value) => void store.setShortcut(value)}
          onClear={() => void store.setShortcut("")}
          onReset={() => void store.setShortcut(DEFAULT_CAKE_CHAT_OVERLAY_SHORTCUT)}
        />
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        On macOS, Command–` also moves focus between an app's windows. If the system keeps that
        shortcut, turn off Keyboard → Keyboard Shortcuts → Keyboard → “Move focus to next window” in
        System Settings, or choose another shortcut here. Window → Drop-down Cake Chat opens it from
        the menu.
      </p>
      {store.error && <Callout variant="error">{store.error}</Callout>}
    </section>
  );
});
