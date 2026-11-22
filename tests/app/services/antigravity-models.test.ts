import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { expect, vi } from "vitest";
import { modelHandlers } from "../../../src/ipc/server/ModelHandlers";
import { RendererConnection } from "../../../src/ipc/protocol/RendererConnectionMiddleware";
import {
  AntigravityModels,
  makeAntigravityModelsLayer,
} from "../../../src/services/antigravity/AntigravityModels";
import {
  ClientConnections,
  ClientConnectionsLive,
} from "../../../src/services/clients/ClientConnections";

const original = [{ modelId: "fixture-sonnet-medium", name: "Fixture Sonnet (Medium)" }];
const replacement = [{ modelId: "fixture-flash", name: "Fixture Flash" }];

it.effect(
  "loads lazily, shares overlapping requests, and keeps the last good catalog on refresh failure",
  () => {
    const discover = vi.fn<(signal: AbortSignal) => Promise<typeof original>>();
    return Effect.gen(function* () {
      const { catalog } = yield* AntigravityModels;
      expect(discover).not.toHaveBeenCalled();
      const ready = yield* Deferred.make<typeof original>();
      discover.mockImplementationOnce((signal) =>
        Effect.runPromise(Deferred.await(ready), { signal }),
      );
      const initial = yield* catalog(false).pipe(Effect.forkChild({ startImmediately: true }));
      const second = yield* catalog(false).pipe(Effect.forkChild({ startImmediately: true }));
      const refresh = yield* catalog(true).pipe(Effect.forkChild({ startImmediately: true }));
      expect(discover).toHaveBeenCalledTimes(1);
      yield* Fiber.interrupt(initial); // Closing a picker/RPC must not kill other waiters.
      yield* Deferred.succeed(ready, original);
      expect(yield* Fiber.join(second)).toEqual({ models: original });
      expect(yield* Fiber.join(refresh)).toEqual({ models: original });
      expect(yield* catalog(false)).toEqual({ models: original });
      expect(discover).toHaveBeenCalledTimes(1);
      discover.mockResolvedValueOnce(replacement);
      expect(yield* catalog(true)).toEqual({ models: replacement });
      discover.mockRejectedValueOnce(new Error("Sign in again"));
      const stale = { models: replacement, error: "Sign in again" };
      expect(yield* catalog(true)).toEqual(stale);
      expect(yield* catalog(false)).toEqual(stale);
      expect(discover).toHaveBeenCalledTimes(3);
    }).pipe(Effect.provide(makeAntigravityModelsLayer(discover)));
  },
);

it.effect(
  "prevents browser clients from launching discovery and keeps the first failure until explicit refresh",
  () => {
    const discover = vi
      .fn<(signal: AbortSignal) => Promise<typeof original>>()
      .mockRejectedValueOnce(new Error("Sign in first"))
      .mockResolvedValueOnce(original);
    return Effect.gen(function* () {
      const clients = yield* ClientConnections;
      const browser = clients.socket();
      const desktop = clients.desktop(123);
      const rpc = (connectionId: number, force: boolean) =>
        modelHandlers["models.catalogAntigravity"]({ force }).pipe(
          Effect.provideService(RendererConnection, { connectionId, correlationId: "test" }),
        );
      expect(yield* rpc(browser, true).pipe(Effect.flip)).toMatchObject({
        message: "Antigravity model discovery requires a desktop connection.",
      });
      expect(discover).not.toHaveBeenCalled();
      expect(yield* rpc(desktop, false)).toEqual({ models: [], error: "Sign in first" });
      expect(yield* rpc(desktop, false)).toEqual({ models: [], error: "Sign in first" });
      expect(discover).toHaveBeenCalledTimes(1);
      expect(yield* rpc(desktop, true)).toEqual({ models: original });
    }).pipe(
      Effect.provide(Layer.merge(ClientConnectionsLive, makeAntigravityModelsLayer(discover))),
    );
  },
);
