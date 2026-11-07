import { randomUUID } from "node:crypto";
import { Effect, Exit, Layer } from "effect";

/** One identity per host process, shared by backend, desktop and renderer receipts.
 * Node's performance origin includes module loading before this module was evaluated.
 */
export const makeStartupDiagnostics = (run: string, now: () => number) => {
  const mark = (phase: string, fields: Readonly<Record<string, string | number>> = {}) =>
    Effect.logInfo("Cake startup", { run, phase, elapsedMs: now(), ...fields });

  const measure = Effect.fn("Startup.measure")(function* <A, E, R>(
    phase: string,
    effect: Effect.Effect<A, E, R>,
  ) {
    const started = now();
    yield* mark(phase, { status: "started" });
    return yield* effect.pipe(
      Effect.onExit((exit) =>
        mark(phase, {
          status: Exit.isSuccess(exit) ? "completed" : "failed-or-interrupted",
          durationMs: now() - started,
        }),
      ),
    );
  });

  const layer = <A, E, R>(phase: string, value: Layer.Layer<A, E, R>) =>
    Layer.unwrap(
      Effect.gen(function* () {
        const started = now();
        yield* mark(phase, { status: "started" });
        return value.pipe(
          Layer.tap(() => mark(phase, { status: "completed", durationMs: now() - started })),
          Layer.tapCause(() =>
            mark(phase, { status: "failed-or-interrupted", durationMs: now() - started }),
          ),
        );
      }),
    );

  return { mark, measure, layer };
};

export const startupDiagnostics = makeStartupDiagnostics(randomUUID(), () => performance.now());
