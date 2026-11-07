import { it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Layer, Logger } from "effect";
import { expect } from "vitest";
import { makeStartupDiagnostics } from "../../../../src/services/diagnostics/startup-diagnostics";

const fixture = () => {
  let now = 100;
  const records: unknown[] = [];
  return {
    diagnostics: makeStartupDiagnostics("test-launch", () => now),
    advance: (ms: number) => {
      now += ms;
    },
    records,
    logging: Logger.layer([Logger.make((event) => records.push(event.message))]),
  };
};

it.effect("records monotonic stage bounds without changing results or logging values", () =>
  Effect.gen(function* () {
    const f = fixture();
    const value = yield* f.diagnostics
      .measure(
        "recovery",
        Effect.sync(() => {
          f.advance(25);
          return "PRIVATE_RESULT";
        }),
      )
      .pipe(Effect.provide(f.logging));
    expect(value).toBe("PRIVATE_RESULT");
    expect(f.records).toEqual([
      [
        "Cake startup",
        { run: "test-launch", phase: "recovery", elapsedMs: 100, status: "started" },
      ],
      [
        "Cake startup",
        {
          run: "test-launch",
          phase: "recovery",
          elapsedMs: 125,
          status: "completed",
          durationMs: 25,
        },
      ],
    ]);
  }),
);

it.effect("preserves failure and interruption without including their bodies", () =>
  Effect.gen(function* () {
    const f = fixture();
    const failed = yield* f.diagnostics
      .measure("failure", Effect.fail("PRIVATE_ERROR"))
      .pipe(Effect.exit, Effect.provide(f.logging));
    expect(Exit.isFailure(failed)).toBe(true);
    const entered = yield* Deferred.make<void>();
    const interrupted = yield* f.diagnostics
      .measure("interrupt", Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)))
      .pipe(Effect.forkScoped, Effect.provide(f.logging));
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(interrupted);
    expect(JSON.stringify(f.records)).not.toContain("PRIVATE_ERROR");
    expect(f.records).toContainEqual([
      "Cake startup",
      expect.objectContaining({ phase: "failure", status: "failed-or-interrupted" }),
    ]);
    expect(f.records).toContainEqual([
      "Cake startup",
      expect.objectContaining({ phase: "interrupt", status: "failed-or-interrupted" }),
    ]);
  }),
);

it.effect("times Layer acquisition and retains the logger in native callbacks", () =>
  Effect.gen(function* () {
    const f = fixture();
    yield* Effect.gen(function* () {
      const run = Effect.runSyncWith(yield* Effect.context<never>());
      run(f.diagnostics.mark("first-commit", { rendererElapsedMs: 17 }));
    }).pipe(
      Effect.provide(
        f.diagnostics
          .layer("backend-graph", Layer.effectDiscard(Effect.sync(() => f.advance(30))))
          .pipe(Layer.provideMerge(f.logging)),
      ),
    );
    expect(f.records).toContainEqual([
      "Cake startup",
      expect.objectContaining({ phase: "backend-graph", status: "completed", durationMs: 30 }),
    ]);
    expect(f.records).toContainEqual([
      "Cake startup",
      expect.objectContaining({
        phase: "first-commit",
        run: "test-launch",
        elapsedMs: 130,
        rendererElapsedMs: 17,
      }),
    ]);
  }),
);
