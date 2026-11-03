import {
  ClientConnections,
  ClientConnectionsLive,
} from "../../../../src/services/clients/ClientConnections";
import { EventEmitter } from "node:events";
import { it } from "@effect/vitest";
import { Context, Deferred, Effect, Fiber, Layer, Queue, Schema, Stream } from "effect";
import type { MenuItemConstructorOptions, PopupOptions } from "electron";
import { afterEach, describe, expect, vi } from "vitest";
import {
  cakeRpcSuccessSchemas,
  type CakeEvent,
} from "../../../../src/contracts/application/cake-rpc-contract";
import { ClientEvents } from "../../../../src/services/clients/ClientEvents";
import { ClientEventsLive } from "../../../../src/services/clients/ClientEventsLive";
import { ClientWorkspaces } from "../../../../src/services/clients/ClientWorkspaces";
import { ClientWorkspacesLive } from "../../../../src/services/clients/ClientWorkspacesLive";
import { Electron } from "../../../../src/services/electron/Electron";
import { makeElectronLive } from "../../../../src/services/electron/ElectronLive";

const native = vi.hoisted(() => ({
  template: [] as MenuItemConstructorOptions[],
  destroyed: false,
  windowShows: [] as (boolean | undefined)[],
  activations: [] as string[],
  confirm: vi.fn(async () => ({ response: 0 })),
  flushes: 0,
  fromId: vi.fn(() => undefined as unknown),
  fromWebContents: vi.fn(() => undefined as unknown),
  popup: vi.fn<(options: PopupOptions) => void>(),
  decodeImage: vi.fn(),
  writeClipboard: vi
    .fn<(items: { data: Record<string, Blob | string> }[]) => Promise<void>>()
    .mockResolvedValue(undefined),
}));
vi.mock("electron", () => ({
  BrowserWindow: class extends EventEmitter {
    id = 1;
    webContents = Object.assign(new EventEmitter(), {
      id: 42,
      setWindowOpenHandler: () => {},
    });
    constructor(options: { show?: boolean }) {
      super();
      native.windowShows.push(options.show);
    }
    static getFocusedWindow() {
      return undefined;
    }
    static fromWebContents() {
      return native.fromWebContents();
    }
    isMinimized() {
      return true;
    }
    restore() {
      native.activations.push("restore");
    }
    focus() {
      native.activations.push("focus");
    }
    loadFile() {
      return Promise.resolve();
    }
    loadURL() {
      return Promise.resolve();
    }
    isDestroyed() {
      return native.destroyed;
    }
    close() {
      let prevented = false;
      this.emit("close", {
        preventDefault: () => {
          prevented = true;
        },
      });
      if (!prevented) this.destroy();
    }
    destroy() {
      native.destroyed = true;
      this.emit("closed");
    }
  },
  Menu: {
    buildFromTemplate: (template: MenuItemConstructorOptions[]) => {
      native.template = template;
      return { popup: native.popup };
    },
    setApplicationMenu: () => {},
  },
  nativeImage: { createFromDataURL: native.decodeImage },
  clipboard: { write: native.writeClipboard },
  ClipboardItem: class {
    constructor(readonly data: Record<string, Blob | string>) {}
  },
  dialog: { showMessageBox: native.confirm },
  Notification: {},
  shell: {},
  webContents: { fromId: native.fromId },
}));

const live = makeElectronLive({
  application: Object.assign(Object.create(null), { on: () => {}, removeListener: () => {} }),
  cakeIconPath: "/icon.png",
  annotationMenuIconPath: "/icon.png",
  chatMenuIconPath: "/icon.png",
  preloadPath: "/preload.js",
  rendererPath: "/index.html",
}).pipe(
  Layer.provideMerge(Layer.mergeAll(ClientConnectionsLive, ClientEventsLive, ClientWorkspacesLive)),
);

afterEach(() => {
  vi.unstubAllEnvs();
  native.fromId.mockReset();
  native.fromWebContents.mockReset();
  native.popup.mockReset();
  native.decodeImage.mockReset();
  native.writeClipboard.mockReset().mockResolvedValue(undefined);
});

