import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Ref } from "effect";
import { describe, expect } from "vitest";
import { makeInstallSingleFlight } from "../../../../src/services/vscode/VsCodeServerLive";

describe("VsCodeServerLive install single-flight", () => {
  it.effect("keeps the shared install alive when its initiating caller is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const runs = yield* Ref.make(0);
        const install = Effect.gen(function* () {
          yield* Ref.update(runs, (count) => count + 1);
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(finish);
        });
        const runInstall = yield* makeInstallSingleFlight(install);

        const initiatingCaller = yield* Effect.forkChild(runInstall);
        yield* Deferred.await(started);
        const waitingCaller = yield* Effect.forkChild(runInstall);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(initiatingCaller);
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(waitingCaller);

        expect(yield* Ref.get(runs)).toBe(1);
      }),
    ),
  );

  it.effect("delivers the shared typed installation failure to every waiter", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const runInstall = yield* makeInstallSingleFlight(
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(finish);
            return yield* Effect.fail("installation failed" as const);
          }),
        );

        const first = yield* Effect.forkChild(Effect.flip(runInstall));
        yield* Deferred.await(started);
        const second = yield* Effect.forkChild(Effect.flip(runInstall));
        yield* Effect.yieldNow;
        yield* Deferred.succeed(finish, undefined);

        expect(yield* Fiber.join(first)).toBe("installation failed");
        expect(yield* Fiber.join(second)).toBe("installation failed");
      }),
    ),
  );
});
