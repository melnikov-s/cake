import { Context, Effect, Fiber, FiberHandle, Layer, Option, Semaphore } from "effect";
import type { AntigravityCatalog } from "../../contracts/model-presets/antigravity-catalog";
import { discoverAntigravityModels } from "./acp";

export class AntigravityModels extends Context.Service<
  AntigravityModels,
  { readonly catalog: (force: boolean) => Effect.Effect<AntigravityCatalog> }
>()("cake/services/antigravity/AntigravityModels") {}

/** Shared by all desktop endpoints on this backend; never starts a subprocess at acquisition. */
export const makeAntigravityModelsLayer = (discover = discoverAntigravityModels) =>
  Layer.effect(
    AntigravityModels,
    Effect.gen(function* () {
      const inFlight = yield* FiberHandle.make<AntigravityCatalog, never>();
      const admission = yield* Semaphore.make(1);
      let snapshot: AntigravityCatalog | undefined;
      const probe = Effect.callback<AntigravityCatalog>((resume, signal) => {
        const pending = discover(signal).then(
          (models) => resume(Effect.succeed({ models })),
          (error) =>
            resume(
              Effect.succeed({
                models: snapshot?.models ?? [],
                error:
                  error instanceof Error ? error.message : "Antigravity model discovery failed.",
              }),
            ),
        );
        // Interruption aborts ACP. Wait for its process and scratch cleanup on backend shutdown.
        return Effect.promise(() => pending);
      }).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            snapshot = result;
          }),
        ),
      );

      const catalog = Effect.fn("AntigravityModels.catalog")(function* (force: boolean) {
        const lookup = yield* admission.withPermits(1)(
          Effect.gen(function* () {
            // A failed first probe also waits for an explicit retry instead of launching on every open.
            if (!force && snapshot) return Effect.succeed(snapshot);
            const existing = yield* FiberHandle.get(inFlight);
            const fiber = Option.isSome(existing)
              ? existing.value
              : yield* FiberHandle.run(inFlight, probe);
            return Fiber.join(fiber);
          }),
        );
        return yield* lookup;
      });
      return AntigravityModels.of({ catalog });
    }),
  );
