import { it } from "@effect/vitest";
import { Effect, Fiber, Queue, Stream } from "effect";
import { describe, expect, vi } from "vitest";
import type { DrawControlInvocation } from "../../../../src/domain/draw/draw-control";
import { Electron } from "../../../../src/services/electron/Electron";
import { makeElectronLive } from "../../../../src/services/electron/ElectronLive";
import { NativeEvents } from "../../../../src/services/electron/NativeEvents";

vi.mock("electron", () => ({
  nativeImage: {
    createFromPath: () => ({ setTemplateImage: () => undefined }),
  },
  webContents: {
    fromId: (id: number) => ({ id, isDestroyed: () => false }),
  },
  BrowserWindow: class {},
  Menu: class {},
  Notification: class {},
  clipboard: {},
  shell: {},
}));

describe("NativeEvents", () => {
  it.effect("forwards draw-control-requested through the application event stream", () =>
    Effect.gen(function* () {
      const layer = makeElectronLive({
        application: {} as never,
        cakeIconPath: "/icon.png",
        annotationMenuIconPath: "/icon.png",
        chatMenuIconPath: "/icon.png",
        preloadPath: "/preload.js",
        rendererPath: "/index.html",
      });

      const { electron, nativeEvents } = yield* Effect.all({
        electron: Electron,
        nativeEvents: NativeEvents,
      }).pipe(Effect.provide(layer));

      const connectionId = 42;
      const received = yield* Queue.unbounded<unknown>();
      const fiber = yield* nativeEvents.application(connectionId).pipe(
        Stream.runForEach((event) => Queue.offer(received, event)),
        Effect.forkChild,
      );

      const ready = yield* Queue.take(received);
      expect(ready).toEqual({ type: "renderer-events-ready", channel: "application" });

      const invocation: DrawControlInvocation = { _tag: "Read", scope: "viewport" };
      electron.sendTo(
        { id: connectionId, isDestroyed: () => false } as never,
        {
          type: "terminal-data",
          terminalId: "term-1",
          data: "filtered out",
        } as never,
      );
      electron.sendTo({ id: connectionId, isDestroyed: () => false } as never, {
        type: "draw-control-requested",
        sessionId: "session-1",
        drawRequestId: "request-1",
        invocation,
      });

      const drawEvent = yield* Queue.take(received);
      expect(drawEvent).toEqual({
        type: "draw-control-requested",
        sessionId: "session-1",
        drawRequestId: "request-1",
        invocation,
      });

      yield* Fiber.interrupt(fiber);
    }),
  );
});
