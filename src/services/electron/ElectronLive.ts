import { Effect, Layer, Queue, Stream } from "effect";
import {
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  nativeImage,
  Notification,
  shell,
  webContents,
  type App,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron";
import type { ProjectWorkflowColor } from "../../domain/application/application-data";
import type { CakeEvent } from "../../ipc/cake-rpc-contract";
import { shouldAllowNavigation } from "./navigation-policy";
import {
  CAKE_TITLE_BAR_HEIGHT,
  Electron,
  ElectronError,
  type ElectronWindowLifecycle,
} from "./Electron";
import { NativeEvents, type FocusedCakeEvent } from "./NativeEvents";

const TRAFFIC_LIGHT_X = 18;
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

const workflowStatusColors = {
  rose: "#df7180",
  peach: "#e79568",
  amber: "#daa836",
  lime: "#8db64b",
  mint: "#4eae83",
  sky: "#4ba8cc",
  blue: "#638bdc",
  violet: "#9a78d7",
} satisfies Record<ProjectWorkflowColor, string>;

const workflowStatusMenuIcon = (color: ProjectWorkflowColor) =>
  nativeImage.createFromDataURL(
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><rect x="3" y="3" width="10" height="10" rx="3" fill="${workflowStatusColors[color]}"/></svg>`,
    )}`,
  );

export const makeElectronLive = (options: ElectronLiveOptions) => {
  const windows = new Map<number, BrowserWindow>();
  const windowWorkspaces = new Map<number, string>();
  const fullscreenSurfaces = new Map<number, Set<string>>();
  const fullscreenSurfaceListeners = new Set<
    (state: { readonly connectionId: number; readonly open: boolean }) => void
  >();
  const openSessionContextMenus = new Set<Menu>();
  const nativeEventListeners = new Map<number, Set<(event: CakeEvent) => void>>();
  let applicationQuitting = false;
  let stopped = false;
  let windowLifecycle: ElectronWindowLifecycle | undefined;
  const lifecycle = () => {
    if (!windowLifecycle) throw new Error("Electron window lifecycle has not started");
    return windowLifecycle;
  };

  const requireRendererConnection = (connectionId: number): WebContents => {
    const sender = webContents.fromId(connectionId);
    if (!sender || sender.isDestroyed()) throw new Error("Renderer connection is no longer active");
    return sender;
  };

  const subscribeNativeEvents = (
    connectionId: number,
    listener: (event: CakeEvent) => void,
  ): (() => void) => {
    const listeners = nativeEventListeners.get(connectionId) ?? new Set();
    listeners.add(listener);
    nativeEventListeners.set(connectionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) nativeEventListeners.delete(connectionId);
    };
  };

  const sendTo = (target: WebContents, event: CakeEvent) => {
    if (target.isDestroyed()) return;
    for (const listener of nativeEventListeners.get(target.id) ?? []) listener(event);
  };

  const broadcast = (event: CakeEvent) => {
    for (const window of windows.values()) sendTo(window.webContents, event);
  };

  const centerTrafficLights = (window: BrowserWindow, titleBarHeight: number) => {
    if (process.platform === "darwin")
      window.setWindowButtonPosition(trafficLightPosition(titleBarHeight));
  };

  const loadRenderer = async (window: BrowserWindow) => {
    if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL);
    else await window.loadFile(options.rendererPath);
  };

  const closeFullscreenSurfaceForWindow = (window: BrowserWindow) => {
    const surfaceIds = fullscreenSurfaces.get(window.webContents.id);
    const surfaceId = surfaceIds ? Array.from(surfaceIds).at(-1) : undefined;
    if (!surfaceId) return false;
    sendTo(window.webContents, { type: "fullscreen-surface-close-requested", surfaceId });
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
    const ownerId = window.webContents.id;
    windows.set(window.id, window);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("before-input-event", (event, input) => {
      // Native Command+Backquote is claimed by the application-menu accelerator below. Keep this
      // fallback for Backquote input delivered directly to Chromium and for modifier variants.
      if (process.platform !== "darwin" || !input.meta || input.code !== "Backquote") return;
      event.preventDefault();
      if (input.type !== "keyDown" || input.isAutoRepeat) return;
      sendTo(window.webContents, {
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
    window.webContents.on("render-process-gone", () => {
      fullscreenSurfaces.delete(ownerId);
    });
    window.on("close", (event) => {
      if (applicationQuitting) return;
      if (closeFullscreenSurfaceForWindow(window)) {
        event.preventDefault();
        return;
      }
      if (lifecycle().backToAgentForWindow(ownerId)) {
        centerTrafficLights(window, CAKE_TITLE_BAR_HEIGHT);
        event.preventDefault();
      }
    });
    window.on("closed", () => {
      const workingDirectory = windowWorkspaces.get(ownerId);
      windows.delete(window.id);
      windowWorkspaces.delete(ownerId);
      fullscreenSurfaces.delete(ownerId);
      nativeEventListeners.delete(ownerId);
      if (applicationQuitting) return;
      lifecycle().onWindowClosed(ownerId, workingDirectory);
    });
    void loadRenderer(window);
    return window;
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
                  sendTo(target.webContents, { type: "embedded-editor-toggle-mode-requested" });
              },
            },
            {
              label: "Toggle Terminal",
              // macOS handles Command+Backquote in the application menu before Chromium's
              // `before-input-event`. Keep a native accelerator here so Cake receives it.
              ...(process.platform === "darwin" ? { accelerator: "CommandOrControl+`" } : null),
              click: (_menuItem, _window, event) => {
                const focused = BrowserWindow.getFocusedWindow();
                const target =
                  focused && windows.has(focused.id) ? focused : [...windows.values()].at(-1);
                if (!target) return;
                if (process.platform === "darwin" && event.triggeredByAccelerator) {
                  sendTo(target.webContents, {
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
                sendTo(target.webContents, { type: "terminal-toggle-requested" });
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
                  enabled: lifecycle().hasUtilityModel(),
                  click: () => finish("reword"),
                },
                {
                  label: "Reword with Prompt…",
                  enabled: lifecycle().hasUtilityModel(),
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
              const finish = (action?: SuccessSessionMenu["action"], statusId?: string) => {
                if (completed) return;
                completed = true;
                resolve({ action, ...(statusId ? { statusId } : undefined) });
              };
              const copyId = {
                label: "Copy Session ID",
                click: () => clipboard.writeText(request.sessionId),
              };
              const statusItems: MenuItemConstructorOptions[] = request.workflow
                ? [
                    ...(request.workflow.currentStatus === "active"
                      ? []
                      : [{ label: "Active", click: () => finish("set-status", "active") }]),
                    ...request.workflow.statuses
                      .filter((status) => status.id !== request.workflow?.currentStatus)
                      .map((status): MenuItemConstructorOptions => ({
                        label: status.name,
                        icon: workflowStatusMenuIcon(status.color),
                        click: () => finish("set-status", status.id),
                      })),
                    ...(request.draft || request.familyChild || request.resolved
                      ? []
                      : [
                          {
                            label: "Resolved",
                            click: () => finish("set-status", "resolved"),
                          },
                        ]),
                  ]
                : [];
              const statusMenu: MenuItemConstructorOptions | undefined = statusItems.length
                ? { label: "Set Status", submenu: statusItems }
                : undefined;
              const activeItems: MenuItemConstructorOptions[] = [
                { label: "Rename", click: () => finish("rename") },
                ...(request.unread === false
                  ? [{ label: "Mark as Unread", click: () => finish("mark-unread") }]
                  : []),
                ...(statusMenu ? [statusMenu] : []),
                copyId,
              ];
              const menu = Menu.buildFromTemplate(
                request.familyChild
                  ? request.resolved
                    ? [copyId]
                    : activeItems
                  : request.resolved
                    ? [
                        ...(statusMenu
                          ? [statusMenu]
                          : [{ label: "Unresolve", click: () => finish("unresolve") }]),
                        copyId,
                        { type: "separator" },
                        { label: "Delete", click: () => finish("delete") },
                      ]
                    : request.draft || statusMenu
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
        const sender = yield* Effect.try({
          try: () => requireRendererConnection(connectionId),
          catch: electronError,
        });
        let surfaceIds = fullscreenSurfaces.get(sender.id);
        const wasOpen = Boolean(surfaceIds?.size);
        if (request.open) {
          if (!surfaceIds) {
            surfaceIds = new Set();
            fullscreenSurfaces.set(sender.id, surfaceIds);
          }
          surfaceIds.add(request.surfaceId);
        } else if (surfaceIds) {
          surfaceIds.delete(request.surfaceId);
          if (surfaceIds.size === 0) fullscreenSurfaces.delete(sender.id);
        }
        const open = Boolean(fullscreenSurfaces.get(sender.id)?.size);
        if (open !== wasOpen)
          for (const listener of fullscreenSurfaceListeners)
            listener({ connectionId: sender.id, open });
        return { requestId: request.requestId };
      },
    ),
    openExternal: Effect.fn("Electron.openExternal")((url) =>
      Effect.tryPromise({
        try: async () => {
          const protocol = new URL(url).protocol;
          if (protocol !== "https:" && protocol !== "http:")
            throw new Error("External URL must use HTTP or HTTPS");
          await shell.openExternal(url);
        },
        catch: electronError,
      }),
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
        createWindow();
      }),
    ),
    stop: Effect.fn("Electron.stop")(() =>
      Effect.sync(() => {
        if (stopped) return;
        stopped = true;
        applicationQuitting = true;
        for (const menu of openSessionContextMenus) menu.closePopup();
        openSessionContextMenus.clear();
        // The initial Electron quit is prevented so Effect can finalize first. Destroy the
        // renderer windows now so RPC transports and native views cannot retain the runtime.
        for (const window of windows.values()) if (!window.isDestroyed()) window.destroy();
        nativeEventListeners.clear();
        fullscreenSurfaceListeners.clear();
        windowWorkspaces.clear();
        fullscreenSurfaces.clear();
        windows.clear();
        windowLifecycle = undefined;
      }),
    ),
    sendTo,
    broadcast,
    fullscreenSurfaceChanges,
    requireRendererConnection,
    workspaceForConnection: (connectionId) => windowWorkspaces.get(connectionId),
    associateWorkspace: (connectionId, workingDirectory) =>
      windowWorkspaces.set(connectionId, workingDirectory),
    forgetWorkspace: (workingDirectory) => {
      for (const [connectionId, current] of windowWorkspaces)
        if (current === workingDirectory) windowWorkspaces.delete(connectionId);
    },
    windowsForWorkspace: (workingDirectory) =>
      [...windows.values()].flatMap((window) =>
        windowWorkspaces.get(window.webContents.id) === workingDirectory && !window.isDestroyed()
          ? [[window.webContents.id, window] as const]
          : [],
      ),
    centerTrafficLights,
  });

  const observe = (connectionId: number, initial: CakeEvent) =>
    Stream.callback<CakeEvent>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const unsubscribe = subscribeNativeEvents(connectionId, (event) => {
            Queue.offerUnsafe(queue, event);
          });
          Queue.offerUnsafe(queue, initial);
          return unsubscribe;
        }),
        (unsubscribe) => Effect.sync(unsubscribe),
      ),
    );
  const focused = <Types extends CakeEvent["type"]>(
    connectionId: number,
    channel: Extract<CakeEvent, { type: "renderer-events-ready" }>["channel"],
    ...types: ReadonlyArray<Types>
  ): Stream.Stream<FocusedCakeEvent<Types | "renderer-events-ready">> => {
    const accepted = new Set<CakeEvent["type"]>(["renderer-events-ready", ...types]);
    return observe(connectionId, { type: "renderer-events-ready", channel }).pipe(
      Stream.filter((event): event is FocusedCakeEvent<Types | "renderer-events-ready"> =>
        accepted.has(event.type),
      ),
    );
  };
  const nativeEvents = NativeEvents.of({
    application: (connectionId) =>
      focused(
        connectionId,
        "application",
        "changelog-snapshot",
        "complete",
        "fatal",
        "notification",
        "extension-ui-intent",
        "project-session-control-requested",
        "application-hotkey-input",
      ),
    artifacts: (connectionId) =>
      focused(connectionId, "artifacts", "artifact-updated", "artifact-requested", "ui-request"),
    terminals: (connectionId) => focused(connectionId, "terminals", "terminal-toggle-requested"),
    vscode: (connectionId) =>
      focused(
        connectionId,
        "vscode",
        "embedded-editor-toggle-mode-requested",
        "embedded-editor-selection",
        "embedded-editor-back-to-agent",
        "embedded-editor-annotation-opened",
        "embedded-editor-toggle-chat",
        "embedded-editor-toggle-sidebar",
        "embedded-editor-selection-cleared",
        "embedded-editor-entered",
      ),
    surfaces: (connectionId) =>
      focused(connectionId, "surfaces", "fullscreen-surface-close-requested"),
  });

  return Layer.merge(
    Layer.effect(
      Electron,
      Effect.acquireRelease(Effect.succeed(service), () => service.stop()),
    ),
    Layer.succeed(NativeEvents, nativeEvents),
  );
};

type SuccessTranscriptMenu = {
  readonly action?: "chat-about-selection" | "add-annotation";
};
type SuccessComposerMenu = { readonly action?: "reword" | "reword-with-prompt" };
type SuccessSessionMenu = {
  readonly action?: "rename" | "mark-unread" | "resolve" | "unresolve" | "set-status" | "delete";
  readonly statusId?: string;
};
type SuccessProjectMenu = {
  readonly action?: "settings" | "remove-project" | "delete-resolved-worktrees";
};