describe("ElectronLive client state", () => {
  it.effect.each(["select", "dismiss"] as const)(
    "native Project menu %s returns a validated automation action or dismissal",
    (choice) =>
      Effect.gen(function* () {
        const context = yield* Layer.build(live);
        const electron = Context.get(context, Electron);
        const connectionId = Context.get(context, ClientConnections).desktop(42);
        const owner = { id: 1 };
        native.fromId.mockReturnValue({ id: 42, isDestroyed: () => false });
        native.fromWebContents.mockReturnValue(owner);
        native.popup.mockImplementation(({ callback }) => {
          const item = native.template.find((entry) => entry.label === "New Automation…");
          if (!item?.click) throw new Error("Missing native New Automation action");
          if (choice === "select") Reflect.apply(item.click, undefined, []);
          callback?.();
        });
        const result = yield* electron.showProjectContextMenu(connectionId, {
          path: "/project",
          x: 24,
          y: 48,
          sessionSort: "date",
          resolvedWorktreeCount: 0,
        });
        expect(result.action).toBe(choice === "select" ? "new-automation" : undefined);
        expect(native.popup).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ window: owner, x: 24, y: 48 }),
        );
        expect(
          yield* Schema.decodeUnknownEffect(cakeRpcSuccessSchemas["show-project-context-menu"])(
            result,
          ),
        ).toEqual(result);
      }),
  );
  it.effect("copies decoded pixels and reports native failures without writing empty images", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(live);
      const service = Context.get(context, Electron);
      const connectionId = Context.get(context, ClientConnections).desktop(42);
      native.fromId.mockReturnValue({ id: 42, isDestroyed: () => false });
      const image = { isEmpty: () => false, toPNG: () => Buffer.from("pixels") };
      native.decodeImage.mockReturnValue(image);
      yield* service.copyImage(connectionId, { dataUrl: "data:image/png;base64,cGl4ZWxz" });
      expect(native.decodeImage).toHaveBeenCalledWith("data:image/png;base64,cGl4ZWxz");
      expect(native.writeClipboard).toHaveBeenCalledExactlyOnceWith([
        expect.objectContaining({ data: { "image/png": expect.any(Blob) } }),
      ]);
      const png = native.writeClipboard.mock.calls[0]![0][0]!.data["image/png"];
      if (!(png instanceof Blob)) throw new Error("Missing PNG payload");
      expect(png.type).toBe("image/png");
      expect(yield* Effect.promise(() => png.text())).toBe("pixels");
      native.writeClipboard.mockClear();
      native.decodeImage.mockReturnValue({ isEmpty: () => true });
      const invalid = yield* service
        .copyImage(connectionId, { dataUrl: "invalid" })
        .pipe(Effect.flip);
      expect(invalid.message).toContain("could not be decoded");
      expect(native.writeClipboard).not.toHaveBeenCalled();
      native.decodeImage.mockReturnValue(image);
      native.writeClipboard.mockRejectedValue(new Error("Clipboard unavailable"));
      const failed = yield* service.copyImage(connectionId, { dataUrl: "valid" }).pipe(Effect.flip);
      expect(failed.message).toBe("Clipboard unavailable");
      native.fromId.mockReturnValue(undefined);
      const disconnected = yield* service
        .copyImage(connectionId, { dataUrl: "valid" })
        .pipe(Effect.flip);
      expect(disconnected.message).toBe("Renderer connection is no longer active");
    }),
  );

  it.effect.each([
    { mode: "background", smoke: "1", activations: [] },
    { mode: "ordinary", smoke: undefined, activations: ["restore", "focus"] },
  ])("$mode second launches obey native activation policy", ({ smoke, activations }) =>
    Effect.gen(function* () {
      vi.stubEnv("CAKE_ELECTRON_SMOKE", smoke);
      native.destroyed = false;
      native.windowShows = [];
      native.activations = [];
      const context = yield* Layer.build(live);
      const electron = Context.get(context, Electron);
      yield* electron.start({
        flushWindowState: () => Effect.void,
        onWindowCloseRequested: () => {},
        backToAgentForWindow: () => false,
        onWindowClosed: () => {},
        allowProjectPath: () => Effect.void,
        canRewordSelection: () => true,
      });
      yield* electron.focusOrCreateWindow();
      expect(native.activations).toEqual(activations);
      expect(native.windowShows).toEqual([smoke === "1" ? false : undefined]);
      // A second launch must still recreate a closed window; smoke-mode creation stays hidden.
      Context.get(context, ClientWorkspaces).associateWorkspace(1, "/project");
      const windows = electron.windowsForWorkspace("/project");
      expect(windows).toHaveLength(1);
      windows[0]?.[1].destroy();
      native.destroyed = false;
      yield* electron.focusOrCreateWindow();
      expect(native.windowShows).toEqual([
        smoke === "1" ? false : undefined,
        smoke === "1" ? false : undefined,
      ]);
      expect(native.activations).toEqual(activations);
      yield* electron.stop();
    }),
  );

  it.effect(
    "waits for the final renderer save before closing and coalesces repeated close clicks",
    () =>
      Effect.gen(function* () {
        native.destroyed = false;
        const context = yield* Layer.build(live);
        const electron = Context.get(context, Electron);
        const requested = yield* Queue.unbounded<number>();
        const saving = yield* Deferred.make<void>();
        const saveStarted = yield* Deferred.make<void>();
        yield* electron.start({
          flushWindowState: () =>
            Deferred.succeed(saveStarted, undefined).pipe(Effect.andThen(Deferred.await(saving))),
          onWindowCloseRequested: (id) => {
            Queue.offerUnsafe(requested, id);
          },
          backToAgentForWindow: () => false,
          onWindowClosed: () => {},
          allowProjectPath: () => Effect.void,
          canRewordSelection: () => true,
        });
        Context.get(context, ClientWorkspaces).associateWorkspace(1, "/project");
        const window = electron.windowsForWorkspace("/project")[0]![1];
        window.close();
        window.close();
        expect(yield* Queue.take(requested)).toBe(1);
        expect(yield* Queue.size(requested)).toBe(0);
        expect(native.destroyed).toBe(false);
        const closing = yield* electron.closeWindow(1).pipe(Effect.forkChild);
        yield* Deferred.await(saveStarted);
        expect(native.destroyed).toBe(false);
        yield* Deferred.succeed(saving, undefined);
        yield* Fiber.join(closing);
        expect(native.destroyed).toBe(true);
      }),
  );

  it.effect(
    "save failures keep windows open unless the user explicitly discards the latest settings",
    () =>
      Effect.gen(function* () {
        native.destroyed = false;
        native.confirm.mockClear();
        native.confirm.mockResolvedValue({ response: 0 });
        const context = yield* Layer.build(live);
        const electron = Context.get(context, Electron);
        yield* electron.start({
          flushWindowState: () => Effect.fail({ message: "Disk full" }),
          onWindowCloseRequested: () => {},
          backToAgentForWindow: () => false,
          onWindowClosed: () => {},
          allowProjectPath: () => Effect.void,
          canRewordSelection: () => true,
        });
        expect(yield* electron.prepareToQuit()).toBe(false);
        yield* electron.closeWindow(1);
        expect(native.destroyed).toBe(false);
        expect(native.confirm).toHaveBeenCalledTimes(2);
        native.confirm.mockResolvedValue({ response: 1 });
        expect(yield* electron.prepareToQuit()).toBe(true);
        yield* electron.closeWindow(1);
        expect(native.destroyed).toBe(true);
      }),
  );

  it.effect("native window closure reads and releases the shared workspace authority", () =>
    Effect.gen(function* () {
      native.destroyed = false;
      const context = yield* Layer.build(live);
      const electron = Context.get(context, Electron);
      const workspaces = Context.get(context, ClientWorkspaces);
      const onWindowClosed = vi.fn();
      yield* electron.start({
        flushWindowState: () => Effect.void,
        onWindowCloseRequested: () => {},
        backToAgentForWindow: () => false,
        onWindowClosed,
        allowProjectPath: () => Effect.void,
        canRewordSelection: () => true,
      });
      workspaces.associateWorkspace(1, "/project");
      workspaces.associateWorkspace(7, "/project");
      const windows = electron.windowsForWorkspace("/project");
      expect(windows.map(([id]) => id)).toEqual([1]);
      workspaces.associateWorkspace(1, "/new");
      expect(electron.windowsForWorkspace("/project")).toEqual([]);
      expect(electron.windowsForWorkspace("/new").map(([id]) => id)).toEqual([1]);
      workspaces.forgetWorkspace("/new");
      expect(electron.windowsForWorkspace("/new")).toEqual([]);
      workspaces.associateWorkspace(1, "/current");
      windows[0]?.[1].destroy();
      expect(onWindowClosed).toHaveBeenCalledWith(1, "/current", 42);
      expect(workspaces.workspaceForConnection(1)).toBeUndefined();
      expect(workspaces.workspaceForConnection(7)).toBe("/project");
      expect(electron.windowsForWorkspace("/current")).toEqual([]);
      // An association is not proof of a native window: native APIs still check it.
      const error = yield* Effect.flip(electron.chooseProject(7, {}));
      expect(error.message).toBe("Renderer connection is no longer active");
    }),
  );

  it.effect("native menu and backend publication share one event authority", () =>
    Effect.gen(function* () {
      native.destroyed = false;
      const context = yield* Layer.build(live);
      const electron = Context.get(context, Electron);
      const events = Context.get(context, ClientEvents);
      const workspaces = Context.get(context, ClientWorkspaces);
      const received = yield* Queue.unbounded<CakeEvent>();
      yield* events.vscode(1).pipe(
        Stream.runForEach((event) => Queue.offer(received, event)),
        Effect.forkScoped,
      );
      expect(yield* Queue.take(received)).toEqual({
        type: "renderer-events-ready",
        channel: "vscode",
      });
      yield* electron.start({
        flushWindowState: () => Effect.void,
        onWindowCloseRequested: () => {},
        backToAgentForWindow: () => false,
        onWindowClosed: () => {},
        allowProjectPath: () => Effect.void,
        canRewordSelection: () => true,
      });
      const submenu = native.template.find((item) => item.label === "Window")?.submenu;
      if (!Array.isArray(submenu)) throw new Error("Window menu missing");
      const toggle = submenu.find((item) => item.label === "Toggle Agent / VS Code");
      if (!toggle?.click) throw new Error("Toggle menu action missing");
      // The native implementation's callback does not use the Electron click arguments.
      Reflect.apply(toggle.click, undefined, []);
      expect(yield* Queue.take(received)).toEqual({
        type: "embedded-editor-toggle-mode-requested",
      });
      events.broadcast({ type: "embedded-editor-toggle-sidebar", workspacePath: "/project" });
      expect(yield* Queue.take(received)).toEqual({
        type: "embedded-editor-toggle-sidebar",
        workspacePath: "/project",
      });
      workspaces.associateWorkspace(1, "/project");
      workspaces.associateWorkspace(7, "/project");
      expect(electron.windowsForWorkspace("/project").map(([id]) => id)).toEqual([1]);
      yield* electron.stop();
      expect(native.destroyed).toBe(true);
      expect(workspaces.workspaceForConnection(1)).toBeUndefined();
      expect(workspaces.workspaceForConnection(7)).toBe("/project");
      // Stopping the desktop adapter must not tear down another transport's event authority.
      events.broadcast({ type: "embedded-editor-toggle-chat", workspacePath: "/project" });
      expect(yield* Queue.take(received)).toEqual({
        type: "embedded-editor-toggle-chat",
        workspacePath: "/project",
      });
    }),
  );
});
