import { it } from "@effect/vitest";
import { Effect, Layer, Queue, Stream } from "effect";
import { expect, vi } from "vitest";
import {
  ClientConnections,
  ClientConnectionsLive,
} from "../../../../src/services/clients/ClientConnections";
import { ClientEventsLive } from "../../../../src/services/clients/ClientEventsLive";
import { Electron } from "../../../../src/services/electron/Electron";
import { makeVsCodeViewsLive } from "../../../../src/services/vscode/VsCodeViewsLive";
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

it.effect(
  "cleans the native owner's theme lease after its logical connection has already been released",
  () =>
    Effect.gen(function* () {
      native.close.mockClear();
      native.windows.clear();
      for (const id of [47, 48])
        native.windows.set(id, {
          webContents: { id },
          isDestroyed: () => false,
          contentView: { addChildView() {}, removeChildView() {} },
        });
      let updated = () => {};
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
      const layer = makeVsCodeViewsLive({
        preferredTheme: async () => "dark",
        onThemeUpdated: (listener) => {
          updated = listener;
          return () => {};
        },
      }).pipe(Layer.provide(Native.pipe(Layer.provide(Clients))), Layer.provideMerge(Clients));
      yield* Effect.gen(function* () {
        const views = yield* VsCodeViews;
        const connections = yield* ClientConnections;
        const received = yield* Queue.unbounded<number>();
        yield* views.themeChanges().pipe(
          Stream.runForEach(({ connectionId }) => Queue.offer(received, connectionId)),
          Effect.forkScoped({ startImmediately: true }),
        );
        const first = connections.desktop(47);
        yield* views.open(first, {
          workspacePath: "/server/one",
          url: "http://127.0.0.1:4321/",
          theme: "dark",
        });
        updated();
        expect(yield* Queue.take(received)).toBe(first);
        // Electron releases its identity synchronously before MainApplication's queued view cleanup.
        connections.release(first);
        yield* views.closeForWindow(47);
        const second = connections.desktop(48);
        yield* views.open(second, {
          workspacePath: "/server/two",
          url: "http://127.0.0.1:4322/",
          theme: "dark",
        });
        updated();
        expect(yield* Queue.take(received)).toBe(second);
      }).pipe(Effect.scoped, Effect.provide(layer));
      expect(native.close).toHaveBeenCalledTimes(2);
    }),
);
