import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { vi } from "vitest";
import { Browser } from "../../../../src/services/browser/Browser";
import { NativePreviewTunnels } from "../../../../src/services/browser/NativePreviewTunnels";
import { makeNativePreviewTunnelsLive } from "../../../../src/services/browser/NativePreviewTunnelsLive";
import { Electron } from "../../../../src/services/electron/Electron";

const lease = { endpoint: `/preview/${"a".repeat(64)}/`, secret: "b".repeat(64) };
const nativeSender = () => Object.assign(new EventEmitter(), { isDestroyed: vi.fn(() => false) });
const dependencies = (senders: Map<number, ReturnType<typeof nativeSender>>) =>
  Layer.mergeAll(
    Layer.mock(Electron, {
      windowsForWorkspace: () => [],
      centerTrafficLights: () => {},
      requireRendererConnection: (id) => {
        const sender = senders.get(id);
        if (!sender) throw new Error("Missing test window");
        // Only native event subscription and destruction state cross this fake Electron boundary.
        return sender as unknown as WebContents;
      },
    }),
    Layer.mock(Browser, {
      state: (_id, sessionId) =>
        Effect.succeed({
          sessionId,
          url: "http://localhost/",
          title: "Preview",
          loading: false,
          canGoBack: false,
          canGoForward: false,
          inspecting: false,
        }),
    }),
  );

describe("NativePreviewTunnels acquisition ownership", () => {
  it.effect("interruption between listener acquire/register closes it", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let resolve: ((tunnel: { endpoint: string; close: () => void }) => void) | undefined;
      const listener = new Promise<{ endpoint: string; close: () => void }>((complete) => {
        resolve = complete;
      });
      const close = vi.fn();
      const sender = nativeSender();
      const layer = makeNativePreviewTunnelsLive("http://backend/rpc", () => {
        Deferred.doneUnsafe(started, Effect.void);
        return listener;
      }).pipe(Layer.provide(dependencies(new Map([[1, sender]]))));
      yield* Effect.gen(function* () {
        const tunnels = yield* NativePreviewTunnels;
        const pending = yield* tunnels.open(1, "session", lease).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        pending.interruptUnsafe();
        resolve?.({ endpoint: "http://preview/", close });
        expect((yield* Fiber.await(pending))._tag).toBe("Failure");
        expect(close).toHaveBeenCalledOnce();
        expect(sender.listenerCount("destroyed")).toBe(0);
      }).pipe(Effect.provide(layer));
      expect(close).toHaveBeenCalledOnce();
    }),
  );

  it.effect(
    "window destruction during acquisition releases instead of registering a dead owner",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        let resolve: ((tunnel: { endpoint: string; close: () => void }) => void) | undefined;
        const listener = new Promise<{ endpoint: string; close: () => void }>((complete) => {
          resolve = complete;
        });
        const close = vi.fn();
        const sender = nativeSender();
        yield* Effect.gen(function* () {
          const tunnels = yield* NativePreviewTunnels;
          const pending = yield* tunnels.open(1, "session", lease).pipe(Effect.forkChild);
          yield* Deferred.await(started);
          sender.isDestroyed.mockReturnValue(true);
          sender.emit("destroyed");
          resolve?.({ endpoint: "http://preview/", close });
          expect((yield* Fiber.join(pending).pipe(Effect.result))._tag).toBe("Failure");
          expect(close).toHaveBeenCalledOnce();
          expect(sender.listenerCount("destroyed")).toBe(0);
        }).pipe(
          Effect.provide(
            makeNativePreviewTunnelsLive("http://backend/rpc", () => {
              Deferred.doneUnsafe(started, Effect.void);
              return listener;
            }).pipe(Layer.provide(dependencies(new Map([[1, sender]])))),
          ),
        );
      }),
  );

  it.effect(
    "registered listeners are isolated by window, replaced once, and closed by their layer Scope",
    () =>
      Effect.gen(function* () {
        const first = nativeSender();
        const second = nativeSender();
        const close = [vi.fn(), vi.fn(), vi.fn()];
        let count = 0;
        const layer = makeNativePreviewTunnelsLive("http://backend/rpc", async () => {
          const index = count++;
          return { endpoint: `http://preview/${index}`, close: () => close[index]?.() };
        }).pipe(
          Layer.provide(
            dependencies(
              new Map([
                [1, first],
                [2, second],
              ]),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const tunnels = yield* NativePreviewTunnels;
          const endpoint = yield* tunnels.open(1, "session", lease);
          expect(yield* tunnels.open(1, "session", lease)).toBe(endpoint);
          yield* tunnels.open(2, "session", lease);
          yield* tunnels.open(1, "other-session", lease);
          expect(close[0]).toHaveBeenCalledOnce();
          first.emit("destroyed");
          first.emit("destroyed");
          expect(close[2]).toHaveBeenCalledOnce();
          expect(close[1]).not.toHaveBeenCalled();
        }).pipe(Effect.provide(layer));
        expect(close.map((spy) => spy.mock.calls.length)).toEqual([1, 1, 1]);
        expect(second.listenerCount("destroyed")).toBe(0);
      }),
  );
});
