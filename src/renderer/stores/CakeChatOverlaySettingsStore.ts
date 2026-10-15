import { snapshot, Store } from "r-state-tree";
import { DEFAULT_CAKE_CHAT_OVERLAY_SHORTCUT } from "../../contracts/desktop/cake-chat-overlay-data";
import { ClientContext } from "./context/ClientContext";

/**
 * Owns the system-wide drop-down Cake Chat shortcut preference. Like the screen-capture
 * shortcut, the preference persists in the window snapshot and main registers it; main reports
 * registration conflicts back through `configure`, which this Store presents in Settings.
 */
export class CakeChatOverlaySettingsStore extends Store {
  @snapshot shortcut = DEFAULT_CAKE_CHAT_OVERLAY_SHORTCUT;
  /** Bring the frontmost app's selected text along when the shortcut drops Cake Chat down. */
  @snapshot captureSelectedText = true;
  error: string | undefined;
  private configurationQueue: Promise<void> = Promise.resolve();

  configure() {
    const settings = { shortcut: this.shortcut, captureSelectedText: this.captureSelectedText };
    this.configurationQueue = this.configurationQueue.then(async () => {
      if (this.signal.aborted) return;
      try {
        await ClientContext.consume(this)!.electron.configureCakeChatOverlay(settings, {
          signal: this.signal,
        });
        if (!this.signal.aborted) this.error = undefined;
      } catch (error) {
        if (!this.signal.aborted)
          this.error = error instanceof Error ? error.message : String(error);
      }
    });
    return this.configurationQueue;
  }

  setShortcut(value: string) {
    this.shortcut = value;
    return this.configure();
  }

  setCaptureSelectedText(enabled: boolean) {
    this.captureSelectedText = enabled;
    return this.configure();
  }
}
