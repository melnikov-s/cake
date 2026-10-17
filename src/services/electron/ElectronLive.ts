import { Effect, Layer, Queue, Stream } from "effect";
import {
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  nativeImage,
  Notification,
  shell,
  systemPreferences,
  webContents,
  type App,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron";
import { ScreenCaptureWindow } from "./ScreenCaptureWindow";
import { captureWidgetView } from "./capture-widget-view";
import { CakeChatOverlayWindow } from "./CakeChatOverlayWindow";
import type { CakeWindowFocus } from "./cake-chat-overlay-policy";
import { ACCESSIBILITY_PERMISSION_MESSAGE, readSelectedText, runOsaScript } from "./selected-text";
import { shouldAllowNavigation } from "./navigation-policy";
import { installRendererDiagnostics } from "./renderer-diagnostics";
import { CAKE_TITLE_BAR_HEIGHT, Electron, type ElectronWindowLifecycle } from "./Electron";
import { ElectronError } from "../../contracts/desktop/electron-errors";
import { ClientConnections } from "../clients/ClientConnections";
import { ClientEvents } from "../clients/ClientEvents";
import { ClientWorkspaces } from "../clients/ClientWorkspaces";

const TRAFFIC_LIGHT_X = 18;
/** Time for the window server to remove a hidden window before a screen still is taken. */
const OVERLAY_HIDE_SETTLE_MS = 150;
const TRAFFIC_LIGHT_DIAMETER = 14;

export interface ElectronLiveOptions {
  readonly application: App;
  readonly cakeIconPath: string;
  readonly annotationMenuIconPath: string;
  readonly chatMenuIconPath: string;
  readonly preloadPath: string;
  readonly rendererPath: string;
}

const electronError = (cause: unknown) =>
  new ElectronError({ message: cause instanceof Error ? cause.message : String(cause) });

const trafficLightPosition = (titleBarHeight: number) => ({
  x: TRAFFIC_LIGHT_X,
  y: Math.round((titleBarHeight - TRAFFIC_LIGHT_DIAMETER) / 2),
});

type IconMenuEntry = Omit<MenuItemConstructorOptions, "icon" | "label" | "role" | "type"> & {
  readonly label: string;
  readonly icon: string;
};

const iconMenuEntry = ({ icon: iconPath, ...entry }: IconMenuEntry) => {
  const icon = nativeImage.createFromPath(iconPath);
  icon.setTemplateImage(true);
  return { ...entry, icon } satisfies MenuItemConstructorOptions;
};

const makeElectronService = (
  options: ElectronLiveOptions,
  clientEvents: ClientEvents["Service"],
  clientWorkspaces: ClientWorkspaces["Service"],
  connections: ClientConnections["Service"],
) => {
  const windows = new Map<number, BrowserWindow>();
  let lastFocusedWindow: BrowserWindow | undefined;
  const capture = new ScreenCaptureWindow({
    preloadPath: options.preloadPath,
    rendererPath: options.rendererPath,
    rendererUrl: process.env.ELECTRON_RENDERER_URL,
    hidden: process.env.CAKE_ELECTRON_SMOKE === "1",
    targetWindow: () => {
      const focused = BrowserWindow.getFocusedWindow();
      // While the drop-down is open, a capture belongs to the conversation it shows.
      const dropDown = overlay.visibleWindow;
      if (dropDown) return dropDown;
      return focused && windows.has(focused.id)
        ? focused
        : lastFocusedWindow && !lastFocusedWindow.isDestroyed()
          ? lastFocusedWindow
          : [...windows.values()].at(-1);
    },
    requestCapture: (window) =>
      clientEvents.sendTo(connectionForWindow(window), { type: "screen-capture-requested" }),
  });
  const overlay: CakeChatOverlayWindow = new CakeChatOverlayWindow({
    preloadPath: options.preloadPath,
    rendererPath: options.rendererPath,
    rendererUrl: process.env.ELECTRON_RENDERER_URL,
    hidden: process.env.CAKE_ELECTRON_SMOKE === "1",
    registerShortcuts: process.env.CAKE_ELECTRON_SMOKE !== "1",
    focus: (): CakeWindowFocus => {
      const focused = BrowserWindow.getFocusedWindow();
      if (!focused) return "none";
      if (windows.has(focused.id)) return "main";
      return overlay.owns(focused) ? "overlay" : "other";
    },
    prepareWindow: (window) => {
      const nativeId = window.webContents.id;
      const ownerId = connections.desktop(nativeId);
      installContentGuards(window);
      window.on("closed", () => {
        clientWorkspaces.releaseConnection(ownerId);
        connections.release(ownerId);
        if (!applicationQuitting) lifecycle().onWindowClosed(ownerId, undefined, nativeId);
      });
    },
    onShown: (window, context) => {
      // The first drop-down creates the renderer; retry until it subscribes to events.
      let attempts = 0;
      const deliver = () => {
        if (window.isDestroyed()) return;
        const connectionId = connections.forNative(window.webContents.id);
        const delivered =
          connectionId !== undefined &&
          clientEvents.sendTo(connectionId, { type: "cake-chat-overlay-shown", ...context });
        if (!delivered && ++attempts < 100) setTimeout(deliver, 100);
      };
      deliver();
    },
    readContext: async () => {
      const result = await readSelectedText({
        platform: process.platform,
        accessibilityTrusted: () => systemPreferences.isTrustedAccessibilityClient(false),
        runScript: runOsaScript,
        clipboardFallback: true,
      });
      if (result.kind === "text") return { selectedText: result.selection };
      if (result.kind === "failed")
        console.warn("[cake] Could not read selected text", result.message);
      // Explain a missing permission once per run instead of on every drop-down.
      if (result.kind !== "permission-denied" || accessibilityNoticeShown) return {};
      accessibilityNoticeShown = true;
      return { notice: ACCESSIBILITY_PERMISSION_MESSAGE };
    },
    reportShortcutError: (message) => {
      const target =
        lastFocusedWindow && !lastFocusedWindow.isDestroyed()
          ? lastFocusedWindow
          : [...windows.values()].at(-1);
      if (target)
        clientEvents.sendTo(connectionForWindow(target), {
          type: "notification",
          title: "Drop-down Cake Chat shortcut unavailable",
          message,
          tone: "error",
        });
    },
  });
  let accessibilityNoticeShown = false;
  // Focus moves between windows as a blur followed by a focus; settle before deciding whether
  // the drop-down shortcut belongs to the system or to the focused main window.
  let overlayFocusSync: ReturnType<typeof setImmediate> | undefined;
  const syncOverlayShortcut = () => {
    if (overlayFocusSync) return;
    overlayFocusSync = setImmediate(() => {
      overlayFocusSync = undefined;
      overlay.sync();
    });
  };
  const fullscreenSurfaces = new Map<number, Set<string>>();
  const failedRenderers = new Set<number>();
  const fullscreenSurfaceListeners = new Set<
    (state: { readonly connectionId: number; readonly open: boolean }) => void
  >();
  const openSessionContextMenus = new Set<Menu>();
  let applicationQuitting = false;
  let stopped = false;
  let windowLifecycle: ElectronWindowLifecycle | undefined;
  const lifecycle = () => {
    if (!windowLifecycle) throw new Error("Electron window lifecycle has not started");
    return windowLifecycle;
  };

  const requireRendererConnection = (connectionId: number): WebContents => {
    const nativeId = connections.nativeId(connectionId);
    const sender = nativeId === undefined ? undefined : webContents.fromId(nativeId);
    if (!sender || sender.isDestroyed()) throw new Error("Renderer connection is no longer active");
    return sender;
  };

  const centerTrafficLights = (window: BrowserWindow, titleBarHeight: number) => {
    if (process.platform === "darwin")
      window.setWindowButtonPosition(trafficLightPosition(titleBarHeight));
  };

  const loadRenderer = async (window: BrowserWindow) => {
    try {
      if (process.env.ELECTRON_RENDERER_URL)
        await window.loadURL(process.env.ELECTRON_RENDERER_URL);
      else await window.loadFile(options.rendererPath);
    } catch (error) {
      // Closing or quitting mid-load aborts navigation; that is not an application failure.
      if (!window.isDestroyed()) throw error;
    }
  };

  const connectionForWindow = (window: BrowserWindow) => {
    const id = connections.forNative(window.webContents.id);
    if (id === undefined) throw new Error("Window client connection missing");
    return id;
  };
  const closeFullscreenSurfaceForWindow = (window: BrowserWindow) => {
    const surfaceIds = fullscreenSurfaces.get(connectionForWindow(window));
    const surfaceId = surfaceIds ? Array.from(surfaceIds).at(-1) : undefined;
    if (!surfaceId) return false;
    clientEvents.sendTo(connectionForWindow(window), {
      type: "fullscreen-surface-close-requested",
      surfaceId,
    });
    return true;
  };

  const fullscreenSurfaceChanges = () =>
    Stream.callback<{ readonly connectionId: number; readonly open: boolean }>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const listener = (state: { readonly connectionId: number; readonly open: boolean }) =>
            Queue.offerUnsafe(queue, state);
          fullscreenSurfaceListeners.add(listener);
          return listener;
        }),
        (listener) => Effect.sync(() => fullscreenSurfaceListeners.delete(listener)),
      ),
    );

  /** Shared by main windows and the drop-down overlay: no popups, no foreign navigation,
   * and the native edit/spelling context menu. */
  const installContentGuards = (window: BrowserWindow) => {
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("context-menu", (_event, params) => {
      if (!params.isEditable && !params.selectionText && !params.misspelledWord && !params.linkURL)
        return;
      const template: MenuItemConstructorOptions[] = [];
      if (params.misspelledWord) {
        for (const suggestion of params.dictionarySuggestions.slice(0, 5))
          template.push({
            label: suggestion,
            click: () => window.webContents.replaceMisspelling(suggestion),
          });
        if (!params.dictionarySuggestions.length)
          template.push({ label: "No Suggestions", enabled: false });
        template.push({ type: "separator" });
      }
      if (params.linkURL)
        template.push(
          { label: "Copy Link", click: () => clipboard.writeText(params.linkURL) },
          { type: "separator" },
        );
      if (params.isEditable || params.selectionText)
        template.push(
          { role: "cut", enabled: params.isEditable && params.editFlags.canCut },
          {
            role: "copy",
            enabled: params.isEditable ? params.editFlags.canCopy : Boolean(params.selectionText),
          },
          { role: "paste", enabled: params.isEditable && params.editFlags.canPaste },
          { role: "selectAll" },
        );
      Menu.buildFromTemplate(template).popup({ window });
    });
    window.webContents.on("will-navigate", (event, url) => {
      if (
        !shouldAllowNavigation(window.webContents.getURL(), url, process.env.ELECTRON_RENDERER_URL)
      )
        event.preventDefault();
    });
  };

  const createWindow = () => {
    const browserWindowOptions = {
      width: 1180,
      height: 820,
      minWidth: 760,
      minHeight: 560,
      titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
      backgroundColor: "#15191d",
      icon: options.cakeIconPath,
      webPreferences: {
        preload: options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    } as const;
    const window = new BrowserWindow({
      ...(process.platform === "darwin"
        ? {
            ...browserWindowOptions,
            trafficLightPosition: trafficLightPosition(CAKE_TITLE_BAR_HEIGHT),
          }
        : browserWindowOptions),
      ...(process.env.CAKE_ELECTRON_SMOKE === "1" ? { show: false } : null),
    });
    const nativeId = window.webContents.id;
    const ownerId = connections.desktop(nativeId);
    installRendererDiagnostics(window, () => {
      failedRenderers.add(ownerId);
      for (const listener of fullscreenSurfaceListeners)
        listener({ connectionId: ownerId, open: true });
    });
    window.webContents.on("did-start-navigation", (event) => {
      if (!event.isMainFrame || event.isSameDocument || !failedRenderers.delete(ownerId)) return;
      for (const listener of fullscreenSurfaceListeners)
        listener({ connectionId: ownerId, open: Boolean(fullscreenSurfaces.get(ownerId)?.size) });
    });
    windows.set(window.id, window);
    lastFocusedWindow = window;
    window.on("focus", () => {
      lastFocusedWindow = window;
      try {
        capture.activate(window);
      } catch (error) {
        clientEvents.sendTo(connectionForWindow(window), {
          type: "notification",
          title: "Screen capture shortcut unavailable",
          message: error instanceof Error ? error.message : String(error),
          tone: "error",
        });
      }
    });
    window.on("blur", () => {
      clientEvents.sendTo(connectionForWindow(window), { type: "window-blurred" });
    });
    installContentGuards(window);
    window.webContents.on("before-input-event", (event, input) => {
      // Native Command+Backquote is claimed by the application-menu accelerator below. Keep this
      // fallback for Backquote input delivered directly to Chromium and for modifier variants.
      if (process.platform !== "darwin" || !input.meta || input.code !== "Backquote") return;
      event.preventDefault();
      if (input.type !== "keyDown" || input.isAutoRepeat) return;
      clientEvents.sendTo(connectionForWindow(window), {
        type: "application-hotkey-input",
        key: input.key,
        code: input.code,
        metaKey: input.meta,
        ctrlKey: input.control,
        altKey: input.alt,
        shiftKey: input.shift,
        repeat: input.isAutoRepeat,
        isComposing: false,
      });
    });
    window.webContents.on("render-process-gone", () => {
      fullscreenSurfaces.delete(ownerId);
    });
    window.on("close", (event) => {
      if (applicationQuitting) return;
      if (failedRenderers.has(ownerId)) return;
      if (closeFullscreenSurfaceForWindow(window)) {
        event.preventDefault();
        return;
      }
      if (lifecycle().backToAgentForWindow(nativeId)) {
        centerTrafficLights(window, CAKE_TITLE_BAR_HEIGHT);
        event.preventDefault();
      }
    });
    window.on("closed", () => {
      const workingDirectory = clientWorkspaces.workspaceForConnection(ownerId);
      capture.release(window);
      windows.delete(window.id);
      clientWorkspaces.releaseConnection(ownerId);
      connections.release(ownerId);
      fullscreenSurfaces.delete(ownerId);
      failedRenderers.delete(ownerId);
      if (applicationQuitting) return;
      lifecycle().onWindowClosed(ownerId, workingDirectory, nativeId);
      // macOS keeps a window-less Cake running, so the drop-down stays available from the
      // shortcut. Elsewhere a hidden overlay must not keep the process alive after the last
      // main window closes; it is recreated on demand if sharing keeps Cake running.
      if (windows.size === 0 && process.platform !== "darwin") overlay.destroyWindow();
    });
    void loadRenderer(window);
    return window;
  };

  const onActivate = () => {
    if (!stopped && windows.size === 0) createWindow();
  };
  const configureApplicationBranding = () => {
    const windowMenuTail: MenuItemConstructorOptions[] =
      process.platform === "darwin"
        ? [{ type: "separator" }, { role: "front" }]
        : [{ role: "close" }];
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: "Cake",
          submenu: [
            { role: "about", label: "About Cake" },
            { type: "separator" },
            { role: "services", submenu: [] },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        },
        { role: "fileMenu" },
        { role: "editMenu" },
        { role: "viewMenu" },
        ...(process.env.ELECTRON_RENDERER_URL || process.env.CAKE_MANUAL_RELOAD === "1"
          ? [
              {
                label: "Developer",
                submenu: [
                  ...(process.env.ELECTRON_RENDERER_URL
                    ? [
                        {
                          label: "Toggle Developer Tools",
                          accelerator:
                            process.platform === "darwin" ? "Alt+Command+I" : "Ctrl+Shift+I",
                          click: () =>
                            BrowserWindow.getFocusedWindow()?.webContents.toggleDevTools(),
                        } satisfies MenuItemConstructorOptions,
                      ]
                    : []),
                  ...(process.env.CAKE_MANUAL_RELOAD === "1"
                    ? [
                        {
                          label: "Reload Cake",
                          click: () => BrowserWindow.getFocusedWindow()?.webContents.reload(),
                        } satisfies MenuItemConstructorOptions,
                      ]
                    : []),
                ],
              } satisfies MenuItemConstructorOptions,
            ]
          : []),
        {
          label: "Window",
          submenu: [
            { label: "New Cake Window", click: () => createWindow() },
            { role: "minimize" },
            { role: "zoom" },
            { type: "separator" },
            {
              label: "Toggle Agent / VS Code",
              click: () => {
                const focused = BrowserWindow.getFocusedWindow();
                const target =
                  focused && windows.has(focused.id) ? focused : [...windows.values()].at(-1);
                if (target)
                  clientEvents.sendTo(connectionForWindow(target), {
                    type: "embedded-editor-toggle-mode-requested",
                  });
              },
            },
            {
              label: "Drop-down Cake Chat",
              click: () => overlay.toggle(),
            },
            {
              label: "Toggle Terminal",
              // macOS handles Command+Backquote in the application menu before Chromium's
              // `before-input-event`. Keep a native accelerator here so Cake receives it.
              ...(process.platform === "darwin" ? { accelerator: "CommandOrControl+`" } : null),
              click: (_menuItem, _window, event) => {
                const focused = BrowserWindow.getFocusedWindow();
                // Inside the drop-down overlay, Command+Backquote puts the overlay away.
                if (focused && overlay.owns(focused)) {
                  overlay.hide();
                  return;
                }
                const target =
                  focused && windows.has(focused.id) ? focused : [...windows.values()].at(-1);
                if (!target) return;
                if (process.platform === "darwin" && event.triggeredByAccelerator) {
                  clientEvents.sendTo(connectionForWindow(target), {
                    type: "application-hotkey-input",
                    key: "`",
                    code: "Backquote",
                    metaKey: true,
                    ctrlKey: false,
                    altKey: false,
                    shiftKey: false,
                    repeat: false,
                    isComposing: false,
                  });
                  return;
                }
                clientEvents.sendTo(connectionForWindow(target), {
                  type: "terminal-toggle-requested",
                });
              },
            },
            ...windowMenuTail,
          ],
        },
      ]),
    );
    if (process.platform === "darwin" && options.application.dock) {
      const icon = nativeImage.createFromPath(options.cakeIconPath);
      if (!icon.isEmpty()) options.application.dock.setIcon(icon);
    }
  };

  const service = Electron.of({
    configureScreenCapture: Effect.fn("Electron.configureScreenCapture")((connectionId, settings) =>
      Effect.try({
        try: () => {
          const owner = BrowserWindow.fromWebContents(requireRendererConnection(connectionId));
          if (!owner || !windows.has(owner.id))
            throw new Error("Screen capture settings require a Cake window");
          capture.configure(owner, settings);
          return {};
        },
        catch: electronError,
      }),
    ),
    configureCakeChatOverlay: Effect.fn("Electron.configureCakeChatOverlay")(
      (connectionId, settings) =>
        Effect.try({
          try: () => {
            requireRendererConnection(connectionId);
            overlay.configure(settings);
            return {};
          },
          catch: electronError,
        }),
    ),
    hideCakeChatOverlay: Effect.fn("Electron.hideCakeChatOverlay")((connectionId) =>
      Effect.try({
        try: () => {
          requireRendererConnection(connectionId);
          overlay.hide();
          return {};
        },
        catch: electronError,
      }),
    ),
    showMainWindow: Effect.fn("Electron.showMainWindow")((connectionId, request) =>
      Effect.try({
        try: () => {
          requireRendererConnection(connectionId);
          if (stopped) throw new Error("Cake is shutting down");
          overlay.hide();
          const window = windows.values().next().value ?? createWindow();
          if (process.env.CAKE_ELECTRON_SMOKE !== "1") {
            // The overlay is a non-activating panel, so Cake may not be the active app yet.
            if (process.platform === "darwin") options.application.focus({ steal: true });
            if (window.isMinimized()) window.restore();
            window.show();
            window.focus();
          }
          const sessionId = request.sessionId;
          if (sessionId) {
            // A newly created window subscribes once its renderer starts; retry briefly.
            let attempts = 0;
            const deliver = () => {
              if (window.isDestroyed()) return;
              const delivered = clientEvents.sendTo(connectionForWindow(window), {
                type: "session-open-requested",
                sessionId,
              });
              if (!delivered && ++attempts < 60) setTimeout(deliver, 250);
            };
            deliver();
          }
          return {};
        },
        catch: electronError,
      }),
    ),
    captureWidgetView: Effect.fn("Electron.captureWidgetViewForConnection")(
      function* (connectionId, request) {
        const sender = yield* Effect.try({
          try: () => requireRendererConnection(connectionId),
          catch: electronError,
        });
        const owner = BrowserWindow.fromWebContents(sender);
        if (!owner || owner.isDestroyed() || owner.isMinimized())
          return yield* new ElectronError({
            message: "Current widget capture requires an available, non-minimized Cake window.",
          });
        return yield* captureWidgetView(sender, request.viewId);
      },
    ),
    startScreenCapture: Effect.fn("Electron.startScreenCapture")((connectionId, routing) =>
      Effect.tryPromise({
        try: async (signal) => {
          const owner = BrowserWindow.fromWebContents(requireRendererConnection(connectionId));
          if (owner && overlay.owns(owner)) {
            // Take the drop-down out of the still, then bring it back with the attachment.
            overlay.hide();
            await new Promise((resolve) => setTimeout(resolve, OVERLAY_HIDE_SETTLE_MS));
            try {
              return await capture.start(owner, routing, signal);
            } finally {
              if (!stopped && !owner.isDestroyed()) overlay.show();
            }
          }
          if (!owner || !windows.has(owner.id))
            throw new Error("Screen capture requires a Cake window");
          return capture.start(owner, routing, signal);
        },
        catch: electronError,
      }),
    ),
    screenCaptureState: Effect.fn("Electron.screenCaptureState")((connectionId) =>
      Effect.try({
        try: () => capture.state(requireRendererConnection(connectionId).id),
        catch: electronError,
      }),
    ),
    finishScreenCapture: Effect.fn("Electron.finishScreenCapture")((connectionId, request) =>
      Effect.try({
        try: () => {
          capture.finish(requireRendererConnection(connectionId).id, request.capture);
          return {};
        },
        catch: electronError,
      }),
    ),
    chooseProject: Effect.fn("Electron.chooseProject")(function* (connectionId) {
      const sender = yield* Effect.try({
        try: () => requireRendererConnection(connectionId),
        catch: electronError,
      });
      const owner = BrowserWindow.fromWebContents(sender);
      if (!owner) return {};
      const path = yield* Effect.tryPromise({
        try: async () => {
          const result = await dialog.showOpenDialog(owner, { properties: ["openDirectory"] });
          return result.canceled ? undefined : result.filePaths[0];
        },
        catch: electronError,
      });
      if (path) yield* lifecycle().allowProjectPath(path);
      return { path };
    }),
    openExternalUrl: Effect.fn("Electron.openExternalUrl")(function* (_connectionId, request) {
      return yield* Effect.tryPromise({
        try: async () => {
          const url = new URL(request.url);
          if (url.protocol !== "https:" && url.protocol !== "http:")
            throw new Error("External links must use HTTP or HTTPS");
          await shell.openExternal(url.href);
          return {};
        },
        catch: electronError,
      });
    }),
    showNotification: Effect.fn("Electron.showNotification")(function* (connectionId, request) {
      yield* Effect.try({
        try: () => requireRendererConnection(connectionId),
        catch: electronError,
      });
      return yield* Effect.try({
        try: () => {
          if (!Notification.isSupported())
            throw new Error("Native system notifications are not supported");
          new Notification({
            title: request.title,
            body: request.body,
            id: request.id,
            groupId: request.groupId,
          }).show();
          return {};
        },
        catch: electronError,
      });
    }),
    showTranscriptSelectionContextMenu: Effect.fn("Electron.showTranscriptSelectionContextMenu")(
      function* (connectionId, request) {
        const sender = yield* Effect.try({
          try: () => requireRendererConnection(connectionId),
          catch: electronError,
        });
        const owner = BrowserWindow.fromWebContents(sender);
        if (!owner) return {};
        return yield* Effect.tryPromise({
          try: () =>
            new Promise<SuccessTranscriptMenu>((resolve) => {
              let selectedAction: SuccessTranscriptMenu["action"];
              const template: MenuItemConstructorOptions[] = [{ role: "copy" }];
              if (request.canAnnotate)
                template.push(
                  iconMenuEntry({
                    label: "Add annotation",
                    icon: options.annotationMenuIconPath,
                    click: () => {
                      selectedAction = "add-annotation";
                    },
                  }),
                );
              if (request.canChat)
                template.push(
                  iconMenuEntry({
                    label: "Chat about this",
                    icon: options.chatMenuIconPath,
                    click: () => {
                      selectedAction = "chat-about-selection";
                    },
                  }),
                );
              template.push({ role: "selectAll" });
              Menu.buildFromTemplate(template).popup({
                window: owner,
                callback: () => resolve({ action: selectedAction }),
              });
            }),
          catch: electronError,
        });
      },
    ),
    showComposerContextMenu: Effect.fn("Electron.showComposerContextMenu")(
      function* (connectionId, request) {
        const sender = yield* Effect.try({
          try: () => requireRendererConnection(connectionId),
          catch: electronError,
        });
        const owner = BrowserWindow.fromWebContents(sender);
        if (!owner) return {};
        return yield* Effect.tryPromise({
          try: () =>
            new Promise<SuccessComposerMenu>((resolve) => {
              let completed = false;
              const finish = (action?: SuccessComposerMenu["action"]) => {
                if (completed) return;
                completed = true;
                resolve({ action });
              };
              Menu.buildFromTemplate([
                { role: "cut" },
                { role: "copy" },
                { role: "paste" },
                { type: "separator" },
                {
                  label: "Reword",
                  enabled: lifecycle().canRewordSelection(),
                  click: () => finish("reword"),
                },
                {
                  label: "Reword with Prompt…",
                  enabled: lifecycle().canRewordSelection(),
                  click: () => finish("reword-with-prompt"),
                },
                { type: "separator" },
                { role: "selectAll" },
              ]).popup({ window: owner, x: request.x, y: request.y, callback: () => finish() });
            }),
          catch: electronError,
        });
      },
    ),
    showSessionContextMenu: Effect.fn("Electron.showSessionContextMenu")(
      function* (connectionId, request) {
        const sender = yield* Effect.try({
          try: () => requireRendererConnection(connectionId),
          catch: electronError,
        });
        const owner = BrowserWindow.fromWebContents(sender);
        if (!owner) return {};
        return yield* Effect.tryPromise({
          try: () =>
            new Promise<SuccessSessionMenu>((resolve) => {
              let completed = false;
              const finish = (action?: SuccessSessionMenu["action"]) => {
                if (completed) return;
                completed = true;
                resolve({ action });
              };
              const copyId = {
                label: "Copy Session ID",
                click: () => clipboard.writeText(request.sessionId),
              };
              const activeItems: MenuItemConstructorOptions[] = [
                ...(request.unread === false
                  ? [{ label: "Mark as Unread", click: () => finish("mark-unread") }]
                  : []),
                { label: "Rename", click: () => finish("rename") },
                copyId,
              ];
              const menu = Menu.buildFromTemplate(
                request.permanent
                  ? [
                      {
                        label: "Mark as Read",
                        enabled: request.unread === true,
                        click: () => finish("mark-read"),
                      },
                      {
                        label: "Mark as Unread",
                        enabled: request.unread === false,
                        click: () => finish("mark-unread"),
                      },
                      copyId,
                    ]
                  : request.resolved
                    ? [
                        { label: "Unresolve", click: () => finish("unresolve") },
                        copyId,
                        ...(request.familyChild
                          ? []
                          : [
                              { type: "separator" as const },
                              { label: "Delete", click: () => finish("delete") },
                            ]),
                      ]
                    : request.draft
                      ? activeItems
                      : [...activeItems, { label: "Resolve", click: () => finish("resolve") }],
              );
              openSessionContextMenus.add(menu);
              menu.popup({
                window: owner,
                x: request.x,
                y: request.y,
                callback: () => {
                  openSessionContextMenus.delete(menu);
                  finish();
                },
              });
            }),
          catch: electronError,
        });
      },
    ),
    showProjectContextMenu: Effect.fn("Electron.showProjectContextMenu")(
      function* (connectionId, request) {
        const sender = yield* Effect.try({
          try: () => requireRendererConnection(connectionId),
          catch: electronError,
        });
        const owner = BrowserWindow.fromWebContents(sender);
        if (!owner) return {};
        return yield* Effect.tryPromise({
          try: () =>
            new Promise<SuccessProjectMenu>((resolve) => {
              let completed = false;
              const finish = (action?: SuccessProjectMenu["action"]) => {
                if (completed) return;
                completed = true;
                resolve({ action });
              };
              Menu.buildFromTemplate([
                { label: "Project Settings…", click: () => finish("settings") },
                {
                  label: "Sort Sessions",
                  submenu: [
                    {
                      label: "By Date",
                      type: "radio",
                      checked: request.sessionSort === "date",
                      click: () => finish("sort-by-date"),
                    },
                    {
                      label: "By Label",
                      type: "radio",
                      checked: request.sessionSort === "label",
                      click: () => finish("sort-by-label"),
                    },
                  ],
                },
                { type: "separator" },
                { label: "Copy Project Path", click: () => clipboard.writeText(request.path) },
                { type: "separator" },
                {
                  label: `Delete Resolved Worktrees${request.resolvedWorktreeCount > 0 ? ` (${request.resolvedWorktreeCount})` : ""}`,
                  enabled: request.resolvedWorktreeCount > 0,
                  click: () => finish("delete-resolved-worktrees"),
                },
                { type: "separator" },
                { label: "Remove Project…", click: () => finish("remove-project") },
              ]).popup({ window: owner, x: request.x, y: request.y, callback: () => finish() });
            }),
          catch: electronError,
        });
      },
    ),
    setFullscreenSurfaceOpen: Effect.fn("Electron.setFullscreenSurfaceOpen")(
      function* (connectionId, request) {
        yield* Effect.try({
          try: () => requireRendererConnection(connectionId),
          catch: electronError,
        });
        let surfaceIds = fullscreenSurfaces.get(connectionId);
        const wasOpen = failedRenderers.has(connectionId) || Boolean(surfaceIds?.size);
        if (request.open) {
          if (!surfaceIds) {
            surfaceIds = new Set();
            fullscreenSurfaces.set(connectionId, surfaceIds);
          }
          surfaceIds.add(request.surfaceId);
        } else if (surfaceIds) {
          surfaceIds.delete(request.surfaceId);
          if (surfaceIds.size === 0) fullscreenSurfaces.delete(connectionId);
        }
        const open =
          failedRenderers.has(connectionId) || Boolean(fullscreenSurfaces.get(connectionId)?.size);
        if (open !== wasOpen)
          for (const listener of fullscreenSurfaceListeners) listener({ connectionId, open });
        return { requestId: request.requestId };
      },
    ),
    start: Effect.fn("Electron.start")((nextLifecycle) =>
      Effect.sync(() => {
        windowLifecycle = nextLifecycle;
        stopped = false;
        applicationQuitting = false;
        if (
          process.env.CAKE_ELECTRON_SMOKE === "1" &&
          process.platform === "darwin" &&
          options.application.dock
        )
          options.application.dock.hide();
        configureApplicationBranding();
        options.application.on("activate", onActivate);
        options.application.on("browser-window-focus", syncOverlayShortcut);
        options.application.on("browser-window-blur", syncOverlayShortcut);
        createWindow();
      }),
    ),
    focusOrCreateWindow: Effect.fn("Electron.focusOrCreateWindow")(() =>
      Effect.sync(() => {
        // A window-less instance stays alive on macOS and while sharing the desktop; a second
        // launch is the user asking for that window back rather than for a second process.
        if (stopped || !windowLifecycle) return;
        const window = windows.values().next().value;
        if (!window) {
          onActivate();
          return;
        }
        // Background tests still handle second launches, but must never activate native windows.
        if (process.env.CAKE_ELECTRON_SMOKE === "1") return;
        if (window.isMinimized()) window.restore();
        window.focus();
      }),
    ),
    stop: Effect.fn("Electron.stop")(() =>
      Effect.sync(() => {
        if (stopped) return;
        stopped = true;
        applicationQuitting = true;
        capture.stop();
        overlay.stop();
        if (overlayFocusSync) clearImmediate(overlayFocusSync);
        overlayFocusSync = undefined;
        options.application.removeListener("activate", onActivate);
        options.application.removeListener("browser-window-focus", syncOverlayShortcut);
        options.application.removeListener("browser-window-blur", syncOverlayShortcut);
        for (const menu of openSessionContextMenus) menu.closePopup();
        openSessionContextMenus.clear();
        // The initial Electron quit is prevented so Effect can finalize first. Destroy the
        // renderer windows now so RPC transports and native views cannot retain the runtime.
        for (const window of windows.values()) {
          clientWorkspaces.releaseConnection(connectionForWindow(window));
          if (!window.isDestroyed()) window.destroy();
        }
        fullscreenSurfaceListeners.clear();
        fullscreenSurfaces.clear();
        failedRenderers.clear();
        windows.clear();
        windowLifecycle = undefined;
      }),
    ),
    fullscreenSurfaceChanges,
    requireRendererConnection,
    windowsForWorkspace: (workingDirectory) =>
      [...windows.values()].flatMap((window) =>
        clientWorkspaces.workspaceForConnection(connectionForWindow(window)) === workingDirectory &&
        !window.isDestroyed()
          ? [[connectionForWindow(window), window] as const]
          : [],
      ),
    centerTrafficLights,
  });

  return service;
};

export const makeElectronLive = (options: ElectronLiveOptions) =>
  Layer.effect(
    Electron,
    Effect.gen(function* () {
      const clientEvents = yield* ClientEvents;
      const clientWorkspaces = yield* ClientWorkspaces;
      const connections = yield* ClientConnections;
      const service = makeElectronService(options, clientEvents, clientWorkspaces, connections);
      return yield* Effect.acquireRelease(Effect.succeed(service), () => service.stop());
    }),
  );

type SuccessTranscriptMenu = {
  readonly action?: "chat-about-selection" | "add-annotation";
};
type SuccessComposerMenu = { readonly action?: "reword" | "reword-with-prompt" };
type SuccessSessionMenu = {
  readonly action?: "rename" | "mark-read" | "mark-unread" | "resolve" | "unresolve" | "delete";
};
type SuccessProjectMenu = {
  readonly action?:
    | "settings"
    | "sort-by-date"
    | "sort-by-label"
    | "remove-project"
    | "delete-resolved-worktrees";
};
