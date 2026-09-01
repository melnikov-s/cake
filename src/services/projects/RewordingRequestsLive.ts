import { Effect, Layer } from "effect";
import { RewordingRequests } from "./RewordingRequests";

export const RewordingRequestsLive = Layer.effect(
  RewordingRequests,
  Effect.gen(function* () {
    const controllers = new Map<number, Set<AbortController>>();
    const disposeOwner = (ownerId: number) => {
      for (const controller of controllers.get(ownerId) ?? []) controller.abort();
      controllers.delete(ownerId);
    };

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const ownerId of controllers.keys()) disposeOwner(ownerId);
      }),
    );

    return RewordingRequests.of({
      acquire: Effect.fn("RewordingRequests.acquire")((ownerId) =>
        Effect.sync(() => {
          const controller = new AbortController();
          const owned = controllers.get(ownerId) ?? new Set<AbortController>();
          owned.add(controller);
          controllers.set(ownerId, owned);
          return controller;
        }),
      ),
      release: Effect.fn("RewordingRequests.release")((ownerId, controller) =>
        Effect.sync(() => {
          const owned = controllers.get(ownerId);
          owned?.delete(controller);
          if (owned?.size === 0) controllers.delete(ownerId);
        }),
      ),
      disposeOwner: Effect.fn("RewordingRequests.disposeOwner")((ownerId) =>
        Effect.sync(() => disposeOwner(ownerId)),
      ),
    });
  }),
);
