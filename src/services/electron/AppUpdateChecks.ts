import { Result, Schema } from "effect";
import {
  dialog,
  net,
  Notification,
  shell,
  type App,
  type MenuItemConstructorOptions,
} from "electron";
import { AppUpdate, isNewerVersion } from "../../contracts/application/app-update";

const feed = "https://github.com/melnikov-s/cake/releases/latest/download/latest-mac-arm64.json";
const replacementInstructions =
  "Download the DMG, quit Cake, then drag Cake into Applications and replace the old app. Your chats and settings stay in place. This build is not notarized; macOS may require first-launch approval in System Settings → Privacy & Security.";

/** Concrete native-menu/network adapter. No install, restart, persistence or periodic polling. */
export class AppUpdateChecks {
  private readonly abort = new AbortController();
  private checking = false;
  private notification: Notification | undefined;
  readonly menuItem: MenuItemConstructorOptions;

  constructor(private readonly application: Pick<App, "isPackaged" | "getVersion">) {
    this.menuItem = {
      label: "Check for Updates…",
      enabled: application.isPackaged && process.platform === "darwin" && process.arch === "arm64",
      click: () => {
        void this.check(false);
      },
    };
  }

  start() {
    if (this.menuItem.enabled) void this.check(true);
  }

  stop() {
    this.abort.abort();
    this.notification?.close();
  }

  async check(silent: boolean): Promise<void> {
    if (!this.menuItem.enabled || this.checking || this.abort.signal.aborted) return;
    this.checking = true;
    try {
      const response = await net.fetch(feed, {
        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15_000)]),
        cache: "no-store",
      });
      if (response.status === 404)
        throw new Error("No public Cake release with update metadata is available yet.");
      if (!response.ok) throw new Error(`The release server returned HTTP ${response.status}.`);
      const decoded = Schema.decodeUnknownResult(AppUpdate)(await response.json());
      if (Result.isFailure(decoded)) throw new Error("The release metadata is invalid.");
      if (this.abort.signal.aborted) return;
      const update = decoded.success;
      if (!isNewerVersion(update.version, this.application.getVersion())) {
        if (!silent)
          await dialog.showMessageBox({
            type: "info",
            message: `Cake ${this.application.getVersion()} is up to date.`,
            buttons: ["OK"],
          });
        return;
      }
      if (silent) {
        this.notification = new Notification({
          title: `Cake ${update.version} is available`,
          body: "Click to download. Quit Cake and replace the app manually to update.",
        });
        this.notification.on("click", () => {
          void this.download(update);
        });
        this.notification.show();
      } else {
        const { response: choice } = await dialog.showMessageBox({
          type: "info",
          message: `Cake ${update.version} is available`,
          detail: replacementInstructions,
          buttons: ["Download", "Later"],
          defaultId: 0,
          cancelId: 1,
        });
        if (choice === 0) await this.download(update);
      }
    } catch (error) {
      if (!silent && !this.abort.signal.aborted) await this.showError(error);
    } finally {
      this.checking = false;
    }
  }

  private async download(update: AppUpdate) {
    if (this.abort.signal.aborted) return;
    try {
      await shell.openExternal(update.downloadUrl);
    } catch (error) {
      await this.showError(error);
    }
  }

  private async showError(error: unknown) {
    await dialog.showMessageBox({
      type: "warning",
      message: "Could not check or download Cake updates",
      detail: error instanceof Error ? error.message : String(error),
      buttons: ["OK"],
    });
  }
}
