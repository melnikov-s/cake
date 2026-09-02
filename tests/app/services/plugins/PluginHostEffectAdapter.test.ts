import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, vi } from "vitest";
import { adaptPluginHostOperation } from "../../../../src/services/plugins/PluginHostEffectAdapter";

describe("PluginHostEffectAdapter", () => {
  it.effect("forwards Effect interruption to cancellable host operations", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const interrupted = vi.fn(async () => undefined);
      const operation = adaptPluginHostOperation(
        "test.operation",
        () => {
          Deferred.doneUnsafe(started, Effect.void);
          return new Promise<string>(() => undefined);
        },
        interrupted,
      );
      const fiber = yield* Effect.forkChild(operation(7, { requestId: "request-1" }));

      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);

      expect(interrupted).toHaveBeenCalledWith(7, { requestId: "request-1" });
    }),
  );
});
