import { ClientConnectionsLive } from "../../../../src/services/clients/ClientConnections";
import { EventEmitter } from "node:events";
import { it } from "@effect/vitest";
import { Context, Effect, Layer, Queue, Stream } from "effect";
import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, vi } from "vitest";
import type { CakeEvent } from "../../../../src/ipc/cake-rpc-contract";
import { ClientEvents } from "../../../../src/services/clients/ClientEvents";
import { ClientEventsLive } from "../../../../src/services/clients/ClientEventsLive";
import { ClientWorkspaces } from "../../../../src/services/clients/ClientWorkspaces";
import { ClientWorkspacesLive } from "../../../../src/services/clients/ClientWorkspacesLive";
import { Electron } from "../../../../src/services/electron/Electron";
import { makeElectronLive } from "../../../../src/services/electron/ElectronLive";

const native = vi.hoisted(() => ({
  template: [] as MenuItemConstructorOptions[],
  destroyed: false,
}));
vi.mock("electron", () => ({
  BrowserWindow: class extends EventEmitter {
    id = 1;
    webContents = Object.assign(new EventEmitter(), {
      id: 42,
      setWindowOpenHandler: () => {},
    });
    static getFocusedWindow() {
      return undefined;
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
    destroy() {
      native.destroyed = true;
      this.emit("closed");
    }
  },
  Menu: {
    buildFromTemplate: (template: MenuItemConstructorOptions[]) => {
      native.template = template;
      return {};
    },
    setApplicationMenu: () => {},
  },
  nativeImage: {},
  clipboard: {},
  dialog: {},
  Notification: {},
  shell: {},
  webContents: { fromId: () => undefined },
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

describe("ElectronLive client state", () => {
  it.effect("native window closure reads and releases the shared workspace authority", () =>
    Effect.gen(function* () {
      native.destroyed = false;
      const context = yield* Layer.build(live);
      const electron = Context.get(context, Electron);
      const workspaces = Context.get(context, ClientWorkspaces);
      const onWindowClosed = vi.fn();
      yield* electron.start({
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
