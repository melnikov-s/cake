import {
  BrowserWindow,
  desktopCapturer,
  dialog,
  globalShortcut,
  nativeImage,
  screen,
  systemPreferences,
} from "electron";
import {
  captureAccelerator,
  captureOutputSize,
  DEFAULT_CAPTURE_MAX_DIMENSION,
  DEFAULT_CAPTURE_SHORTCUT,
  type CaptureDestination,
  type CaptureRouting,
  type CaptureResult,
  type ScreenCaptureSettings,
  type ScreenCaptureSnapshot,
} from "../../domain/screen-capture/screen-capture-data";

interface CaptureWindowOptions {
  readonly preloadPath: string;
  readonly rendererPath: string;
  readonly rendererUrl?: string;
  readonly hidden: boolean;
  readonly targetWindow: () => BrowserWindow | undefined;
  readonly requestCapture: (window: BrowserWindow) => void;
}

/** Native boundary: one capture at a time, with its window and pixels owned until completion.
 * No files or clipboard entries are created. The caller's aborted RPC tears down the overlay.
 */
export class ScreenCaptureWindow {
  private readonly settings = new Map<number, ScreenCaptureSettings>();
  private accelerator = "";
  private capturing = false;
  private stopped = false;
  private overlay: BrowserWindow | undefined;
  private snapshot: ScreenCaptureSnapshot | undefined;
  private complete: ((capture?: CaptureResult) => void) | undefined;

  constructor(private readonly options: CaptureWindowOptions) {}

  configure(window: BrowserWindow, settings: ScreenCaptureSettings) {
    this.settings.set(window.id, settings);
    if (this.options.targetWindow()?.id === window.id) this.activate(window);
  }

  activate(window: BrowserWindow) {
    if (this.stopped) return;
    const settings = this.settings.get(window.id) ?? {
      shortcut: DEFAULT_CAPTURE_SHORTCUT,
      maxDimension: DEFAULT_CAPTURE_MAX_DIMENSION,
    };
    const next = captureAccelerator(settings.shortcut);
    if (next === this.accelerator) return;
    // Register before removing the old shortcut so a collision never disables the working one.
    if (
      next &&
      !globalShortcut.register(next, () => {
        const target = this.options.targetWindow();
        if (target) this.options.requestCapture(target);
        else
          dialog.showErrorBox(
            "Screen capture",
            "Open a Cake window and chat before capturing an attachment.",
          );
      })
    )
      throw new Error(
        "That global shortcut is unavailable. Choose a different shortcut in Screen Capture settings.",
      );
    if (this.accelerator) globalShortcut.unregister(this.accelerator);
    this.accelerator = next;
  }

  release(window: BrowserWindow) {
    this.settings.delete(window.id);
  }

  async start(
    owner: BrowserWindow,
    routing: CaptureRouting,
    signal: AbortSignal,
  ): Promise<{ capture?: CaptureResult }> {
    if (this.stopped) throw new Error("Screen capture has shut down");
    if (signal.aborted) return {};
    if (this.capturing) throw new Error("A screen capture is already open");
    this.capturing = true;
    const onAbort = () => this.complete?.();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (
        process.platform === "darwin" &&
        systemPreferences.getMediaAccessStatus("screen") === "denied"
      )
        throw new Error(
          "Allow Cake in System Settings → Privacy & Security → Screen & System Audio Recording, then restart Cake.",
        );
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const width = Math.round(display.size.width * display.scaleFactor);
      const height = Math.round(display.size.height * display.scaleFactor);
      // Take the still before opening the overlay, so the toolbar can never enter the capture.
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width, height },
        fetchWindowIcons: false,
      });
      if (this.stopped || signal.aborted || owner.isDestroyed()) return {};
      const source = sources.find((entry) => entry.display_id === String(display.id));
      if (!source || source.thumbnail.isEmpty())
        throw new Error("Screen capture is unavailable. Check Cake's screen-recording permission.");
      const pixels = source.thumbnail.getSize();
      this.snapshot = {
        image: source.thumbnail.toDataURL(),
        routing,
        width: pixels.width,
        height: pixels.height,
        maxDimension: this.settings.get(owner.id)?.maxDimension ?? DEFAULT_CAPTURE_MAX_DIMENSION,
      };
      const overlay = new BrowserWindow({
        ...display.bounds,
        show: false,
        frame: false,
        resizable: false,
        movable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        enableLargerThanScreen: true,
        webPreferences: {
          preload: this.options.preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
        },
      });
      this.overlay = overlay;
      overlay.setAlwaysOnTop(true, "screen-saver");
      overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      overlay.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      overlay.webContents.on("will-navigate", (event) => event.preventDefault());
      const result = new Promise<{ capture?: CaptureResult }>((resolve) => {
        this.complete = (capture) => {
          this.complete = undefined;
          resolve(capture ? { capture } : {});
        };
        overlay.on("closed", () => this.complete?.());
        overlay.webContents.on("render-process-gone", () => this.complete?.());
      });
      const ownerClosed = () => this.complete?.();
      owner.once("closed", ownerClosed);
      try {
        if (this.options.rendererUrl) {
          const url = new URL(this.options.rendererUrl);
          url.searchParams.set("screenCapture", "1");
          await overlay.loadURL(url.href);
        } else await overlay.loadFile(this.options.rendererPath, { query: { screenCapture: "1" } });
        if (signal.aborted) this.complete?.();
        else if (!this.options.hidden) {
          overlay.show();
          overlay.focus();
        }
        return await result;
      } finally {
        owner.removeListener("closed", ownerClosed);
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.complete = undefined;
      this.snapshot = undefined;
      if (this.overlay && !this.overlay.isDestroyed()) this.overlay.destroy();
      this.overlay = undefined;
      this.capturing = false;
    }
  }

  state(senderId: number): ScreenCaptureSnapshot {
    if (this.overlay?.webContents.id !== senderId || !this.snapshot || !this.complete)
      throw new Error("This window does not own an active screen capture");
    return this.snapshot;
  }

  finish(senderId: number, capture?: { image: string; destination: CaptureDestination }) {
    const snapshot = this.state(senderId);
    let data: string | undefined;
    if (capture) {
      const { image, destination } = capture;
      const routing = snapshot.routing;
      const offered =
        destination.kind === "new-session"
          ? routing.projects.some((project) => project.path === destination.projectPath)
          : destination.kind === "cake-chat"
            ? routing.cakeChats.some((session) => session.sessionId === destination.sessionId)
            : routing.projects.some((project) =>
                project.sessions.some((session) => session.sessionId === destination.sessionId),
              );
      if (!offered) throw new Error("Choose an available screenshot destination.");
      if (!image.startsWith("data:image/png;base64,"))
        throw new Error("Screen captures must be PNG images");
      let result = nativeImage.createFromDataURL(image);
      if (result.isEmpty()) throw new Error("The captured image could not be decoded");
      const size = result.getSize();
      const output = captureOutputSize(size.width, size.height, snapshot.maxDimension);
      if (size.width !== output.width || size.height !== output.height)
        result = result.resize({ ...output, quality: "best" });
      data = result.toPNG().toString("base64");
      if (data.length > 20_000_000)
        throw new Error("The captured image is too large. Lower the maximum image dimension.");
    }
    this.overlay?.hide();
    this.complete?.(data && capture ? { data, destination: capture.destination } : undefined);
  }

  stop() {
    this.stopped = true;
    if (this.accelerator) globalShortcut.unregister(this.accelerator);
    this.accelerator = "";
    this.complete?.();
    if (this.overlay && !this.overlay.isDestroyed()) this.overlay.destroy();
    this.settings.clear();
  }
}
