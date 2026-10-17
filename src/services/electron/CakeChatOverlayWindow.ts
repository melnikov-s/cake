import { BrowserWindow, globalShortcut, screen } from "electron";
import { captureAccelerator } from "../../contracts/desktop/screen-capture-data";
import {
  CAKE_CHAT_OVERLAY_QUERY,
  type CakeChatOverlaySettings,
  type CakeChatOverlayShownContext,
} from "../../contracts/desktop/cake-chat-overlay-data";
import {
  overlayBounds,
  overlayShortcutActive,
  type CakeWindowFocus,
} from "./cake-chat-overlay-policy";

interface CakeChatOverlayWindowOptions {
  readonly preloadPath: string;
  readonly rendererPath: string;
  readonly rendererUrl?: string;
  /** Background tests load the overlay renderer without presenting native windows. */
  readonly hidden: boolean;
  /** Background tests must never claim system-wide keys on the developer's machine. */
  readonly registerShortcuts: boolean;
  readonly focus: () => CakeWindowFocus;
  /** Installs shared navigation guards and the renderer connection lifecycle. */
  readonly prepareWindow: (window: BrowserWindow) => void;
  /** Lets the overlay renderer replay its drop-down motion, focus the composer, and attach
   * any context gathered before the drop-down. */
  readonly onShown: (window: BrowserWindow, context: CakeChatOverlayShownContext) => void;
  /** Reads another app's selection before the overlay takes keyboard focus. */
  readonly readContext: () => Promise<CakeChatOverlayShownContext>;
  /** A shortcut that worked earlier could not be reclaimed after Cake lost focus. */
  readonly reportShortcutError: (message: string) => void;
}

const unavailable = (accelerator: string) =>
  `${accelerator} is already used by another app or Cake shortcut. Choose a different drop-down Cake Chat shortcut in Settings → Cake Chat.`;

/**
 * Native boundary for the Quake-style drop-down Cake Chat: one lazily created, reused window
 * that renders the shared Cake Chat surface, plus the system-wide shortcut that toggles it.
 * The shortcut is registered only while no main Cake window has focus, so the same keys keep
 * their in-app meaning inside Cake (see `overlayShortcutActive`).
 */
export class CakeChatOverlayWindow {
  private accelerator = "";
  private registered = "";
  private window: BrowserWindow | undefined;
  private visible = false;
  private stopped = false;
  private captureSelectedText = true;
  private gathering = false;
  private readonly onShortcut = () => this.toggle("shortcut");

  constructor(private readonly options: CakeChatOverlayWindowOptions) {}

  /** Throws when the system refuses the accelerator; the previous shortcut keeps working. */
  configure({ shortcut, captureSelectedText }: CakeChatOverlaySettings) {
    if (this.stopped) return;
    this.captureSelectedText = captureSelectedText;
    const next = captureAccelerator(shortcut);
    if (next === this.accelerator) {
      this.sync();
      return;
    }
    // Register before releasing the old shortcut so Settings learns about a conflict immediately,
    // even while a main window is focused, and a collision never disables the working shortcut.
    if (next && this.options.registerShortcuts && !globalShortcut.register(next, this.onShortcut))
      throw new Error(unavailable(next));
    if (this.registered) globalShortcut.unregister(this.registered);
    this.registered = next && this.options.registerShortcuts ? next : "";
    this.accelerator = next;
    this.sync();
  }

  /** Re-evaluates registration after any Cake window gains or loses focus. */
  sync() {
    if (this.stopped || !this.options.registerShortcuts) return;
    const active = overlayShortcutActive(this.accelerator, this.options.focus());
    if (active && !this.registered) {
      if (globalShortcut.register(this.accelerator, this.onShortcut))
        this.registered = this.accelerator;
      else this.options.reportShortcutError(unavailable(this.accelerator));
    } else if (!active && this.registered) {
      globalShortcut.unregister(this.registered);
      this.registered = "";
    }
  }

  /** The visible overlay window, for routing native features such as screen capture. */
  get visibleWindow() {
    return this.visible && this.window && !this.window.isDestroyed() ? this.window : undefined;
  }

  owns(window: BrowserWindow) {
    return this.window === window;
  }

  get isVisible() {
    return this.visible;
  }

  /**
   * The shortcut is pressed while another app is frontmost, so it reads that app's selection
   * first: once the overlay has keyboard focus, a copy fallback would copy from Cake instead.
   * The menu item is chosen inside Cake and has no foreign selection to bring along.
   */
  toggle(source: "shortcut" | "menu" = "menu") {
    if (this.visible) {
      this.hide();
      return;
    }
    if (source !== "shortcut" || !this.captureSelectedText || this.options.focus() === "main") {
      this.show();
      return;
    }
    if (this.gathering) return;
    this.gathering = true;
    void this.options
      .readContext()
      .catch((): CakeChatOverlayShownContext => ({}))
      .then((context) => {
        this.gathering = false;
        this.show(context);
      });
  }

  show(context: CakeChatOverlayShownContext = {}) {
    if (this.stopped) return;
    const window = this.window ?? this.create();
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    window.setBounds(overlayBounds(display.workArea));
    this.visible = true;
    this.options.onShown(window, context);
    if (this.options.hidden) return;
    window.show();
    window.focus();
  }

  hide() {
    this.visible = false;
    if (this.window && !this.window.isDestroyed()) this.window.hide();
  }

  /** Releases the renderer; the next toggle recreates it. */
  destroyWindow() {
    const window = this.window;
    this.window = undefined;
    this.visible = false;
    if (window && !window.isDestroyed()) window.destroy();
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.registered) globalShortcut.unregister(this.registered);
    this.registered = "";
    this.accelerator = "";
    this.destroyWindow();
  }

  private create() {
    const window = new BrowserWindow({
      show: false,
      frame: false,
      // macOS panels float over fullscreen Spaces without activating Cake or changing its
      // activation policy, like the screen-capture overlay.
      type: process.platform === "darwin" ? "panel" : undefined,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: "#15191d",
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    this.window = window;
    // Floating stays above ordinary and fullscreen app windows while Cake's own context menus,
    // the emoji picker, and system alerts still appear above the overlay.
    window.setAlwaysOnTop(true, "floating");
    // Skipping the process transform keeps Cake's Dock icon and menu bar intact on macOS.
    window.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    window.on("closed", () => {
      if (this.window !== window) return;
      this.window = undefined;
      this.visible = false;
    });
    this.options.prepareWindow(window);
    const url = this.options.rendererUrl ? new URL(this.options.rendererUrl) : undefined;
    url?.searchParams.set(CAKE_CHAT_OVERLAY_QUERY, "1");
    const loading = url
      ? window.loadURL(url.href)
      : window.loadFile(this.options.rendererPath, {
          query: { [CAKE_CHAT_OVERLAY_QUERY]: "1" },
        });
    // Quitting mid-load aborts navigation; that is not an application failure.
    void loading.catch((error: unknown) => {
      if (!window.isDestroyed()) throw error;
    });
    return window;
  }
}
