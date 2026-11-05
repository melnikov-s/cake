import { it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { expect, vi } from "vitest";
import {
  ClientConnections,
  ClientConnectionsLive,
} from "../../../../src/services/clients/ClientConnections";
import { ClientEventsLive } from "../../../../src/services/clients/ClientEventsLive";
import {
  CAKE_TITLE_BAR_HEIGHT,
  Electron,
  VSCODE_TITLE_BAR_HEIGHT,
} from "../../../../src/services/electron/Electron";
import { VsCodeViewsLive } from "../../../../src/services/vscode/VsCodeViewsLive";
import { VsCodeViews } from "../../../../src/services/vscode/VsCodeViews";

const native = vi.hoisted(() => {
  const close = vi.fn();
  const windows = new Map<
    number,
    {
      webContents: { id: number };
      isDestroyed(): boolean;
      contentView: { addChildView(): void; removeChildView(): void };
    }
  >();
  return {
    close,
    windows,
    WebContentsView: class {
      setVisible() {}
      setBounds() {}
      setBackgroundColor() {}
      webContents = {
        on() {},
        setWindowOpenHandler() {},
        loadURL: async () => {},
        executeJavaScript: async () => {},
        isDestroyed: () => false,
        close,
      };
    },
  };
});
vi.mock("electron", () => ({
  WebContentsView: native.WebContentsView,
  BrowserWindow: {
    getAllWindows: () => [...native.windows.values()],
    fromWebContents: (sender: { id: number }) => native.windows.get(sender.id),
  },
}));

it.effect("closes the native view after its logical connection has already been released", () =>
  Effect.gen(function* () {
    native.close.mockClear();
    native.windows.clear();
    for (const id of [47, 48])
      native.windows.set(id, {
        webContents: { id },
        isDestroyed: () => false,
        contentView: { addChildView() {}, removeChildView() {} },
      });
    const Native = Layer.unwrap(
      Effect.gen(function* () {
        const connections = yield* ClientConnections;
        return Layer.mock(Electron, {
          fullscreenSurfaceChanges: () => Stream.empty,
          centerTrafficLights: () => {},
          windowsForWorkspace: () => [],
          requireRendererConnection: (id) => {
            const nativeId = connections.nativeId(id);
            if (nativeId === undefined) throw new Error("Disconnected");
            return { id: nativeId } as never;
          },
        });
      }),
    );
    const Clients = Layer.merge(ClientConnectionsLive, ClientEventsLive);
    const layer = VsCodeViewsLive.pipe(
      Layer.provide(Native.pipe(Layer.provide(Clients))),
      Layer.provideMerge(Clients),
    );
    yield* Effect.gen(function* () {
      const views = yield* VsCodeViews;
      const connections = yield* ClientConnections;
      const first = connections.desktop(47);
      yield* views.open(first, {
        workspacePath: "/server/one",
        url: "http://127.0.0.1:4321/",
        theme: "dark",
      });
      // Electron releases its identity synchronously before MainApplication's queued view cleanup.
      connections.release(first);
      yield* views.closeForWindow(47);
      const second = connections.desktop(48);
      yield* views.open(second, {
        workspacePath: "/server/two",
        url: "http://127.0.0.1:4322/",
        theme: "dark",
      });
    }).pipe(Effect.scoped, Effect.provide(layer));
    expect(native.close).toHaveBeenCalledTimes(2);
  }),
);

it.effect("centers the traffic lights on VS Code's title bar while its view is shown", () =>
  Effect.gen(function* () {
    native.windows.clear();
    native.windows.set(49, {
      webContents: { id: 49 },
      isDestroyed: () => false,
      contentView: { addChildView() {}, removeChildView() {} },
    });
    const heights: number[] = [];
    const Native = Layer.unwrap(
      Effect.gen(function* () {
        const connections = yield* ClientConnections;
        return Layer.mock(Electron, {
          fullscreenSurfaceChanges: () => Stream.empty,
          centerTrafficLights: (_window, height) => heights.push(height),
          windowsForWorkspace: () => [],
          requireRendererConnection: (id) => {
            const nativeId = connections.nativeId(id);
            if (nativeId === undefined) throw new Error("Disconnected");
            return { id: nativeId } as never;
          },
        });
      }),
    );
    const Clients = Layer.merge(ClientConnectionsLive, ClientEventsLive);
    const layer = VsCodeViewsLive.pipe(
      Layer.provide(Native.pipe(Layer.provide(Clients))),
      Layer.provideMerge(Clients),
    );
    yield* Effect.gen(function* () {
      const views = yield* VsCodeViews;
      const connection = (yield* ClientConnections).desktop(49);
      const editor = { x: 0, y: 0, width: 900, height: 700, projectSidebarWidth: 0 };
      // Cake's title bars match VS Code's whenever its view is shown, wherever it sits:
      // at the window's corner, below the top terminal, or beside the project sidebar.
      yield* views.updateBounds(connection, { ...editor, visible: true });
      yield* views.updateBounds(connection, { ...editor, visible: true, y: 365, height: 335 });
      yield* views.updateBounds(connection, { ...editor, visible: true, x: 280 });
      yield* views.updateBounds(connection, { ...editor, visible: false });
    }).pipe(Effect.scoped, Effect.provide(layer));
    expect(heights).toEqual([
      VSCODE_TITLE_BAR_HEIGHT,
      VSCODE_TITLE_BAR_HEIGHT,
      VSCODE_TITLE_BAR_HEIGHT,
      CAKE_TITLE_BAR_HEIGHT,
    ]);
  }),
);
